# 新账号权益：新手任务 + 邀请码（做任务赢积分好礼）

Loomy 账号除了「每日赠送积分」和「宠物打工」，还有两块**一次性**的永久积分权益：

| 权益 | 入口 / 接口 | 单个账号可得 | 能否重复 |
| --- | --- | --- | --- |
| 新手任务（客户端右上角「做任务赢积分好礼」） | `GET/POST /api/v1/onboarding/tasks*` | **10000** | 一次性，8 条各一次 |
| 填写邀请码 | `POST /api/v1/points/activation` | **5000**（从未领过注册奖励的账号再补 **5000**） | 每账号只能绑一次 |
| 邀请码被他人使用（码主） | 同上，绑定成功后自动到账 | **5000 / 人** | 每码最多 1000 次 |

所以一个全新账号按下面的流程走一遍，永久积分大约 **+20000**；之后再靠每日赠送（5000/天）和宠物打工（日限 1000）。

## 建号标准流程

```bash
# 1) 拿 session（三选一）
node src/cli.js import-local                    # 复用本机 Loomy 登录态
node src/cli.js login --phone 1xxxxxxxxxx       # 短信登录（服务端建议 cli 两段式）
# 或管理台：账号 → 短信登录

# 2) 权益默认已自动领（见下一节）；需要手动补/重跑时：
node src/cli.js bonus --account <id|名称|手机号>          # 只补新手任务
node src/cli.js bonus --account <id|名称|手机号> --invite auto   # 自动从池内摸一个邀请码

# 3) 核对余额（每日 / 永久）
node src/cli.js accounts points
```

- `--dry-run` 只读不写，可以先看一眼还差哪些任务。
- 两个动作服务端都做幂等校验（`alreadyActivated` / `alreadyCompleted`），**重复执行不会重复加分**，所以可以放心写进建号脚本。
- 邀请码从池内摸一个即可：`GET /api/v1/invitation-codes`（每个账号一个 6 位码，`status=active`，`maxUses` 1000）。绑定过邀请码之后，新账号自己也会自动获得一个邀请码，可以留给下一个号用。

## 自动领取（默认开）

建号入口（短信登录 / 导入登录态）成功后，网关自己跑一遍上面第 2 步：

```
afterLogin(account)                    # src/server.js
  → autoClaimBonus(account)            # src/core/bonus.js: claimAccountBonus
      ① 补全未完成的新手任务（已完成的跳过，不重复提交）
      ② 若账号未绑过码，从池内摸一个 active 邀请码绑定
  → refreshModels / pointsTracker.refreshAccount   # 先领后刷，wallet 里能看到刚到的积分
```

配置（`config/config.json` → `login`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `login.autoBonus` | `true` | 建号后自动补新手任务；`false` 则完全自动不领 |
| `login.autoInvite` | `true` | 自动绑池内邀请码；`false` 则只补任务、不绑码 |

环境变量：`LOOMY_PROXY_LOGIN_AUTO_BONUS` / `LOOMY_PROXY_LOGIN_AUTO_INVITE`。

注意事项：

- 摸码会跳过自己、停用的账号、非 `active` 或已用尽的码，起点随机，避免新号全挂同一个码主下。
- 绑定不可改：自动绑定后想换码主只能换账号，所以对码主有要求时先设 `login.autoInvite: false`，建完号再手动 `bonus --invite <CODE>`。
- 领权益失败（上游报错、池内无码）只记日志与 `after.bonus.errors`，**不会让登录失败**；CLI 手动跑时失败会以非 0 退出码结束。
- 管理台短信登录成功后的弹窗会列出「已绑邀请码 X（来自 Y） · 补领新手任务 N 条」。

## 新手任务清单（8 条 / 合计 10000）

| key | 客户端标题 | 积分 | 服务端流水名 |
| --- | --- | --- | --- |
| `first_message` | 发送你的第一条消息 | 500 | 新手任务-发送第一条消息 |
| `pick_skill` | 试试选择一个技能 | 1000 | 新手任务-选择技能并发送 |
| `generate_ppt` | 生成第一份 PPT | 1500 | 新手任务-生成 PPT |
| `set_schedule` | 设置定时任务 | 1000 | 新手任务-设置定时任务 |
| `install_skill` | 在技能广场安装一个技能 | 1500 | 新手任务-技能广场安装一个技能 |
| `configure_remote` | 配置远程控制 | 1000 | 新手任务-配置远程控制 |
| `create_soul` | 创建你的第一个搭子 | 1500 | 新手任务-创建第一个搭子 |
| `share_soul` | 把搭子分享给朋友 | 2000 | 新手任务-分享搭子 |

客户端侧本来是「做动作自动打卡」：发消息、选中技能、命中预填文案、建定时任务、装技能、保存远程配置、建搭子、分享搭子；挂载时还会用本地数据回扫补领前四项。
但服务端只按 `key` 记账、不校验动作来源，所以直接 `POST /api/v1/onboarding/tasks/complete {key}` 即可（`bonus` 命令就是这么做的）。

## 协议细节

```
GET  {pointsBase}/api/v1/onboarding/tasks
     → data{tasks{key:boolean}, earned, total}          # earned 客户端自己按注册表现算

POST {pointsBase}/api/v1/onboarding/tasks/complete
     body {key} → data{alreadyCompleted, balance}        # balance 是新手任务累计值，不是积分余额

GET  {pointsBase}/api/v1/points/activation
     → data{activated, appliedInvitationCode}

POST {pointsBase}/api/v1/points/activation
     body {inviteCode}
     → data{activated, alreadyActivated, registerReward, inviteeReward, inviterReward,
            permanentBalance, dailyBalance, dailyQuota, dailyConsumed, dailyCycleDate,
            appliedInvitationCode, invitationCodes[{inviteCode, usedCount, maxUses, status}]}
```

- `pointsBase` = `config.upstream.baseUrl` 去掉 `/api/v1`（生产为 `https://loomyad.xunfei.cn`）。
- 头只有 `token: <session>`；统一 envelope `{code, desc, trace_id, data}`，`000000` 为成功，`100002` 是 session 失效。
- 奖励入账方向是 `credit`，可在 `GET /api/v1/points/records?recordType=earned` 核对，描述分别是
  `注册奖励` / `填写邀请码奖励` / `邀请好友奖励` / `新手任务-xxx`。
- 注意 `dailyMaxPoints`/`tiers` 那套是**宠物打工**（`/api/v1/pet-work`），每天重置、日限 1000，和本文的一次性权益不是一条链路。

## 实测记录（2026-10-22，服务器 154.40.58.3）

| 账号 | 邀请码 | 绑定的码 | 新手任务 | 邀请码收益 | 永久余额变化 |
| --- | --- | --- | --- | --- | --- |
| 本机导入 152****5487 | 7NMABG | TR9BBD | 3500 → 10000 | 填码 +5000，邀请 2 人 +10000 | 18310 → 33295 |
| lisama 152****5141 | TR9BBD | 7NMABG | 7000 → 10000 | 填码 +5000，邀请 1 人 +5000 | 21521 → 33499 |
| NK5756347 180****6347 | MGTT64（绑定后生成，未使用） | 7NMABG | 0 → 10000 | 填码 +5000，补注册奖励 +5000 | 14353 → 24353 |

三个号一共补进 **≈54500 永久积分**（新手任务 19500 + 邀请/注册 35000）。

## 注意事项

- **别用自己的码给自己绑**：服务端不校验归属，但会浪费掉唯一一次填码机会，收益一样只有 5000。
- 同一台机器连续批量注册容易被风控，邀请码绑定最好分散设备/时间。
- session 有效期 14 天；`bonus` 失败一般是 session 失效（`100002`）或上游连接抖动，重跑即可（幂等）。
- 邀请码绑定后不可更改（`activated: true` 之后再调会返回 `alreadyActivated`）。
