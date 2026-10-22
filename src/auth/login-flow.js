/**
 * 手机号 + 短信验证码登录流程。
 *
 * 逆向依据 electron/xfyun/account-service.js + electron/ipc/xfyun-ipc.js：
 *   POST /login/phone/sendMsgCode  → 下发给客户端的只有 msgid（客户端负责保管）
 *   POST /login/phone/checkCode    → {base, param:{ccode, phone, mcode, msgid, expire}}
 *                                    返回 session（14 天有效）
 *   POST /userinfo/query/baseInfo  → 用 session 换 userid / phone / nickname
 *
 * 官方客户端把 msgid 存在渲染进程里，丢了就得重新发码。网关是长期运行的
 * 多用户服务，因此这里把「一次登录」提升为一等对象 pending：
 *
 *   start(phone)  → pending{ loginId, msgid, expiresAt, attemptsLeft }
 *   resend(id)    → 换新 msgid（受冷却约束）
 *   verify(id,pw) → 校验验证码、换取 session、落库账号（同人重复登录即刷新 auth）
 *
 * 安全约定：
 *   - 验证码只在上游请求里出现，绝不写日志/审计（审计只记手机号掩码与结果）；
 *   - session 只在返回给调用方的 account 里出现一次，磁盘里由 AccountStore 管理；
 *   - 发码有「同号冷却 + 同号/同 IP 每小时配额」，避免把账号服务当短信炮台。
 */

import { appendJsonl, readJsonFile, writeJsonFileAtomic } from '../util/store.js'
import { maskPhone } from '../core/accounts.js'

const PHONE_RE = /^1[3-9]\d{9}$/

export const LOGIN_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
}

/** 登录流程业务错误：带稳定的 code，路由层据此选 HTTP 状态码。 */
export class LoginError extends Error {
  constructor (message, { code = 'LOGIN_ERROR', status = 400, details = null } = {}) {
    super(message)
    this.name = 'LoginError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export class LoginFlow {
  constructor ({
    accountClient,
    accountStore,
    logger = null,
    config = {},
    auditFile = '',
    pendingFile = '',
    hooks = {},
    now = () => Date.now(),
  } = {}) {
    this.accountClient = accountClient
    this.accountStore = accountStore
    this.logger = logger
    this.auditFile = auditFile
    this.pendingFile = pendingFile
    this.hooks = hooks
    this.now = now
    const login = config.login || {}
    this.settings = {
      codeTtlSeconds: clamp(login.codeTtlSeconds, 60, 900, 300),
      pendingTtlSeconds: clamp(login.pendingTtlSeconds, 60, 3600, 900),
      resendCooldownSeconds: clamp(login.resendCooldownSeconds, 0, 600, 60),
      maxAttempts: clamp(login.maxAttempts, 1, 10, 5),
      maxSendsPerHour: clamp(login.maxSendsPerHour, 1, 100, 5),
      maxPending: clamp(login.maxPending, 1, 1000, 200),
    }
    /** @type {Map<string, object>} loginId → pending */
    this.pendings = new Map()
    /** 发码配额：key → { windowStart, count } */
    this.budgets = new Map()
    if (this.pendingFile) this.loadPendings()
  }

  /**
   * pending 落盘：CLI 两条命令（发码 / 填码）是两个进程，服务也可能重启，
   * 所以把未完成的登录流程连同 msgid 一起存到 data/login-pending.json（0600，随过期清理）。
   */
  loadPendings () {
    const parsed = readJsonFile(this.pendingFile, { pendings: [] })
    const now = this.now()
    for (const item of parsed?.pendings || []) {
      if (!item?.id || !item.phone || !item.msgid) continue
      if (item.status && item.status !== LOGIN_STATUS.PENDING) continue
      if (Number(item.expiresAt) && Number(item.expiresAt) < now) continue
      this.pendings.set(item.id, { ...item, status: LOGIN_STATUS.PENDING })
    }
    return this.pendings.size
  }

  persistPendings () {
    if (!this.pendingFile) return
    const pendingOnly = [...this.pendings.values()]
      .filter((item) => item.status === LOGIN_STATUS.PENDING)
      .map((item) => ({
        id: item.id,
        phone: item.phone,
        name: item.name,
        scene: item.scene,
        ccode: item.ccode,
        msgid: item.msgid,
        sends: item.sends,
        attempts: item.attempts,
        createdAt: item.createdAt,
        lastSentAt: item.lastSentAt,
        expiresAt: item.expiresAt,
        status: item.status,
      }))
    try {
      writeJsonFileAtomic(this.pendingFile, { version: 1, pendings: pendingOnly })
    } catch {
      /* 落盘失败只影响跨进程续跑，不影响本次登录 */
    }
  }

  get ready () {
    return Boolean(this.accountClient?.ready)
  }

  /** 配置热更新（管理台改了重发冷却/尝试次数后即时生效）。 */
  refreshConfig (config = {}) {
    const login = config.login || {}
    this.settings = {
      codeTtlSeconds: clamp(login.codeTtlSeconds, 60, 900, this.settings.codeTtlSeconds),
      pendingTtlSeconds: clamp(login.pendingTtlSeconds, 60, 3600, this.settings.pendingTtlSeconds),
      resendCooldownSeconds: clamp(login.resendCooldownSeconds, 0, 600, this.settings.resendCooldownSeconds),
      maxAttempts: clamp(login.maxAttempts, 1, 10, this.settings.maxAttempts),
      maxSendsPerHour: clamp(login.maxSendsPerHour, 1, 100, this.settings.maxSendsPerHour),
      maxPending: clamp(login.maxPending, 1, 1000, this.settings.maxPending),
    }
    return this.settings
  }

  // ---------------------------------------------------------------- 发码

  /** 开始一次登录：校验手机号 → 占配额 → 请求上游发码 → 返回 pending 视图。 */
  async start (phone, { ip = '', scene = 'login', name = '' } = {}) {
    this.sweep()
    const normalized = String(phone || '').trim()
    if (!PHONE_RE.test(normalized)) {
      throw new LoginError('手机号格式不正确（需 11 位大陆手机号）', { code: 'INVALID_PHONE' })
    }
    this.requireReady()
    this.consumeBudget(`phone:${normalized}`)
    if (ip) this.consumeBudget(`ip:${ip}`)

    const sent = await this.sendCode(normalized, scene)
    const now = this.now()
    const pending = {
      id: `login_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      phone: normalized,
      name: String(name || '').trim(),
      ip,
      scene,
      ccode: '86',
      msgid: sent.msgid,
      sends: 1,
      attempts: 0,
      createdAt: now,
      lastSentAt: now,
      expiresAt: now + this.settings.pendingTtlSeconds * 1000,
      status: LOGIN_STATUS.PENDING,
    }
    this.pendings.set(pending.id, pending)
    this.enforceCapacity()
    this.persistPendings()
    this.audit('send', pending, { ok: true })
    this.logger?.info('短信验证码已发送', { phone: maskPhone(normalized), loginId: pending.id, ip })
    return this.view(pending)
  }

  /** 重新发码：复用同一条 pending，只换 msgid，受冷却与小时配额约束。 */
  async resend (loginId, { ip = '' } = {}) {
    this.sweep()
    const pending = this.requirePending(loginId)
    if (pending.status !== LOGIN_STATUS.PENDING) {
      throw new LoginError('该登录流程已结束，请重新开始', { code: 'LOGIN_CLOSED', status: 409 })
    }
    const elapsed = this.now() - pending.lastSentAt
    const cooldownMs = this.settings.resendCooldownSeconds * 1000
    if (elapsed < cooldownMs) {
      throw new LoginError(`请等待 ${Math.ceil((cooldownMs - elapsed) / 1000)} 秒后再重发`, {
        code: 'RESEND_COOLDOWN',
        status: 429,
        details: { retryAfterSeconds: Math.ceil((cooldownMs - elapsed) / 1000) },
      })
    }
    this.requireReady()
    this.consumeBudget(`phone:${pending.phone}`)
    if (ip) this.consumeBudget(`ip:${ip}`)

    const sent = await this.sendCode(pending.phone, pending.scene)
    pending.msgid = sent.msgid
    pending.sends += 1
    pending.lastSentAt = this.now()
    pending.expiresAt = pending.lastSentAt + this.settings.pendingTtlSeconds * 1000
    pending.attempts = 0
    this.persistPendings()
    this.audit('resend', pending, { ok: true })
    this.logger?.info('短信验证码已重发', { phone: maskPhone(pending.phone), loginId: pending.id, sends: pending.sends })
    return this.view(pending)
  }

  // ---------------------------------------------------------------- 校验

  /**
   * 校验验证码并落库账号。
   * 同一手机号/同一 userid 再次登录时不会新建账号，而是把 session 换成新的（相当于刷新 auth）。
   */
  async verify (loginId, code, { ip = '', name = '' } = {}) {
    this.sweep()
    const pending = this.requirePending(loginId)
    if (pending.status === LOGIN_STATUS.CANCELLED) {
      throw new LoginError('该登录流程已取消', { code: 'LOGIN_CLOSED', status: 409 })
    }
    if (pending.status === LOGIN_STATUS.VERIFIED) {
      throw new LoginError('该登录流程已完成，请勿重复提交', { code: 'LOGIN_CLOSED', status: 409 })
    }
    if (this.now() > pending.expiresAt) {
      pending.status = LOGIN_STATUS.EXPIRED
      throw new LoginError('验证码已过期，请重新获取', { code: 'LOGIN_EXPIRED', status: 410 })
    }
    const mcode = String(code || '').trim()
    if (!/^\d{4,8}$/.test(mcode)) {
      throw new LoginError('验证码格式不正确', { code: 'INVALID_CODE' })
    }
    if (pending.attempts >= this.settings.maxAttempts) {
      throw new LoginError('验证码尝试次数过多，请重新获取', { code: 'TOO_MANY_ATTEMPTS', status: 429 })
    }
    this.requireReady()
    pending.attempts += 1
    this.persistPendings()

    let data
    try {
      data = await this.accountClient.loginBySmsCode(pending.phone, mcode, pending.msgid, { ccode: pending.ccode })
    } catch (error) {
      const authFailed = error?.isAuthError || Number(pending.attempts) >= this.settings.maxAttempts
      this.audit('verify', pending, { ok: false, code: error?.code || 'ERROR', error: error.message })
      this.logger?.warn('短信登录校验失败', {
        phone: maskPhone(pending.phone),
        loginId: pending.id,
        attempts: pending.attempts,
        code: error?.code || '',
      })
      throw new LoginError(error?.message || '验证码校验失败', {
        code: error?.code || 'VERIFY_FAILED',
        // 验证码错是 400；上游不可用时用 502，便于客户端区分「重试」与「重填」
        status: error?.status && error.status >= 500 ? 502 : 400,
        details: { attemptsLeft: Math.max(0, this.settings.maxAttempts - pending.attempts), authFailed },
      })
    }

    const login = extractLoginResult(data || {})
    if (!login.session) {
      throw new LoginError('登录成功但上游未返回 session', { code: 'NO_SESSION', status: 502 })
    }

    // 用 session 换资料；失败不影响登录成功，资料下次校验还能补
    let profile = {}
    try {
      profile = (await this.accountClient.getUserInfo(login.session)) || {}
    } catch (error) {
      this.logger?.warn('登录后查询用户信息失败（不影响入库）', { phone: maskPhone(pending.phone), error: error.message })
    }

    const account = this.upsertAccount({
      name: pending.name || name || String(profile.nickname || ''),
      session: login.session,
      userid: login.userid || String(profile.userid || ''),
      phone: pending.phone || String(profile.phone || ''),
      nickname: login.nickname || String(profile.nickname || ''),
    })

    pending.status = LOGIN_STATUS.VERIFIED
    pending.verifiedAt = this.now()
    pending.accountId = account.record.id
    this.persistPendings()
    this.audit('verify', pending, { ok: true, accountId: account.record.id, created: account.created })
    this.logger?.info('短信登录成功', {
      phone: maskPhone(pending.phone),
      accountId: account.record.id,
      created: account.created,
      nickname: account.record.nickname,
    })

    let after = null
    if (typeof this.hooks.afterLogin === 'function') {
      try {
        after = await this.hooks.afterLogin(account.record, { created: account.created })
      } catch (error) {
        this.logger?.warn('登录后置动作失败', { accountId: account.record.id, error: error.message })
      }
    }

    return {
      account: this.accountStore.toPublic(account.record),
      created: account.created,
      profile: {
        userid: account.record.userid,
        phone: maskPhone(account.record.phone),
        nickname: account.record.nickname,
      },
      after,
    }
  }

  /**
   * 兼容旧调用：调用方自己保管 msgid（管理台旧版、脚本、外部集成）。
   * 会临时构造一条 pending，行为与 verify 一致，但不参与重发与状态查询。
   */
  async verifyWithMsgid ({ phone, code, msgid }, { ip = '', name = '' } = {}) {
    const normalized = String(phone || '').trim()
    if (!PHONE_RE.test(normalized) || !msgid) {
      throw new LoginError('phone / code / msgid 都必须提供', { code: 'INVALID_PHONE' })
    }
    const now = this.now()
    const pending = {
      id: `login_legacy_${now.toString(36)}`,
      phone: normalized,
      name: String(name || '').trim(),
      ip,
      scene: 'login',
      ccode: '86',
      msgid: String(msgid),
      sends: 1,
      attempts: 0,
      createdAt: now,
      lastSentAt: now,
      expiresAt: now + this.settings.codeTtlSeconds * 1000,
      status: LOGIN_STATUS.PENDING,
      legacy: true,
    }
    this.pendings.set(pending.id, pending)
    try {
      return await this.verify(pending.id, code, { ip, name })
    } finally {
      this.pendings.delete(pending.id)
    }
  }

  // ---------------------------------------------------------------- 查询/取消

  status (loginId) {
    this.sweep()
    const pending = this.pendings.get(String(loginId || ''))
    return pending ? this.view(pending) : null
  }

  cancel (loginId, { ip = '' } = {}) {
    const pending = this.pendings.get(String(loginId || ''))
    if (!pending) throw new LoginError('登录流程不存在或已过期', { code: 'NOT_FOUND', status: 404 })
    pending.status = LOGIN_STATUS.CANCELLED
    pending.cancelledAt = this.now()
    this.audit('cancel', pending, { ok: true })
    this.pendings.delete(pending.id)
    this.persistPendings()
    return { ok: true }
  }

  list () {
    this.sweep()
    return [...this.pendings.values()].map((pending) => this.view(pending))
  }

  // ---------------------------------------------------------------- 内部

  sendCode (phone, scene) {
    return this.accountClient
      .sendSmsCode(phone, { scene })
      .then((data) => {
        const msgid = String(data?.msgid || data?.msgId || '').trim()
        if (!msgid) throw new LoginError('上游未返回 msgid，短信可能未发出', { code: 'NO_MSGID', status: 502 })
        return { msgid }
      })
      .catch((error) => {
        if (error instanceof LoginError) throw error
        throw new LoginError(`发送验证码失败：${error?.message || '未知错误'}`, {
          code: error?.code || 'SEND_FAILED',
          status: error?.status && error.status >= 500 ? 502 : 400,
        })
      })
  }

  requireReady () {
    if (!this.ready) {
      throw new LoginError('缺少讯飞账号签名凭据（需在 Loomy 安装目录的 .env 中提供 AK/SK）', {
        code: 'CREDENTIALS_MISSING',
        status: 503,
      })
    }
  }

  requirePending (loginId) {
    const pending = this.pendings.get(String(loginId || ''))
    if (!pending) throw new LoginError('登录流程不存在或已过期，请重新获取验证码', { code: 'NOT_FOUND', status: 404 })
    if (pending.expiresAt && this.now() > pending.expiresAt && pending.status === LOGIN_STATUS.PENDING) {
      pending.status = LOGIN_STATUS.EXPIRED
      throw new LoginError('登录流程已过期，请重新获取验证码', { code: 'LOGIN_EXPIRED', status: 410 })
    }
    return pending
  }

  /** 同号/同 IP 的发送配额（滑动小时窗），防止验证码轰炸。 */
  consumeBudget (key) {
    const now = this.now()
    const hour = 3600 * 1000
    const entry = this.budgets.get(key)
    if (!entry || now - entry.windowStart > hour) {
      this.budgets.set(key, { windowStart: now, count: 1 })
      return
    }
    if (entry.count >= this.settings.maxSendsPerHour) {
      const retryAfterSeconds = Math.ceil((entry.windowStart + hour - now) / 1000)
      throw new LoginError(`发送过于频繁，请 ${Math.ceil(retryAfterSeconds / 60)} 分钟后再试`, {
        code: 'SEND_QUOTA_EXCEEDED',
        status: 429,
        details: { retryAfterSeconds },
      })
    }
    entry.count += 1
  }

  /** 同一手机号/同一 userid 视为同一个人：换 session 而不是新建账号。 */
  upsertAccount (input) {
    const existing = this.accountStore
      .list()
      .find((account) => (input.userid && account.userid === input.userid) || (input.phone && account.phone === input.phone))
    if (!existing) {
      const result = this.accountStore.add(input)
      return { record: result.account, created: result.created }
    }
    const patch = {
      session: input.session,
      status: 'active',
    }
    if (input.userid) patch.userid = input.userid
    if (input.phone) patch.phone = input.phone
    if (input.nickname) patch.nickname = input.nickname
    if (input.name && !existing.name) patch.name = input.name
    const updated = this.accountStore.update(existing.id, patch)
    this.logger?.info('短信重新登录，已刷新账号 session', { accountId: existing.id, phone: maskPhone(input.phone) })
    return { record: updated, created: false }
  }

  sweep () {
    const now = this.now()
    let dirty = false
    for (const [id, pending] of this.pendings) {
      if (pending.status !== LOGIN_STATUS.PENDING) {
        // 已结束的流程保留一段时间供前端查询结果
        if (now - (pending.verifiedAt || pending.cancelledAt || pending.expiresAt) > 120_000) this.pendings.delete(id)
        continue
      }
      if (now > pending.expiresAt) {
        pending.status = LOGIN_STATUS.EXPIRED
        dirty = true
      }
    }
    for (const [key, entry] of this.budgets) {
      if (now - entry.windowStart > 3600 * 1000 * 2) this.budgets.delete(key)
    }
    if (dirty) this.persistPendings()
  }

  enforceCapacity () {
    if (this.pendings.size <= this.settings.maxPending) return
    const ordered = [...this.pendings.values()].sort((a, b) => a.createdAt - b.createdAt)
    while (this.pendings.size > this.settings.maxPending) {
      const oldest = ordered.shift()
      if (!oldest) break
      this.pendings.delete(oldest.id)
    }
  }

  view (pending) {
    const now = this.now()
    const cooldownMs = this.settings.resendCooldownSeconds * 1000
    const elapsed = now - pending.lastSentAt
    return {
      loginId: pending.id,
      phoneMasked: maskPhone(pending.phone),
      status: pending.status,
      sends: pending.sends,
      attempts: pending.attempts,
      attemptsLeft: Math.max(0, this.settings.maxAttempts - pending.attempts),
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
      expiresInSeconds: Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)),
      canResendAt: pending.lastSentAt + cooldownMs,
      resendAfterSeconds: Math.max(0, Math.ceil((cooldownMs - elapsed) / 1000)),
      accountId: pending.accountId || '',
    }
  }

  audit (action, pending, extra = {}) {
    if (!this.auditFile) return
    try {
      appendJsonl(this.auditFile, {
        ts: this.now(),
        action,
        loginId: pending?.id || '',
        phone: pending?.phone ? maskPhone(pending.phone) : '',
        ip: pending?.ip || '',
        sends: pending?.sends || 0,
        attempts: pending?.attempts || 0,
        ...extra,
      })
    } catch {
      /* 审计写失败不能影响登录 */
    }
  }
}

/** 从 checkCode 返回值里稳妥地取 session 与用户信息（与 account.js 保持一致）。 */
export function extractLoginResult (data = {}) {
  const session = String(data.session || data.token || data.data?.session || '').trim()
  return {
    session,
    userid: String(data.userid || data.userId || '').trim(),
    phone: String(data.phone || data.mobile || '').trim(),
    nickname: String(data.nickname || data.nickName || '').trim(),
  }
}

function clamp (value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}
