#!/usr/bin/env node
/**
 * LoomyProxy CLI。
 *
 *   node src/cli.js serve            启动网关
 *   node src/cli.js doctor           环境自检（安装目录 / 凭据 / 上游连通性）
 *   node src/cli.js login            手机号 + 短信验证码登录（交互式 / --phone --code 两段式）
 *   node src/cli.js import-local     导入本机 Loomy 客户端登录态
 *   node src/cli.js accounts         列出账号 / check / rm
 *   node src/cli.js key              创建 / 列出 / 吊销下游密钥
 *   node src/cli.js models           刷新并打印模型目录
 *   node src/cli.js probe            用账号池直接打一发上游对话，验证链路
 */

import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { CONFIG_PATH, DATA_DIR, loadConfig } from './config.js'
import { createLogger } from './util/log.js'
import { createContext, startServer } from './server.js'
import { loomyConfigRoot, loomyUserDataDir, readLocalAuthSession, readLocalUpstreamBase } from './auth/local-session.js'
import { findEnvFiles, resolveLoomyEnvConfig } from './auth/envfile.js'
import { maskPhone } from './core/accounts.js'

const [, , command = 'serve', ...args] = process.argv
const logger = createLogger({ level: process.env.LOOMY_PROXY_LOG_LEVEL || 'info' })

function flags (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item.startsWith('--')) {
      const key = item.slice(2)
      const nextValue = argv[i + 1]
      if (nextValue && !nextValue.startsWith('--')) { out[key] = nextValue; i += 1 } else out[key] = true
    } else {
      out._.push(item)
    }
  }
  return out
}

function print (line = '') {
  output.write(`${line}\n`)
}

function table (rows, columns) {
  if (rows.length === 0) return print('(空)')
  const widths = columns.map((col) => Math.max(col.title.length, ...rows.map((row) => String(col.value(row) ?? '').length)))
  print(columns.map((col, index) => col.title.padEnd(widths[index])).join('  '))
  print(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) {
    print(columns.map((col, index) => String(col.value(row) ?? '').padEnd(widths[index])).join('  '))
  }
}

async function cmdServe () {
  const parsed = flags(args)
  const config = loadConfig()
  if (parsed.port) config.server.port = Number(parsed.port)
  if (parsed.host) config.server.host = String(parsed.host)
  const { host, port, ctx } = await startServer({ config, logger })
  print(`LoomyProxy ${ctx.version} 已启动: http://${host}:${port}`)
  print(`  管理台: http://${host}:${port}/admin`)
  print(`  OpenAI 兼容入口: http://${host}:${port}/v1`)
  print(`  上游: ${ctx.upstream.baseUrl}`)
  print(`  账号: ${JSON.stringify(ctx.accountStore.summary())}`)
  print(`  模型: ${ctx.catalog.models.length} 个`)
  if (!ctx.config.server.adminPassword) {
    print('  ⚠️  未设置管理密码：管理台仅允许本机访问')
  }
  const shutdown = async (signal) => {
    print(`\n收到 ${signal}，正在关闭...`)
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function cmdDoctor () {
  const config = loadConfig()
  print('== LoomyProxy 环境自检 ==')
  print(`Node: ${process.version} (${process.platform}/${process.arch})`)
  print(`配置: ${CONFIG_PATH}`)
  print(`数据: ${DATA_DIR}`)
  print('')
  print(`Loomy 配置根: ${loomyConfigRoot()}`)
  print(`Loomy userData: ${loomyUserDataDir()}`)
  const candidates = findEnvFiles(config.auth.loomyInstallDir)
  print(`.env 候选: ${candidates.length === 0 ? '(未找到)' : candidates.join(' , ')}`)
  const envConfig = resolveLoomyEnvConfig({ installDir: config.auth.loomyInstallDir, envFile: config.auth.envFile })
  print(`凭据来源: ${envConfig.source || '(无)'}`)
  print(`  账号服务: ${envConfig.accountBaseUrl || config.auth.accountBaseUrl}`)
  print(`  appId: ${envConfig.appId || config.auth.appId}`)
  print(`  AK/SK: ${envConfig.accessKeyId ? '已就绪' : '缺失'}`)
  const local = readLocalAuthSession()
  print(`本机登录态: ${local.found ? `已找到（${local.file}）` : '未找到'}`)
  const upstream = readLocalUpstreamBase()
  if (upstream.baseUrl) print(`客户端上游: ${upstream.baseUrl}`)

  const ctx = createContext({ config, logger: createLogger({ level: 'warn' }) })
  print('')
  print(`上游地址: ${ctx.upstream.baseUrl}`)
  print(`账号池: ${JSON.stringify(ctx.accountStore.summary())}`)
  print(`下游密钥: ${ctx.keyStore.countEnabled()} 个启用`)
  print(`模型缓存: ${ctx.catalog.models.length} 个`)
  if (ctx.accountStore.list().length > 0) {
    const check = await ctx.refreshModels({ silent: false })
    print(`上游连通性: ${check.ok ? `正常（拉取到 ${check.count} 个模型）` : `失败：${check.error}`}`)
  } else {
    print('上游连通性: 跳过（账号池为空）')
  }
}

async function cmdImportLocal () {
  const config = loadConfig()
  const ctx = createContext({ config, logger })
  const local = readLocalAuthSession()
  if (!local.found || !local.session) {
    print(`未找到本机 Loomy 登录态。查找路径: ${local.file}`)
    process.exitCode = 1
    return
  }
  const existing = ctx.accountStore.list().find((account) => account.session === local.session.session)
  if (existing) {
    print(`该登录态已在账号池中（${existing.id}）`)
    return
  }
  const result = ctx.accountStore.add({
    name: '本机导入',
    session: local.session.session,
    userid: local.session.userid,
    phone: local.session.phone,
  })
  if (ctx.accountClient.ready) {
    try {
      const profile = await ctx.accountClient.getUserInfo(result.account.session)
      ctx.accountStore.markChecked(result.account.id, { ok: true, profile })
      print(`导入成功: ${result.account.id}  ${profile?.nickname || ''} ${maskPhone(profile?.phone || '')}`)
    } catch (error) {
      ctx.accountStore.markChecked(result.account.id, { ok: false, error: error.message })
      print(`已导入但校验失败: ${error.message}`)
    }
  } else {
    print(`导入成功: ${result.account.id}（未配置签名凭据，跳过校验）`)
  }
  const refresh = await ctx.refreshModels({ silent: false })
  print(refresh.ok ? `模型目录已同步: ${refresh.count} 个` : `模型同步失败: ${refresh.error}`)
}

async function cmdLogin () {
  const parsed = flags(args)
  const config = loadConfig()
  const ctx = createContext({ config, logger })
  const flow = ctx.loginFlow
  const rl = readline.createInterface({ input, output })
  const interactive = Boolean(input.isTTY)

  try {
    if (!flow.ready) {
      print('缺少讯飞账号签名凭据：需要 Loomy 安装目录下的 .env（含 AK/SK），可用 --env-file 指定')
      process.exitCode = 1
      return
    }

    // --- 只查状态 / 取消 ---
    if (parsed.status) {
      const view = flow.status(parsed.status)
      print(view ? JSON.stringify(view, null, 2) : '登录流程不存在或已过期')
      return
    }
    if (parsed.cancel) {
      flow.cancel(parsed.cancel)
      print('已取消该登录流程')
      return
    }
    if (parsed.list) {
      table(flow.list(), [
        { title: 'loginId', value: (row) => row.loginId },
        { title: '手机号', value: (row) => row.phoneMasked },
        { title: '状态', value: (row) => row.status },
        { title: '剩余秒', value: (row) => row.expiresInSeconds },
        { title: '剩余次数', value: (row) => row.attemptsLeft },
      ])
      return
    }

    // --- 第一步：发码（若给了 --login-id 则跳过） ---
    let loginId = String(parsed['login-id'] || '').trim()
    let phone = String(parsed.phone || '').trim()

    if (!loginId) {
      if (!phone) {
        if (!interactive) {
          print('非交互环境请用 --phone <手机号> 指定号码')
          process.exitCode = 1
          return
        }
        phone = String(await rl.question('手机号: ')).trim()
      }
      const view = await flow.start(phone, { name: parsed.name })
      loginId = view.loginId
      print(`验证码已发送至 ${view.phoneMasked}，${view.expiresInSeconds} 秒内有效（最多试 ${view.attemptsLeft} 次）`)
      if (parsed['send-only']) {
        print(`loginId: ${loginId}`)
        print(`下一步: node src/cli.js login --login-id ${loginId} --code <验证码>`)
        return
      }
    }

    // --- 第二步：填码 ---
    let code = String(parsed.code || '').trim()
    if (!code) {
      if (!interactive) {
        print(`请另开一次命令提交验证码: node src/cli.js login --login-id ${loginId} --code <验证码>`)
        print(`当前 loginId: ${loginId}`)
        return
      }
      code = String(await rl.question('验证码: ')).trim()
    }

    const result = await flow.verify(loginId, code, { name: parsed.name })
    print(`${result.created ? '登录成功并已入库' : '登录成功，已刷新该账号 auth'}: ${result.account.id}`)
    print(`账号: ${result.profile.nickname || '(无昵称)'} ${result.profile.phone} · 状态 ${result.account.status} · 权重 ${result.account.weight}`)
    if (result.after?.models?.ok) print(`模型目录已同步: ${result.after.models.count} 个`)
    else if (result.after?.models) print(`模型同步: ${result.after.models.error || '跳过'}`)
  } catch (error) {
    print(`登录失败: ${error.message}${error.code ? ` (${error.code})` : ''}`)
    if (error.details?.attemptsLeft !== undefined) print(`剩余尝试次数: ${error.details.attemptsLeft}`)
    if (error.details?.retryAfterSeconds) print(`请 ${error.details.retryAfterSeconds} 秒后重试`)
    process.exitCode = 1
  } finally {
    rl.close()
  }
}

async function cmdAccounts () {
  const parsed = flags(args)
  const config = loadConfig()
  const ctx = createContext({ config, logger })
  const action = parsed._[0] || 'list'

  if (action === 'list') {
    const rows = ctx.accountStore.list()
    table(rows, [
      { title: 'ID', value: (row) => row.id },
      { title: '名称', value: (row) => row.name },
      { title: '昵称', value: (row) => row.nickname },
      { title: '手机', value: (row) => maskPhone(row.phone) },
      { title: '状态', value: (row) => ctx.accountStore.effectiveStatus(row) },
      { title: '权重', value: (row) => row.weight },
      { title: '请求', value: (row) => row.stats.requests },
      { title: '积分', value: (row) => row.stats.points },
    ])
    print('')
    print(`汇总: ${JSON.stringify(ctx.accountStore.summary())}`)
    return
  }

  if (action === 'check') {
    for (const account of ctx.accountStore.list()) {
      if (!ctx.accountClient.ready) { print('未配置签名凭据，跳过校验'); return }
      try {
        const profile = await ctx.accountClient.getUserInfo(account.session)
        ctx.accountStore.markChecked(account.id, { ok: true, profile })
        print(`✅ ${account.id} ${profile?.nickname || ''} ${maskPhone(profile?.phone || '')}`)
      } catch (error) {
        ctx.accountStore.markChecked(account.id, { ok: false, error: error.message })
        print(`❌ ${account.id} ${error.message}`)
      }
    }
    return
  }

  if (action === 'rm' || action === 'remove') {
    const id = parsed._[1]
    if (!id) throw new Error('用法: accounts rm <accountId>')
    print(ctx.accountStore.remove(id) ? '已删除' : '未找到该账号')
    return
  }

  if (action === 'enable' || action === 'disable') {
    const id = parsed._[1]
    if (!id) throw new Error(`用法: accounts ${action} <accountId>`)
    const updated = ctx.accountStore.update(id, { enabled: action === 'enable' })
    print(updated ? `已${action === 'enable' ? '启用' : '停用'} ${updated.id}` : '未找到该账号')
    return
  }

  throw new Error(`未知的 accounts 子命令: ${action}`)
}

async function cmdKey () {
  const parsed = flags(args)
  const config = loadConfig()
  const ctx = createContext({ config, logger })
  const action = parsed._[0] || 'list'

  if (action === 'create') {
    const { key, plaintext } = ctx.keyStore.create({
      name: parsed.name || '',
      rpm: Number(parsed.rpm) || 0,
      allowedModels: parsed.models ? String(parsed.models).split(',').map((item) => item.trim()).filter(Boolean) : [],
    })
    print(`已创建密钥 ${key.id}`)
    print('')
    print(`  ${plaintext}`)
    print('')
    print('（该明文只显示一次，请立刻保存）')
    return
  }

  if (action === 'list') {
    table(ctx.keyStore.keys, [
      { title: 'ID', value: (row) => row.id },
      { title: '名称', value: (row) => row.name },
      { title: '前缀', value: (row) => `${row.prefix}…` },
      { title: '启用', value: (row) => (row.enabled ? 'yes' : 'no') },
      { title: '请求', value: (row) => row.stats.requests },
      { title: '积分', value: (row) => row.stats.points },
    ])
    return
  }

  if (action === 'rm' || action === 'revoke') {
    const id = parsed._[1]
    if (!id) throw new Error('用法: key rm <keyId>')
    print(ctx.keyStore.remove(id) ? '已删除' : '未找到该密钥')
    return
  }

  throw new Error(`未知的 key 子命令: ${action}`)
}

async function cmdModels () {
  const parsed = flags(args)
  const config = loadConfig()
  const ctx = createContext({ config, logger })
  const refreshed = await ctx.refreshModels({ silent: false })
  if (!refreshed.ok) {
    print(`刷新失败: ${refreshed.error}`)
    process.exitCode = 1
    return
  }
  if (parsed.json) {
    print(JSON.stringify(ctx.catalog.models.map((model) => ({ ...model, raw: undefined })), null, 2))
    return
  }
  table(ctx.catalog.models, [
    { title: 'ID', value: (row) => row.id },
    { title: '名称', value: (row) => row.name },
    { title: '协议', value: (row) => row.protocol },
    { title: '上下文', value: (row) => row.contextLength || '' },
    { title: '输出', value: (row) => row.maxOutputTokens || '' },
    { title: '推理', value: (row) => (row.capabilities.reasoning ? 'yes' : '') },
    { title: '视觉', value: (row) => (row.capabilities.vision ? 'yes' : '') },
    { title: '默认', value: (row) => (row.isDefaultModel ? '主' : row.isDefaultSmallModel ? '小' : '') },
  ])
}

async function cmdProbe () {
  const parsed = flags(args)
  const config = loadConfig()
  const ctx = createContext({ config, logger })
  const account = ctx.scheduler.candidates({})[0]
  if (!account) { print('没有可用账号'); process.exitCode = 1; return }
  const model = parsed.model || ctx.catalog.pickDefault('openai') || 'spark-x2.6'
  print(`使用账号 ${account.id} / 模型 ${model} 打一条测试对话...`)
  const response = await ctx.upstream.fetch(account, '/chat/completions', {
    method: 'POST',
    body: {
      model,
      messages: [{ role: 'user', content: '用一句话说明你是谁，并复述 "loomy-proxy ok"' }],
      max_tokens: 128,
      stream: false,
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    },
    headers: ctx.upstream.headers(account, { purpose: config.upstream.requestPurpose }),
  })
  const text = await response.text()
  print(`HTTP ${response.status}`)
  print(text.slice(0, 1500))
}

async function cmdHelp () {
  print(`LoomyProxy CLI

用法:
  node src/cli.js serve [--port 8787] [--host 127.0.0.1]
  node src/cli.js doctor
  node src/cli.js login [--phone 13800000000]
  node src/cli.js import-local
  node src/cli.js accounts [list|check|rm|enable|disable] [id]
  node src/cli.js key [list|create|rm] [--name xxx] [--rpm 60] [--models a,b]
  node src/cli.js models [--json]
  node src/cli.js probe [--model spark-x2.6]

环境变量:
  LOOMY_PROXY_HOST / LOOMY_PROXY_PORT / LOOMY_PROXY_ADMIN_PASSWORD
  LOOMY_PROXY_UPSTREAM_BASE / LOOMY_PROXY_ACCOUNT_BASE
  LOOMY_PROXY_LOOMY_DIR / LOOMY_PROXY_ENV_FILE / LOOMY_PROXY_LOG_LEVEL
`)
}

async function main () {
  switch (command) {
    case 'serve': return cmdServe()
    case 'doctor': return cmdDoctor()
    case 'login': return cmdLogin()
    case 'import-local': case 'import': return cmdImportLocal()
    case 'accounts': return cmdAccounts()
    case 'key': case 'keys': return cmdKey()
    case 'models': return cmdModels()
    case 'probe': return cmdProbe()
    case 'help': case '--help': case '-h': return cmdHelp()
    default:
      await cmdHelp()
      process.exitCode = 1
  }
}

main().catch((error) => {
  logger.error(error.message)
  process.exitCode = 1
})
