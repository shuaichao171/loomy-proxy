/**
 * Loomy 反代网关 —— HTTP 服务主体。
 *
 * 路由总览：
 *   GET  /health                       健康检查（无鉴权，便于反代/容器探针）
 *   GET  /v1/models                    OpenAI 模型列表
 *   POST /v1/chat/completions          OpenAI 对话（流式/非流式）
 *   POST /v1/images/generations        文生图 / 图生图
 *   POST /v1/messages                  Anthropic 协议透传
 *   ANY  /v1/completions|embeddings    明确 501（上游 404）
 *   GET  /admin                        管理台
 *   ANY  /admin/api/*                  管理接口（Cookie / Bearer / 本机免密）
 */

import http from 'node:http'
import path from 'node:path'
import { DATA_DIR, loadConfig, saveConfig } from './config.js'
import { createLogger } from './util/log.js'
import { ensureDataDir } from './config.js'
import { getBearerToken, isLoopback, readBody, sendJson, sendOpenAiError, sendText, setCorsHeaders } from './util/http.js'
import { AccountStore } from './core/accounts.js'
import { ApiKeyStore } from './core/keys.js'
import { UsageLedger } from './core/usage.js'
import { ModelCatalog } from './core/models.js'
import { Scheduler } from './core/scheduler.js'
import { LoomyUpstream } from './upstream/client.js'
import { XfyunAccountClient } from './auth/account.js'
import { LoginFlow } from './auth/login-flow.js'
import { resolveLoomyEnvConfig } from './auth/envfile.js'
import { handleChatCompletions, handleImagesGenerations, handleModels, handleUnsupported } from './routes/openai.js'
import { handleCountTokens, handleMessages } from './routes/anthropic.js'
import { handleAdmin, serveAdminUi } from './routes/admin.js'

export const VERSION = '1.0.0'

export function createContext ({ config = loadConfig(), logger = null, env = process.env } = {}) {
  ensureDataDir()
  const log = logger || createLogger({
    level: config.logging?.level || 'info',
    maxEntries: config.logging?.maxLogEntries || 500,
  })

  const accountStore = new AccountStore({ filePath: path.join(DATA_DIR, 'accounts.json'), logger: log })
  const keyStore = new ApiKeyStore({ filePath: path.join(DATA_DIR, 'keys.json'), logger: log })
  const usage = new UsageLedger({
    filePath: path.join(DATA_DIR, 'usage.jsonl'),
    maxEntries: config.logging?.maxLogEntries || 500,
    logger: log,
  })
  const catalog = new ModelCatalog({ cacheFile: path.join(DATA_DIR, 'models.json'), logger: log })
  const scheduler = new Scheduler({ accountStore, config, logger: log })
  const upstream = new LoomyUpstream({
    baseUrl: config.upstream.baseUrl,
    clientVersion: config.upstream.clientVersion,
    timeoutMs: config.upstream.timeoutMs,
    sendTraceparent: config.upstream.sendTraceparent,
    sendTrackingHeaders: config.upstream.sendTrackingHeaders,
    requestPurpose: config.upstream.requestPurpose,
    logger: log,
  })

  const envConfig = resolveLoomyEnvConfig({
    installDir: config.auth.loomyInstallDir,
    envFile: config.auth.envFile,
  })
  const accountClient = new XfyunAccountClient({
    baseUrl: config.auth.accountBaseUrl || envConfig.accountBaseUrl,
    appId: config.auth.appId || envConfig.appId,
    accessKeyId: envConfig.accessKeyId,
    accessKeySecret: envConfig.accessKeySecret,
  })

  const ctx = {
    version: VERSION,
    startedAt: Date.now(),
    config,
    logger: log,
    accountStore,
    keyStore,
    usage,
    catalog,
    scheduler,
    upstream,
    accountClient,
    envConfig,
    authKey: null,
    abortSignal: null,
    applyConfig (next) {
      ctx.config = next
      scheduler.refreshConfig(next)
      if (ctx.loginFlow) ctx.loginFlow.refreshConfig(next)
      upstream.baseUrl = next.upstream.baseUrl
      upstream.clientVersion = next.upstream.clientVersion
      upstream.timeoutMs = next.upstream.timeoutMs
      upstream.sendTraceparent = next.upstream.sendTraceparent
      upstream.sendTrackingHeaders = next.upstream.sendTrackingHeaders
      upstream.requestPurpose = next.upstream.requestPurpose
      saveConfig(next)
      return ctx.config
    },
    async refreshModels ({ silent = true } = {}) {
      const pool = scheduler.available()
      if (pool.length === 0) {
        if (!silent) log.warn('刷新模型失败：没有可用账号')
        return { ok: false, error: '没有可用账号，无法拉取模型列表' }
      }
      let lastError = null
      for (const account of pool.slice(0, Math.min(pool.length, 3))) {
        try {
          const result = await upstream.fetchModels(account)
          if (!result.ok) {
            lastError = result.error
            if (result.error?.authInvalid) {
              accountStore.markChecked(account.id, { ok: false, error: `${result.error.code}: ${result.error.message}` })
            }
            continue
          }
          catalog.update(result.models, result.meta)
          log.info('模型目录已刷新', { count: catalog.models.length })
          return { ok: true, count: catalog.models.length, models: catalog.models.map((model) => model.id) }
        } catch (error) {
          lastError = { code: 'NETWORK', message: error.message }
        }
      }
      if (!silent) log.warn('刷新模型失败', { error: lastError?.message })
      return { ok: false, error: lastError?.message || '刷新失败' }
    },
    finishRequest ({ account, key, model, endpoint, stream, usage: usageInfo, latencyMs, chatId, status = 'ok' }) {
      const points = usageInfo?.points || 0
      scheduler.success(account.id, { points })
      keyStore.recordUsage(key?.id, { points, tokens: usageInfo?.totalTokens || 0 })
      usage.record({
        endpoint,
        model,
        accountId: account.id,
        keyId: key?.id || '',
        status,
        stream,
        latencyMs,
        promptTokens: usageInfo?.promptTokens || 0,
        completionTokens: usageInfo?.completionTokens || 0,
        totalTokens: usageInfo?.totalTokens || 0,
        points,
        chatId,
        client: 'openai-compatible',
      })
    },
  }

  /**
   * 短信登录流程（手机号 + 验证码 → session → 账号）。
   * 与账号池解耦：只负责「把 auth 换成可用的 account」，登录成功后触发一次模型同步。
   */
  ctx.loginFlow = new LoginFlow({
    accountClient,
    accountStore,
    logger: log,
    config,
    auditFile: path.join(DATA_DIR, 'login-audit.jsonl'),
    pendingFile: path.join(DATA_DIR, 'login-pending.json'),
    hooks: {
      async afterLogin (account) {
        const refresh = await ctx.refreshModels({ silent: true })
        return { models: refresh }
      },
    },
  })

  return ctx
}

/** 简易令牌桶限流：按密钥 ID 计每分钟请求数。 */
function createRateLimiter () {
  const buckets = new Map()
  return function allow (keyId, rpm) {
    if (!rpm || rpm <= 0) return true
    const now = Date.now()
    const windowStart = now - 60_000
    const bucket = buckets.get(keyId) || []
    const recent = bucket.filter((ts) => ts > windowStart)
    if (recent.length >= rpm) {
      buckets.set(keyId, recent)
      return false
    }
    recent.push(now)
    buckets.set(keyId, recent)
    return true
  }
}

const PUBLIC_PATHS = new Set(['/health', '/admin', '/admin/', '/admin/app.js', '/favicon.ico'])
const ADMIN_PREFIX = '/admin'

export function createServer (ctx) {
  const limiter = createRateLimiter()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname
    if (ctx.config.server.cors) setCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      if (pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          version: VERSION,
          uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
          accounts: ctx.accountStore.summary(),
          models: ctx.catalog.models.length,
        })
      }

      if (pathname === '/admin' || pathname === '/admin/') {
        return serveAdminUi(ctx, req, res)
      }

      if (pathname.startsWith(`${ADMIN_PREFIX}/api`)) {
        return await handleAdmin(ctx, req, res, url)
      }

      if (pathname === '/v1/models' && req.method === 'GET') {
        const key = authenticate(ctx, req, res, limiter)
        if (!key) return
        ctx.authKey = key
        return await handleModels(ctx, req, res)
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        const key = authenticate(ctx, req, res, limiter)
        if (!key) return
        ctx.authKey = key
        return await guard(ctx, req, res, () => handleChatCompletions(ctx, req, res))
      }

      if (pathname === '/v1/messages' && req.method === 'POST') {
        const key = authenticate(ctx, req, res, limiter)
        if (!key) return
        ctx.authKey = key
        const contentType = String(req.headers['content-type'] || '')
        return await guard(ctx, req, res, () => handleMessages(ctx, req, res, contentType))
      }

      if (pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
        const key = authenticate(ctx, req, res, limiter)
        if (!key) return
        return handleCountTokens(ctx, req, res)
      }

      if (pathname === '/v1/images/generations' && req.method === 'POST') {
        const key = authenticate(ctx, req, res, limiter)
        if (!key) return
        ctx.authKey = key
        return await guard(ctx, req, res, () => handleImagesGenerations(ctx, req, res))
      }

      if (pathname === '/v1/completions' || pathname === '/v1/embeddings') {
        const key = authenticate(ctx, req, res, limiter)
        if (!key) return
        return handleUnsupported(pathname.replace('/v1/', ''))(ctx, req, res)
      }

      if (pathname.startsWith('/v1/')) {
        return sendOpenAiError(res, 404, `LoomyProxy 未实现该接口: ${pathname}`, { type: 'invalid_request_error' })
      }

      return sendText(res, 404, `Not Found: ${pathname}`)
    } catch (error) {
      const status = Number(error?.statusCode) || 500
      ctx.logger.error('请求处理异常', { path: pathname, error: error?.message })
      if (res.headersSent) {
        try { res.end() } catch { /* ignore */ }
        return
      }
      return sendJson(res, status, { error: { message: error?.message || 'internal error', type: 'api_error' } })
    }
  })

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    ctx.logger.debug('clientError', { error: error.message })
  })

  return server
}

function authenticate (ctx, req, res, limiter) {
  const token = getBearerToken(req)
  if (!token) {
    sendOpenAiError(res, 401, '缺少 API Key：请在 Authorization: Bearer <key> 中携带 LoomyProxy 密钥', {
      type: 'authentication_error',
      code: 'missing_api_key',
    })
    return null
  }
  // 兼容「直接拿 Loomy session 当 key」的调试场景：仅本机且配置允许时
  const key = ctx.keyStore.verify(token)
  if (!key) {
    sendOpenAiError(res, 401, '无效的 API Key', { type: 'authentication_error', code: 'invalid_api_key' })
    return null
  }
  if (!limiter(key.id, key.rpm || ctx.config.limits.requestsPerMinutePerKey)) {
    sendOpenAiError(res, 429, '超出该密钥的每分钟请求上限', { type: 'rate_limit_error', code: 'rate_limited' })
    return null
  }
  return key
}

async function guard (ctx, req, res, handler) {
  const controller = new AbortController()
  ctx.abortSignal = controller.signal
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'))
  })
  try {
    await handler()
  } finally {
    ctx.abortSignal = null
  }
}

export async function startServer ({ config = loadConfig(), logger = null } = {}) {
  const ctx = createContext({ config, logger })
  if (ctx.config.logging?.requestLog) {
    ctx.logger.debug('请求日志已开启')
  }
  if (ctx.accountStore.list().length === 0) {
    ctx.logger.warn('账号池为空：请在管理台导入本机 Loomy 登录态或短信登录')
  }
  if (ctx.keyStore.countEnabled() === 0) {
    ctx.logger.warn('还没有下游密钥：执行 `node src/cli.js key create` 生成')
  }
  await ctx.refreshModels({ silent: true })
  const server = createServer(ctx)
  const host = ctx.config.server.host
  const port = ctx.config.server.port
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return { ctx, server, host, port }
}

export { isLoopback, readBody, sendJson }
