/**
 * 新账号权益领取（新手任务 + 邀请码）。
 *
 * 新号拿到 session 后能白拿约 20000 永久积分：
 *   - 新手任务：8 条一次性，合计 10000（客户端文案「做任务赢积分好礼」）
 *   - 填写邀请码：inviteeReward 5000；从未领过注册奖励的账号再补 registerReward 5000
 *   - 同一时刻码主那边 +5000（inviterReward）
 *
 * 上游两个接口都是服务端幂等记账（alreadyCompleted / alreadyActivated），重跑不会重复加分，
 * 所以这一份逻辑同时挂在两个入口：
 *   - CLI：node src/cli.js bonus --account <id> [--invite CODE|auto]
 *   - 网关：短信登录 / 导入登录态成功后自动领（config.login.autoBonus / autoInvite）
 */

import { maskPhone } from './accounts.js'

/**
 * 新手任务（客户端「做任务赢积分好礼」）的清单。
 *
 * 金额以客户端注册表为准，服务端只按 key 记账，所以这里只用于展示与排序。
 */
export const ONBOARDING_TASKS = [
  { key: 'first_message', title: '发送你的第一条消息', points: 500 },
  { key: 'pick_skill', title: '选择技能并发送', points: 1000 },
  { key: 'generate_ppt', title: '生成第一份 PPT', points: 1500 },
  { key: 'set_schedule', title: '设置定时任务', points: 1000 },
  { key: 'install_skill', title: '在技能广场安装一个技能', points: 1500 },
  { key: 'configure_remote', title: '配置远程控制', points: 1000 },
  { key: 'create_soul', title: '创建第一个搭子', points: 1500 },
  { key: 'share_soul', title: '把搭子分享给朋友', points: 2000 },
]

/** 上游错误对象（{code, message}）或字符串 → 一行可读文案。 */
export function describeError (error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return error.message || error.code || '未知错误'
}

function accountLabel (account) {
  return String(account?.name || account?.nickname || maskPhone(account?.phone) || account?.id || '')
}

/**
 * 从池内其它账号里摸一个可用邀请码。
 *
 * 跳过：自己、停用的账号、没有 session 的账号、非 active 或已用尽的码。
 * 起点随机，避免所有新号都挂到同一个码主名下。
 *
 * @returns {Promise<{inviteCode: string, accountId: string, label: string}|null>}
 */
export async function pickPoolInviteCode ({ accountStore, upstream, excludeId = '', logger = null } = {}) {
  const candidates = accountStore
    .list()
    .filter((account) => account.id !== excludeId && account.enabled !== false && account.session)
  if (candidates.length === 0) return null

  const start = Math.floor(Math.random() * candidates.length)
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const account = candidates[(start + offset) % candidates.length]
    let result = null
    try {
      result = await upstream.fetchInvitationCodes(account.session)
    } catch (error) {
      logger?.warn('读取邀请码失败', { accountId: account.id, error: error.message })
      continue
    }
    if (!result?.ok) continue
    const code = (result.data?.list || []).find((item) => {
      if (!item?.inviteCode || item.status !== 'active') return false
      const maxUses = Number(item.maxUses)
      const usedCount = Number(item.usedCount) || 0
      return !Number.isFinite(maxUses) || usedCount < maxUses
    })
    if (code) {
      return { inviteCode: String(code.inviteCode), accountId: account.id, label: accountLabel(account) }
    }
  }
  return null
}

/**
 * 给一个账号领权益：邀请码（可选）+ 新手任务，全程幂等。
 *
 * 上游失败不抛异常，而是记进 report.errors —— 调用方（登录钩子）不该因为领权益失败而登录失败。
 *
 * @param {object} options
 * @param {object} options.accountStore 账号存储
 * @param {object} options.upstream 上游客户端（需 fetchActivation / fetchOnboardingTasks / completeOnboardingTask / bindInviteCode）
 * @param {string} options.accountId 目标账号 id
 * @param {string} [options.inviteCode] 指定要绑的邀请码
 * @param {boolean} [options.autoInvite] 未指定邀请码时，是否从池内摸一个
 * @param {boolean} [options.dryRun] 只读不写（不绑码、不补任务）
 * @param {object} [options.logger]
 * @returns {Promise<object>} report
 */
export async function claimAccountBonus ({
  accountStore,
  upstream,
  accountId,
  inviteCode = '',
  autoInvite = false,
  dryRun = false,
  logger = null,
} = {}) {
  const account = accountStore.get(accountId)
  if (!account) throw new Error(`未找到账号: ${accountId}`)

  const report = {
    accountId: account.id,
    label: accountLabel(account),
    ok: true,
    dryRun,
    invite: { status: 'skipped', inviteCode: '', fromAccountId: '', fromLabel: '', rewards: null, error: '' },
    tasks: { earned: 0, total: 0, rows: [] },
    errors: [],
  }
  const fail = (step, error) => {
    report.ok = false
    report.errors.push({ step, message: describeError(error) })
  }

  // ---- 1) 邀请码：每号只能绑一次，已激活的直接跳过 ----
  const activation = await upstream.fetchActivation(account.session)
  if (!activation?.ok) {
    report.invite.status = 'error'
    report.invite.error = describeError(activation?.error)
    fail('activation', activation?.error)
  } else if (activation.data?.activated === true) {
    report.invite.status = 'already-activated'
    report.invite.inviteCode = String(activation.data?.appliedInvitationCode || '')
  } else {
    let code = String(inviteCode || '').trim()
    let source = null
    if (!code && autoInvite) {
      source = await pickPoolInviteCode({ accountStore, upstream, excludeId: account.id, logger })
      code = source?.inviteCode || ''
      report.invite.fromAccountId = source?.accountId || ''
      report.invite.fromLabel = source?.label || ''
    }
    report.invite.inviteCode = code
    if (!code) {
      report.invite.status = 'no-code'
    } else if (dryRun) {
      report.invite.status = 'dry-run'
    } else {
      const bound = await upstream.bindInviteCode(account.session, code)
      if (!bound?.ok) {
        report.invite.status = 'failed'
        report.invite.error = describeError(bound?.error)
        fail('invite', bound?.error)
      } else {
        report.invite.status = 'bound'
        const data = bound.data || {}
        report.invite.rewards = {
          inviteeReward: Number(data.inviteeReward) || 0,
          registerReward: Number(data.registerReward) || 0,
          permanentBalance: data.permanentBalance ?? null,
          currentBalance: data.currentBalance ?? null,
        }
        logger?.info('已绑定邀请码', {
          accountId: account.id,
          inviteCode: code,
          fromAccountId: report.invite.fromAccountId || '(手动指定)',
        })
      }
    }
  }

  // ---- 2) 新手任务：只补未完成的 key ----
  const snapshot = await upstream.fetchOnboardingTasks(account.session)
  if (!snapshot?.ok) {
    fail('tasks', snapshot?.error)
  } else {
    const tasks = snapshot.data?.tasks || {}
    report.tasks.earned = Number(snapshot.data?.earned) || 0
    report.tasks.total = Number(snapshot.data?.total) || ONBOARDING_TASKS.reduce((sum, item) => sum + item.points, 0)
    for (const task of ONBOARDING_TASKS) {
      const row = { key: task.key, title: task.title, points: task.points, status: '', error: '' }
      if (tasks[task.key] === true) {
        row.status = 'done'
      } else if (dryRun) {
        row.status = 'dry-run'
      } else {
        const result = await upstream.completeOnboardingTask(account.session, task.key)
        if (result?.ok) row.status = result.data?.alreadyCompleted === true ? 'done' : 'claimed'
        else {
          row.status = 'failed'
          row.error = describeError(result?.error)
          fail('task', `${task.key}: ${row.error}`)
        }
      }
      report.tasks.rows.push(row)
    }
  }

  return report
}

/** 领权益报告 → 精简摘要（登录 API 响应、管理台/终端展示共用）。 */
export function summarizeBonus (report) {
  if (!report) return null
  return {
    ok: report.ok,
    invite: {
      status: report.invite.status,
      inviteCode: report.invite.inviteCode,
      fromLabel: report.invite.fromLabel,
      rewards: report.invite.rewards,
    },
    tasks: {
      earned: report.tasks.earned,
      total: report.tasks.total,
      claimed: report.tasks.rows.filter((row) => row.status === 'claimed').length,
    },
    errors: report.errors,
  }
}

const INVITE_STATUS_TEXT = {
  bound: '已绑邀请码',
  'already-activated': '邀请码已绑定',
  'no-code': '池内暂无可用邀请码',
  'dry-run': '邀请码未绑定（dry-run）',
  failed: '邀请码绑定失败',
  error: '邀请码查询失败',
  skipped: '邀请码跳过',
}

/** 摘要 → 一行终端文案（cli login / 日志用）。传 null 表示本次根本没领。 */
export function formatBonusLine (summary) {
  if (!summary) return '权益: 未自动领取（login.autoBonus 关闭或出错，详见日志）'
  const parts = []
  const invite = summary.invite || {}
  const text = INVITE_STATUS_TEXT[invite.status] || `邀请码 ${invite.status || '状态未知'}`
  if (invite.status === 'bound') {
    const reward = Number(invite.rewards?.inviteeReward) || 0
    const from = invite.fromLabel ? `（来自 ${invite.fromLabel}）` : ''
    parts.push(`${text} ${invite.inviteCode}${from}${reward ? ` +${reward}` : ''}`)
  } else if (invite.status === 'already-activated' && invite.inviteCode) {
    parts.push(`${text} ${invite.inviteCode}`)
  } else {
    parts.push(text)
  }
  const tasks = summary.tasks || {}
  if (tasks.total) {
    const claimed = tasks.claimed ? `本次补领 ${tasks.claimed} 条` : '无新增'
    parts.push(`新手任务 ${tasks.earned ?? 0}/${tasks.total}（${claimed}）`)
  }
  if (summary.errors?.length) {
    parts.push(summary.errors.map((item) => `${item.step} 失败: ${item.message}`).join('; '))
  }
  return `权益: ${parts.join(' · ')}`
}
