import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AccountStore } from '../src/core/accounts.js'
import { PointsTracker } from '../src/core/points.js'
import { Scheduler } from '../src/core/scheduler.js'

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-proxy-points-'))
}

function fakeUpstream (handler) {
  const calls = []
  return {
    calls,
    async fetchPoints (session, options) {
      calls.push({ session, options })
      return handler(session, calls.length)
    },
  }
}

test('积分观测：拉取写入 wallet，失败保留旧值并记录错误', async () => {
  const dir = tempDir()
  const accountStore = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const { account } = accountStore.add({ session: 'dddddddddddddddddddddddddddddddd' })

  const upstream = fakeUpstream(() => ({ ok: true, data: { balance: 8500, dailyBalance: 4135 } }))
  const tracker = new PointsTracker({ accountStore, upstream, config: { pool: { preferDailyPoints: true } } })

  const ok = await tracker.refreshAccount(account.id, { force: true })
  assert.equal(ok.ok, true)
  assert.equal(accountStore.get(account.id).wallet.daily, 4135)
  assert.equal(accountStore.get(account.id).wallet.balance, 8500)
  assert.equal(tracker.summary().dailyReady, 1)

  const failing = fakeUpstream(() => ({ ok: false, error: { code: 'HTTP_500', message: 'boom' } }))
  const tracker2 = new PointsTracker({ accountStore, upstream: failing, config: { pool: { preferDailyPoints: true } } })
  const bad = await tracker2.refreshAccount(account.id, { force: true })
  assert.equal(bad.ok, false)
  assert.match(accountStore.get(account.id).wallet.error, /boom/)
  assert.equal(accountStore.get(account.id).wallet.daily, 4135, '失败时保留上次成功余额')
})

test('积分观测：最小刷新间隔与并发去重', async () => {
  const dir = tempDir()
  const accountStore = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const { account } = accountStore.add({ session: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })
  let now = 1_000_000
  const upstream = fakeUpstream(() => ({ ok: true, data: { balance: 10, dailyBalance: 2 } }))
  const tracker = new PointsTracker({
    accountStore,
    upstream,
    config: { pool: { preferDailyPoints: true, pointsMinRefreshSeconds: 60, pointsRefreshSeconds: 300 } },
    now: () => now,
  })

  await tracker.refreshAccount(account.id)
  now += 5_000
  const skipped = await tracker.refreshAccount(account.id)
  assert.equal(skipped.skipped, 'throttled')
  assert.equal(upstream.calls.length, 1)

  now += 61_000
  await tracker.refreshAccount(account.id)
  assert.equal(upstream.calls.length, 2)
})

test('调度器：每日积分优先 —— 全部每日归零后才轮到永久积分', () => {
  const dir = tempDir()
  const accountStore = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const daily = accountStore.add({ session: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).account
  const permanent = accountStore.add({ session: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }).account
  const unknown = accountStore.add({ session: 'cccccccccccccccccccccccccccccccc' }).account

  accountStore.markPoints(daily.id, { balance: 100, daily: 50 })
  accountStore.markPoints(permanent.id, { balance: 900, daily: 0 })

  const config = {
    pool: { strategy: 'round-robin', maxRetries: 2, cooldownSeconds: 60, sessionAffinity: true, affinityTtlSeconds: 60, preferDailyPoints: true },
  }
  const scheduler = new Scheduler({ accountStore, config })

  // 仅有一条有每日积分：应始终排第一，哪怕会话亲和指向别的账号
  for (let i = 0; i < 3; i += 1) {
    assert.equal(scheduler.candidates({})[0].id, daily.id)
  }
  assert.equal(scheduler.candidates({ affinityKey: 'chat-perm' })[0].id, daily.id)

  // 档位顺序：每日(daily) → 未知(unknown) → 只剩永久(permanent)
  const order = scheduler.candidates({}).map((item) => item.id)
  assert.deepEqual(order, [daily.id, unknown.id, permanent.id])

  // 每日用尽后，daily / permanent 同为「只剩永久」，按策略轮询
  // （先给 unknown 也拉一次余额，否则它一直待在「未知」档，优先级高于只剩永久的账号）
  accountStore.markPoints(unknown.id, { balance: 700, daily: 0 })
  accountStore.markPoints(daily.id, { balance: 100, daily: 0 })
  const picks = new Set()
  for (let i = 0; i < 6; i += 1) picks.add(scheduler.candidates({})[0].id)
  assert.equal(picks.has(daily.id), true)
  assert.equal(picks.has(permanent.id), true)
})

test('调度器：preferDailyPoints=false 时退回原策略', () => {
  const dir = tempDir()
  const accountStore = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const a = accountStore.add({ session: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).account
  const b = accountStore.add({ session: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }).account
  accountStore.markPoints(a.id, { balance: 10, daily: 0 })
  accountStore.markPoints(b.id, { balance: 10, daily: 999 })

  const config = { pool: { strategy: 'round-robin', maxRetries: 1, cooldownSeconds: 60, preferDailyPoints: false } }
  const scheduler = new Scheduler({ accountStore, config })
  const picks = new Set()
  for (let i = 0; i < 4; i += 1) picks.add(scheduler.candidates({})[0].id)
  assert.equal(picks.size, 2, '关闭积分优先级时应纯轮询')
})

test('积分观测：本地估算见底会触发一次核对', () => {
  const dir = tempDir()
  const accountStore = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const { account } = accountStore.add({ session: 'ffffffffffffffffffffffffffffffff' })
  accountStore.markPoints(account.id, { balance: 500, daily: 3 })
  const tracker = new PointsTracker({ accountStore, upstream: fakeUpstream(() => ({ ok: true, data: {} })), config: { pool: { preferDailyPoints: true } } })

  assert.equal(tracker.shouldRefresh(accountStore.get(account.id)), false)
  accountStore.markSuccess(account.id, { points: 3 })
  assert.equal(accountStore.get(account.id).wallet.daily, 0)
  assert.equal(tracker.shouldRefresh(accountStore.get(account.id)), true, '估算见底应尽快核对')
})
