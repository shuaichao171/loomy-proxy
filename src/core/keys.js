/**
 * 下游访问密钥（给客户端用的 sk-loomy-*）。
 *
 * 参考 one-api / new-api 的令牌模型：创建时明文只返回一次，之后只存
 * sha256 摘要 + 前缀，用于校验与列表展示，避免明文密钥落盘。
 */

import crypto from 'node:crypto'
import { newId, readJsonFile, shortId, writeJsonFileAtomic } from '../util/store.js'

export const KEY_PREFIX = 'sk-loomy-'

function hashKey (plaintext) {
  return crypto.createHash('sha256').update(String(plaintext)).digest('hex')
}

export class ApiKeyStore {
  constructor ({ filePath, logger = null }) {
    this.filePath = filePath
    this.logger = logger
    this.keys = []
    this.loadedAt = 0
    this.load()
  }

  load () {
    this.loadedAt = Date.now()
    const parsed = readJsonFile(this.filePath, { keys: [] })
    this.keys = Array.isArray(parsed?.keys) ? parsed.keys.map((key) => this.normalize(key)) : []
  }

  normalize (key = {}) {
    return {
      id: String(key.id || newId('key_')),
      name: String(key.name || ''),
      keyHash: String(key.keyHash || ''),
      prefix: String(key.prefix || ''),
      enabled: key.enabled !== false,
      allowedModels: Array.isArray(key.allowedModels) ? key.allowedModels.map(String).filter(Boolean) : [],
      rpm: Math.max(0, Number(key.rpm) || 0),
      createdAt: Number(key.createdAt) || Date.now(),
      lastUsedAt: Number(key.lastUsedAt) || 0,
      stats: {
        requests: Number(key.stats?.requests) || 0,
        points: Number(key.stats?.points) || 0,
        tokens: Number(key.stats?.tokens) || 0,
      },
    }
  }

  persist () {
    writeJsonFileAtomic(this.filePath, { version: 1, keys: this.keys })
  }

  publicList () {
    return this.keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      enabled: key.enabled,
      allowedModels: key.allowedModels,
      rpm: key.rpm,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      stats: key.stats,
    }))
  }

  /** 返回 { key, plaintext }；plaintext 只在这一次返回，之后无法再取回。 */
  create ({ name = '', allowedModels = [], rpm = 0 } = {}) {
    const plaintext = `${KEY_PREFIX}${shortId(24)}`
    const key = this.normalize({
      id: newId('key_'),
      name: name || `key-${new Date().toISOString().slice(0, 10)}`,
      keyHash: hashKey(plaintext),
      prefix: plaintext.slice(0, KEY_PREFIX.length + 6),
      allowedModels,
      rpm,
    })
    this.keys.push(key)
    this.persist()
    this.logger?.info('创建下游密钥', { id: key.id, prefix: key.prefix })
    return { key, plaintext }
  }

  verify (plaintext) {
    const token = String(plaintext || '').trim()
    if (!token) return null
    const digest = hashKey(token)
    const found = this.findByDigest(digest)
    if (found) return found
    // 未命中时再重读一次文件：CLI / 另一个进程（docker exec）刚创建的密钥
    // 不该要求先重启服务才生效；命中路径零额外 I/O。
    if (this.reloadFromDisk()) {
      return this.findByDigest(digest)
    }
    return null
  }

  findByDigest (digest) {
    const key = this.keys.find((item) => item.keyHash === digest)
    if (!key || !key.enabled) return null
    return key
  }

  /** 从磁盘重读；有变化返回 true（只在 verify 未命中时调用）。 */
  reloadFromDisk () {
    const before = this.keys.length
    const beforeFirst = this.keys[0]?.id || ''
    try {
      this.load()
    } catch {
      return false
    }
    return this.keys.length !== before || (this.keys[0]?.id || '') !== beforeFirst
  }

  get (id) {
    return this.keys.find((key) => key.id === id) || null
  }

  update (id, patch = {}) {
    const key = this.get(id)
    if (!key) return null
    if (patch.name !== undefined) key.name = String(patch.name)
    if (patch.enabled !== undefined) key.enabled = patch.enabled !== false
    if (patch.allowedModels !== undefined) {
      key.allowedModels = Array.isArray(patch.allowedModels) ? patch.allowedModels.map(String).filter(Boolean) : []
    }
    if (patch.rpm !== undefined) key.rpm = Math.max(0, Number(patch.rpm) || 0)
    this.persist()
    return key
  }

  remove (id) {
    const index = this.keys.findIndex((key) => key.id === id)
    if (index < 0) return false
    this.keys.splice(index, 1)
    this.persist()
    return true
  }

  recordUsage (id, { points = 0, tokens = 0 } = {}) {
    const key = this.get(id)
    if (!key) return
    key.stats.requests += 1
    key.stats.points += Number(points) || 0
    key.stats.tokens += Number(tokens) || 0
    key.lastUsedAt = Date.now()
    this.persist()
  }

  /** 当前已启用的密钥数量，用于首次启动提示。 */
  countEnabled () {
    return this.keys.filter((key) => key.enabled).length
  }
}
