import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { decryptEnvContent, parseDotenv, isEncryptedEnvContent } from '../src/auth/envfile.js'
import { buildSignedHeadersFor, generateSignature } from '../src/auth/sign.js'

// 与 electron/utils/env-file-crypto.js 相同的加密实现，用于验证解密器
function encryptEnvContent (plaintext) {
  const passphrase = 'loomy::env::3f9c1d2a7b6e4f08::local-obfuscation::v1'
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase, salt, 32)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const payload = Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64')
  return `LOOMYENC1:${payload}\n`
}

test('env 解密：LOOMYENC1 往返一致', () => {
  const plain = 'A=1\nB=二\nLOOMY_POINTS_BASE_URL=https://loomyad.xunfei.cn\n'
  const encrypted = encryptEnvContent(plain)
  assert.equal(isEncryptedEnvContent(encrypted), true)
  assert.equal(decryptEnvContent(encrypted), plain)
})

test('env 解密：明文直通', () => {
  assert.equal(decryptEnvContent('A=1\n'), 'A=1\n')
  assert.equal(decryptEnvContent(''), '')
})

test('dotenv 解析：注释、引号、空行', () => {
  const env = parseDotenv('# 注释\nA=1\nB="two"\n\nC = three \nNOEQ\n')
  assert.deepEqual(env, { A: '1', B: 'two', C: 'three' })
})

test('签名：Authorization 结构与 Content-MD5', () => {
  const body = JSON.stringify({ base: { appid: 'X' }, param: { session: 's' } })
  const { headers, bodyString } = buildSignedHeadersFor({
    accessKeyId: 'AKID',
    accessKeySecret: 'SECRET',
    method: 'POST',
    path: '/userinfo/query/baseInfo',
    body,
  })
  assert.equal(bodyString, body)
  assert.match(headers.Authorization, /^account AKID:[A-Za-z0-9+/=]+$/)
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['Content-MD5'], crypto.createHash('md5').update(body, 'utf8').digest('base64'))
  assert.ok(Date.parse(headers.Date))
  assert.match(headers.Nonce, /^[0-9a-f-]{36}$/)
})

test('签名：同一输入与固定 nonce/date 可复现', () => {
  const args = {
    method: 'POST',
    path: '/login/phone/checkCode',
    queryParams: { b: '2', a: '1' },
    body: '{"x":1}',
    contentType: 'application/json',
    date: 'Tue, 01 Jan 2030 00:00:00 GMT',
    nonce: 'fixed-nonce',
    customHeaders: {},
    accessKeySecret: 'SECRET',
  }
  const first = generateSignature(args)
  const second = generateSignature({ ...args })
  assert.equal(first, second)
  // 换 body 必须换签名
  assert.notEqual(first, generateSignature({ ...args, body: '{"x":2}' }))
  // 换 query 顺序在 "拼串" 层面不同，但服务端同样按原顺序签名，故此处仅验证稳定性
  assert.equal(typeof first, 'string')
})
