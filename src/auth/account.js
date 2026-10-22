/**
 * 讯飞账号服务客户端（登录 / 会话校验 / 登出）。
 *
 * 逆向依据 electron/xfyun/account-service.js：
 *   POST /login/phone/sendMsgCode   {base, param:{ccode, phone, expire}}      → data.msgid
 *   POST /login/phone/checkCode     {base, param:{ccode, phone, mcode, msgid, expire}}
 *   POST /userinfo/query/baseInfo   {base, param:{session}}                  → data.userid/phone/nickname
 *   POST /login/account/logout      {base, param:{session}}
 * base 固定字段：appid / modelid=Web / version=1.0.0 / devid=web / ua / traceid
 *
 * 业务错误同样走 HTTP 200，body 形如 {code:'100002', desc:'登录已失效，请重新登录'}，
 * 因此必须解析 body.code 而不是只看 status。
 */

import crypto from 'node:crypto'
import { buildSignedHeadersFor } from './sign.js'

const AUTH_ERROR_CODES = new Set(['020002', '100002'])
const DEFAULT_UA = 'Loomy|Desktop|Electron|macOS'

export class AccountApiError extends Error {
  constructor (message, { code = '', status = 0, isAuthError = false, payload = null } = {}) {
    super(message)
    this.name = 'AccountApiError'
    this.code = code
    this.status = status
    this.isAuthError = isAuthError
    this.payload = payload
  }
}

export class XfyunAccountClient {
  constructor ({ baseUrl, appId, accessKeyId, accessKeySecret, timeoutMs = 20000, ua = DEFAULT_UA } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '')
    this.appId = String(appId || '')
    this.accessKeyId = String(accessKeyId || '')
    this.accessKeySecret = String(accessKeySecret || '')
    this.timeoutMs = timeoutMs
    this.ua = ua
  }

  get ready () {
    return Boolean(this.baseUrl && this.accessKeyId && this.accessKeySecret && this.appId)
  }

  base () {
    return {
      appid: this.appId,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      ua: this.ua,
      traceid: crypto.randomUUID().replace(/-/g, ''),
    }
  }

  async request ({ method = 'POST', path, query = {}, body = null }) {
    if (!this.ready) {
      throw new AccountApiError('讯飞账号配置不完整（缺少 baseUrl / appId / AK / SK）', { code: 'NO_CREDENTIALS' })
    }
    const { headers, bodyString } = buildSignedHeadersFor({
      accessKeyId: this.accessKeyId,
      accessKeySecret: this.accessKeySecret,
      method,
      path,
      queryParams: query,
      body,
    })
    const queryString = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString()
    const url = `${this.baseUrl}${path}${queryString ? `?${queryString}` : ''}`

    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : bodyString,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? '请求超时' : (error?.cause?.message || error?.message || '网络错误')
      throw new AccountApiError(`${path} 调用失败: ${reason}`, { code: 'NETWORK' })
    }

    const text = await response.text()
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        throw new AccountApiError(`${path} 返回非 JSON（HTTP ${response.status}）`, { status: response.status, payload: { raw: text.slice(0, 300) } })
      }
    }

    if (!response.ok && !payload) {
      throw new AccountApiError(`${path} HTTP ${response.status}`, { status: response.status })
    }

    const code = String(payload?.code || '')
    if (code && code !== '000000') {
      const isAuthError = AUTH_ERROR_CODES.has(code)
      throw new AccountApiError(payload?.desc || `${path} 返回错误 ${code}`, {
        code,
        status: response.status,
        isAuthError,
        payload,
      })
    }

    return payload?.data ?? payload
  }

  sendSmsCode (phone, { scene = 'login', expire = 300, ccode = '86' } = {}) {
    return this.request({
      method: 'POST',
      path: '/login/phone/sendMsgCode',
      body: { base: this.base(), param: { ccode, phone, expire, ...(scene === 'login' ? {} : { scene }) } },
    })
  }

  loginBySmsCode (phone, mcode, msgid, { ccode = '86', expire = 14 * 24 * 3600 } = {}) {
    return this.request({
      method: 'POST',
      path: '/login/phone/checkCode',
      body: { base: this.base(), param: { ccode, phone, mcode, msgid, expire } },
    })
  }

  getUserInfo (session) {
    return this.request({
      method: 'POST',
      path: '/userinfo/query/baseInfo',
      body: { base: this.base(), param: { session } },
    })
  }

  logout (session) {
    return this.request({
      method: 'POST',
      path: '/login/account/logout',
      body: { base: this.base(), param: { session } },
    })
  }
}

/** 从 checkCode / bindSkip 等返回值里稳妥地取 session 与用户信息。 */
export function extractLoginResult (data = {}) {
  const session = String(data.session || data.token || data.data?.session || '').trim()
  return {
    session,
    userid: String(data.userid || data.userId || '').trim(),
    phone: String(data.phone || data.mobile || '').trim(),
    nickname: String(data.nickname || data.nickName || '').trim(),
  }
}
