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
- 下游密钥：`sk-loomy-…`，可限定模型、每分钟限流，明文只显示一次
- 管理台 `/admin`：账号、密钥、模型、用量、日志、设置
- 免登录导入：直接复用本机已安装 Loomy 的登录态
- 短信登录：手机号 + 验证码换 auth（服务端保管 loginId，含冷却 / 配额 / 试错上限 / 审计），
  AK/SK 从 Loomy 安装目录的加密 `.env` 运行期解密，详见 [`docs/LOGIN-FLOW.md`](docs/LOGIN-FLOW.md)

## 快速开始

```bash
cd E:/Loomy/LoomyProxy

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
node src/cli.js accounts [list|check|rm|enable|disable] [id]
node src/cli.js key [list|create|rm] [--name x] [--rpm 60] [--models a,b]
node src/cli.js models [--json]        # 刷新并打印模型目录
node src/cli.js probe [--model x]      # 用账号池直打一发上游对话
npm test                               # 离线单测
```

## 配置要点（`config/config.json`）

| 键 | 说明 |
| --- | --- |
| `server.host` / `server.port` | 监听地址，默认 `127.0.0.1:8787` |
| `server.adminPassword` | 管理台密码；**留空＝仅本机可访问**；对外暴露前必须设置 |
| `upstream.baseUrl` | 上游根地址，生产 `https://loomyad.xunfei.cn/api/v1` |
| `upstream.clientVersion` | 发出去的 `loomy-version` 头 |
| `upstream.requestPurpose` | 默认 `X-Loomy-Request-Purpose`（`chat.message`） |
| `auth.loomyInstallDir` | Loomy 安装目录（用于解密 `.env`、导入登录态） |
| `pool.strategy` | `round-robin` / `weighted` / `fill-first` |
| `pool.maxRetries` | 失败后最多换几个账号重试（0–5） |
| `pool.cooldownSeconds` | 失败账号冷却时长 |
| `pool.sessionAffinity` | 同一会话是否粘同一账号 |
| `limits.requestsPerMinutePerKey` | 每密钥每分钟请求上限，0 = 不限 |
| `login.resendCooldownSeconds` | 两次发码的最小间隔，默认 60 |
| `login.maxAttempts` | 单次登录允许的错误验证码次数，默认 5 |
| `login.maxSendsPerHour` | 同号 / 同 IP 每小时发码上限，默认 5 |
| `login.pendingTtlSeconds` | 登录流程保存时长，默认 900 |

环境变量覆盖：`LOOMY_PROXY_HOST/PORT/ADMIN_PASSWORD/UPSTREAM_BASE/ACCOUNT_BASE/LOOMY_DIR/ENV_FILE/LOG_LEVEL`。

## 免责与边界

- 本项目只做**协议复刻与自用聚合**，不破解、不修改 Loomy 客户端；账号与计费仍由讯飞服务端裁决。
- 上游 `points_consumed` 会照实消耗你账号的积分；多账号分摊请自行评估合规性。
- 不提供 `/v1/embeddings`、`/v1/completions`（上游 404）；`/v1/audio/*` 不在 iModel 网关范围。
- 请遵守 Loomy / 讯飞的服务条款与当地法律法规，不要用于公开二次分发。
