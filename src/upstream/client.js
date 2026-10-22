/**
 * Loomy 上游客户端。
 *
 * 逆向依据（electron/llm/llm-completion.js、electron/utils/request-headers.js、
 * electron/utils/app-version.js、electron/image/image-generation-service.js）：
 *
 *   baseURL   = <points base>/api/v1        （生产 https://loomyad.xunfei.cn/api/v1）
 *   鉴权      = Authorization: Bearer <session>（客户端同时附带 token 头）
 *   追踪      = traceparent: 00-<32hex>-<16hex>-01、ChatId / MsgId / TurnId
 *   版本      = loomy-version: <客户端版本>
 *   用途      = X-Loomy-Request-Purpose: chat.message 等 17 个协议值
 *
 * 端点：GET /models、POST /chat/completions、POST /messages（Anthropic）、
 *       POST /images/generations。/completions 与 /embeddings 上游 404。
 *
 * 关键坑：上游业务错误也用 HTTP 200 返回，body 形如
 *   {"code":"100002","desc":"登录已失效，请重新登录","trace_id":"..."}
 * 因此判断成功与否必须解析 body.code，不能只看 status。
 */

import crypto from 'node:crypto'

export const AUTH_INVALID_CODES = new Set(['020002', '100002'])
export const PROTOCOL_PURPOSES = new Set([
  'chat.message', 'chat.title', 'pet.comment', 'pet.reward', 'kb.vision', 'kb.audio',
  'kb.summary', 'kb.embed', 'search.web', 'image.generate', 'assistant.completion',
  'assistant.asr-correct', 'memory.extract', 'memory.recall', 'memory.dream',
  'skill.evolution', 'skill.curator',
])

function randomHex (bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

export function generateTraceparent () {
  return `00-${randomHex(16)}-${randomHex(8)}-01`
}

export function normalizePurpose (value, fallback = '') {
  const text = String(value || '').trim()
  return PROTOCOL_PURPOSES.has(text) ? text : fallback
}

/**
 * 生成上游请求头。追踪头默认开启：客户端注释里提到缺 traceparent 时
 * 某些模型的上游会挂到超时，带上没有代价。
 */
export function buildUpstreamHeaders (account, {
  stream = false,
  purpose = '',
  chatId = '',
  msgId = '',
  turnId = '',
  anthropic = false,
  clientVersion = '',
  sendTraceparent = true,
  sendTrackingHeaders = true,
  extra = {},
} = {}) {
  const session = String(account?.session || '').trim()
  const headers = {
    Accept: stream ? 'text/event-stream' : 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session}`,
    // 客户端两条都发；上游只认 Authorization，但保留 token 头可减少行为差异
    token: session,
  }
  if (clientVersion) headers['loomy-version'] = clientVersion
  if (anthropic) headers['anthropic-version'] = '2023-06-01'
  if (sendTraceparent) headers.traceparent = generateTraceparent()
  if (sendTrackingHeaders) {
    if (chatId) headers.ChatId = chatId
    if (msgId) headers.MsgId = msgId
    if (turnId) headers.TurnId = turnId
    const normalizedPurpose = normalizePurpose(purpose)
    if (normalizedPurpose) headers['X-Loomy-Request-Purpose'] = normalizedPurpose
  }
  return { ...headers, ...extra }
}

/** 解析上游业务错误信封；不是错误返回 null。 */
export function parseErrorEnvelope (payload) {
  if (!payload || typeof payload !== 'object') return null
  const code = String(payload.code || '').trim()
  if (!code || code === '000000') return null
  const message = String(payload.desc || payload.message || payload.error?.message || `上游返回错误 ${code}`)
  return {
    code,
    message,
    authInvalid: AUTH_INVALID_CODES.has(code),
    traceId: String(payload.trace_id || ''),
  }
}

export class LoomyUpstream {
  constructor ({ baseUrl, clientVersion = '', timeoutMs = 600000, sendTraceparent = true, sendTrackingHeaders = true, requestPurpose = 'chat.message', logger = null }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.clientVersion = clientVersion
    this.timeoutMs = timeoutMs
    this.sendTraceparent = sendTraceparent
    this.sendTrackingHeaders = sendTrackingHeaders
    this.requestPurpose = requestPurpose
    this.logger = logger
  }

  resolveUrl (path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  headers (account, options = {}) {
    return buildUpstreamHeaders(account, {
      clientVersion: this.clientVersion,
      sendTraceparent: this.sendTraceparent,
      sendTrackingHeaders: this.sendTrackingHeaders,
      purpose: options.purpose || this.requestPurpose,
      ...options,
    })
  }

  /** 直连上游，返回原生 Response（调用方决定怎么消费）。 */
  async fetch (account, path, { method = 'POST', body = null, headers = {}, signal = null, timeoutMs = 0 } = {}) {
    const url = this.resolveUrl(path)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs || this.timeoutMs)
    const onAbort = () => controller.abort(new Error('client aborted'))
    if (signal) {
      if (signal.aborted) controller.abort(new Error('client aborted'))
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...this.headers(account, typeof headers.__options === 'object' ? headers.__options : {}),
          ...stripOptions(headers),
        },
        body: method === 'GET' || method === 'HEAD' ? undefined : (typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined),
        signal: controller.signal,
      })
      response.__cleanup = () => {
        clearTimeout(timeout)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      return response
    } catch (error) {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', onAbort)
      throw error
    }
  }

  async fetchModels (account, { headers = {} } = {}) {
    const response = await this.fetch(account, '/models', { method: 'GET', headers })
    const text = await response.text()
    let payload = null
    try { payload = text ? JSON.parse(text) : null } catch { payload = null }
    const envelopeError = parseErrorEnvelope(payload)
    if (envelopeError) return { ok: false, error: envelopeError, status: response.status }
    if (!response.ok) {
      return { ok: false, error: { code: `HTTP_${response.status}`, message: text.slice(0, 300), authInvalid: false }, status: response.status }
    }
    const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
    return {
      ok: true,
      models: data,
      meta: {
        reasoningEnabled: payload?.reasoning_enabled,
        reasoningCatalogVersion: payload?.reasoning_catalog_version,
      },
    }
  }

  /** 积分余额（管理台展示用）。GET <base>/../v2/points/records */
  async fetchPoints (session, { limit = 5 } = {}) {
    const base = this.baseUrl.replace(/\/api\/v1$/, '')
    const url = `${base}/api/v2/points/records?pageSize=${encodeURIComponent(limit)}`
    const response = await fetch(url, {
      headers: { token: String(session || ''), Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    })
    const payload = await response.json().catch(() => null)
    const envelopeError = parseErrorEnvelope(payload)
    if (envelopeError) return { ok: false, error: envelopeError }
    return { ok: true, data: payload?.data || null }
  }
}

function stripOptions (headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (key === '__options') continue
    out[key] = value
  }
  return out
}

/**
 * 把上游 SSE 原样转发给下游，同时抽取 usage（含 points_consumed）。
 * 返回 { usage, sample, bytes }，任何解析失败都不影响转发。
 */
export function relaySse (upstreamResponse, res, { onEvent = null } = {}) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder()
    let buffer = ''
    let bytes = 0
    let usage = null
    let lastModel = ''
    let finished = false

    const handleLine = (line) => {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') return
      let event
      try { event = JSON.parse(data) } catch { return }
      if (!event || typeof event !== 'object') return
      if (event.usage && typeof event.usage === 'object') usage = event.usage
      if (event.message?.usage && typeof event.message.usage === 'object') usage = event.message.usage
      if (event.model) lastModel = String(event.model)
      if (typeof onEvent === 'function') {
        try { onEvent(event) } catch { /* 业务回调异常不能影响转发 */ }
      }
    }

    res.on('close', () => { finished = true })
    const finish = () => {
      if (finished) return
      finished = true
      resolve({ usage, model: lastModel, bytes })
    }

    ;(async () => {
      try {
        for await (const chunk of upstreamResponse.body) {
          // fetch 给的是 Uint8Array；测试/其它实现可能直接给字符串，两种都支持
          const isString = typeof chunk === 'string'
          const text = isString ? chunk : decoder.decode(chunk, { stream: true })
          bytes += isString ? Buffer.byteLength(chunk) : chunk.length
          buffer += text
          let index = -1
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            handleLine(line)
          }
          if (!res.write(chunk)) {
            await new Promise((resolveDrain) => res.once('drain', resolveDrain))
          }
        }
        if (buffer) handleLine(buffer)
        res.end()
        finish()
      } catch (error) {
        res.end()
        if (finished) return
        finished = true
        reject(error)
      }
    })()
  })
}
