/**
 * 短信登录流程离线单测。
 *
 * 全部用假的 accountClient，不发真实短信、不碰网络：
 * 覆盖发码 / 重发冷却 / 配额 / 尝试次数 / 过期 / 账号 upsert / 旧 msgid 兼容 / 落盘与审计。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LoginFlow, LoginError, LOGIN_STATUS } from '../src/auth/login-flow.js'
import { AccountApiError } from '../src/auth/account.js'
import { AccountStore } from '../src/core/accounts.js'

const PHONE = '13800001111'
const PHONE2 = '13900002222'

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-login-'))
}

class FakeClient {
  constructor () {
    this.ready = true
    this.lastSession = ''
    this.seq = 0
    this.calls = []
    this.sendError = null
    this.verifyError = null
    this.profileError = null
    this.msgid = null
  }

  async sendSmsCode (phone, options = {}) {
    this.calls.push({ type: 'send', phone, options })
    if (this.sendError) throw this.sendError
    const msgid = this.msgid ?? `msg-${++this.seq}`
    return { msgid }
  }

  async loginBySmsCode (phone, code, msgid) {
    this.calls.push({ type: 'verify', phone, code, msgid })
    if (this.verifyError) throw this.verifyError
    this.lastSession = `sess-${++this.seq}`
    return { session: this.lastSession, userid: 'u-1', nickname: '测试用户' }
  }

  async getUserInfo () {
    if (this.profileError) throw this.profileError
    return { userid: 'u-1', phone: PHONE, nickname: '测试用户' }
  }
}

function makeFlow (overrides = {}) {
  const dir = tempDir()
  const accountStore = overrides.accountStore || new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const client = overrides.client || new FakeClient()
  const flow = new LoginFlow({
    accountClient: client,
    accountStore,
    config: { login: { resendCooldownSeconds: 60, maxAttempts: 3, maxSendsPerHour: 5, pendingTtlSeconds: 900, ...(overrides.login || {}) } },
    auditFile: path.join(dir, 'login-audit.jsonl'),
    pendingFile: path.join(dir, 'login-pending.json'),
    hooks: overrides.hooks || {},
    now: overrides.now || (() => Date.now()),
  })
  return { flow, client, accountStore, dir }
}

test('start：返回 loginId 与倒计时，示例中不含 msgid / session', async () => {
  const { flow } = makeFlow()
  const view = await flow.start(PHONE)
  assert.match(view.loginId, /^login_/)
  assert.equal(view.phoneMasked, '138****1111')
  assert.equal(view.status, LOGIN_STATUS.PENDING)
  assert.equal(view.attemptsLeft, 3)
  assert.ok(view.expiresInSeconds > 0)
  assert.equal(view.resendAfterSeconds, 60)
  assert.equal(Object.keys(view).some((key) => /msgid|session/i.test(key)), false)
})

test('start：手机号非法 / 缺少凭据 / 上游失败 / 无 msgid 都要明确报错', async () => {
  const { flow, client } = makeFlow()
  await assert.rejects(() => flow.start('12345'), (error) => error.code === 'INVALID_PHONE')

  client.ready = false
  await assert.rejects(() => flow.start(PHONE), (error) => error.code === 'CREDENTIALS_MISSING' && error.status === 503)
  client.ready = true

  client.sendError = new AccountApiError('短信服务繁忙', { code: '100001', status: 500 })
  await assert.rejects(() => flow.start(PHONE2), (error) => error.code === '100001' && error.status === 502)
  client.sendError = null

  client.msgid = ''
  await assert.rejects(() => flow.start(PHONE2), (error) => error.code === 'NO_MSGID')
})

test('resend：冷却期内拒绝并给出剩余秒，冷却后换新 msgid 且重置尝试次数', async () => {
  let now = 1_800_000_000_000
  const { flow, client } = makeFlow({ now: () => now })
  const view = await flow.start(PHONE)

  await assert.rejects(() => flow.resend(view.loginId), (error) => {
    assert.equal(error.code, 'RESEND_COOLDOWN')
    assert.equal(error.status, 429)
    assert.ok(error.details.retryAfterSeconds > 0)
    return true
  })

  now += 61_000
  const again = await flow.resend(view.loginId)
  assert.equal(again.sends, 2)
  assert.equal(again.attemptsLeft, 3)
  const sends = client.calls.filter((call) => call.type === 'send')
  assert.equal(sends.length, 2)
  assert.notEqual(sends[0].options, undefined)
})

test('start：同号每小时配额用尽后拒绝（429）', async () => {
  let now = 1_800_000_000_000
  const { flow } = makeFlow({ now: () => now, login: { maxSendsPerHour: 2 } })
  await flow.start(PHONE)
  const second = await flow.start(PHONE)
  await flow.resend(second.loginId).catch(() => {})
  now += 61_000
  await flow.resend(second.loginId).catch(() => {})
  await assert.rejects(() => flow.start(PHONE), (error) => error.code === 'SEND_QUOTA_EXCEEDED' && error.status === 429)
})

test('verify：验证码正确 → 落库账号并触发 afterLogin；session 不进审计日志', async () => {
  const events = []
  const { flow, accountStore, dir } = makeFlow({
    hooks: { afterLogin: async (account) => { events.push(account.id); return { models: { ok: true, count: 13 } } } },
  })
  const view = await flow.start(PHONE)
  const result = await flow.verify(view.loginId, '123456')

  assert.equal(result.created, true)
  assert.equal(result.account.phone, '138****1111')
  assert.ok(result.account.sessionMasked.includes('****'))
  assert.equal(result.profile.nickname, '测试用户')
  assert.deepEqual(result.after, { models: { ok: true, count: 13 } })
  assert.equal(events.length, 1)
  assert.equal(accountStore.list().length, 1)
  assert.ok(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8').includes('sess-'))

  const audit = fs.readFileSync(path.join(dir, 'login-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(audit.map((row) => row.action), ['send', 'verify'])
  assert.equal(audit[1].ok, true)
  assert.equal(audit.some((row) => JSON.stringify(row).includes('sess-')), false)
  assert.equal(audit.some((row) => JSON.stringify(row).includes('123456')), false)
})

test('verify：同一手机号再次登录不新建账号，而是刷新 session', async () => {
  const { flow, accountStore, client } = makeFlow()
  const first = await flow.verify((await flow.start(PHONE)).loginId, '111111')
  const second = await flow.verify((await flow.start(PHONE)).loginId, '222222')

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.account.id, first.account.id)
  assert.equal(accountStore.list().length, 1)
  const stored = accountStore.list()[0]
  assert.equal(stored.session, client.lastSession)
  assert.equal(stored.status, 'active')
})

test('verify：验证码错误累计尝试次数，用尽后拒绝继续', async () => {
  const { flow, client } = makeFlow({ login: { maxAttempts: 2 } })
  const view = await flow.start(PHONE)
  client.verifyError = new AccountApiError('验证码错误', { code: '100001', status: 200 })

  await assert.rejects(() => flow.verify(view.loginId, '000000'), (error) => {
    assert.equal(error.code, '100001')
    assert.equal(error.details.attemptsLeft, 1)
    return true
  })
  await assert.rejects(() => flow.verify(view.loginId, '000000'), (error) => {
    assert.equal(error.details.attemptsLeft, 0)
    return true
  })
  await assert.rejects(() => flow.verify(view.loginId, '000000'), (error) => error.code === 'TOO_MANY_ATTEMPTS' && error.status === 429)

  client.verifyError = null
  await assert.rejects(() => flow.verify(view.loginId, '000000'), (error) => error.code === 'TOO_MANY_ATTEMPTS')
})

test('verify：验证码格式 / 流程不存在 / 过期 都有独立错误码', async () => {
  let now = 1_800_000_000_000
  const { flow } = makeFlow({ now: () => now })
  const view = await flow.start(PHONE)

  await assert.rejects(() => flow.verify(view.loginId, 'abc'), (error) => error.code === 'INVALID_CODE')
  await assert.rejects(() => flow.verify('login_nope', '1234'), (error) => error.code === 'NOT_FOUND' && error.status === 404)

  now += 901_000
  await assert.rejects(() => flow.verify(view.loginId, '123456'), (error) => error.code === 'LOGIN_EXPIRED' && error.status === 410)
  assert.equal(flow.status(view.loginId).status, LOGIN_STATUS.EXPIRED)
})

test('verify：上游未返回 session 时报 502，不写账号', async () => {
  const { flow, client, accountStore } = makeFlow()
  const view = await flow.start(PHONE)
  client.loginBySmsCode = async () => ({ userid: 'u-1' })
  await assert.rejects(() => flow.verify(view.loginId, '123456'), (error) => error.code === 'NO_SESSION' && error.status === 502)
  assert.equal(accountStore.list().length, 0)
})

test('verify：资料接口失败不影响登录成功', async () => {
  const { flow, client } = makeFlow()
  const view = await flow.start(PHONE)
  client.profileError = new Error('profile down')
  const result = await flow.verify(view.loginId, '123456')
  assert.equal(result.created, true)
  assert.ok(result.account.id)
})

test('verifyWithMsgid：兼容旧调用（客户端自带 msgid）', async () => {
  const { flow } = makeFlow()
  const result = await flow.verifyWithMsgid({ phone: PHONE, code: '123456', msgid: 'msg-legacy' })
  assert.equal(result.created, true)
  assert.match(result.account.id, /^acc_/)
  assert.equal(flow.list().length, 0)
})

test('status / cancel：能查能取消，取消后再校验报错', async () => {
  const { flow } = makeFlow()
  const view = await flow.start(PHONE)
  assert.equal(flow.status(view.loginId).loginId, view.loginId)
  assert.deepEqual(flow.cancel(view.loginId), { ok: true })
  assert.equal(flow.status(view.loginId), null)
  await assert.rejects(() => flow.verify(view.loginId, '123456'), (error) => error.code === 'NOT_FOUND')
  assert.throws(() => flow.cancel('login_missing'), (error) => error.code === 'NOT_FOUND')
})

test('pending 落盘：新实例可以续跑；已完成的流程不再恢复', async () => {
  const dir = tempDir()
  const pendingFile = path.join(dir, 'login-pending.json')
  const accountStore = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const client = new FakeClient()
  const options = {
    accountClient: client,
    accountStore,
    config: { login: { resendCooldownSeconds: 0 } },
    pendingFile,
    auditFile: path.join(dir, 'audit.jsonl'),
  }
  const first = new LoginFlow(options)
  const view = await first.start(PHONE)

  const second = new LoginFlow(options)
  assert.equal(second.status(view.loginId)?.loginId, view.loginId)
  const result = await second.verify(view.loginId, '123456')
  assert.equal(result.created, true)

  const third = new LoginFlow(options)
  assert.equal(third.status(view.loginId), null)
  assert.equal(JSON.parse(fs.readFileSync(pendingFile, 'utf8')).pendings.length, 0)
})

test('refreshConfig：热更新重发冷却与尝试次数', async () => {
  const { flow } = makeFlow()
  assert.equal(flow.settings.maxAttempts, 3)
  flow.refreshConfig({ login: { maxAttempts: 6, resendCooldownSeconds: 0 } })
  assert.equal(flow.settings.maxAttempts, 6)
  assert.equal(flow.settings.resendCooldownSeconds, 0)
  const view = await flow.start(PHONE)
  assert.equal(view.attemptsLeft, 6)
  assert.equal(view.resendAfterSeconds, 0)
})

test('LoginError 默认状态码与消息', () => {
  const error = new LoginError('示例错误')
  assert.equal(error.status, 400)
  assert.equal(error.code, 'LOGIN_ERROR')
  assert.equal(error.name, 'LoginError')
})
