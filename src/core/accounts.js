/**
 * 账号池持久化。
 *
 * 参考 one-api / new-api 的「渠道（channel）」与 gpt-load 的「分组 + 凭据池」：
 * 每个账号是一条上游凭据（Loomy session），带权重、可用状态、冷却时间与调用统计。
 *
 * 注意：session 等价于登录态，属于敏感凭据 —— 只在 data/accounts.json（0600）落盘，
 * 任何 API 响应里都只输出打码后的值。
 */

import { appendJsonl, newId, readJsonFile, writeJsonFileAtomic } from '../util/store.js'

const STATUS = { ACTIVE: 'active', COOLING: 'cooling', INVALID: 'invalid', DISABLED: 'disabled' }

export function maskSession (session) {
  const text = String(session || '')
  if (text.length <= 8) return text ? '****' : ''
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

export function maskPhone (phone) {
  const text = String(phone || '')
  if (text.length < 7) return text
  return `${text.slice(0, 3)}****${text.slice(-4)}`
}

export class AccountStore {
  constructor ({ filePath, logger = null }) {
    this.filePath = filePath
    this.logger = logger
    this.accounts = []
    this.load()
  }

  load () {
    const parsed = readJsonFile(this.filePath, { accounts: [] })
    this.accounts = Array.isArray(parsed?.accounts) ? parsed.accounts.map((account) => this.normalize(account)) : []
  }

  normalize (account = {}) {
    return {
      id: String(account.id || newId('acc_')),
      name: String(account.name || ''),
      session: String(account.session || ''),
      userid: String(account.userid || ''),
      phone: String(account.phone || ''),
      nickname: String(account.nickname || ''),
      baseUrl: String(account.baseUrl || ''),
      enabled: account.enabled !== false,
      weight: Math.max(1, Number(account.weight) || 1),
      status: Object.values(STATUS).includes(account.status) ? account.status : STATUS.ACTIVE,
      cooldownUntil: Number(account.cooldownUntil) || 0,
      lastError: String(account.lastError || ''),
      lastCheckedAt: Number(account.lastCheckedAt) || 0,
      lastUsedAt: Number(account.lastUsedAt) || 0,
      createdAt: Number(account.createdAt) || Date.now(),
      updatedAt: Number(account.updatedAt) || Date.now(),
      stats: {
        requests: Number(account.stats?.requests) || 0,
        errors: Number(account.stats?.errors) || 0,
        points: Number(account.stats?.points) || 0,
      },
    }
  }

  persist () {
    writeJsonFileAtomic(this.filePath, { version: 1, accounts: this.accounts })
  }

  list () {
    return this.accounts
  }

  publicList () {
    return this.accounts.map((account) => this.toPublic(account))
  }

  toPublic (account) {
    return {
      id: account.id,
      name: account.name,
      sessionMasked: maskSession(account.session),
      userid: account.userid,
      phone: maskPhone(account.phone),
      nickname: account.nickname,
      baseUrl: account.baseUrl,
      enabled: account.enabled,
      weight: account.weight,
      status: this.effectiveStatus(account),
      cooldownUntil: account.cooldownUntil,
      lastError: account.lastError,
      lastCheckedAt: account.lastCheckedAt,
      lastUsedAt: account.lastUsedAt,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      stats: account.stats,
      health: this.health(account),
    }
  }

  effectiveStatus (account) {
    if (!account.enabled) return STATUS.DISABLED
    if (account.status === STATUS.INVALID) return STATUS.INVALID
    if (account.cooldownUntil && account.cooldownUntil > Date.now()) return STATUS.COOLING
    return STATUS.ACTIVE
  }

  health (account) {
    const status = this.effectiveStatus(account)
    if (status === STATUS.ACTIVE) return 'healthy'
    if (status === STATUS.COOLING) return 'cooling'
    if (status === STATUS.INVALID) return 'invalid'
    return 'disabled'
  }

  get (id) {
    return this.accounts.find((account) => account.id === id || account.userid === id || account.name === id) || null
  }

  add (input = {}) {
    const session = String(input.session || '').trim()
    if (!session) throw new Error('session 不能为空')
    const duplicate = this.accounts.find((account) => account.session === session)
    if (duplicate) return { account: duplicate, created: false, reason: 'duplicate' }
    const account = this.normalize({
      ...input,
      id: newId('acc_'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: STATUS.ACTIVE,
      cooldownUntil: 0,
      lastError: '',
    })
    this.accounts.push(account)
    this.persist()
    this.logger?.info('新增账号', { id: account.id, phone: maskPhone(account.phone), nickname: account.nickname })
    return { account, created: true }
  }

  update (id, patch = {}) {
    const account = this.get(id)
    if (!account) return null
    const allowed = ['name', 'session', 'userid', 'phone', 'nickname', 'baseUrl', 'enabled', 'weight', 'status']
    for (const key of allowed) {
      if (patch[key] === undefined) continue
      if (key === 'weight') account.weight = Math.max(1, Number(patch.weight) || 1)
      else if (key === 'enabled') account.enabled = patch.enabled !== false
      else account[key] = String(patch[key] ?? '')
    }
    if (patch.status && Object.values(STATUS).includes(patch.status)) {
      account.status = patch.status
      if (patch.status === STATUS.ACTIVE) account.cooldownUntil = 0
    }
    account.updatedAt = Date.now()
    this.persist()
    return account
  }

  remove (id) {
    const index = this.accounts.findIndex((account) => account.id === id)
    if (index < 0) return false
    const [removed] = this.accounts.splice(index, 1)
    this.persist()
    this.logger?.info('删除账号', { id: removed.id })
    return true
  }

  markSuccess (id, { points = 0 } = {}) {
    const account = this.get(id)
    if (!account) return
    account.status = STATUS.ACTIVE
    account.cooldownUntil = 0
    account.lastError = ''
    account.lastUsedAt = Date.now()
    account.stats.requests += 1
    if (points) account.stats.points += Number(points) || 0
    this.persist()
  }

  markFailure (id, { reason = '', cooldownSeconds = 60, invalid = false } = {}) {
    const account = this.get(id)
    if (!account) return
    account.stats.errors += 1
    account.lastError = String(reason).slice(0, 500)
    account.updatedAt = Date.now()
    if (invalid) {
      account.status = STATUS.INVALID
      account.cooldownUntil = 0
    } else {
      account.cooldownUntil = Date.now() + cooldownSeconds * 1000
      if (account.status !== STATUS.INVALID) account.status = STATUS.ACTIVE
    }
    this.persist()
    appendJsonl(`${this.filePath}.failures.jsonl`, {
      ts: Date.now(),
      accountId: account.id,
      reason: account.lastError,
      invalid,
    })
  }

  markChecked (id, { ok, error = '', profile = null } = {}) {
    const account = this.get(id)
    if (!account) return
    account.lastCheckedAt = Date.now()
    if (ok) {
      account.status = STATUS.ACTIVE
      account.cooldownUntil = 0
      account.lastError = ''
      if (profile) {
        if (profile.userid) account.userid = String(profile.userid)
        if (profile.phone) account.phone = String(profile.phone)
        if (profile.nickname) account.nickname = String(profile.nickname)
      }
    } else {
      account.lastError = String(error).slice(0, 500)
      if (/100002|020002|登录已失效|未登录|缺少 token/.test(String(error))) {
        account.status = STATUS.INVALID
      }
    }
    account.updatedAt = Date.now()
    this.persist()
  }

  summary () {
    const counts = { total: this.accounts.length, active: 0, cooling: 0, invalid: 0, disabled: 0 }
    for (const account of this.accounts) {
      const status = this.effectiveStatus(account)
      if (status === STATUS.ACTIVE) counts.active += 1
      else if (status === STATUS.COOLING) counts.cooling += 1
      else if (status === STATUS.INVALID) counts.invalid += 1
      else counts.disabled += 1
    }
    counts.points = this.accounts.reduce((sum, account) => sum + (account.stats?.points || 0), 0)
    return counts
  }
}

export { STATUS as ACCOUNT_STATUS }
