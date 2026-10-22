/**
 * 讯飞账号服务签名（HMAC-SHA1）。
 *
 * 逆向依据 electron/xfyun/sign.js：服务端要求
 *   Authorization: "account <accessKeyId>:<signature>"
 *   Date / Nonce / Content-MD5 一起参与签名。
 * 待签串按 \n 拼：METHOD, ESCAPED_PATH, ESCAPED_QUERY, Content-MD5, Content-Type,
 *                 Date, Nonce, SignedHeaders, CanonicalizedHeaders(去尾换行)
 */

import crypto from 'node:crypto'

function contentMD5 (body) {
  if (!body) return ''
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  return crypto.createHash('md5').update(bodyStr, 'utf8').digest('base64')
}

function rfc3986 (value) {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

function buildEscapedPath (path) {
  let clean = path.startsWith('/') ? path : `/${path}`
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1)
  return clean.split('/').map((seg) => (seg ? rfc3986(seg) : '')).join('/')
}

function buildEscapedQueryString (query = {}) {
  const entries = Object.entries(query || {})
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => {
      const escapedKey = rfc3986(key)
      const escapedValue = value === null || value === undefined ? '' : rfc3986(String(value))
      return `${escapedKey}=${escapedValue}`
    })
    .join('&')
}

function buildCanonicalizedHeaders (headers = {}, prefix = 'x-') {
  const picked = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase()
    if (lower.startsWith(prefix)) picked[lower] = String(value).trim()
  }
  const sorted = Object.keys(picked).sort()
  if (sorted.length === 0) return ''
  return sorted.map((key) => `${key}:${picked[key]}\n`).join('')
}

function buildSignedHeaders (headers = {}, prefix = 'x-') {
  const picked = Object.keys(headers || {})
    .map((key) => key.toLowerCase())
    .filter((key) => key.startsWith(prefix))
  return picked.sort().join(';')
}

export function generateSignature ({ method, path, queryParams = {}, body = '', contentType = '', date, nonce, customHeaders = {}, accessKeySecret }) {
  const parts = [
    String(method).toUpperCase(),
    buildEscapedPath(path),
    buildEscapedQueryString(queryParams),
    contentMD5(body),
    contentType,
    date,
    nonce,
    buildSignedHeaders(customHeaders),
    buildCanonicalizedHeaders(customHeaders).replace(/\n$/, ''),
  ]
  return crypto.createHmac('sha1', accessKeySecret).update(parts.join('\n'), 'utf8').digest('base64')
}

export function buildSignedHeadersFor ({ accessKeyId, accessKeySecret, method, path, queryParams = {}, body = '', contentType = 'application/json', customHeaders = {} }) {
  const bodyString = body === null || body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const date = new Date().toUTCString()
  const nonce = crypto.randomUUID()
  const signature = generateSignature({
    method,
    path,
    queryParams,
    body: bodyString,
    contentType,
    date,
    nonce,
    customHeaders,
    accessKeySecret,
  })
  const headers = {
    Authorization: `account ${accessKeyId}:${signature}`,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
    ...customHeaders,
  }
  const md5 = contentMD5(bodyString)
  if (md5) headers['Content-MD5'] = md5
  return { headers, bodyString }
}
