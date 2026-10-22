/**
 * 从本机已安装的 Loomy 客户端导入登录态（免短信登录）。
 *
 * 逆向依据：
 *   - electron/config-path.js：Windows 用户目录 = C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>
 *   - electron/auth/auth-session-runtime.js：electron-store 文件 <userData>/auth-session.json
 *   - 字段：{ session, userid, phone, updatedAt }
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export function loomyConfigRoot () {
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.config', 'loomy')
  }
  const hash = crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12)
  return path.join('C:', 'Users', 'Public', 'Loomy', hash)
}

export function loomyUserDataDir () {
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.config', 'loomy')
  }
  return path.join(loomyConfigRoot(), 'userData')
}

export function loomyOpenCodeConfigDir () {
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.config', 'loomy-opencode')
  }
  return path.join(loomyConfigRoot(), 'opencode')
}

export function readLocalAuthSession () {
  const file = path.join(loomyUserDataDir(), 'auth-session.json')
  if (!fs.existsSync(file)) return { found: false, file, session: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const session = String(parsed?.session || '').trim()
    return {
      found: Boolean(session),
      file,
      session: session
        ? {
            session,
            userid: String(parsed.userid || '').trim(),
            phone: String(parsed.phone || '').trim(),
            updatedAt: Number(parsed.updatedAt) || 0,
          }
        : null,
    }
  } catch (error) {
    return { found: false, file, session: null, error: error.message }
  }
}

/** 读取客户端里当前生效的 iModel baseURL（用于确定上游环境）。 */
export function readLocalUpstreamBase () {
  const candidates = [
    path.join(loomyOpenCodeConfigDir(), 'opencode.json'),
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const baseUrl = String(parsed?.provider?.imodel?.options?.baseURL || '').trim()
      if (baseUrl) return { source: file, baseUrl: baseUrl.replace(/\/+$/, '') }
    } catch {
      // 忽略：文件不存在或非 JSON
    }
  }
  return { source: '', baseUrl: '' }
}
