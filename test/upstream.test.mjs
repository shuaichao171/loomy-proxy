import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { buildUpstreamHeaders, generateTraceparent, parseErrorEnvelope, relaySse, normalizePurpose } from '../src/upstream/client.js'
import { extractUsage, isEventStream } from '../src/routes/shared.js'
import { withAccountFailover } from '../src/core/executor.js'

test('traceparent 结构合法', () => {
  const trace = generateTraceparent()
  assert.match(trace, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
})

test('上游头：Bearer / token / 版本 / 追踪 / Anthropic', () => {
  const headers = buildUpstreamHeaders({ session: 'SESSION' }, {
    stream: true,
    clientVersion: '0.9.39',
    chatId: 'chat-1',
    msgId: 'msg-1',
    turnId: 'turn-1',
    purpose: 'chat.message',
  })
  assert.equal(headers.Authorization, 'Bearer SESSION')
  assert.equal(headers.token, 'SESSION')
  assert.equal(headers.Accept, 'text/event-stream')
  assert.equal(headers['loomy-version'], '0.9.39')
  assert.equal(headers.ChatId, 'chat-1')
  assert.equal(headers.MsgId, 'msg-1')
  assert.equal(headers.TurnId, 'turn-1')
  assert.equal(headers['X-Loomy-Request-Purpose'], 'chat.message')

  const anthropic = buildUpstreamHeaders({ session: 'S' }, { anthropic: true })
  assert.equal(anthropic['anthropic-version'], '2023-06-01')
  assert.equal(anthropic['X-Loomy-Request-Purpose'], undefined)
})

test('用途白名单：非法值不发送', () => {
  assert.equal(normalizePurpose('chat.message'), 'chat.message')
  assert.equal(normalizePurpose('hack.reasoning'), '')
  const headers = buildUpstreamHeaders({ session: 'S' }, { purpose: 'not-a-purpose' })
  assert.equal(headers['X-Loomy-Request-Purpose'], undefined)
})

test('业务错误信封：HTTP 200 也能识别', () => {
  assert.equal(parseErrorEnvelope({ code: '000000', desc: '成功' }), null)
  const auth = parseErrorEnvelope({ code: '100002', desc: '登录已失效，请重新登录', trace_id: 't' })
  assert.equal(auth.authInvalid, true)
  assert.equal(auth.code, '100002')
  const bad = parseErrorEnvelope({ code: '100001', desc: '请求参数错误' })
  assert.equal(bad.authInvalid, false)
  assert.equal(parseErrorEnvelope(null), null)
  assert.equal(parseErrorEnvelope({ data: [] }), null)
})

test('usage 归一：OpenAI / Anthropic 两种字段', () => {
  assert.deepEqual(extractUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, points_consumed: 2 }).points, 2)
  const anthropic = extractUsage({ input_tokens: 7, output_tokens: 3 })
  assert.equal(anthropic.promptTokens, 7)
  assert.equal(anthropic.totalTokens, 10)
})

test('SSE 探测', () => {
  const mk = (type) => ({ headers: { get: () => type } })
  assert.equal(isEventStream(mk('text/event-stream; charset=utf-8')), true)
  assert.equal(isEventStream(mk('application/json')), false)
  assert.equal(isEventStream({}), false)
})

function fakeResponse (chunks) {
  return { body: Readable.from(chunks) }
}

function fakeRes () {
  const chunks = []
  return {
    chunks,
    writableEnded: false,
    write (chunk) { chunks.push(Buffer.from(chunk)); return true },
    end () { this.writableEnded = true },
    once () {},
    on () {},
  }
}

test('SSE 转发：字节完整透传并抓到 usage', async () => {
  const payload = [
    'data: {"id":"1","model":"m1","choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"id":"1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7,"points_consumed":1}}\n\n',
    'data: [DONE]\n\n',
  ]
  const res = fakeRes()
  const result = await relaySse(fakeResponse(payload), res)
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), payload.join(''))
  assert.equal(result.usage.points_consumed, 1)
  assert.equal(res.writableEnded, true)
})

test('SSE 转发：跨 chunk 切断的行也能解析', async () => {
  const res = fakeRes()
  const result = await relaySse(fakeResponse([
    'data: {"choices":[{"delta":{"content":"a"}}],"usa',
    'ge":{"points_consumed":5}}\n\n',
  ]), res)
  assert.equal(result.usage.points_consumed, 5)
})

function makeScheduler (accounts) {
  const list = accounts.map((id) => ({ id, session: `s-${id}`, enabled: true, status: 'active', cooldownUntil: 0, weight: 1 }))
  const failures = []
  return {
    failures,
    candidates: () => list.filter((item) => item.id !== null),
    failure: (id, info) => { failures.push({ id, ...info }); const index = list.findIndex((item) => item.id === id); if (index >= 0) list.splice(index, 1) },
    success: () => {},
  }
}

test('故障转移：首个账号 login 失效后换下一个成功', async () => {
  const scheduler = makeScheduler(['a1', 'a2'])
  const attempts = []
  const result = await withAccountFailover({
    scheduler,
    maxRetries: 1,
    execute: async (account) => {
      attempts.push(account.id)
      return { response: { status: 200, ok: true } }
    },
    inspect: async (response) => {
      if (attempts.length === 1) return { code: '100002', message: '登录已失效', authInvalid: true }
      response.ok = true
      return null
    },
  })
  assert.deepEqual(attempts, ['a1', 'a2'])
  assert.equal(result.account.id, 'a2')
  assert.equal(scheduler.failures.length, 1)
  assert.equal(scheduler.failures[0].authInvalid, true)
})

test('故障转移：无可用账号时给出明确错误', async () => {
  const scheduler = makeScheduler([])
  await assert.rejects(
    () => withAccountFailover({ scheduler, execute: async () => ({ response: {} }) }),
    /没有可用账号/,
  )
})
