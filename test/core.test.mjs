import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AccountStore, maskPhone, maskSession } from '../src/core/accounts.js'
import { ApiKeyStore } from '../src/core/keys.js'
import { UsageLedger } from '../src/core/usage.js'
import { ModelCatalog, normalizeModel } from '../src/core/models.js'
import { Scheduler } from '../src/core/scheduler.js'

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-proxy-test-'))
}

test('账号池：新增 / 去重 / 脱敏 / 状态机', () => {
  const dir = tempDir()
  const store = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const { account, created } = store.add({ session: 'abcdefghijklmnopqrstuvwx12345678', phone: '13800001111', name: 'A' })
  assert.equal(created, true)
  assert.equal(store.add({ session: account.session }).created, false)

  const masked = store.toPublic(account)
  assert.equal(masked.sessionMasked, 'abcd****5678')
  assert.equal(masked.phone, '138****1111')
  assert.equal(masked.health, 'healthy')

  store.markFailure(account.id, { reason: 'timeout', cooldownSeconds: 60 })
  assert.equal(store.effectiveStatus(store.get(account.id)), 'cooling')

  store.markFailure(account.id, { reason: '100002: 登录已失效', invalid: true })
  assert.equal(store.effectiveStatus(store.get(account.id)), 'invalid')

  store.markChecked(account.id, { ok: true, profile: { nickname: '小明' } })
  assert.equal(store.effectiveStatus(store.get(account.id)), 'active')
  assert.equal(store.get(account.id).nickname, '小明')

  store.update(account.id, { enabled: false })
  assert.equal(store.effectiveStatus(store.get(account.id)), 'disabled')

  // 重新加载应保持持久化结果
  const reloaded = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.list()[0].nickname, '小明')
})

test('脱敏函数边界', () => {
  assert.equal(maskSession(''), '')
  assert.equal(maskSession('short'), '****')
  assert.equal(maskPhone('13800001111'), '138****1111')
  assert.equal(maskPhone('123'), '123')
})

test('下游密钥：明文只出现一次，校验用摘要', () => {
  const dir = tempDir()
  const store = new ApiKeyStore({ filePath: path.join(dir, 'keys.json') })
  const { key, plaintext } = store.create({ name: 'test' })
  assert.match(plaintext, /^sk-loomy-[0-9a-f]{48}$/)
  assert.equal(store.verify(plaintext)?.id, key.id)
  assert.equal(store.verify('sk-loomy-deadbeef'), null)

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'))
  assert.equal(JSON.stringify(persisted).includes(plaintext), false, '密钥明文不得落盘')

  store.update(key.id, { enabled: false })
  assert.equal(store.verify(plaintext), null)
})

test('调度器：轮询覆盖全部账号，冷却与失效被排除', () => {
  const dir = tempDir()
  const accounts = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const a = accounts.add({ session: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).account
  const b = accounts.add({ session: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }).account
  const config = { pool: { strategy: 'round-robin', maxRetries: 1, cooldownSeconds: 1, sessionAffinity: true, affinityTtlSeconds: 60 } }
  const scheduler = new Scheduler({ accountStore: accounts, config })

  const first = scheduler.candidates({})[0]
  const second = scheduler.candidates({})[0]
  assert.notEqual(first.id, second.id, '轮询应轮换首选账号')

  scheduler.failure(a.id, { authInvalid: true })
  assert.deepEqual(scheduler.candidates({}).map((item) => item.id), [b.id])

  scheduler.failure(b.id, { reason: 'timeout' })
  assert.equal(scheduler.candidates({}).length, 0, '全部冷却后无可用账号')
})

test('调度器：会话亲和粘同一账号', () => {
  const dir = tempDir()
  const accounts = new AccountStore({ filePath: path.join(dir, 'accounts.json') })
  const a = accounts.add({ session: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).account
  accounts.add({ session: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
  const config = { pool: { strategy: 'round-robin', sessionAffinity: true, affinityTtlSeconds: 60, cooldownSeconds: 1 } }
  const scheduler = new Scheduler({ accountStore: accounts, config })

  scheduler.success(a.id, { affinityKey: 'chat-1' })
  for (let i = 0; i < 4; i += 1) {
    assert.equal(scheduler.candidates({ affinityKey: 'chat-1' })[0].id, a.id)
  }
})

test('用量账本：聚合与积分累加', () => {
  const dir = tempDir()
  const ledger = new UsageLedger({ filePath: path.join(dir, 'usage.jsonl') })
  ledger.record({ endpoint: '/v1/chat/completions', model: 'm1', accountId: 'a1', keyId: 'k1', points: 2, promptTokens: 10, completionTokens: 5 })
  ledger.record({ endpoint: '/v1/chat/completions', model: 'm1', accountId: 'a1', keyId: 'k1', points: 3, status: 'error' })
  const summary = ledger.summary({ days: 1 })
  assert.equal(summary.totals.requests, 2)
  assert.equal(summary.totals.errors, 1)
  assert.equal(summary.totals.points, 5)
  assert.equal(summary.byModel[0].id, 'm1')
  assert.equal(summary.byModel[0].requests, 2)
  assert.equal(ledger.list({ limit: 1 })[0].points, 3)
})

test('模型目录：归一化与 OpenAI 投影', () => {
  const model = normalizeModel({
    id: 'spark-x2.6',
    name: 'Spark-X2.6(限时免费)',
    protocol: 'openai_chat',
    context_length: 1048576,
    max_output_tokens: 131072,
    capabilities: { reasoning: true, function_calling: true, input_modalities: ['text'] },
    is_default_model: true,
  })
  assert.equal(model.protocol, 'openai')
  assert.equal(model.capabilities.reasoning, true)
  assert.equal(model.contextLength, 1048576)

  const dir = tempDir()
  const catalog = new ModelCatalog({ cacheFile: path.join(dir, 'models.json') })
  catalog.update([{ id: 'a', protocol: 'openai_chat' }, { id: 'b', protocol: 'anthropic_messages' }], {})
  assert.equal(catalog.models.length, 2)
  assert.equal(catalog.pickDefault('anthropic'), 'b')
  const list = catalog.toOpenAiList()
  assert.equal(list.object, 'list')
  assert.equal(list.data[1].protocol, 'anthropic')

  const reloaded = new ModelCatalog({ cacheFile: path.join(dir, 'models.json') })
  assert.equal(reloaded.models.length, 2)
})

test('ApiKeyStore：别的进程新建的密钥无需重启即可校验（reload-on-miss）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loomy-keys-'))
  const file = path.join(dir, 'keys.json')
  const live = new ApiKeyStore({ filePath: file })          // 模拟常驻服务
  const cli = new ApiKeyStore({ filePath: file })           // 模拟 docker exec 里的 CLI
  const created = cli.create({ name: 'from-cli' })

  // 常驻服务启动后没有重读过文件，但外部进程新建的密钥应当立刻可用
  assert.equal(live.verify(created.plaintext)?.id, created.key.id)

  // 命中路径走内存，不再重复读盘
  assert.equal(live.verify(created.plaintext)?.id, created.key.id)
})
