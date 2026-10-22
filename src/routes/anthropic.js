/**
 * Anthropic 兼容入口：POST /v1/messages。
 *
 * Loomy 上游对 anthropic_messages 协议的模型提供原生 /messages（实测 spark-x 可用，
 * 支持 stream 与 thinking 块），因此这里是「协议同构透传」，不做格式转换，
 * 只补齐 max_tokens 默认值、模型解析与账号容错。
 */

import crypto from 'node:crypto'
import { readBody, sendJson, sendOpenAiError } from '../util/http.js'
import { createAnthropicUsageCollector, describeErrorBody, extractUsage, isEventStream, readCachedJson, tapJson } from './shared.js'
import { withAccountFailover, UpstreamExhaustedError } from '../core/executor.js'
import { mapErrorStatus } from './openai.js'

export async function handleMessages (ctx, req, res) {
  const { config, logger, upstream, scheduler, usage, catalog } = ctx
  const started = Date.now()
  const { json: payload } = await readBody(req, { maxBytes: config.limits.maxBodyBytes })
  if (!payload || typeof payload !== 'object') {
    return sendOpenAiError(res, 400, '请求体必须是 JSON 对象', { type: 'invalid_request_error', anthropic: true })
  }

  const key = ctx.authKey
  const isStream = payload.stream === true
  const requested = String(payload.model || '').trim()
  const anthropicModel = catalog.models.find((model) => model.protocol === 'anthropic')
  const model = requested || catalog.pickDefault('anthropic') || anthropicModel?.id || catalog.pickDefault()
  if (!model) {
    return sendOpenAiError(res, 503, '模型目录为空：请先在管理台刷新模型列表', { type: 'api_error', anthropic: true })
  }

  const chatId = `lpy-ant-${crypto.randomUUID()}`
  const upstreamBody = { ...payload, model, stream: isStream }
  if (upstreamBody.max_tokens === undefined) upstreamBody.max_tokens = 4096

  let result
  try {
    result = await withAccountFailover({
      scheduler,
      affinityKey: String(payload.metadata?.user_id || chatId),
      maxRetries: config.pool.maxRetries,
      execute: (account) => upstream.fetch(account, '/messages', {
        method: 'POST',
        body: upstreamBody,
        headers: upstream.headers(account, {
          stream: isStream,
          anthropic: true,
          purpose: config.upstream.requestPurpose || 'chat.message',
          chatId,
        }),
        signal: ctx.abortSignal,
      }),
      inspect: async (response) => {
        if (isEventStream(response)) return null
        const parsed = await tapJson(response)
        if (!parsed) return { code: `HTTP_${response.status}`, message: '上游返回无法解析的响应', authInvalid: false }
        if (parsed.envelope) return parsed.envelope
        if (!response.ok) return { code: `HTTP_${response.status}`, message: describeErrorBody(parsed), authInvalid: false }
        return null
      },
    })
  } catch (error) {
    const status = error instanceof UpstreamExhaustedError ? mapErrorStatus(error.lastError) : 502
    logger.error('Anthropic 消息请求失败', { model, message: error.message })
    usage.record({
      endpoint: '/v1/messages',
      model,
      keyId: key?.id || '',
      status: 'error',
      errorCode: error.lastError?.code || 'upstream_error',
      stream: isStream,
      latencyMs: Date.now() - started,
      chatId,
    })
    return sendOpenAiError(res, status, error.message, {
      type: error.lastError?.authInvalid ? 'authentication_error' : 'api_error',
      anthropic: true,
    })
  }

  const account = result.account
  const response = result.response

  if (!isEventStream(response)) {
    const parsed = readCachedJson(response) || await tapJson(response)
    const json = parsed?.json || {}
    const usageInfo = extractUsage(json.usage)
    ctx.finishRequest({
      account,
      key,
      model: json.model || model,
      endpoint: '/v1/messages',
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
    res.end(parsed?.raw ?? JSON.stringify(json))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-loomy-account': account.id,
    'x-loomy-model': model,
  })

  const collector = createAnthropicUsageCollector()
  try {
    const { relaySse } = await import('../upstream/client.js')
    const relayed = await relaySse(response, res, { onEvent: (event) => collector.observe(event) })
    const snapshot = collector.snapshot()
    const usageInfo = snapshot.points || snapshot.promptTokens || snapshot.completionTokens
      ? { ...snapshot, points: snapshot.points }
      : extractUsage(relayed.usage)
    ctx.finishRequest({
      account,
      key,
      model: snapshot.model || relayed.model || model,
      endpoint: '/v1/messages',
      stream: true,
      usage: usageInfo,
      latencyMs: Date.now() - started,
      chatId,
      status: 'ok',
    })
  } catch (error) {
    logger.warn('Anthropic 流式转发中断', { model, error: error.message })
    usage.record({
      endpoint: '/v1/messages',
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

export function handleCountTokens (ctx, req, res) {
  // Anthropic 客户端会用 count_tokens 预估成本；上游没有该接口，这里给一个粗略估算。
  sendJson(res, 200, { input_tokens: 0, note: 'loomy-proxy: 上游未提供 count_tokens，按 0 返回' })
}
