/**
 * HTTP 小工具：读请求体、发 JSON、CORS、IP 解析。
 * 不引第三方框架，保持零依赖可审计。
 */

export function setCorsHeaders (res, { credentials = false } = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, anthropic-version, x-loomy-chat-id, x-loomy-msg-id, x-loomy-purpose')
  res.setHeader('Access-Control-Expose-Headers', 'x-loomy-account, x-loomy-model, x-request-id, x-loomy-points')
  if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true')
}

export function sendJson (res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

export function sendText (res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.from(String(text), 'utf8')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

/** OpenAI / Anthropic 两种风格的错误信封都兼容输出。 */
export function sendOpenAiError (res, status, message, { type, code, anthropic = false } = {}) {
  if (anthropic) {
    return sendJson(res, status, {
      type: 'error',
      error: { type: type || 'api_error', message: String(message) },
    })
  }
  return sendJson(res, status, {
    error: {
      message: String(message),
      type: type || 'api_error',
      param: null,
      code: code ?? null,
    },
  })
}

export function readBody (req, { maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        fail(Object.assign(new Error('请求体超过大小限制'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({ raw: '', json: null })
      try {
        resolve({ raw, json: JSON.parse(raw) })
      } catch (error) {
        reject(Object.assign(new Error(`请求体不是合法 JSON: ${error.message}`), { statusCode: 400 }))
      }
    })
    req.on('error', fail)
    req.on('aborted', () => fail(Object.assign(new Error('请求被中断'), { statusCode: 499 })))
  })
}

export function getBearerToken (req) {
  const auth = String(req.headers.authorization || '').trim()
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i)
    if (match) return match[1].trim()
  }
  const apiKey = String(req.headers['x-api-key'] || '').trim()
  if (apiKey) return apiKey
  return ''
}

export function getClientIp (req) {
  return String(req.socket?.remoteAddress || '')
}

export function isLoopback (req) {
  const ip = getClientIp(req)
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

export function parseCookies (req) {
  const raw = String(req.headers.cookie || '')
  const out = {}
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

export function setCookie (res, name, value, { maxAge = 0, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax']
  if (httpOnly) parts.push('HttpOnly')
  if (maxAge > 0) parts.push(`Max-Age=${maxAge}`)
  const existing = res.getHeader('Set-Cookie')
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : []
  list.push(parts.join('; '))
  res.setHeader('Set-Cookie', list)
}
