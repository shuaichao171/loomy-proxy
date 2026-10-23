/**
 * 配置加载。
 *
 * 优先级：环境变量 > config/config.json > 内置默认值。
 * 配置文件缺失时自动从 config.example.json 复制一份，避免用户第一次运行就报错。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_DIR = path.join(ROOT_DIR, 'config')
export const DATA_DIR = path.join(ROOT_DIR, 'data')
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
export const EXAMPLE_CONFIG_PATH = path.join(CONFIG_DIR, 'config.example.json')

const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    adminPassword: '',
    cors: true,
    trustProxyHeaders: false,
  },
  upstream: {
    baseUrl: 'https://loomyad.xunfei.cn/api/v1',
    clientVersion: '0.9.39',
    requestPurpose: 'chat.message',
    timeoutMs: 600000,
    sendTraceparent: true,
    sendTrackingHeaders: true,
  },
  auth: {
    accountBaseUrl: 'https://account.xfinfr.com',
    appId: 'GM3LOOMY',
    loomyInstallDir: 'E:/Loomy',
    envFile: '',
  },
  pool: {
    strategy: 'round-robin',
    maxRetries: 2,
    cooldownSeconds: 60,
    sessionAffinity: true,
    affinityTtlSeconds: 1800,
    preferDailyPoints: true,
    pointsRefreshSeconds: 300,
    pointsMinRefreshSeconds: 60,
  },
  login: {
    codeTtlSeconds: 300,
    pendingTtlSeconds: 900,
    resendCooldownSeconds: 60,
    maxAttempts: 5,
    maxSendsPerHour: 5,
    maxPending: 200,
    autoBonus: true,
    autoInvite: true,
  },
  logging: {
    level: 'info',
    requestLog: true,
    usageLog: true,
    maxLogEntries: 500,
  },
  limits: {
    requestsPerMinutePerKey: 0,
    maxBodyBytes: 32 * 1024 * 1024,
  },
}

function isPlainObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge (base, override) {
  if (!isPlainObject(base)) return isPlainObject(override) ? { ...override } : override ?? base
  if (!isPlainObject(override)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

function num (value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool (value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

function clampInt (value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function ensureConfigFile () {
  if (fs.existsSync(CONFIG_PATH)) return
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    fs.copyFileSync(EXAMPLE_CONFIG_PATH, CONFIG_PATH)
    return
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf8')
}

function readConfigFile () {
  ensureConfigFile()
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : {}
  } catch (error) {
    throw new Error(`配置文件解析失败 (${CONFIG_PATH}): ${error.message}`)
  }
}

function applyEnvOverrides (config, env = process.env) {
  const next = config
  if (env.LOOMY_PROXY_HOST) next.server.host = env.LOOMY_PROXY_HOST
  if (env.LOOMY_PROXY_PORT) next.server.port = num(env.LOOMY_PROXY_PORT, next.server.port)
  if (env.LOOMY_PROXY_ADMIN_PASSWORD) next.server.adminPassword = env.LOOMY_PROXY_ADMIN_PASSWORD
  if (env.LOOMY_PROXY_UPSTREAM_BASE) next.upstream.baseUrl = env.LOOMY_PROXY_UPSTREAM_BASE
  if (env.LOOMY_PROXY_UPSTREAM_CONNECT_TIMEOUT_MS) next.upstream.connectTimeoutMs = num(env.LOOMY_PROXY_UPSTREAM_CONNECT_TIMEOUT_MS, next.upstream.connectTimeoutMs)
  if (env.LOOMY_PROXY_UPSTREAM_CONNECT_RETRIES) next.upstream.connectRetries = num(env.LOOMY_PROXY_UPSTREAM_CONNECT_RETRIES, next.upstream.connectRetries)
  if (env.LOOMY_PROXY_ACCOUNT_BASE) next.auth.accountBaseUrl = env.LOOMY_PROXY_ACCOUNT_BASE
  if (env.LOOMY_PROXY_LOOMY_DIR) next.auth.loomyInstallDir = env.LOOMY_PROXY_LOOMY_DIR
  if (env.LOOMY_PROXY_ENV_FILE) next.auth.envFile = env.LOOMY_PROXY_ENV_FILE
  if (env.LOOMY_PROXY_LOG_LEVEL) next.logging.level = env.LOOMY_PROXY_LOG_LEVEL
  if (env.LOOMY_PROXY_ADMIN_PASSWORD === '' && env.LOOMY_PROXY_ADMIN_PASSWORD !== undefined) {
    next.server.adminPassword = ''
  }
  if (env.LOOMY_PROXY_LOGIN_RESEND_COOLDOWN !== undefined) {
    next.login.resendCooldownSeconds = num(env.LOOMY_PROXY_LOGIN_RESEND_COOLDOWN, next.login.resendCooldownSeconds)
  }
  if (env.LOOMY_PROXY_LOGIN_MAX_ATTEMPTS !== undefined) {
    next.login.maxAttempts = num(env.LOOMY_PROXY_LOGIN_MAX_ATTEMPTS, next.login.maxAttempts)
  }
  if (env.LOOMY_PROXY_LOGIN_AUTO_BONUS !== undefined) {
    next.login.autoBonus = bool(env.LOOMY_PROXY_LOGIN_AUTO_BONUS, next.login.autoBonus)
  }
  if (env.LOOMY_PROXY_LOGIN_AUTO_INVITE !== undefined) {
    next.login.autoInvite = bool(env.LOOMY_PROXY_LOGIN_AUTO_INVITE, next.login.autoInvite)
  }
  if (env.LOOMY_PROXY_PREFER_DAILY_POINTS !== undefined) {
    next.pool.preferDailyPoints = bool(env.LOOMY_PROXY_PREFER_DAILY_POINTS, next.pool.preferDailyPoints)
  }
  if (env.LOOMY_PROXY_POINTS_REFRESH_SECONDS !== undefined) {
    next.pool.pointsRefreshSeconds = num(env.LOOMY_PROXY_POINTS_REFRESH_SECONDS, next.pool.pointsRefreshSeconds)
  }
  return next
}

function normalizeConfig (config) {
  const next = config
  next.server.port = num(next.server.port, DEFAULTS.server.port)
  next.server.cors = bool(next.server.cors, DEFAULTS.server.cors)
  next.upstream.baseUrl = String(next.upstream.baseUrl || DEFAULTS.upstream.baseUrl).replace(/\/+$/, '')
  next.upstream.timeoutMs = num(next.upstream.timeoutMs, DEFAULTS.upstream.timeoutMs)
  next.upstream.connectTimeoutMs = clampInt(next.upstream.connectTimeoutMs, 1000, 60000, DEFAULTS.upstream.connectTimeoutMs)
  next.upstream.connectRetries = clampInt(next.upstream.connectRetries, 0, 3, DEFAULTS.upstream.connectRetries)
  next.upstream.sendTraceparent = bool(next.upstream.sendTraceparent, true)
  next.upstream.sendTrackingHeaders = bool(next.upstream.sendTrackingHeaders, true)
  next.pool.maxRetries = Math.max(0, Math.min(5, num(next.pool.maxRetries, 2)))
  next.pool.cooldownSeconds = Math.max(1, num(next.pool.cooldownSeconds, 60))
  next.pool.sessionAffinity = bool(next.pool.sessionAffinity, true)
  next.pool.preferDailyPoints = bool(next.pool.preferDailyPoints, DEFAULTS.pool.preferDailyPoints)
  next.pool.pointsRefreshSeconds = clampInt(next.pool.pointsRefreshSeconds, 30, 3600, DEFAULTS.pool.pointsRefreshSeconds)
  next.pool.pointsMinRefreshSeconds = clampInt(next.pool.pointsMinRefreshSeconds, 5, 600, DEFAULTS.pool.pointsMinRefreshSeconds)
  if (!['round-robin', 'weighted', 'fill-first'].includes(next.pool.strategy)) {
    next.pool.strategy = 'round-robin'
  }
  next.limits.requestsPerMinutePerKey = Math.max(0, num(next.limits.requestsPerMinutePerKey, 0))
  next.limits.maxBodyBytes = Math.max(1024, num(next.limits.maxBodyBytes, DEFAULTS.limits.maxBodyBytes))
  next.login = next.login || {}
  next.login.codeTtlSeconds = clampInt(next.login.codeTtlSeconds, 60, 900, DEFAULTS.login.codeTtlSeconds)
  next.login.pendingTtlSeconds = clampInt(next.login.pendingTtlSeconds, 60, 3600, DEFAULTS.login.pendingTtlSeconds)
  next.login.resendCooldownSeconds = clampInt(next.login.resendCooldownSeconds, 0, 600, DEFAULTS.login.resendCooldownSeconds)
  next.login.maxAttempts = clampInt(next.login.maxAttempts, 1, 10, DEFAULTS.login.maxAttempts)
  next.login.maxSendsPerHour = clampInt(next.login.maxSendsPerHour, 1, 100, DEFAULTS.login.maxSendsPerHour)
  next.login.maxPending = clampInt(next.login.maxPending, 1, 1000, DEFAULTS.login.maxPending)
  next.login.autoBonus = bool(next.login.autoBonus, DEFAULTS.login.autoBonus)
  next.login.autoInvite = bool(next.login.autoInvite, DEFAULTS.login.autoInvite)
  return next
}

export function loadConfig ({ env = process.env } = {}) {
  const fileConfig = readConfigFile()
  const merged = deepMerge(DEFAULTS, fileConfig)
  const withEnv = applyEnvOverrides(merged, env)
  return normalizeConfig(withEnv)
}

export function saveConfig (config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

export function ensureDataDir () {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  return DATA_DIR
}

export { DEFAULTS }
