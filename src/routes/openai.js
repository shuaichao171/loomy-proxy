/**
 * OpenAI 兼容入口。
 *
 * 暴露：/v1/models、/v1/chat/completions、/v1/images/generations
 * 明确不支持（上游就是 404）：/v1/completions、/v1/embeddings —— 返回明确的 501，
 * 比透传上游的 404 页面更好排查。
 */

import crypto from 'node:crypto'
import { readBody, sendJson, sendOpenAiError } from '../util/http.js'
import { describeErrorBody, extractUsage, isEventStream, readCachedJson, tapJson } from './shared.js'
import { withAccountFailover, UpstreamExhaustedError } from '../core/executor.js'

const AFFINITY_HEADER = 'x-loomy-chat-id'

export function conversationKey (req, payload) {
  const header = String(req.headers[AFFINITY_HEADER] || '').trim()
  if (header) return header.slice(0, 200)
  const explicit = String(payload?.user || payload?.metadata?.chat_id || '').trim()
  if (explicit) return explicit.slice(0, 200)
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const seed = messages.slice(0, 2).map((message) => typeof message?.content === 'string' ? message.content : '').join('\u0000')
  if (!seed.trim()) return ''
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 24)
}

function newChatId (key) {
  return key ? `lpy-${key}` : `lpy-${crypto.randomUUID()}`
}

export async function handleChatCompletions (ctx, req, res) {
  const { config, logger, upstream, scheduler, usage, catalog } = ctx
  const started = Date.now()
  const { json: payload } = await readBody(req, { maxBytes: config.limits.maxBodyBytes })
  if (!payload || typeof payload !== 'object') {
    return sendOpenAiError(res, 400, '请求体必须是 JSON 对象', { type: 'invalid_request_error', code: 'invalid_json' })
  }

  const key = ctx.authKey
  const isStream = payload.stream === true
  const requestedModel = String(payload.model || '').trim()
  const model = requestedModel || catalog.pickDefault('openai')
  if (!model) {
    return sendOpenAiError(res, 503, '模型目录为空：请先在管理台刷新模型列表', { type: 'service_unavailable', code: 'no_models' })
  }
  if (key?.allowedModels?.length && !key.allowedModels.includes(model) && !key.allowedModels.includes('*')) {
    return sendOpenAiError(res, 403, `当前密钥不允许使用模型 ${model}`, { type: 'permission_error', code: 'model_not_allowed' })
  }

  const chatId = newChatId(conversationKey(req, payload))
  const msgId = String(req.headers['x-loomy-msg-id'] || `${chatId}-${Date.now()}`).slice(0, 256)
  const turnId = String(req.headers['x-loomy-turn-id'] || msgId).slice(0, 256)
  const purpose = String(req.headers['x-loomy-purpose'] || config.upstream.requestPurpose || 'chat.message')

  // 透传客户端参数，仅补齐 Loomy 需要的默认值（不去改动客户端的语义）
  const upstreamBody = { ...payload, model, stream: isStream }
  // stream_options 只对流式请求有意义；非流式带上会被部分后端（如 dashscope）判为非法参数
  if (isStream && upstreamBody.stream_options === undefined) upstreamBody.stream_options = { include_usage: true }

  let result
  try {
    result = await withAccountFailover({
      scheduler,
      affinityKey: chatId,
      maxRetries: config.pool.maxRetries,
      onAttempt: ({ account, error, attempt }) => {
        if (error) {
          logger.warn('上游尝试失败，切换账号', { accountId: account.id, code: error.code, attempt })
        }
      },
      execute: (account) => upstream.fetch(account, '/chat/completions', {
        method: 'POST',
        body: upstreamBody,
        headers: upstream.headers(account, {
          stream: isStream,
          purpose,
          chatId,
          msgId,
          turnId,
        }),
        signal: ctx.abortSignal,
      }),
      inspect: async (response) => {
        if (isEventStream(response)) return null
        const parsed = await tapJson(response)
        if (!parsed) {
          return { code: `HTTP_${response.status}`, message: `上游返回无法解析的响应（HTTP ${response.status}）`, authInvalid: false }
        }
        if (parsed.envelope) return parsed.envelope
        if (!response.ok) {
          return { code: `HTTP_${response.status}`, message: describeErrorBody(parsed), authInvalid: false }
        }
        return null
      },
    })
  } catch (error) {
    const status = error instanceof UpstreamExhaustedError ? mapErrorStatus(error.lastError) : 502
    const code = error.lastError?.code || 'upstream_error'
    logger.error('对话请求失败', { model, code, message: error.message })
    usage.record({
      endpoint: '/v1/chat/completions',
      model,
      keyId: key?.id || '',
      status: 'error',
      errorCode: code,
      stream: isStream,
      latencyMs: Date.now() - started,
      chatId,
    })
    return sendOpenAiError(res, status, error.message, { type: 'upstream_error', code })
  }

  const account = result.account
  const response = result.response

  // 情况一：上游直接返回 JSON（非流式，或流式被上游降级成一次性 JSON）
  if (!isEventStream(response)) {
    const parsed = readCachedJson(response) || await tapJson(response)
    const json = parsed?.json ?? null
    const usageInfo = extractUsage(json?.usage)
    ctx.finishRequest({
      account,
      key,
      model,
      endpoint: '/v1/chat/completions',
      stream: false,
      usage: usageInfo,
      latencyMs: Date.now() - started,
      chatId,
      status: 'ok',
    })
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'x-loomy-account': account.id,
      'x-loomy-model': model,
      'x-loomy-points': String(usageInfo.points),
    })
    res.end(parsed?.raw ?? JSON.stringify(json ?? {}))
    return
  }

  // 情况二：真正的 SSE 流式转发
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-loomy-account': account.id,
    'x-loomy-model': model,
  })

  try {
    const relayed = await relayStream(ctx, response, res)
    const usageInfo = extractUsage(relayed.usage)
    ctx.finishRequest({
      account,
      key,
      model: relayed.model || model,
      endpoint: '/v1/chat/completions',
      stream: true,
      usage: usageInfo,
      latencyMs: Date.now() - started,
      chatId,
      status: 'ok',
    })
  } catch (error) {
    logger.warn('流式转发中断', { model, error: error.message })
    usage.record({
      endpoint: '/v1/chat/completions',
      model,
      accountId: account.id,
      keyId: key?.id || '',
      status: 'error',
      errorCode: 'stream_aborted',
      stream: true,
      latencyMs: Date.now() - started,
      chatId,
    })
  }
}

export async function handleModels (ctx, req, res) {
  const { catalog } = ctx
  if (catalog.isStale(5 * 60 * 1000)) {
    await ctx.refreshModels({ silent: true })
  }
  sendJson(res, 200, catalog.toOpenAiList())
}

export async function handleImagesGenerations (ctx, req, res) {
  const { config, logger, upstream, scheduler, usage, catalog } = ctx
  const started = Date.now()
  const { json: payload } = await readBody(req, { maxBytes: config.limits.maxBodyBytes })
  if (!payload || typeof payload !== 'object') {
    return sendOpenAiError(res, 400, '请求体必须是 JSON 对象', { type: 'invalid_request_error' })
  }
  const key = ctx.authKey
  const model = String(payload.model || '').trim() || catalog.models.find((item) => /image/i.test(item.id))?.id || ''
  if (!model) {
    return sendOpenAiError(res, 503, '未指定生图模型', { type: 'service_unavailable' })
  }
  if (key?.allowedModels?.length && !key.allowedModels.includes(model) && !key.allowedModels.includes('*')) {
    return sendOpenAiError(res, 403, `当前密钥不允许使用模型 ${model}`, { type: 'permission_error' })
  }

  const upstreamBody = {
    model,
    prompt: payload.prompt,
    n: payload.n ?? 1,
    size: payload.size,
    response_format: payload.response_format || 'url',
    ...(payload.images ? { images: payload.images } : {}),
    ...(payload.image ? { images: [payload.image] } : {}),
  }
  for (const field of Object.keys(upstreamBody)) {
    if (upstreamBody[field] === undefined) delete upstreamBody[field]
  }

  const chatId = `lpy-img-${crypto.randomUUID()}`
  try {
    const result = await withAccountFailover({
      scheduler,
      affinityKey: '',
      maxRetries: config.pool.maxRetries,
      execute: (account) => upstream.fetch(account, '/images/generations', {
        method: 'POST',
        body: upstreamBody,
        headers: upstream.headers(account, { stream: false, purpose: 'image.generate', chatId }),
        signal: ctx.abortSignal,
        timeoutMs: 300000,
      }),
      inspect: async (response) => {
        const parsed = await tapJson(response)
        if (!parsed) return { code: `HTTP_${response.status}`, message: '上游返回无法解析的响应', authInvalid: false }
        if (parsed.envelope) return parsed.envelope
        if (!response.ok) return { code: `HTTP_${response.status}`, message: describeErrorBody(parsed), authInvalid: false }
        return null
      },
    })
    const parsed = readCachedJson(result.response) || await tapJson(result.response)
    const json = parsed?.json || {}
    const usageInfo = extractUsage(json.usage)
    ctx.finishRequest({
      account: result.account,
      key,
      model,
      endpoint: '/v1/images/generations',
      stream: false,
      usage: usageInfo,
      latencyMs: Date.now() - started,
      chatId,
      status: 'ok',
    })
    sendJson(res, 200, {
      created: json.created || Math.floor(Date.now() / 1000),
      data: Array.isArray(json.data) ? json.data : [],
      ...(usageInfo.points ? { usage: { points_consumed: usageInfo.points } } : {}),
    }, { 'x-loomy-account': result.account.id, 'x-loomy-model': model })
  } catch (error) {
    const status = mapErrorStatus(error.lastError)
    logger.error('生图请求失败', { model, message: error.message })
    usage.record({
      endpoint: '/v1/images/generations',
      model,
      keyId: key?.id || '',
      status: 'error',
      errorCode: error.lastError?.code || 'upstream_error',
      latencyMs: Date.now() - started,
      chatId,
    })
    sendOpenAiError(res, status, error.message, { type: 'upstream_error', code: error.lastError?.code })
  }
}

export function handleUnsupported (name) {
  return (ctx, req, res) => {
    sendOpenAiError(res, 501, `Loomy 上游不提供 /v1/${name} 接口`, {
      type: 'invalid_request_error',
      code: 'not_implemented',
    })
  }
}

/** SSE 转发：透传字节，同时把最后一个 usage 抓出来（见 upstream/client.js relaySse）。 */
async function relayStream (ctx, upstreamResponse, res) {
  const { relaySse } = await import('../upstream/client.js')
  return relaySse(upstreamResponse, res)
}

export function mapErrorStatus (error) {
  if (!error) return 502
  if (error.authInvalid) return 401
  const code = String(error.code || '')
  if (code === '429' || code === '100429') return 429
  if (/^HTTP_5/.test(code)) return 502
  if (code === 'NETWORK' || code === 'TIMEOUT') return 504
  if (/^HTTP_4/.test(code)) return 400
  return 502
}
