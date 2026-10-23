/**
 * 账号调度器：在多条上游凭据之间做选择与容错。
 *
 * 设计参考 gpt-load 的分组调度：
 *   - 三道策略：round-robin / weighted / fill-first
 *   - 冷却（cooldown）：失败账号进入冷却，冷却期内不再被选中
 *   - 会话亲和（sessionAffinity）：同一会话尽量落在同一账号，减少「换个账号重新计费/上下文抖动」
 *   - 失效（invalid）：上游返回 100002 判定登录态失效，交给管理台重新登录
 *   - 积分优先级（preferDailyPoints）：先烧完所有账号的「每日赠送积分」，再动永久积分
 *     —— 档位由 accounts.wallet 提供（见 core/points.js）；未知余额的账号不会阻塞其它账号
 */

import { ACCOUNT_STATUS, pointsTier } from './accounts.js'

export class Scheduler {
  constructor ({ accountStore, config, logger = null, pointsTracker = null }) {
    this.accountStore = accountStore
    this.config = config
    this.logger = logger
    this.pointsTracker = pointsTracker
    this.cursor = 0
    this.affinity = new Map()
  }

  setPointsTracker (pointsTracker) {
    this.pointsTracker = pointsTracker
  }

  get strategy () {
    return this.config.pool?.strategy || 'round-robin'
  }

  get cooldownSeconds () {
    return this.config.pool?.cooldownSeconds ?? 60
  }

  get affinityEnabled () {
    return this.config.pool?.sessionAffinity !== false
  }

  get affinityTtlMs () {
    return (this.config.pool?.affinityTtlSeconds ?? 1800) * 1000
  }

  /** 是否按「每日积分优先」排序。默认开启。 */
  get preferDailyPoints () {
    return this.config.pool?.preferDailyPoints !== false
  }

  refreshConfig (config) {
    this.config = config
  }

  available () {
    let pool = this.filter()
    if (pool.length === 0 && typeof this.accountStore.reload === 'function') {
      // 池子空了再从磁盘读一次：CLI 在另一进程里导入/登录的账号无需重启即可用
      if (this.accountStore.reload()) pool = this.filter()
    }
    return pool
  }

  filter () {
    const now = Date.now()
    return this.accountStore.list().filter((account) => {
      if (!account.enabled) return false
      if (account.status === ACCOUNT_STATUS.INVALID) return false
      if (account.cooldownUntil && account.cooldownUntil > now) return false
      return Boolean(account.session)
    })
  }

  /** 返回按优先级排好序的候选账号（第一个是首选）。 */
  candidates ({ affinityKey = '' } = {}) {
    const pool = this.available()
    if (pool.length === 0) return []

    // 顺手让积分余额保持新鲜（非阻塞，内部有 TTL 与去重）
    this.pointsTracker?.poke(pool)

    const pinnedId = this.affinityEnabled && affinityKey ? this.resolveAffinity(affinityKey) : ''
    const groups = this.preferDailyPoints ? groupByPointsTier(pool) : [pool]
    const ordered = []
    for (const group of groups) {
      if (group.length === 0) continue
      const pinned = pinnedId ? group.find((account) => account.id === pinnedId) : null
      if (pinned) ordered.push(pinned)
      ordered.push(...this.strategyOrder(group.filter((account) => account !== pinned)))
    }
    return ordered
  }

  strategyOrder (pool) {
    if (pool.length <= 1) return [...pool]
    if (this.strategy === 'weighted') return weightedOrder(pool)
    if (this.strategy === 'fill-first') return [...pool]
    return this.roundRobinOrder(pool)
  }

  roundRobinOrder (pool) {
    if (pool.length === 0) return []
    const start = this.cursor % pool.length
    this.cursor = (this.cursor + 1) % Math.max(1, pool.length)
    return [...pool.slice(start), ...pool.slice(0, start)]
  }

  resolveAffinity (key) {
    const entry = this.affinity.get(key)
    if (!entry) return ''
    if (Date.now() - entry.ts > this.affinityTtlMs) {
      this.affinity.delete(key)
      return ''
    }
    return entry.accountId
  }

  bindAffinity (key, accountId) {
    if (!this.affinityEnabled || !key || !accountId) return
    this.affinity.set(key, { accountId, ts: Date.now() })
    if (this.affinity.size > 2000) {
      // 简单 LRU 收敛：清掉最早的一批
      const entries = [...this.affinity.entries()].sort((a, b) => a[1].ts - b[1].ts)
      for (const [oldKey] of entries.slice(0, 500)) this.affinity.delete(oldKey)
    }
  }

  success (accountId, { points = 0, affinityKey = '' } = {}) {
    this.accountStore.markSuccess(accountId, { points })
    if (affinityKey) this.bindAffinity(affinityKey, accountId)
  }

  failure (accountId, { reason = '', authInvalid = false, retryAfterSeconds = 0 } = {}) {
    const cooldown = retryAfterSeconds > 0 ? retryAfterSeconds : this.cooldownSeconds
    this.accountStore.markFailure(accountId, { reason, cooldownSeconds: cooldown, invalid: authInvalid })
    if (authInvalid) {
      const account = this.accountStore.get(accountId)
      this.logger?.warn('账号登录态失效，已标记 invalid', { accountId, phone: account?.phone ? '***' : '' })
    }
  }

  summary () {
    return {
      strategy: this.strategy,
      available: this.available().length,
      affinityEntries: this.affinity.size,
      accounts: this.accountStore.summary(),
    }
  }
}

function weightedOrder (pool) {
  const remaining = [...pool]
  const out = []
  while (remaining.length > 0) {
    const totalWeight = remaining.reduce((sum, account) => sum + Math.max(1, account.weight || 1), 0)
    let ticket = Math.random() * totalWeight
    let index = remaining.length - 1
    for (let i = 0; i < remaining.length; i += 1) {
      ticket -= Math.max(1, remaining[i].weight || 1)
      if (ticket <= 0) { index = i; break }
    }
    out.push(remaining[index])
    remaining.splice(index, 1)
  }
  return out
}

/**
 * 按积分档位分细：0 有每日积分 → 1 未知 → 2 只剩永久 → 3 彻底没分。
 * 返回数组顺序即调度优先级；同一档内由 strategy（轮询/加权/填满）决定。
 */
function groupByPointsTier (pool) {
  const groups = [[], [], [], []]
  for (const account of pool) groups[pointsTier(account)].push(account)
  return groups
}
