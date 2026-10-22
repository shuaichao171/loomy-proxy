/**
 * 极简结构化日志。默认写 stdout，同时保留一个有上限的内存环形缓冲给管理台查询。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger ({ level = 'info', maxEntries = 500, sink = console } = {}) {
  const threshold = LEVELS[level] || LEVELS.info
  const entries = []
  let seq = 0

  function push (levelName, message, meta) {
    if ((LEVELS[levelName] || 0) < threshold) return
    const entry = {
      id: ++seq,
      ts: Date.now(),
      level: levelName,
      message: String(message ?? ''),
      ...(meta && typeof meta === 'object' ? { meta } : {}),
    }
    entries.push(entry)
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries)
    const line = `[${new Date(entry.ts).toISOString()}] ${levelName.toUpperCase()} ${entry.message}`
    if (meta && typeof meta === 'object') {
      sink[levelName === 'debug' ? 'log' : levelName]?.(line, redact(meta))
    } else {
      sink[levelName === 'debug' ? 'log' : levelName]?.(line)
    }
  }

  return {
    debug: (message, meta) => push('debug', message, meta),
    info: (message, meta) => push('info', message, meta),
    warn: (message, meta) => push('warn', message, meta),
    error: (message, meta) => push('error', message, meta),
    list: (limit = 100) => entries.slice(-limit),
    clear: () => { entries.length = 0 },
  }
}

const SENSITIVE_KEYS = /^(authorization|token|cookie|set-cookie|x-api-key|api-key|password|session|secret|sk-[a-z0-9]+)$/i

export function redact (value, depth = 0) {
  if (depth > 4) return '[depth]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redact(item, depth + 1)
    }
    return out
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`
  return value
}
