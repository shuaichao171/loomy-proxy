# LoomyProxy · Loomy 反代网关

把 **Loomy（讯飞 iModel）** 的账号池，统一暴露成 **OpenAI / Anthropic 兼容 API**。
零运行时依赖（Node 22+ 标准库），自带管理台、账号池调度、失败冷却、用量记账。

> 逆向过程与协议证据见 [`docs/REVERSE-ENGINEERING.md`](docs/REVERSE-ENGINEERING.md)，
> 架构与调度设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
> REA 取证坐标（产物哈希、evidence id、上游实测清单）见 [`docs/REA-EVIDENCE.md`](docs/REA-EVIDENCE.md)。

## 能力

- `POST /v1/chat/completions` — OpenAI 协议，支持 SSE 流式、`reasoning_effort`、工具调用透传
- `POST /v1/messages` — Anthropic 协议（Loomy 上游原生支持，含 thinking 块）
- `POST /v1/images/generations` — 文生图 / 图生图（`images[]`）
- `GET  /v1/models` — 上游模型目录（协议、上下文、能力、推理档位）
- 账号池：权重 / round-robin / fill-first、失败冷却、登录态失效自动隔离、会话亲和
- 积分优先级：先烧完所有账号的「每日赠送积分」，全部见底才动永久积分（`pool.preferDailyPoints`）
- 下游密钥：`sk-loomy-…`，可限定模型、每分钟限流，明文只显示一次
- 管理台 `/admin`：账号、密钥、模型、用量、日志、设置
- 免登录导入：直接复用本机已安装 Loomy 的登录态
- 短信登录：手机号 + 验证码换 auth（服务端保管 loginId，含冷却 / 配额 / 试错上限 / 审计），
  AK/SK 从 Loomy 安装目录的加密 `.env` 运行期解密，详见 [`docs/LOGIN-FLOW.md`](docs/LOGIN-FLOW.md)
- 建号后自动领新号权益（新手任务 + 池内邀请码，幂等），可用 `login.autoBonus` / `login.autoInvite` 关掉

## 快速开始

```bash
cd E:/ai-work2/LoomyProxy

# 1. 环境自检（找安装目录、解密 .env、读本机登录态）
node src/cli.js doctor

# 2. 导入本机 Loomy 的登录态（已装过 Loomy 并登录过即可）
node src/cli.js import-local

# 3. 生成一个给客户端用的密钥
node src/cli.js key create --name cherry-studio
#    → sk-loomy-xxxxxxxx…

# 4. 启动
node src/cli.js serve
#    http://127.0.0.1:8787/v1   ← 客户端 base_url
#    http://127.0.0.1:8787/admin ← 管理台
```

首次启动会自动生成 `config/config.json`（来自 `config/config.example.json`）。

## 客户端接入

### OpenAI 兼容（Cherry Studio / NextChat / ChatBox / OpenAI SDK / Cline）

```
Base URL: http://127.0.0.1:8787/v1
API Key : sk-loomy-xxxxxxxx          # 步骤 3 生成的
Model   : spark-x2.6 / qwen3.8-flash / auto …
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-loomy-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"spark-x2.6","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

### Anthropic 兼容（Claude Code 等）

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=sk-loomy-xxxxxxxx
```

`/v1/messages` 走 Loomy 上游原生的 Anthropic 端点，不做有损转换。

## 短信登录拿 auth

`session` 是 Loomy 上游唯一的鉴权凭据（14 天有效）。两种拿法：

```bash
# A. 本机已经装过 Loomy 并登录过 —— 直接复用
node src/cli.js import-local

# B. 手机号 + 验证码（会真实发一条短信）
node src/cli.js login                     # 交互式
# 或管理台：账号 → 短信登录
```

登录流程由服务端保管 `loginId`（内存 + `data/login-pending.json`，0600）：

```
send-code  →  {loginId, phoneMasked, expiresInSeconds, resendAfterSeconds}
verify     →  {account, created, profile, after:{models}}
```

要点：同一手机号/`userid` 再次登录不会新建账号，只把 `session` 换成新的（等于刷新 auth）；
发码有同号/同 IP 每小时配额与冷却；验证码只出现在上游请求里，审计只记掩码与结果。
完整协议、错误码与 curl 示例见 [`docs/LOGIN-FLOW.md`](docs/LOGIN-FLOW.md)。

**建号后自动领权益**：新账号有一次性的永久积分可以拿（新手任务 10000 + 填写邀请码 5000，
从未领过注册奖励的账号再补 5000）。短信登录 / 导入登录态成功后会自动领：先补全没做的新手任务，
再从账号池里摸一个可用邀请码绑定（同时给码主 +5000）。两个动作上游都是幂等记账，重跑不会重复加分。
关掉的办法：`login.autoBonus: false`（完全不自动领）、`login.autoInvite: false`（只补任务不自动绑码）。

手动补/重跑：

```bash
node src/cli.js bonus --account <id|名称>            # 只补新手任务（不绑码）
node src/cli.js bonus --account <id|名称> --invite auto      # 自动从池内摸一个邀请码
node src/cli.js bonus --account <id|名称> --invite 7NMABG    # 指定邀请码
node src/cli.js bonus --account <id|名称> --dry-run          # 只读不写
```

细则是 [`docs/ACCOUNT-BONUS.md`](docs/ACCOUNT-BONUS.md)。

## 部署

服务器部署（Docker + Nginx 反代，无需在服务器上 build）见 [`deploy/README.md`](deploy/README.md)：

```bash
git archive --format=tar.gz -o /tmp/loomy-src.tgz HEAD      # 或直接 rsync 工作区
scp /tmp/loomy-src.tgz root@<server>:/tmp/
ssh root@<server>
mkdir -p /www/wwwroot/docker/loomy-proxy-src && tar xzf /tmp/loomy-src.tgz -C /www/wwwroot/docker/loomy-proxy-src
cd /www/wwwroot/docker/loomy-proxy-src/deploy && bash install.sh
```

`install.sh` 会生成 `.env`（含管理台密码）、`config/config.json`，拉起容器并做健康检查；
对外入口由 Nginx vhost 反代（模板 [`deploy/nginx/loomy-proxy.conf`](deploy/nginx/loomy-proxy.conf)，SSE 已关缓冲）。

## 命令

```bash
node src/cli.js serve [--port 8787] [--host 127.0.0.1]
node src/cli.js doctor                 # 环境自检 + 上游连通性
node src/cli.js login                  # 短信登录：交互式（手机号 → 验证码）
node src/cli.js login --phone 1xxx --send-only          # 只发码，打印 loginId
node src/cli.js login --login-id x --code 123456        # 另一次命令提交验证码（可跨进程）
node src/cli.js login --list|--status id|--cancel id    # 管理未完成的登录流程
node src/cli.js import-local           # 导入本机 Loomy 登录态
node src/cli.js accounts [list|check|points|rm|enable|disable] [id]
node src/cli.js accounts points      # 拉取每日/永久积分余额，影响调度顺序
node src/cli.js key [list|create|rm] [--name x] [--rpm 60] [--models a,b]
                                       # ⚠️ 服务在跑时账号/密钥的增删改一律走管理台或管理 API，
                                       # 详见下文「服务在跑时，别用 CLI 直接改 data/」一节
node src/cli.js models [--json]        # 刷新并打印模型目录
node src/cli.js probe [--model x]      # 用账号池直打一发上游对话
node src/cli.js bonus --account x [--invite CODE|auto] [--dry-run]   # 新账号权益：邀请码 + 新手任务
npm test                               # 离线单测
```

## ⚠️ 服务在跑时，别用 CLI 直接改 `data/`（内存态会覆盖）

网关启动时把 `data/accounts.json`、`data/keys.json` **整表读进内存**，之后每一次写盘都是
**整表覆盖**（账号请求统计、冷却/失效标记、积分余额刷新、密钥 `lastUsedAt` 都会触发写盘）。
所以在 `node src/cli.js serve` 正在跑的时候，用**另一个进程**（CLI / `docker exec`）去改这两个文件：

- **新增的账号会被运行中进程的内存快照抹掉**（症状：`accounts list` 里看得见新号，过一会儿就没了）；
- 新密钥有 reload-on-miss 兜底（`Keys.verify()` 未命中会重读磁盘），但下一次任何写盘仍可能把它覆盖掉；
- 账号池侧的 reload 只在「池子为空」时才触发，所以外部新增的账号通常根本不会被发现。

**规则：服务在跑 → 增删改走进程内（管理台 / 管理 API）；要跑 CLI → 先停服务。**

| 操作 | 服务在跑时用这个 ✅ | 服务已停时用这个 ✅ |
| --- | --- | --- |
| 加账号（短信登录） | 管理台「账号池 → 短信登录」，或 `POST /admin/api/login/send-code` + `POST /admin/api/login/verify` | `node src/cli.js login` |
| 导入本机登录态 | `POST /admin/api/accounts/import-local` | `node src/cli.js import-local` |
| 建 / 删密钥 | `POST /admin/api/keys`、`DELETE /admin/api/keys/:id` | `node src/cli.js key create` / `key rm` |
| 启停账号 / 改权重 / 删账号 | `PATCH` / `DELETE /admin/api/accounts/:id` | `node src/cli.js accounts enable\|disable\|rm` |
| 刷新模型目录、积分余额 | `POST /admin/api/models/refresh`、`POST /admin/api/points/refresh` | `node src/cli.js models` / `accounts points` |
| 领新号权益 | `node src/cli.js bonus`（只写上游，最坏回写几个余额数字，账号不会丢） | 同左 |

不改 `data/` 的命令随时可跑：`doctor`、`probe`、`login --list/--status`、`login --send-only`；
`login --code <验证码>` 会建号，属于上面的「加账号」。管理 API 鉴权：本机且未设管理密码时直接放行，
设了密码就带 `Authorization: Bearer <管理密码>`。

## 配置要点（`config/config.json`）

| 键 | 说明 |
| --- | --- |
| `server.host` / `server.port` | 监听地址，默认 `127.0.0.1:8787` |
| `server.adminPassword` | 管理台密码；**留空＝仅本机可访问**；对外暴露前必须设置 |
| `upstream.baseUrl` | 上游根地址，生产 `https://loomyad.xunfei.cn/api/v1` |
| `upstream.clientVersion` | 发出去的 `loomy-version` 头 |
| `upstream.requestPurpose` | 默认 `X-Loomy-Request-Purpose`（`chat.message`） |
| `upstream.connectTimeoutMs` | 首字节/连接超时，超时即放弃本次尝试并可重试（默认 8000） |
| `upstream.connectRetries` | 连接层失败（未拿到响应头）立即重连的重试次数（0–3，默认 1） |
| `auth.loomyInstallDir` | Loomy 安装目录（用于解密 `.env`、导入登录态） |
| `pool.strategy` | `round-robin` / `weighted` / `fill-first` |
| `pool.maxRetries` | 失败后最多换几个账号重试（0–5） |
| `pool.cooldownSeconds` | 失败账号冷却时长 |
| `pool.sessionAffinity` | 同一会话是否粘同一账号 |
| `pool.preferDailyPoints` | `true`（默认）：先把每日赠送积分烧完，全部为 0 才用永久积分；档位顺序 每日 → 未知 → 永久 → 无 |
| `pool.pointsRefreshSeconds` | 积分余额刷新 TTL（秒，默认 300）；请求路径上按 TTL 非阻塞刷新 |
| `pool.pointsMinRefreshSeconds` | 单账号两次刷新余额的最小间隔（秒，默认 60） |
| `limits.requestsPerMinutePerKey` | 每密钥每分钟请求上限，0 = 不限 |
| `login.resendCooldownSeconds` | 两次发码的最小间隔，默认 60 |
| `login.maxAttempts` | 单次登录允许的错误验证码次数，默认 5 |
| `login.maxSendsPerHour` | 同号 / 同 IP 每小时发码上限，默认 5 |
| `login.pendingTtlSeconds` | 登录流程保存时长，默认 900 |
| `login.autoBonus` | 建号（短信登录 / 导入）成功后自动补新手任务，默认 `true` |
| `login.autoInvite` | 自动从池内摸一个邀请码给新号绑定，默认 `true` |

环境变量覆盖：`LOOMY_PROXY_HOST/PORT/ADMIN_PASSWORD/UPSTREAM_BASE/ACCOUNT_BASE/LOOMY_DIR/ENV_FILE/LOG_LEVEL`。

## 免责与边界

- 本项目只做**协议复刻与自用聚合**，不破解、不修改 Loomy 客户端；账号与计费仍由讯飞服务端裁决。
- 上游 `points_consumed` 会照实消耗你账号的积分；多账号分摊请自行评估合规性。
- 不提供 `/v1/embeddings`、`/v1/completions`（上游 404）；`/v1/audio/*` 不在 iModel 网关范围。
- 请遵守 Loomy / 讯飞的服务条款与当地法律法规，不要用于公开二次分发。
