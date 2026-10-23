# LoomyProxy 架构

## 1. 定位

LoomyProxy 是一个**自托管 AI 网关**：上游是 Loomy（讯飞 iModel）的账号池，下游对客户端暴露
标准 OpenAI / Anthropic 协议。客户端只改两行配置（`base_url` + `api_key`），
不需要知道 session、签名、追踪头这些 Loomy 专有细节。

设计上对齐几个成熟开源项目：

| 参考项目 | 借鉴点 |
| --- | --- |
| [songquanpeng/one-api](https://github.com/songquanpeng/one-api)、[QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 渠道/令牌/用量/日志四件套；统一 OpenAI 兼容面；上游凭据只存服务端 |
| [tbphp/gpt-load](https://github.com/tbphp/gpt-load) | 「分组 + 凭据池」模型；权重调度、失败冷却、会话亲和、请求日志与用量核算 |
| [sdivyanshu90/build-your-own-ai-gateway](https://github.com/sdivyanshu90/build-your-own-ai-gateway)、[shuv1337/proxx](https://github.com/shuv1337/proxx) | 首字节前故障转移；OpenAI 与 Anthropic 双协议入口；密钥级限流 |

差异点（Loomy 特有，别家没有）：
**上游业务错误返回 HTTP 200**，所以错误识别只能解析 body 的 `code/desc`；
账号凭据是「登录 session」而非 API Key，需要短信登录或从本机客户端导入。

## 2. 分层

```
客户端 (Cherry Studio / NextChat / OpenAI SDK / Claude Code / Cline …)
        │  Authorization: Bearer sk-loomy-…
        ▼
┌──────────────────────────────────────────────────────────────┐
│ src/server.js            HTTP 路由 / CORS / 密钥鉴权 / 限流    │
├──────────────────────────────────────────────────────────────┤
│ src/routes/                                                    │
│   openai.js     /v1/chat/completions /v1/models /images        │
│   anthropic.js  /v1/messages                                  │
│   admin.js      /admin/api/*（账号、密钥、模型、用量、设置）    │
│   shared.js     SSE 探测、body 复用、usage 归一                 │
├──────────────────────────────────────────────────────────────┤
│ src/core/                                                      │
│   executor.js   首字节前故障转移（换账号重试）                  │
│   scheduler.js  策略选择 + 冷却 + 会话亲和                      │
│   accounts.js   账号池持久化（session 脱敏输出）                │
│   keys.js       下游密钥（sha256 摘要存储）                     │
│   usage.js      用量账本（按 模型/账号/密钥 聚合 + JSONL）      │
│   models.js     模型目录缓存 + OpenAI 投影                      │
├──────────────────────────────────────────────────────────────┤
│ src/upstream/client.js   头拼装 / 信封解析 / SSE 透传 + usage    │
│ src/auth/*               讯飞签名、账号 API、.env 解密、本机导入 │
└──────────────────────────────────────────────────────────────┘
        │  Authorization: Bearer <loomy session>
        ▼
   https://loomyad.xunfei.cn/api/v1   （OpenAI + Anthropic + images）
```

## 3. 请求生命周期

1. **鉴权**：`Authorization: Bearer` / `x-api-key` → sha256 比对密钥表；未命中 401。
2. **限流**：按密钥令牌桶（每分钟，`limits.requestsPerMinutePerKey` 或密钥自身 rpm）。
3. **模型解析**：显式 `model` 优先，否则用目录里的默认主模型；密钥可限定模型白名单。
4. **调度**：`scheduler.candidates()` 返回有序候选 —— 亲和账号优先，其后按策略（轮询/加权/填满）。
5. **转发**：拼齐 `Authorization/token/traceparent/loomy-version/ChatId/MsgId/TurnId/X-Loomy-Request-Purpose`。
6. **判定**：
   - `content-type: text/event-stream` → 直接透传字节（`relaySse` 顺带抓 usage）；
   - 其它 → 读完整 body，解析 `{code,desc}` 信封；`code!=000000` 视为失败。
7. **故障转移**：失败账号冷却/标失效，换下一个账号重试（`pool.maxRetries`，默认 2 次）。
   **只在首字节前回退**，已经吐给客户端的流不会重放。
8. **记账**：`usage.record()` 落 JSONL，并按模型/账号/密钥聚合；账号积分累加。

## 4. 账号池状态机

```
           add/import/login
                  │
                  ▼
        ┌───► active ──── 上游 100002 ───► invalid（需重新登录）
        │       │
        │       ├── 超时 / 5xx / 429 ──► cooling（cooldownUntil）
        │       │                            │
        │       └────── 冷却到期 ◄───────────┘
        │
        └── 校验通过（/userinfo/query/baseInfo）
enabled=false ──► disabled（不参与调度）
```

- `effectiveStatus()` 每次读都按 `enabled / invalid / cooldownUntil` 重新计算，避免脏状态。
- `fill-first` 便于「主账号优先」，`weighted` 便于按额度分摊，`round-robin` 适合等权池。
- `sessionAffinity`：按会话键（`x-loomy-chat-id` 头 → `user` 字段 → 首条消息哈希）粘账号，
  减少同一对话在账号间跳动；TTL 默认 30 分钟。

### 4.1 积分优先级（每日 → 永久）

上游 `GET /api/v2/points/records` 返回 `{balance, dailyBalance, …}`：

| 字段 | 含义 | 特性 |
| --- | --- | --- |
| `dailyBalance` | 每日赠送积分 | 当天有效，跨天重置，**要优先烧掉** |
| `balance` | 永久积分 | 不过期，用一点少一点 |

扣分先后由上游服务端决定，网关能做的是「选账号」，所以把账号分成四个档位（`core/points.js`）：

```
档位 0  daily      wallet.daily > 0            ← 最高优先
档位 1  unknown    尚未拉到余额                ← 不阻塞旧数据缺失的账号
档位 2  permanent  每日为 0、永久 > 0         ← 所有账号每日都见底后才轮到
档位 3  empty      两边都为 0                   ← 仍可尝试，排最后
```

- 同一档内仍由 `round-robin / weighted / fill-first` 决定顺序；会话亲和只在同一档内生效，
  避免「为了粘会话而绕过每日积分」。
- 余额由 `PointsTracker` 维护：启动时全量拉一次、`pool.pointsRefreshSeconds`（默认 300s）定时刷新、
  调度路径上按 TTL 非阻塞刷新（`poke`，单账号间隔 ≥ `pointsMinRefreshSeconds`）。
- 每次请求成功后按 `usage.points_consumed` 本地估算扣减（先扣每日再扣永久）；估算把每日扣到 0 时
  立刻触发一次上游核对，避免估算误差导致长期误判。
- 脚本/自动化：`node src/cli.js accounts points`、管理台「刷新积分」、`POST /admin/api/points/refresh`。
- 关闭方式：`pool.preferDailyPoints=false`（或 `LOOMY_PROXY_PREFER_DAILY_POINTS=false`），退回纯策略调度。

### 4.2 上游连接层韧性（首字节超时 + 重连）

上游 `loomyad.xunfei.cn` 解析到两条 A 记录（`114.118.75.244 / .245`，TTL 600s），
实测会出现“TCP 握手成功、TLS/首字节长时间不回”的边缘节点抽风：
同一个时刻一个 IP 正常、另一个卡死，过几分钟又都恢复。

这类失真最容易被放大，因为：

- undici 默认 `connectTimeout` 是 10s，而且 TCP 层算“已连通”，所以不会切到另一个地址；
- 网关的重试是换**账号**，host 不变，连接池还缓存着同一个 origin。

所以 `upstream/client.js` 把超时拆成两段：

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `upstream.connectTimeoutMs` | 8000 | 拿不到**响应头**就放弃本次尝试（可重试），不等 10s |
| `upstream.connectRetries` | 1 | 连接层失败（`UND_ERR_CONNECT_TIMEOUT / ECONNRESET / ECONNREFUSED / EAI_AGAIN / ENOTFOUND / UPSTREAM_CONNECT_TIMEOUT` …）立即重连重试，新连接会重新解析 DNS，有机会落到另一个边缘 |
| `upstream.timeoutMs` | 600000 | 拿到响应头之后，流式 body 的总时长 |

两个定时器都 `unref()`，不会把 CLI 进程吊死；**已经开始读流（SSE）的请求绝不重试**，
避免下游收到重复内容、也避免重复扣点。重试耗尽的请求会以 `NETWORK` 交给 `executor` 换账号。

排查建议：不要用 `/etc/hosts` 钉单 IP（容器重建即丢）——两台边缘都可能抽风，钉死等于把可用性
绑在一个 IP 上。先用 `curl --resolve loomyad.xunfei.cn:443:<ip> -m 8 https://loomyad.xunfei.cn/api/v1/models`
对比两条 A 记录，再看 `docker logs` 里是否出现“上游连接失败，立即重连重试”。

## 5. 数据与安全

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `config/config.json` | 服务 / 上游 / 池 / 限流设置 | 普通 |
| `data/accounts.json` | Loomy session（等价登录态） | 0600，接口只吐 `abcd****wxyz` |
| `data/keys.json` | 下游密钥 sha256 摘要 + 前缀 | 0600，明文只在创建时返回一次 |
| `data/usage.jsonl` | 用量流水 | 普通 |
| `data/models.json` | 模型目录缓存 | 普通 |

- 讯飞 AK/SK **不落本仓库**：启动时从 `E:\Loomy\resources\.env.prod` 解密到内存。
- 管理台鉴权：`server.adminPassword` 配置后走 HMAC 签名 Cookie（24h）；未配置时只允许 127.0.0.1。
- 默认只监听 `127.0.0.1`；对外暴露需自行配置 `--host` 并务必设置管理密码。

## 6. 明确不支持

| 接口 | 原因 |
| --- | --- |
| `/v1/embeddings` | 上游 404（客户端知识库 embedding 需另配 provider） |
| `/v1/completions` | 上游 404 |
| `/v1/audio/*` | Loomy 的语音走 RTASR 专用服务，不在 iModel 网关内 |
| 图片编辑/多图编排 | 上游 `/images/generations` 只接受 prompt + images[]，其余语义由客户端自行组合 |
