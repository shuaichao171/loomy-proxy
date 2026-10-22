/**
 * 管理 API + 内嵌管理台。
 *
 * 鉴权模型：
 *   - 配置了 server.adminPassword → 登录换 HttpOnly Cookie（HMAC 签名，24h 有效）
 *   - 未配置密码 → 仅允许 127.0.0.1 访问（首跑开箱可用，但依旧不对外暴露）
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLoopback, parseCookies, readBody, sendJson, sendText, setCookie } from '../util/http.js'
import { loomyUserDataDir, readLocalAuthSession, readLocalUpstreamBase } from '../auth/local-session.js'
import { maskPhone, maskSession } from '../core/accounts.js'
import { LoginError } from '../auth/login-flow.js'
import { ROOT_DIR } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_HTML_PATH = path.resolve(__dirname, '..', 'ui', 'admin.html')
const COOKIE_NAME = 'loomy_proxy_admin'
const TOKEN_TTL_MS = 24 * 3600 * 1000

function signToken (password, expiresAt) {
  const payload = `v1.${expiresAt}`
  const signature = crypto.createHmac('sha256', `loomy-proxy::${password}`).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function verifyToken (password, token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return false
  const [, expiresRaw, signature] = parts
  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
  const expected = crypto.createHmac('sha256', `loomy-proxy::${password}`).update(`v1.${expiresAt}`).digest('base64url')
  if (signature.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

export function isAdminAuthorized (ctx, req) {
  const password = String(ctx.config.server.adminPassword || '')
  if (!password) return isLoopback(req)
  const cookies = parseCookies(req)
  if (verifyToken(password, cookies[COOKIE_NAME])) return true
  const header = String(req.headers.authorization || '')
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (match && match[1] === password) return true
  return false
}

function requireAdmin (ctx, req, res) {
  if (isAdminAuthorized(ctx, req)) return true
  sendJson(res, 401, { error: '未授权：请先在 /admin 登录' })
  return false
}

export function serveAdminUi (ctx, req, res) {
  try {
    const html = fs.readFileSync(ADMIN_HTML_PATH, 'utf8')
    sendText(res, 200, html, 'text/html; charset=utf-8')
  } catch (error) {
    sendText(res, 500, `管理台文件缺失: ${error.message}`)
  }
}

export async function handleAdmin (ctx, req, res, url) {
  const route = url.pathname.replace(/^\/admin\/api\/?/, '')
  const method = req.method.toUpperCase()

  // 登录相关不要求已授权（但要求有密码配置）
  if (route === 'session' && method === 'POST') {
    const password = String(ctx.config.server.adminPassword || '')
    if (!password) {
      if (!isLoopback(req)) return sendJson(res, 403, { error: '未配置管理密码，仅允许本机访问' })
      return sendJson(res, 200, { ok: true, mode: 'local-open' })
    }
    const { json } = await readBody(req)
    if (String(json?.password || '') !== password) {
      return sendJson(res, 401, { error: '密码错误' })
    }
    const expiresAt = Date.now() + TOKEN_TTL_MS
    setCookie(res, COOKIE_NAME, signToken(password, expiresAt), { maxAge: TOKEN_TTL_MS / 1000 })
    return sendJson(res, 200, { ok: true, expiresAt })
  }

  if (!requireAdmin(ctx, req, res)) return

  if (route === 'logout' && method === 'POST') {
    setCookie(res, COOKIE_NAME, '', { maxAge: 1 })
    return sendJson(res, 200, { ok: true })
  }

  if (route === 'overview' && method === 'GET') {
    return sendJson(res, 200, buildOverview(ctx))
  }

  if (route === 'config' && method === 'GET') {
    return sendJson(res, 200, sanitizeConfig(ctx.config))
  }

  if (route === 'config' && method === 'PUT') {
    const { json } = await readBody(req)
    const next = mergeEditableConfig(ctx.config, json)
    ctx.applyConfig(next)
    return sendJson(res, 200, { ok: true, config: sanitizeConfig(ctx.config) })
  }

  // ---- 账号 ----
  if (route === 'accounts' && method === 'GET') {
    return sendJson(res, 200, {
      accounts: ctx.accountStore.publicList(),
      summary: ctx.accountStore.summary(),
      upstreamBase: ctx.config.upstream.baseUrl,
      localSession: localSessionStatus(),
    })
  }

  if (route === 'accounts' && method === 'POST') {
    const { json } = await readBody(req)
    const session = String(json?.session || '').trim()
    if (!session) return sendJson(res, 400, { error: 'session 不能为空' })
    const result = ctx.accountStore.add({
      name: String(json?.name || '').trim(),
      session,
      userid: String(json?.userid || '').trim(),
      phone: String(json?.phone || '').trim(),
      nickname: String(json?.nickname || '').trim(),
      weight: Number(json?.weight) || 1,
    })
    if (result.created) await checkAccount(ctx, result.account.id, { silent: true })
    return sendJson(res, 200, {
      ok: result.created,
      duplicate: result.created ? undefined : true,
      account: ctx.accountStore.toPublic(result.account),
    })
  }

  const accountMatch = route.match(/^accounts\/([^/]+)(?:\/(\w+))?$/)
  if (accountMatch) {
    const [, id, action] = accountMatch
    if (method === 'PATCH' && !action) {
      const { json } = await readBody(req)
      const updated = ctx.accountStore.update(id, json || {})
      if (!updated) return sendJson(res, 404, { error: '账号不存在' })
      return sendJson(res, 200, { ok: true, account: ctx.accountStore.toPublic(updated) })
    }
    if (method === 'DELETE' && !action) {
      const ok = ctx.accountStore.remove(id)
      return sendJson(res, ok ? 200 : 404, { ok })
    }
    if (method === 'POST' && action === 'check') {
      const result = await checkAccount(ctx, id, { silent: false })
      return sendJson(res, result.ok ? 200 : 400, result)
    }
    if (method === 'POST' && action === 'points') {
      const account = ctx.accountStore.get(id)
      if (!account) return sendJson(res, 404, { error: '账号不存在' })
      const points = await ctx.upstream.fetchPoints(account.session).catch((error) => ({ ok: false, error: { message: error.message } }))
      return sendJson(res, 200, points)
    }
  }

  if (route === 'accounts/import-local' && method === 'POST') {
    const local = readLocalAuthSession()
    if (!local.found || !local.session) {
      return sendJson(res, 400, {
        error: '未在本机找到 Loomy 登录态',
        searched: local.file,
      })
    }
    const existing = ctx.accountStore.list().find((account) => account.session === local.session.session)
    if (existing) {
      return sendJson(res, 200, { ok: true, duplicate: true, account: ctx.accountStore.toPublic(existing) })
    }
    const result = ctx.accountStore.add({
      name: '本机导入',
      session: local.session.session,
      userid: local.session.userid,
      phone: local.session.phone,
      weight: 1,
    })
    const checked = await checkAccount(ctx, result.account.id, { silent: true })
    return sendJson(res, 200, { ok: true, account: ctx.accountStore.toPublic(result.account), check: checked })
  }

  // ---- 手机号 + 短信验证码登录 ----
  //
  // 三步流程（服务端保管 pending，客户端只拿 loginId）：
  //   POST login/send-code {phone}            → {loginId, phoneMasked, expiresInSeconds, resendAfterSeconds}
  //   POST login/verify    {loginId, code}    → {account, created, profile, after}
  //   POST login/resend    {loginId}          → 同上（重新发码，受冷却约束）
  // 兼容旧形态：login/verify 传 {phone, code, msgid} 时走 verifyWithMsgid。

  if (route === 'login/send-code' && method === 'POST') {
    const { json } = await readBody(req)
    try {
      const view = await ctx.loginFlow.start(json?.phone, {
        ip: clientIp(req, ctx),
        name: json?.name,
      })
      return sendJson(res, 200, { ok: true, ...view })
    } catch (error) {
      return sendLoginError(res, error)
    }
  }

  if (route === 'login/resend' && method === 'POST') {
    const { json } = await readBody(req)
    try {
      const view = await ctx.loginFlow.resend(json?.loginId, { ip: clientIp(req, ctx) })
      return sendJson(res, 200, { ok: true, ...view })
    } catch (error) {
      return sendLoginError(res, error)
    }
  }

  if (route === 'login/verify' && method === 'POST') {
    const { json } = await readBody(req)
    const loginId = String(json?.loginId || '').trim()
    try {
      const result = loginId
        ? await ctx.loginFlow.verify(loginId, json?.code, { ip: clientIp(req, ctx), name: json?.name })
        : await ctx.loginFlow.verifyWithMsgid(
          { phone: json?.phone, code: json?.code, msgid: json?.msgid },
          { ip: clientIp(req, ctx), name: json?.name },
        )
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      return sendLoginError(res, error)
    }
  }

  if (route === 'login/status' && method === 'GET') {
    const view = ctx.loginFlow.status(url.searchParams.get('loginId') || '')
    if (!view) return sendJson(res, 404, { error: '登录流程不存在或已过期' })
    return sendJson(res, 200, { ok: true, ...view })
  }

  if (route === 'login/cancel' && method === 'POST') {
    const { json } = await readBody(req)
    try {
      return sendJson(res, 200, { ...ctx.loginFlow.cancel(json?.loginId, { ip: clientIp(req, ctx) }) })
    } catch (error) {
      return sendLoginError(res, error)
    }
  }

  // ---- 下游密钥 ----
  if (route === 'keys' && method === 'GET') {
    return sendJson(res, 200, { keys: ctx.keyStore.publicList() })
  }
  if (route === 'keys' && method === 'POST') {
    const { json } = await readBody(req)
    const { key, plaintext } = ctx.keyStore.create({
      name: String(json?.name || ''),
      allowedModels: Array.isArray(json?.allowedModels) ? json.allowedModels : [],
      rpm: Number(json?.rpm) || 0,
    })
    return sendJson(res, 200, { ok: true, key: { ...ctx.keyStore.publicList().find((item) => item.id === key.id) }, plaintext })
  }
  const keyMatch = route.match(/^keys\/([^/]+)$/)
  if (keyMatch) {
    const [, id] = keyMatch
    if (method === 'PATCH') {
      const { json } = await readBody(req)
      const updated = ctx.keyStore.update(id, json || {})
      return sendJson(res, updated ? 200 : 404, { ok: Boolean(updated) })
    }
    if (method === 'DELETE') {
      return sendJson(res, 200, { ok: ctx.keyStore.remove(id) })
    }
  }

  // ---- 模型 ----
  if (route === 'models' && method === 'GET') {
    return sendJson(res, 200, {
      fetchedAt: ctx.catalog.fetchedAt,
      meta: ctx.catalog.meta,
      models: ctx.catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        protocol: model.protocol,
        contextLength: model.contextLength,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: model.capabilities,
        isDefaultModel: model.isDefaultModel,
        isDefaultSmallModel: model.isDefaultSmallModel,
      })),
    })
  }
  if (route === 'models/refresh' && method === 'POST') {
    const result = await ctx.refreshModels({ silent: false })
    return sendJson(res, result.ok ? 200 : 400, result)
  }

  // ---- 观测 ----
  if (route === 'usage' && method === 'GET') {
    const days = Number(url.searchParams.get('days')) || 7
    return sendJson(res, 200, ctx.usage.summary({ days }))
  }
  if (route === 'logs' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 100
    return sendJson(res, 200, { logs: ctx.logger.list(limit), requests: ctx.usage.list({ limit }) })
  }
  if (route === 'health' && method === 'GET') {
    return sendJson(res, 200, buildOverview(ctx))
  }

  return sendJson(res, 404, { error: `未知管理接口: ${route}` })
}

/** 取客户端 IP：只有显式信任反代头时才用 X-Forwarded-For，避免伪造。 */
function clientIp (req, ctx) {
  if (ctx?.config?.server?.trustProxyHeaders) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (forwarded) return forwarded
  }
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
}

/** 登录类错误统一出口：带 code / retryAfter 等结构化信息。 */
function sendLoginError (res, error) {
  const status = error instanceof LoginError ? error.status : 400
  return sendJson(res, status, {
    error: error.message,
    code: error.code || 'LOGIN_ERROR',
    ...(error.details || {}),
  })
}

async function checkAccount (ctx, id, { silent = false } = {}) {
  const account = ctx.accountStore.get(id)
  if (!account) return { ok: false, error: '账号不存在' }
  if (!ctx.accountClient?.ready) return { ok: false, error: '未配置讯飞账号签名凭据，无法校验' }
  try {
    const profile = await ctx.accountClient.getUserInfo(account.session)
    ctx.accountStore.markChecked(id, { ok: true, profile: { userid: profile?.userid, phone: profile?.phone, nickname: profile?.nickname } })
    if (!silent) ctx.logger.info('账号校验通过', { id })
    return { ok: true, profile: { userid: profile?.userid, phone: maskPhone(profile?.phone), nickname: profile?.nickname } }
  } catch (error) {
    ctx.accountStore.markChecked(id, { ok: false, error: error.message })
    return { ok: false, error: error.message, code: error.code }
  }
}

function localSessionStatus () {
  const local = readLocalAuthSession()
  const upstream = readLocalUpstreamBase()
  return {
    userDataDir: loomyUserDataDir(),
    file: local.file,
    found: local.found,
    maskedSession: local.session ? maskSession(local.session.session) : '',
    updatedAt: local.session?.updatedAt || 0,
    clientUpstreamBase: upstream.baseUrl,
    clientUpstreamSource: upstream.source,
  }
}

function buildOverview (ctx) {
  return {
    version: ctx.version,
    uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
    upstream: {
      baseUrl: ctx.config.upstream.baseUrl,
      clientVersion: ctx.config.upstream.clientVersion,
      requestPurpose: ctx.config.upstream.requestPurpose,
    },
    accounts: ctx.accountStore.summary(),
    scheduler: ctx.scheduler.summary(),
    keys: {
      total: ctx.keyStore.keys.length,
      enabled: ctx.keyStore.countEnabled(),
    },
    models: {
      count: ctx.catalog.models.length,
      fetchedAt: ctx.catalog.fetchedAt,
      defaultModel: ctx.catalog.pickDefault('openai'),
      defaultAnthropicModel: ctx.catalog.pickDefault('anthropic'),
    },
    usage: ctx.usage.summary({ days: 1 }),
    localSession: localSessionStatus(),
    generatedAt: Date.now(),
  }
}

const EDITABLE_SECTIONS = ['upstream', 'pool', 'limits', 'logging']

function mergeEditableConfig (config, patch) {
  const next = JSON.parse(JSON.stringify(config))
  for (const section of EDITABLE_SECTIONS) {
    if (patch?.[section] && typeof patch[section] === 'object') {
      next[section] = { ...next[section], ...patch[section] }
    }
  }
  return next
}

function sanitizeConfig (config) {
  const clone = JSON.parse(JSON.stringify(config))
  if (clone.server) clone.server.adminPassword = clone.server.adminPassword ? '******' : ''
  return clone
}

export { ADMIN_HTML_PATH, ROOT_DIR }
