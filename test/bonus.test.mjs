import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AccountStore } from '../src/core/accounts.js'
import { ONBOARDING_TASKS, claimAccountBonus, formatBonusLine, pickPoolInviteCode, summarizeBonus } from '../src/core/bonus.js'

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-proxy-bonus-'))
}

const SESSION = (char) => char.repeat(32)

/**
 * 假上游：只实现 bonus 用到的 5 个接口，记录调用顺序以便断言「有没有真的发写请求」。
 */
function fakeUpstream (options = {}) {
  const calls = []
  const codes = options.codes || {}
  const tasks = { ...(options.tasks || {}) }
  let activation = options.activation || { activated: false }

  return {
    calls,
    countOf (method) {
      return calls.filter((call) => call.method === method).length
    },
    async fetchActivation (session) {
      calls.push({ method: 'fetchActivation', session })
      if (options.activationFails) return { ok: false, error: { code: 'HTTP_500', message: 'boom' } }
      return { ok: true, data: activation }
    },
    async fetchInvitationCodes (session) {
      calls.push({ method: 'fetchInvitationCodes', session })
      return { ok: true, data: { list: codes[session] || [] } }
    },
    async bindInviteCode (session, inviteCode) {
      calls.push({ method: 'bindInviteCode', session, inviteCode })
      if (options.bindFails) return { ok: false, error: { code: '100002', message: '码无效' } }
      activation = { activated: true, appliedInvitationCode: inviteCode }
      return { ok: true, data: { inviteeReward: 5000, registerReward: 5000, permanentBalance: 20000, currentBalance: 25000 } }
    },
    async fetchOnboardingTasks (session) {
      calls.push({ method: 'fetchOnboardingTasks', session })
      if (options.tasksFail) return { ok: false, error: { code: 'HTTP_500', message: 'tasks down' } }
      return { ok: true, data: { tasks: { ...tasks }, earned: 0, total: 10000 } }
    },
    async completeOnboardingTask (session, key) {
      calls.push({ method: 'completeOnboardingTask', session, key })
      const already = tasks[key] === true
      tasks[key] = true
      return { ok: true, data: { alreadyCompleted: already, balance: 10000 } }
    },
  }
}

function seedPool ({ codes = {} } = {}) {
  const accountStore = new AccountStore({ filePath: path.join(tempDir(), 'accounts.json') })
  const inviter = accountStore.add({ name: '码主', session: SESSION('a'), userid: 'u-inviter', phone: '13800000001' }).account
  const target = accountStore.add({ name: '新号', session: SESSION('b'), userid: 'u-target', phone: '13900000002' }).account
  const disabled = accountStore.add({ name: '停用号', session: SESSION('c'), phone: '13700000003' }).account
  accountStore.update(disabled.id, { enabled: false })
  const upstream = fakeUpstream({
    codes: {
      [SESSION('a')]: codes.inviter ?? [{ inviteCode: 'AAA111', usedCount: 0, maxUses: 1000, status: 'active' }],
      [SESSION('c')]: [{ inviteCode: 'DISABLED', usedCount: 0, maxUses: 1000, status: 'active' }],
    },
  })
  return { accountStore, inviter, target, disabled, upstream }
}

test('pickPoolInviteCode：跳过停用账号与已用尽的码，返回活跃码与码主', async () => {
  const { accountStore, inviter, target, upstream } = seedPool({
    codes: {
      // 码主自己的码已用尽 → 不能选它；停用账号的码不该被请求
      inviter: [{ inviteCode: 'USEDUP', usedCount: 1000, maxUses: 1000, status: 'active' }],
    },
  })
  // 再放一个正常码主，验证「用尽的码会继续往下找」
  const second = accountStore.add({ name: '码主2', session: SESSION('d'), phone: '13600000004' }).account
  upstream.calls.length = 0
  const original = upstream.fetchInvitationCodes
  upstream.fetchInvitationCodes = async function (session) {
    if (session === SESSION('d')) {
      this.calls.push({ method: 'fetchInvitationCodes', session })
      return { ok: true, data: { list: [{ inviteCode: 'BBB222', usedCount: 1, maxUses: 1000, status: 'active' }] } }
    }
    return original.call(this, session)
  }

  const picked = await pickPoolInviteCode({ accountStore, upstream, excludeId: target.id })
  assert.equal(picked.inviteCode, 'BBB222')
  assert.equal(picked.accountId, second.id)
  assert.equal(picked.label, '码主2')
  // 停用账号 + 自己都不该被请求
  assert.equal(upstream.calls.some((call) => call.session === SESSION('c') && call.method === 'fetchInvitationCodes'), false)
  assert.equal(upstream.calls.some((call) => call.session === target.session && call.method === 'fetchInvitationCodes'), false)
  // 起点随机，所以「哪个码主被问到」不确定；能确定的是：停用账号与目标账号永远不该被问
})

test('claimAccountBonus：自动绑池内码 + 只补未完成任务，重跑幂等', async () => {
  const { accountStore, target, upstream } = seedPool()
  upstream.fetchOnboardingTasks = async function (session) {
    this.calls.push({ method: 'fetchOnboardingTasks', session })
    const done = this.countOf('completeOnboardingTask') > 0
    const state = {}
    for (const task of ONBOARDING_TASKS) state[task.key] = done
    state[ONBOARDING_TASKS[0].key] = true // 第一条一直显示已完成
    return { ok: true, data: { tasks: state, earned: ONBOARDING_TASKS[0].points, total: 10000 } }
  }

  const first = await claimAccountBonus({ accountStore, upstream, accountId: target.id, autoInvite: true })
  assert.equal(first.ok, true)
  assert.equal(first.invite.status, 'bound')
  assert.equal(first.invite.inviteCode, 'AAA111')
  assert.equal(first.invite.fromLabel, '码主')
  assert.equal(first.invite.rewards.inviteeReward, 5000)
  assert.equal(first.tasks.rows[0].status, 'done') // 已完成的不重复领
  assert.equal(first.tasks.rows.filter((row) => row.status === 'claimed').length, ONBOARDING_TASKS.length - 1)
  assert.equal(upstream.countOf('bindInviteCode'), 1)

  const second = await claimAccountBonus({ accountStore, upstream, accountId: target.id, autoInvite: true })
  assert.equal(second.invite.status, 'already-activated')
  assert.equal(second.invite.inviteCode, 'AAA111')
  assert.equal(second.tasks.rows.every((row) => row.status === 'done'), true)
  assert.equal(upstream.countOf('bindInviteCode'), 1, '已激活不该再绑一次')
  assert.equal(upstream.countOf('completeOnboardingTask'), ONBOARDING_TASKS.length - 1, '已完成的任务不该重复提交')
})

test('claimAccountBonus：dryRun 只读不写', async () => {
  const { accountStore, target, upstream } = seedPool()
  const report = await claimAccountBonus({ accountStore, upstream, accountId: target.id, autoInvite: true, dryRun: true })
  assert.equal(report.invite.status, 'dry-run')
  assert.equal(report.invite.inviteCode, 'AAA111')
  assert.equal(report.tasks.rows.every((row) => row.status === 'dry-run'), true)
  assert.equal(upstream.countOf('bindInviteCode'), 0)
  assert.equal(upstream.countOf('completeOnboardingTask'), 0)
})

test('claimAccountBonus：池内没有可用码时只补任务，不报错', async () => {
  const { accountStore, target, upstream } = seedPool({ codes: { inviter: [] } })
  const report = await claimAccountBonus({ accountStore, upstream, accountId: target.id, autoInvite: true })
  assert.equal(report.ok, true)
  assert.equal(report.invite.status, 'no-code')
  assert.equal(report.invite.inviteCode, '')
  assert.equal(upstream.countOf('bindInviteCode'), 0)
  assert.equal(report.tasks.rows.filter((row) => row.status === 'claimed').length, ONBOARDING_TASKS.length)
})

test('claimAccountBonus：上游失败记进 errors，不抛异常（登录流程不该被领权益拖垮）', async () => {
  const { accountStore, target, upstream } = seedPool()
  const bad = {
    ...upstream,
    calls: [],
    countOf () { return 0 },
    async fetchActivation () { return { ok: false, error: { code: 'HTTP_500', message: 'boom' } } },
    async fetchOnboardingTasks () { return { ok: false, error: { code: 'HTTP_500', message: 'tasks down' } } },
  }
  const report = await claimAccountBonus({ accountStore, upstream: bad, accountId: target.id, autoInvite: true })
  assert.equal(report.ok, false)
  assert.equal(report.invite.status, 'error')
  assert.equal(report.tasks.rows.length, 0)
  assert.deepEqual(report.errors.map((item) => item.step), ['activation', 'tasks'])
  assert.equal(report.errors[0].message, 'boom')
})

test('summarizeBonus / formatBonusLine：摘要字段与终端文案', async () => {
  const { accountStore, target, upstream } = seedPool()
  const report = await claimAccountBonus({ accountStore, upstream, accountId: target.id, autoInvite: true })

  const summary = summarizeBonus(report)
  assert.deepEqual(Object.keys(summary), ['ok', 'invite', 'tasks', 'errors'])
  assert.equal(summary.tasks.claimed, ONBOARDING_TASKS.length)
  assert.equal(summary.invite.status, 'bound')

  const line = formatBonusLine(summary)
  assert.match(line, /^权益: 已绑邀请码 AAA111（来自 码主） \+5000/)
  assert.match(line, new RegExp(`新手任务 0/10000（本次补领 ${ONBOARDING_TASKS.length} 条）`))

  // 没领 / 已绑 / 池内无码 三种文案
  assert.match(formatBonusLine(null), /未自动领取/)
  assert.match(formatBonusLine({ invite: { status: 'already-activated', inviteCode: '6NEPKK' }, tasks: { earned: 10000, total: 10000, claimed: 0 }, errors: [] }), /邀请码已绑定 6NEPKK · 新手任务 10000\/10000（无新增）/)
  assert.match(formatBonusLine({ invite: { status: 'no-code' }, tasks: { earned: 0, total: 0, claimed: 0 }, errors: [] }), /池内暂无可用邀请码/)
  assert.match(formatBonusLine({ invite: { status: 'failed' }, tasks: { earned: 0, total: 0, claimed: 0 }, errors: [{ step: 'tasks', message: 'boom' }] }), /tasks 失败: boom/)
})
