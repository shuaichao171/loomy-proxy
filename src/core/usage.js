/**
 * 用量账本。
 *
 * 上游在 usage 里直接返回 points_consumed（对话/生图都带），
 * 所以这里按 请求 → 密钥 / 账号 / 模型 三个维度聚合，并落 JSONL 便于离线分析。
 */

import { appendJsonl, readJsonlTail } from '../util/store.js'

export class UsageLedger {
  constructor ({ filePath, maxEntries = 500, logger = null } = {}) {
    this.filePath = filePath
    this.maxEntries = maxEntries
    this.logger = logger
    this.recent = []
    this.totals = {
      requests: 0,
      errors: 0,
      points: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }
    this.byModel = new Map()
    this.byAccount = new Map()
    this.byKey = new Map()
    this.startedAt = Date.now()
  }

  record (entry = {}) {
    const record = {
      ts: Date.now(),
      endpoint: String(entry.endpoint || ''),
      model: String(entry.model || ''),
      accountId: String(entry.accountId || ''),
      keyId: String(entry.keyId || ''),
      status: String(entry.status || 'ok'),
      errorCode: String(entry.errorCode || ''),
      stream: entry.stream === true,
      latencyMs: Number(entry.latencyMs) || 0,
      promptTokens: Number(entry.promptTokens) || 0,
      completionTokens: Number(entry.completionTokens) || 0,
      totalTokens: Number(entry.totalTokens) || 0,
      points: Number(entry.points) || 0,
      chatId: String(entry.chatId || ''),
      client: String(entry.client || ''),
    }

    this.recent.push(record)
    if (this.recent.length > this.maxEntries) this.recent.splice(0, this.recent.length - this.maxEntries)

    this.totals.requests += 1
    if (record.status !== 'ok') this.totals.errors += 1
    this.totals.points += record.points
    this.totals.promptTokens += record.promptTokens
    this.totals.completionTokens += record.completionTokens
    this.totals.totalTokens += record.totalTokens || (record.promptTokens + record.completionTokens)

    bump(this.byModel, record.model, record)
    bump(this.byAccount, record.accountId, record)
    bump(this.byKey, record.keyId, record)

    if (this.filePath) {
      try {
        appendJsonl(this.filePath, record)
      } catch (error) {
        this.logger?.warn('用量日志写入失败', { error: error.message })
      }
    }
    return record
  }

  summary ({ days = 7 } = {}) {
    const since = Date.now() - days * 24 * 3600 * 1000
    const recentRecords = this.recent.filter((record) => record.ts >= since)
    return {
      startedAt: this.startedAt,
      totals: this.totals,
      window: {
        days,
        requests: recentRecords.length,
        points: recentRecords.reduce((sum, record) => sum + record.points, 0),
        errors: recentRecords.filter((record) => record.status !== 'ok').length,
      },
      byModel: tableToArray(this.byModel),
      byAccount: tableToArray(this.byAccount),
      byKey: tableToArray(this.byKey),
    }
  }

  list ({ limit = 100 } = {}) {
    return this.recent.slice(-limit).reverse()
  }

  loadHistory (limit = 200) {
    if (!this.filePath) return []
    try {
      return readJsonlTail(this.filePath, limit)
    } catch {
      return []
    }
  }
}

function bump (table, key, record) {
  const id = key || '(unknown)'
  const current = table.get(id) || { id, requests: 0, errors: 0, points: 0, tokens: 0 }
  current.requests += 1
  if (record.status !== 'ok') current.errors += 1
  current.points += record.points
  current.tokens += record.totalTokens || (record.promptTokens + record.completionTokens)
  table.set(id, current)
}

function tableToArray (table) {
  return [...table.values()].sort((a, b) => b.requests - a.requests)
}
