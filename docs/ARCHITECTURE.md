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
