# 手机号 + 验证码登录

Loomy 的 auth 是一枚 32 位 `session`（14 天有效），由讯飞账号服务下发。
本网关把「拿 session」这件事做成了一条可审计、可重试的登录流程，
而不是让调用方自己拼 `msgid`。

## 1. 协议来源

| 步骤 | 上游（`{accountBaseUrl}`，生产 `https://account.xfinfr.com`） | 请求体 |
| --- | --- | --- |
| 发码 | `POST /login/phone/sendMsgCode` | `{base, param:{ccode:'86', phone, expire:300}}` → `data.msgid` |
| 校验 | `POST /login/phone/checkCode` | `{base, param:{ccode, phone, mcode, msgid, expire:14*24*3600}}` → `data.session` |
| 资料 | `POST /userinfo/query/baseInfo` | `{base, param:{session}}` → `data.userid/phone/nickname` |

`base` 固定字段：`{appid, modelid:'Web', version:'1.0.0', devid:'web', ua:'Loomy|Desktop|Electron|macOS', traceid}`。
全部请求用 HMAC-SHA1 签名（`Authorization: account <AK>:<sig>`），AK/SK 从
Loomy 安装目录的 `.env`（`LOOMYENC1` 加密）里解密得到，见 `src/auth/envfile.js`。
业务错误同样是 HTTP 200 + `{code, desc}`，`000000` 才算成功。

## 2. 本网关的流程

```
POST /admin/api/login/send-code  {phone}
      │  ← {loginId, phoneMasked, expiresInSeconds, resendAfterSeconds, attemptsLeft}
      ▼
   （手机收到验证码）
      ▼
POST /admin/api/login/verify     {loginId, code}
      │  ← {account, created, profile, after:{models}}
      ▼
   session 落进账号池（accounts.json，0600），立刻拉一次 /models 验证 auth 可用
```

设计要点：

- **msgid 由服务端保管**。pending 记录存在内存 + `data/login-pending.json`（0600），
  因此 CLI 两条命令、服务重启、页面刷新都不会丢流程；过期自动清理。
- **同人重复登录 = 刷新 auth**。按 `userid`（其次 `phone`）匹配已有账号，
  只替换 `session` 并把状态改回 `active`，不会堆出重复账号。
- **验证码绝不落日志**。审计只写 `data/login-audit.jsonl`：动作、手机号掩码、IP、结果、账号 id。
- **建号后自动领权益**。登录成功先补新手任务、再从池内摸一个邀请码绑定（幂等，重跑不重复加分），
  开关 `login.autoBonus` / `login.autoInvite`，细则见 [`ACCOUNT-BONUS.md`](ACCOUNT-BONUS.md)。
- **限流是服务端强制的**：同号/同 IP 每小时最多 `maxSendsPerHour` 次发码，
  两次发码之间至少 `resendCooldownSeconds` 秒，单次登录最多试 `maxAttempts` 次验证码。

## 3. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/api/login/send-code` | `{phone, name?}` → 发码，返回 `loginId` 与倒计时 |
| POST | `/admin/api/login/resend` | `{loginId}` → 换新 msgid（受冷却与配额约束） |
| POST | `/admin/api/login/verify` | `{loginId, code}` → 校验并落库；也接受旧形态 `{phone, code, msgid}` |
| GET | `/admin/api/login/status?loginId=` | 查状态（剩余秒数 / 剩余尝试次数） |
| POST | `/admin/api/login/cancel` | `{loginId}` → 放弃本次登录 |

错误统一为 `{error, code, ...details}`，`code` 取值：

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_PHONE` | 400 | 手机号格式不对 |
| `INVALID_CODE` | 400 | 验证码不是 4–8 位数字 |
| `CREDENTIALS_MISSING` | 503 | 没解出 AK/SK，无法签名 |
| `SEND_FAILED` / `NO_MSGID` | 400 / 502 | 上游发码失败或没回 msgid |
| `RESEND_COOLDOWN` | 429 | 冷却中，附 `retryAfterSeconds` |
| `SEND_QUOTA_EXCEEDED` | 429 | 每小时配额用尽，附 `retryAfterSeconds` |
| `NOT_FOUND` | 404 | loginId 不存在（进程重启且已落盘的流程也被清掉） |
| `LOGIN_EXPIRED` | 410 | 超过 `pendingTtlSeconds` |
| `TOO_MANY_ATTEMPTS` | 429 | 验证码试错次数用尽 |
| 上游业务码（如 `100001`） | 400 | 验证码错误，附 `attemptsLeft` |

## 4. 用法

### 管理台（推荐）

账号页 → **短信登录**：填手机号 → 发送验证码（按钮带 60s 倒计时）→
填码 → 登录。成功后弹窗内直接显示账号昵称/掩码手机号/模型同步结果。

### CLI

```bash
# 一次跑完（交互式，会提示输入手机号与验证码）
node src/cli.js login

# 两段式：先发码，稍后另一条命令提交验证码（靠 data/login-pending.json 续跑）
node src/cli.js login --phone 13800000000 --send-only
node src/cli.js login --login-id login_xxx --code 123456

# 管理未完成的流程
node src/cli.js login --list
node src/cli.js login --status login_xxx
node src/cli.js login --cancel login_xxx
```

### curl

```bash
curl -s -X POST http://127.0.0.1:8787/admin/api/login/send-code \
  -H 'Content-Type: application/json' -d '{"phone":"13800000000"}'
# → {"ok":true,"loginId":"login_...","phoneMasked":"138****0000","expiresInSeconds":900,...}

curl -s -X POST http://127.0.0.1:8787/admin/api/login/verify \
  -H 'Content-Type: application/json' -d '{"loginId":"login_...","code":"123456"}'
# → {"ok":true,"created":true,"account":{...},"after":{"models":{"ok":true,"count":13}}}
```

## 5. 配置

```json
"login": {
  "codeTtlSeconds": 300,        // 上游验证码有效期（sendMsgCode 的 expire）
  "pendingTtlSeconds": 900,     // 本网关保存登录流程的时长
  "resendCooldownSeconds": 60,  // 两次发码的最小间隔
  "maxAttempts": 5,             // 单次登录允许的错误验证码次数
  "maxSendsPerHour": 5,         // 同号 / 同 IP 每小时发码上限
  "maxPending": 200             // 内存中最多保留的登录流程数
}
```

环境变量覆盖：`LOOMY_PROXY_LOGIN_RESEND_COOLDOWN`、`LOOMY_PROXY_LOGIN_MAX_ATTEMPTS`。

## 6. 边界与风险

- 发码会真实触发短信，且上游可能对同一号码有每日上限；不要拿它做压测。
- `session` 有效期 14 天，到期后上游返回 `100002`，账号会被标 `invalid`，
  此时重新走一次本流程即可刷新（同一账号不会重复）。
- 账号服务 `appid=GM3LOOMY` 的 AK/SK 来自客户端安装包，属于客户端凭据；
  本网关只在本机解密使用，不写入仓库、不回显到接口输出。
- 拿到 session 后别忘了领新账号的一次性权益（新手任务 10000 + 邀请码 5000），
  幂等且只需一条命令：`node src/cli.js bonus --account <id|名称> --invite <池内邀请码>`，
  细则见 [`ACCOUNT-BONUS.md`](ACCOUNT-BONUS.md)。
- 未实现：图形验证码/滑块（上游当前不需要）、密码登录（需要 `getPuKey` 的 RSA 公钥流程）、
  WeChat 扫码绑定。需要时可在此流程上扩展 `start()` 的 scene 分支。
