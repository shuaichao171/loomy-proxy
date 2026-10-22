/**
 * Loomy 客户端 .env 文件解密。
 *
 * 逆向依据（electron/utils/env-file-crypto.js）：
 *   - 打包产物 resources/.env.prod 是 `LOOMYENC1:<base64>` 密文；
 *   - 明文结构 = salt(16) | iv(12) | tag(16) | ciphertext；
 *   - 口令随客户端分发（本质是混淆），KDF = scrypt(N=16384 默认)。
 *
 * 反代只读不写：把安装目录里的配置当「凭据来源」，避免把 AK/SK 复制进本仓库。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const ENV_CRYPT_MAGIC = 'LOOMYENC1'
// 与客户端一致的混淆口令（见 electron/utils/env-file-crypto.js ENV_CRYPT_PASSPHRASE）
const ENV_CRYPT_PASSPHRASE = 'loomy::env::3f9c1d2a7b6e4f08::local-obfuscation::v1'
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

export function isEncryptedEnvContent (raw) {
  return typeof raw === 'string' && raw.startsWith(`${ENV_CRYPT_MAGIC}:`)
}

export function decryptEnvContent (raw) {
  if (!isEncryptedEnvContent(raw)) return typeof raw === 'string' ? raw : ''
  const payload = Buffer.from(raw.slice(ENV_CRYPT_MAGIC.length + 1).trim(), 'base64')
  const salt = payload.subarray(0, SALT_LEN)
  const iv = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag = payload.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN)
  const data = payload.subarray(SALT_LEN + IV_LEN + TAG_LEN)
  const key = crypto.scryptSync(ENV_CRYPT_PASSPHRASE, salt, KEY_LEN)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function parseDotenv (text) {
  const out = {}
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

export function readEnvFile (filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  return parseDotenv(decryptEnvContent(raw))
}

/** 按客户端同样的搜索顺序找 .env.*：prod → 无后缀 → test。 */
export function findEnvFiles (installDir) {
  const roots = [
    installDir ? path.join(installDir, 'resources') : '',
    installDir || '',
    path.join(os.homedir(), '.config', 'loomy'),
    process.cwd(),
  ].filter(Boolean)
  const names = ['.env.prod', '.env', '.env.test']
  const out = []
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name)
      if (fs.existsSync(candidate) && !out.includes(candidate)) out.push(candidate)
    }
  }
  return out
}

function pick (env, keys) {
  for (const key of keys) {
    const value = String(env[key] || '').trim()
    if (value) return value
  }
  return ''
}

/**
 * 解析讯飞账号服务 + 积分（iModel）服务地址与签名凭据。
 * 返回的 accessKeySecret 只在内存里用于签名，日志中一律打码。
 */
export function resolveLoomyEnvConfig ({ installDir = '', envFile = '' } = {}) {
  const candidates = envFile ? [envFile] : findEnvFiles(installDir)
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue
    let env
    try {
      env = readEnvFile(candidate)
    } catch (error) {
      continue
    }
    const config = {
      source: candidate,
      accountBaseUrl: pick(env, ['LOOMY_XFYUN_BASE_URL', 'VITE_XFYUN_BASE_URL']),
      appId: pick(env, ['LOOMY_XFYUN_APP_ID', 'VITE_XFYUN_APP_ID']),
      accessKeyId: pick(env, ['LOOMY_XFYUN_ACCESS_KEY_ID', 'VITE_XFYUN_ACCESS_KEY_ID']),
      accessKeySecret: pick(env, ['LOOMY_XFYUN_ACCESS_KEY_SECRET', 'VITE_XFYUN_ACCESS_KEY_SECRET']),
      pointsBaseUrl: pick(env, ['LOOMY_POINTS_BASE_URL', 'VITE_LOOMY_POINTS_BASE_URL']),
      wechatAppId: pick(env, ['LOOMY_WECHAT_APP_ID', 'VITE_WECHAT_APP_ID']),
    }
    if (config.accessKeyId && config.accessKeySecret) return config
  }
  return {
    source: '',
    accountBaseUrl: '',
    appId: '',
    accessKeyId: '',
    accessKeySecret: '',
    pointsBaseUrl: '',
    wechatAppId: '',
  }
}
