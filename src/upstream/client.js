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

/** 连接/首字节超时（自建），用于区分「连不上」与「上游业务失败」。 */
export const CONNECT_TIMEOUT_CODE = 'UPSTREAM_CONNECT_TIMEOUT'

const CONNECT_FAILURE_CODES = new Set([
  CONNECT_TIMEOUT_CODE,
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND',
])

export function errorCode (error) {
  return String(error?.code || error?.cause?.code || '').trim()
}

/** 是否属于连接层失败（一个字节响应都还没拿到，可安全重试）。 */
export function isConnectFailure (error) {
  return CONNECT_FAILURE_CODES.has(errorCode(error))
}

export class LoomyUpstream {
  constructor ({ baseUrl, clientVersion = '', timeoutMs = 600000, connectTimeoutMs = 8000, connectRetries = 1, sendTraceparent = true, sendTrackingHeaders = true, requestPurpose = 'chat.message', logger = null }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.clientVersion = clientVersion
    this.timeoutMs = timeoutMs
    this.sendTraceparent = sendTraceparent
    this.sendTrackingHeaders = sendTrackingHeaders
    this.requestPurpose = requestPurpose
    this.logger = logger
    this.connectTimeoutMs = Math.max(1000, Number(connectTimeoutMs) || 8000)
    this.connectRetries = Math.max(0, Math.min(3, Number(connectRetries) || 0))
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
  /** 直连上游，返回原生 Response（调用方决定怎么消费）。 */
  async fetch (account, path, { method = 'POST', body = null, headers = {}, signal = null, timeoutMs = 0 } = {}) {
    const url = this.resolveUrl(path)
    const payload = method === 'GET' || method === 'HEAD'
      ? undefined
      : (typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined)
    const requestHeaders = {
      ...this.headers(account, typeof headers.__options === 'object' ? headers.__options : {}),
      ...stripOptions(headers),
    }
    return this.requestWithConnectRetry(path, () => this.requestOnce(url, { method, headers: requestHeaders, body: payload }, { signal, timeoutMs }), signal)
  }

  /**
   * 单次请求。
   *
   * 这里刻意不用 `AbortSignal.timeout(整体超时)` 一把梭：上游偶尔会出现
   * 「TCP 握手成功、TLS/首字节迟迟不回」的边缘节点故障，undici 的默认
   * connectTimeout 是 10s，且因为 TCP 已算连通不会切到另一个 A 记录地址，
   * 于是一次抖动就吃掉整个请求。所以拆成两段：首字节用 connectTimeoutMs
   * 快速失败（可重连重试），拿到响应头之后才交给 timeoutMs 管流式 body。
   */
  async requestOnce (url, options, { signal = null, timeoutMs = 0 } = {}) {
    const controller = new AbortController()
    const totalTimer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs || this.timeoutMs)
    totalTimer.unref?.()
    let connectTimedOut = false
    const connectTimer = setTimeout(() => {
      connectTimedOut = true
      controller.abort(new Error('upstream connect timeout'))
    }, this.connectTimeoutMs)
    connectTimer.unref?.()
    const onAbort = () => controller.abort(new Error('client aborted'))
    if (signal) {
      if (signal.aborted) controller.abort(new Error('client aborted'))
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanup = () => {
      clearTimeout(totalTimer)
      clearTimeout(connectTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(connectTimer)
      response.__cleanup = cleanup
      return response
    } catch (error) {
      cleanup()
      if (connectTimedOut) {
        const timeoutError = new Error(`上游 ${Math.round(this.connectTimeoutMs / 1000)}s 内未返回响应（连接层卡住，已放弃本次尝试）`)
        timeoutError.code = CONNECT_TIMEOUT_CODE
        throw timeoutError
      }
      throw error
    }
  }

  /** 连接层失败（还没拿到响应头）时立即重连重试；已经开始读流的请求绝不重试。 */
  async requestWithConnectRetry (label, run, signal = null) {
    const attempts = this.connectRetries + 1
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await run()
      } catch (error) {
        lastError = error
        if (attempt >= attempts || signal?.aborted || !isConnectFailure(error)) throw error
        this.logger?.warn?.('上游连接失败，立即重连重试', { label, attempt, code: errorCode(error) })
        await new Promise((resolve) => setTimeout(resolve, 120 * attempt))
      }
    }
    throw lastError
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
    const response = await this.requestWithConnectRetry('fetchPoints', () => this.requestOnce(url, {
      headers: { token: String(session || ''), Accept: 'application/json' },
    }, { timeoutMs: 20000 }))
    const payload = await response.json().catch(() => null)
    const envelopeError = parseErrorEnvelope(payload)
    if (envelopeError) return { ok: false, error: envelopeError }
    return { ok: true, data: payload?.data || null }
  }

  /**
   * 新手任务（客户端入口文案「做任务赢积分好礼」）快照。
   *
   * GET <pointsBase>/api/v1/onboarding/tasks → data{tasks{key:bool}, earned, total}
   * 共 8 条一次性任务，全部完成合计 10000 永久积分。
   *
   * @param {string} session 账号 session
   * @returns {Promise<{ok: boolean, data?: object|null, error?: string}>}
   */
  async fetchOnboardingTasks (session) {
    return this.#pointsApi('/api/v1/onboarding/tasks', { session })
  }

  /**
   * 完成一条新手任务（服务端权威记账，重复调用返回 alreadyCompleted）。
   *
   * POST <pointsBase>/api/v1/onboarding/tasks/complete body{key} → data{alreadyCompleted, balance}
   *
   * @param {string} session 账号 session
   * @param {string} key 任务 key（first_message / pick_skill / generate_ppt / set_schedule /
   *   install_skill / configure_remote / create_soul / share_soul）
   */
  async completeOnboardingTask (session, key) {
    return this.#pointsApi('/api/v1/onboarding/tasks/complete', { session, method: 'POST', body: { key } })
  }

  /**
   * 邀请码激活状态。GET <pointsBase>/api/v1/points/activation → data{activated, appliedInvitationCode}
   */
  async fetchActivation (session) {
    return this.#pointsApi('/api/v1/points/activation', { session })
  }

  /**
   * 绑定邀请码兑换积分（每个账号只能绑一次）。
   *
   * POST <pointsBase>/api/v1/points/activation body{inviteCode}
   * → data{inviteeReward, inviterReward, permanentBalance, dailyBalance, registerReward, ...}
   *
   * 注意：填码方拿 inviteeReward(5000)，码主拿 inviterReward(5000)；从未领过注册奖励的账号
   * 还会顺带补发 registerReward(5000)。
   */
  async bindInviteCode (session, inviteCode) {
    return this.#pointsApi('/api/v1/points/activation', { session, method: 'POST', body: { inviteCode } })
  }

  /**
   * 邀请码列表。GET <pointsBase>/api/v1/invitation-codes
   * → data{list[{inviteCode, usedCount, maxUses, status}]}
   *
   * 每个账号一个 6 位码（status=active、maxUses 1000）；绑定过邀请码的账号才会拿到。
   * 池内「摸一个码」给新号填就靠这个接口，见 src/core/bonus.js。
   *
   * @param {string} session 账号 session
   */
  async fetchInvitationCodes (session) {
    return this.#pointsApi('/api/v1/invitation-codes', { session })
  }

  /** points 服务的公共请求器：同一套连接层重连 + envelope 拆包。 */
  async #pointsApi (path, { session, method = 'GET', body = null } = {}) {
    const base = this.baseUrl.replace(/\/api\/v1$/, '')
    const headers = { token: String(session || ''), Accept: 'application/json' }
    if (body !== null) headers['Content-Type'] = 'application/json'
    const response = await this.requestWithConnectRetry(path, () => this.requestOnce(`${base}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    }, { timeoutMs: 20000 }))
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
