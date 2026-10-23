/**
 * 积分观测：拉取每个账号「每日积分 / 永久积分」余额，供调度器做优先级排序。
 *
 * 上游 `GET /api/v2/points/records`（头 `token: <session>`）返回：
 *   { balance, dailyBalance, list:[…] }
 *     balance      = 永久积分（不过期，用完为止）
 *     dailyBalance = 每日赠送积分（当天有效，跨天重置）
 *
 * 需求：先把每日赠送的积分用掉，所有账号的每日积分都归零后，才动永久积分。
 * 扣分先后由上游服务端决定，网关唯一能做的是「选账号」——把仍带每日积分的账号排在前面。
 * 因此这里只做三件事：
 *   1. 按 TTL 定时 / 按需拉取余额，写进 accounts.json 的 account.wallet；
 *   2. 请求成功后按 points_consumed 做本地估算扣减（每日优先），让「见底」立刻反映到排序；
 *   3. 估算见底时尽快向上游确认一次，避免估算误差导致长期误判。
 */

const DEFAULT_TTL_SECONDS = 300
const DEFAULT_MIN_REFRESH_SECONDS = 60
const MAX_PARALLEL = 3

export class PointsTracker {
  constructor ({ accountStore, upstream, config = {}, logger = null, now = () => Date.now() } = {}) {
    this.accountStore = accountStore
    this.upstream = upstream
    this.config = config
    this.logger = logger
    this.now = now
    this.inflight = new Set()
    this.lastAttempt = new Map()
    this.timer = null
  }

  get enabled () {
    return this.config?.pool?.preferDailyPoints !== false
  }

  get ttlMs () {
    const seconds = Number(this.config?.pool?.pointsRefreshSeconds) || DEFAULT_TTL_SECONDS
    return Math.max(10, seconds) * 1000
  }

  get minIntervalMs () {
    const seconds = Number(this.config?.pool?.pointsMinRefreshSeconds) || DEFAULT_MIN_REFRESH_SECONDS
    return Math.max(1, seconds) * 1000
  }

  refreshConfig (config) {
    this.config = config
    if (this.timer) this.start()
  }

  /** 本地估算已经把每日积分扣到 0，但还没跟上游核对过。 */
  estimateExhausted (account) {
    const wallet = account?.wallet
    if (!wallet || !wallet.checkedAt) return false
    if (Number(wallet.daily) > 0) return false
    return Number(wallet.estimatedAt) > Number(wallet.checkedAt)
  }

  shouldRefresh (account) {
    if (!this.enabled) return false
    if (!account?.session) return false
    const checkedAt = Number(account.wallet?.checkedAt) || 0
    if (!checkedAt) return true
    if (this.now() - checkedAt >= this.ttlMs) return true
    return this.estimateExhausted(account)
  }

  /** 非阻塞：对候选池里需要更新的账号发起刷新（受最小间隔与并发去重约束）。 */
  poke (pool = []) {
    if (!this.enabled) return
    for (const account of pool || []) {
      if (!this.shouldRefresh(account)) continue
      if (this.inflight.has(account.id)) continue
      const last = this.lastAttempt.get(account.id) || 0
      if (this.now() - last < this.minIntervalMs) continue
      this.refreshAccount(account.id, { reason: 'schedule' }).catch(() => {})
    }
  }

  /**
   * 刷新单个账号的积分余额。
   * @returns {Promise<{ok:boolean, accountId:string, wallet?:object, skipped?:string, error?:object}>}
   */
  async refreshAccount (id, { force = false, reason = '' } = {}) {
    const account = this.accountStore.get(id)
    if (!account || !account.session) return { ok: false, accountId: String(id || ''), skipped: 'no-account' }
    if (this.inflight.has(account.id)) return { ok: false, accountId: account.id, skipped: 'inflight' }
    const last = this.lastAttempt.get(account.id) || 0
    if (!force && this.now() - last < this.minIntervalMs) {
      return { ok: false, accountId: account.id, skipped: 'throttled' }
    }

    this.inflight.add(account.id)
    this.lastAttempt.set(account.id, this.now())
    try {
      const result = await this.upstream.fetchPoints(account.session)
      if (!result?.ok) {
        const error = result?.error || { code: 'POINTS_FAILED', message: '积分查询失败' }
        this.accountStore.markPoints(account.id, { ok: false, error: `${error.code || ''}: ${error.message || ''}`.trim(': ') })
        this.logger?.debug?.('积分查询失败', { accountId: account.id, reason, code: error.code })
        return { ok: false, accountId: account.id, error }
      }
      const wallet = this.accountStore.markPoints(account.id, {
        ok: true,
        balance: result.data?.balance,
        daily: result.data?.dailyBalance,
      })
      return { ok: true, accountId: account.id, wallet }
    } catch (error) {
      this.accountStore.markPoints(account.id, { ok: false, error: String(error?.message || error).slice(0, 200) })
      return { ok: false, accountId: account.id, error: { code: 'POINTS_FAILED', message: error?.message || String(error) } }
    } finally {
      this.inflight.delete(account.id)
    }
  }

  /** 批量刷新（管理台按钮 / 启动自检用）。 */
  async refreshAll ({ force = true, ids = null } = {}) {
    const targets = (ids && ids.length > 0 ? ids.map((id) => this.accountStore.get(id)).filter(Boolean) : this.accountStore.list())
      .filter((account) => account.session && account.enabled !== false)
    const results = []
    for (let i = 0; i < targets.length; i += MAX_PARALLEL) {
      const chunk = targets.slice(i, i + MAX_PARALLEL)
      results.push(...await Promise.all(chunk.map((account) => this.refreshAccount(account.id, { force, reason: 'bulk' }))))
    }
    return {
      ok: results.every((item) => item.ok),
      refreshed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok && !item.skipped).length,
      skipped: results.filter((item) => item.skipped).length,
      results,
      summary: this.summary(),
    }
  }

  start () {
    this.stop()
    const interval = Math.max(15, Math.min(this.ttlMs, Math.max(15, this.ttlMs / 2)))
    this.timer = setInterval(() => {
      this.refreshAll({ force: false }).catch(() => {})
    }, interval)
    this.timer.unref?.()
    return this.timer
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  summary () {
    const accounts = this.accountStore.list()
    const dailyReady = accounts.filter((account) => (Number(account.wallet?.daily) || 0) > 0)
    return {
      enabled: this.enabled,
      total: accounts.length,
      dailyReady: dailyReady.length,
      dailyPoints: accounts.reduce((sum, account) => sum + (Number(account.wallet?.daily) || 0), 0),
      permanentPoints: accounts.reduce((sum, account) => sum + (Number(account.wallet?.balance) || 0), 0),
      checkedAt: accounts.reduce((latest, account) => Math.max(latest, Number(account.wallet?.checkedAt) || 0), 0),
    }
  }
}
