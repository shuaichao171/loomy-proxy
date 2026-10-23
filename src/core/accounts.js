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
      // 积分钱包：daily = 每日赠送（当天有效），balance = 永久｜调度按它优先烧每日积分
      wallet: {
        balance: Math.max(0, Number(account.wallet?.balance) || 0),
        daily: Math.max(0, Number(account.wallet?.daily) || 0),
        checkedAt: Number(account.wallet?.checkedAt) || 0,
        estimatedAt: Number(account.wallet?.estimatedAt) || 0,
        ok: account.wallet?.ok !== false,
        error: String(account.wallet?.error || ''),
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
      wallet: { ...account.wallet, tier: pointsTier(account), tierLabel: POINTS_TIER_LABEL[pointsTier(account)] },
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


  /** 从磁盘重读（CLI 在另一个进程里增删账号后，服务无需重启即可生效）。 */
  reload () {
    const before = this.accounts.length
    const beforeIds = this.accounts.map((account) => account.id).join(',')
    this.load()
    const afterIds = this.accounts.map((account) => account.id).join(',')
    return this.accounts.length !== before || afterIds !== beforeIds
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
    if (points) {
      const consumed = Number(points) || 0
      account.stats.points += consumed
      // 本地估算：先烧每日积分，再烧永久积分；PointsTracker 刷新后用真实余额覆盖
      if (consumed > 0 && account.wallet?.checkedAt) {
        const fromDaily = Math.min(account.wallet.daily, consumed)
        account.wallet.daily = Math.max(0, account.wallet.daily - fromDaily)
        account.wallet.balance = Math.max(0, account.wallet.balance - (consumed - fromDaily))
        account.wallet.estimatedAt = Date.now()
      }
    }
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

  /** 写入上游积分余额（每日 / 永久）。由 PointsTracker 拉取后调用。 */
  markPoints (id, { balance = null, daily = null, ok = true, error = '' } = {}) {
    const account = this.get(id)
    if (!account) return null
    account.wallet = account.wallet || { balance: 0, daily: 0, checkedAt: 0, estimatedAt: 0, ok: true, error: '' }
    if (ok) {
      if (balance !== null && balance !== undefined) account.wallet.balance = Math.max(0, Number(balance) || 0)
      if (daily !== null && daily !== undefined) account.wallet.daily = Math.max(0, Number(daily) || 0)
      account.wallet.estimatedAt = 0
      account.wallet.error = ''
    } else {
      account.wallet.error = String(error || '').slice(0, 200)
    }
    account.wallet.ok = ok
    account.wallet.checkedAt = Date.now()
    account.updatedAt = Date.now()
    this.persist()
    return { ...account.wallet, tier: pointsTier(account) }
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
    counts.dailyPoints = this.accounts.reduce((sum, account) => sum + (Number(account.wallet?.daily) || 0), 0)
    counts.permanentPoints = this.accounts.reduce((sum, account) => sum + (Number(account.wallet?.balance) || 0), 0)
    return counts
  }
}

/**
 * 账号积分档位（调度排序用）：
 *   0 daily     —— 还有每日赠送积分（当天过期，优先烧）
 *   1 unknown   —— 还没拉到余额（不阻塞其它账号）
 *   2 permanent —— 每日已用尽，只剩永久积分
 *   3 empty     —— 每日与永久都没有
 */
export function pointsTier (account = {}) {
  const wallet = account.wallet || {}
  if (!wallet.checkedAt) return 1
  if (Number(wallet.daily) > 0) return 0
  if (Number(wallet.balance) > 0) return 2
  return 3
}

export const POINTS_TIER_LABEL = { 0: 'daily', 1: 'unknown', 2: 'permanent', 3: 'empty' }

export { STATUS as ACCOUNT_STATUS }
