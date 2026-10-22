# Loomy 逆向分析报告

> 目标：`E:\Loomy`（Loomy Desktop 0.9.39，iFlyTek 讯飞，Electron 应用）
> 目的：取得上游 LLM 协议与鉴权细节，据此实现 OpenAI / Anthropic 兼容反代网关。
> 分析日期：2026-10；结论均可在下文标注的产物/文件/实测量之间交叉验证。
> REA 取证坐标（产物 SHA-256 / evidence id / 实测清单）见 [`REA-EVIDENCE.md`](REA-EVIDENCE.md)。

## 0. 结论速览

| 项目 | 结论 |
| --- | --- |
| 应用形态 | Electron 34+，主进程入口 `electron/entry.js`，业务代码几乎全部**未混淆且明文**落在 `resources/app.asar.unpacked/electron/` |
| 硬完整性 | Electron fuse：`EnableEmbeddedAsarIntegrityValidation=disabled`、`OnlyLoadAppFromAsar=disabled`、`RunAsNode=enabled`（见 REA `inspect_electron_fuses`，证据 `ev_b77ad268…`） |
| LLM 上游 | `https://loomyad.xunfei.cn/api/v1`（生产）/ `https://ossptest.voicecloud.cn/loomy/integration/api/v1`（测试） |
| LLM 鉴权 | `Authorization: Bearer <session>`（32 位登录态），另有 `token` 冗余头 |
| 上游协议 | **就是 OpenAI 兼容协议**，额外支持 Anthropic `/messages`、`/images/generations` |
| 错误语义 | 业务错误也用 **HTTP 200**，body `{"code":"100002","desc":"登录已失效，请重新登录"}` |
| 登录 | 讯飞账号服务 `https://account.xfinfr.com`，HMAC-SHA1 请求签名（AK/SK 藏在加密的 `.env.prod`） |
| 运行期 | 客户端把上游包成 OpenCode provider `imodel`（`@ai-sdk/openai-compatible`），模型表来自上游 `/models` |

## 1. 产物结构与取证

```
E:\Loomy\
├─ Loomy.exe                       # Electron 主程序（214 MB，PE）
├─ resources\
│  ├─ app.asar                     # 231 MB，含 dist/ 前端、src/ 共享模块、electron/ 主进程副本
│  ├─ app.asar.unpacked\electron\  # ★ 主进程源码明文，805 个文件
│  ├─ .env.prod                    # ★ LOOMYENC1 加密的配置（AK/SK、各后端地址）
│  └─ opencode-home-template\      # OpenCode 运行时模板（opencode.json 里就是 imodel provider）
```

- REA `inspect_electron_fuses`：asar 完整性校验未启用 → 可直接读 `app.asar`、可热替换资源。
- REA `analyze_javascript_application`（10 个指定源文件，证据父节点 `ev_bb9bf3ea…`）：
  `parsed_javascript_files=10`、`request` 家族 39 条关系、`configuration` 22 条，
  与下文手工阅读一致，用于给出「静态可证」的边界。

`.env.prod` 解密（`electron/utils/env-file-crypto.js`）：

```
LOOMYENC1:<base64( salt(16) | iv(12) | tag(16) | AES-256-GCM 密文 )>
KDF = scrypt(口令, salt, 32)，口令随客户端分发（源码里叫 local-obfuscation）
```

解密后可见（仅列结构，**不在此记录具体密钥值**）：

```
VITE_XFYUN_BASE_URL       = https://account.xfinfr.com
VITE_XFYUN_APP_ID         = GM3LOOMY
VITE_XFYUN_ACCESS_KEY_ID  / _SECRET   ← 账号服务 HMAC 签名凭据
LOOMY_POINTS_BASE_URL     = https://loomyad.xunfei.cn      ← LLM 上游根
LOOMY_NEXUS_URL / ATHENA_* = 跨端同步（与本项目无关）
```

## 2. LLM 上游协议

### 2.1 地址与鉴权

`electron/bundled-resources.js` 把 provider `imodel` 的 `baseURL` 改写为
`<pointsBaseUrl>/api/v1` 并置 `useSessionAuth: true`：

```js
const imodelBaseURL = pointsBaseUrl.endsWith('/api/v1') ? pointsBaseUrl : `${pointsBaseUrl}/api/v1`
imodelProvider.options = { ...(imodelProvider.options||{}), baseURL: imodelBaseURL, useSessionAuth: true }
```

`useSessionAuth` 的含义见 `electron/llm/llm-completion.js`：
不存 apiKey，直接用**登录态 session 当 Bearer**。

### 2.2 请求头

`electron/utils/request-headers.js` + `electron/utils/app-version.js` 拼出头集合：

| 头 | 作用 | 是否必需 |
| --- | --- | --- |
| `Authorization: Bearer <session>` | 鉴权 | **必需**（实测只有它就能通过） |
| `token: <session>` | 客户端冗余（部分网关读它） | 非必需 |
| `traceparent: 00-<32hex>-<16hex>-01` | 链路追踪；源码注释称缺失时部分模型会挂到超时 | 建议带 |
| `loomy-version: 0.9.39` | 客户端版本 | 非必需（实测缺失仍 200） |
| `ChatId` / `MsgId` / `TurnId` | 轮次与计费归因（`/api/v2/points/records` 里按 `chatId` 聚合） | 非必需 |
| `X-Loomy-Request-Purpose` | 17 个协议用途（`chat.message`、`image.generate`、`kb.vision`…），服务端按用途裁决计费 | 非必需 |
| `anthropic-version: 2023-06-01` | 仅 `/messages` | 走 Anthropic 协议时需要 |

### 2.3 端点（实测）

| 端点 | 结果 |
| --- | --- |
| `GET /models` | 200，返回 `reasoning_enabled`、`reasoning_catalog_version` 与 `data[]` 模型数组 |
| `POST /chat/completions` | 200，OpenAI 兼容；流式 SSE；`usage.points_consumed` 表示扣分 |
| `POST /messages` | 200，Anthropic 兼容（含 `thinking` 块、SSE `message_start/content_block_delta/...`） |
| `POST /images/generations` | 200，`{model, prompt, n, size, response_format, images[]}`，`images[]` 走图生图 |
| `POST /completions` | 404 `404 page not found` |
| `POST /embeddings` | 404（知识库 embedding 需另配第三方 provider） |

模型条目实测样例（`spark-x2.6`）：

```json
{
  "id": "spark-x2.6", "name": "Spark-X2.6 正式版(限时免费)(x0.0)",
  "protocol": "openai_chat", "context_length": 1048576, "max_output_tokens": 131072,
  "capabilities": { "reasoning": true, "vision": false, "function_calling": true,
                    "streaming": true, "system_message": true,
                    "input_modalities": ["text"], "output_modalities": ["text"] },
  "reasoning_efforts": ["none","low","medium","high","xhigh"],
  "default_reasoning_effort": "low", "is_default_model": true
}
```

`electron/model-service.js` 依据 `protocol` 把模型分桶：`openai_chat` → 主 provider，
`anthropic_messages` → 自动生成 `<id>-anthropic` 伴生 provider（`@ai-sdk/anthropic`，同一个 baseURL）。

### 2.4 错误语义（关键坑）

上游业务错误 **一律 HTTP 200**：

```json
{"code":"100002","desc":"登录已失效，请重新登录","trace_id":"..."}
{"code":"100001","desc":"请求参数错误","trace_id":"..."}
```

`code` 语义：`000000` 成功、`020002`/`100002` 登录态失效（客户端 `AUTH_ERROR_CODES`）、`100001` 参数错误。
因此反代必须解析 body，而不是只看 status —— 否则会把「登录失效」当成功流式吐给客户端。

### 2.5 计费与用量

- `usage.points_consumed` 出现在 `chat/completions` 与 `/messages` 的 usage 中。
- `GET /api/v2/points/records?pageSize=N`（头 `token: <session>`）返回
  `{ balance, dailyBalance, list:[{ recordKind, chatId, direction, points, ... }] }`，可用于余额看板。
- `GET /api/v1/user/identity`、`/api/v1/points/activation` 等为配套账号态接口。

## 3. 登录与设备身份

`electron/xfyun/account-service.js` + `electron/xfyun/sign.js`：

```
POST /login/phone/sendMsgCode   {base, param:{ccode, phone, expire}}            → data.msgid
POST /login/phone/checkCode     {base, param:{ccode, phone, mcode, msgid, expire}} → data.session
POST /userinfo/query/baseInfo   {base, param:{session}}                          → userid/phone/nickname
POST /login/account/logout      {base, param:{session}}
```

`base` 固定字段：`{appid, modelid:"Web", version:"1.0.0", devid:"web", ua:"Loomy|Desktop|Electron|macOS", traceid}`。

签名算法（HMAC-SHA1，逐字段复刻 `sign.js`）：

```
Authorization: account <accessKeyId>:<base64(hmac_sha1(secret, stringToSign))>
Date: <UTCString>   Nonce: <uuid>   Content-MD5: <base64(md5(body))>
stringToSign = METHOD \n ESCAPED_PATH \n ESCAPED_QUERY \n Content-MD5 \n Content-Type \n Date \n Nonce \n SignedHeaders \n CanonicalizedHeaders
```

实测：用解密出的 AK/SK 对 `POST /userinfo/query/baseInfo` 签名，返回
`{"code":"000000","desc":"成功","data":{"userid":"...","phone":"152****5487","nickname":"..."}}`
→ 签名算法完全一致，反代可独立完成短信登录。

设备身份（`electron/campus-device-id-service.js`）只用于校园/活动类业务，**不参与 LLM 请求**，
反代无需伪造。

## 4. 本机登录态（免登录导入）

- 配置根：`C:\Users\Public\Loomy\<sha256(用户名) 前 12 位>`（`electron/config-path.js`）
- 登录态：`<配置根>\userData\auth-session.json` → `{ session, userid, phone, updatedAt }`
  （electron-store，`electron/auth/auth-session-runtime.js`）
- 当前运行环境：`<配置根>\opencode\opencode.json` 里 `provider.imodel.options.baseURL` 指明上游环境

反代直接读这个文件即可复用已登录账号，无需再次短信验证。

## 5. 与反代的对应关系

| 逆向结论 | 反代实现 |
| --- | --- |
| 上游是 OpenAI 兼容协议 | `src/routes/openai.js` 直接透传 + 补默认值 |
| 上游 `/messages` 是 Anthropic 原生 | `src/routes/anthropic.js` 协议同构透传 |
| 业务错误 HTTP 200 | `src/upstream/client.js#parseErrorEnvelope` + `src/core/executor.js` 失败换账号 |
| 只有 Bearer 必需 | 仍然带齐 traceparent/loomy-version/ChatId/MsgId/TurnId，最大化与客户端行为一致 |
| session 是账号池的「凭据」 | `src/core/accounts.js` + `src/core/scheduler.js`（权重/冷却/亲和） |
| 登录靠 AK/SK 签名 | `src/auth/sign.js` + `src/auth/account.js` |
| AK/SK 在加密 .env 中 | `src/auth/envfile.js` 运行期解密，不把密钥复制进仓库 |
| 本机已有登录态 | `src/auth/local-session.js` + CLI `import-local` |
| points_consumed | `src/core/usage.js` 记账，管理台可见 |

## 6. 残余未知与边界

- 上游未发现速率上限/并发上限的公开线索，反代内置冷却与失败切换作为保守兜底。
- `/embeddings`、`/completions` 上游 404，反代显式返回 501，不做假实现。
- `protocol` 目前实测只有 `openai_chat`；`anthropic_messages` 分支依据源码 + `/messages` 实测存在。
- 计费裁决在服务端（用途、模型倍率），反代只做展示，不预测扣分。
- 参考实现未覆盖：图片编辑、ASR、知识库（这些走 Loomy 其他后端，不在本项目范围）。
