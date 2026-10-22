/**
 * 持久化：JSON 文件原子写 + JSONL 追加。
 *
 * 账号池与下游密钥都必须保证「写一半断电」不会把文件写坏，
 * 所以统一走 临时文件 → rename 的原子替换。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJsonFile (filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`读取 ${path.basename(filePath)} 失败: ${error.message}`)
  }
}

export function writeJsonFileAtomic (filePath, value) {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, filePath)
  return filePath
}

export function appendJsonl (filePath, record) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
}

export function readJsonlTail (filePath, limit = 200) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function newId (prefix = '') {
  return `${prefix}${crypto.randomUUID()}`
}

export function shortId (bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex')
}
