# REA 取证记录

本文只记录**可复算的取证坐标**（产物 SHA-256、REA evidence id、关键实测），
不把 194 MB 的完整 evidence bundle 放进仓库。需要完整 bundle 时按文末命令重新导出。

## 1. 被分析产物

| 产物 | SHA-256 | 说明 |
| --- | --- | --- |
| `E:\Loomy\Loomy.exe` | `9bb759cbf9d1db98da6559aa456078f0b31be2f0dbc5273df5a0d5adee510d56` | Electron 主程序（214 MB，PE） |
| `E:\Loomy\resources\app.asar` | `afb8f85b93f93396dacf1f2e1e01ee4c46e99deea633cbae7ad5dd47808a58e1` | 应用包（231 MB，12593 个文件） |

## 2. Electron fuse 读取

工具：`rea_inspect_electron_fuses`
Evidence：`ev_b77ad268512c3499425e356f7d5f976d2cdf96ce0d6ee740a382bea78ec04fc0`

| fuse | 状态 | 影响 |
| --- | --- | --- |
| `RunAsNode` | enabled | 可用 `ELECTRON_RUN_AS_NODE` 以 Node 方式跑主程序 |
| `EnableNodeOptionsEnvironmentVariable` | enabled | `NODE_OPTIONS` 生效（便于调试注入） |
| `EnableNodeCliInspectArguments` | enabled | 可开 Inspector |
| `EnableEmbeddedAsarIntegrityValidation` | **disabled** | asar 无完整性校验 → 可静态读取、可热替换 |
| `OnlyLoadAppFromAsar` | **disabled** | 允许从 app 目录外加载代码 |
| `GrantFileProtocolExtraPrivileges` | enabled | file:// 权限放大 |

结论：asar 完整性未启用 + `app.asar.unpacked/electron/` 全量明文，是本项目能做到
「逐行对照客户端行为」的直接原因。

## 3. JavaScript 应用静态分析

工具：`rea_analyze_javascript_application`
（`input_path=E:\Loomy\resources\app.asar`，限定 6 个关键源文件）

| 证据 | 用途 | 统计 |
| --- | --- | --- |
| `ev_bb9bf3ea1372a7fc6adb59947907beab4e15b8c3311f9acdb610d748b55361c2`（父，10 文件） | 首次全景分析 | 10 个文件、16677 AST 节点、177 findings、request 家族 39 条关系 |
| `ev_e0f048815ee6c57b0a87f6f5bc76c36541679b6dd4ca01608e1ea8795e90608c`（父，6 文件） | 聚焦复算 | 6 个文件、7996 AST 节点、108 findings、`configuration` 家族 2 条关系 |
| `ev_d83c8290be2ceb20abc57afffa76041d1f4a249b201b12463e4637d0e47b76c8` | 上者的 summary 视图 | 覆盖 `complete-within-view` |

分析范围（相对 asar 根目录）：

```
electron/llm/llm-completion.js        ← 上游 chat/completions 调用与请求头
electron/utils/request-headers.js     ← traceparent / ChatId / MsgId / TurnId / 用途头
electron/utils/app-version.js         ← loomy-version 头
electron/xfyun/sign.js                ← 账号服务 HMAC-SHA1 签名
electron/xfyun/account-service.js     ← 短信登录 / session 校验
electron/utils/env-file-crypto.js     ← .env.prod 的 LOOMYENC1 解密
electron/bundled-resources.js         ← imodel provider baseURL 注入
electron/points-config.js             ← 上游根地址来源
electron/model-service.js             ← /models 解析、协议分桶
src/lib/model-metadata.js             ← 模型能力/上下文/协议归一化
electron/image/image-generation-service.js ← /images/generations
```

REA 的 `request` 家族关系（14–39 条）与手工阅读得到的 4 个上游调用点一致：
`chat/completions`、`messages`、`images/generations`、`models`。

## 4. 实测坐标（对上游的直接观测）

均在 2026-10-22 使用本机已登录 session 对 **生产** 上游发起，仅记录结构与计数：

| 观测 | 结果 |
| --- | --- |
| `GET /models` | 200，13 个模型，`protocol` 均为 `openai_chat`，首个 `spark-x2.6`（context 1048576 / max_output 131072 / reasoning） |
| `POST /chat/completions`（非流式） | 200，`usage.points_consumed=1~2`，`message.reasoning_content` 存在 |
| `POST /chat/completions`（流式） | 200 `text/event-stream`，末尾 `data: [DONE]`，`stream_options.include_usage=true` 时末块带 usage |
| `POST /messages`（Anthropic） | 200，返回 `content:[{type:"thinking"}]`，`usage.points_consumed=0`（该模型免费档） |
| `POST /messages`（stream） | 200，`message_start / content_block_start / content_block_delta …` |
| `POST /images/generations` | 200，返回 `data:[{url:"https://...cos...png?...sign..."}]` |
| `POST /completions` | 404 `404 page not found` |
| `POST /embeddings` | 404 `404 page not found` |
| 缺 `Authorization` | 200 + `{"code":"100002","desc":"缺少 token"}` |
| 错误 session | 200 + `{"code":"100002","desc":"登录已失效，请重新登录"}` |
| 缺 `traceparent` | 200（该模型未复现客户端注释里的挂死现象） |
| 缺 `loomy-version` | 200（非必需） |
| 账号服务签名（`/userinfo/query/baseInfo`） | `{"code":"000000","desc":"成功","data":{"userid":"…","phone":"152****5487",…}}` |
| 积分接口（`/api/v2/points/records`） | `{"data":{"balance":8500,"dailyBalance":4994,"list":[{…,"chatId":"probe-1","points":1}]}}` |

## 5. 复算方法

```bash
# 在 REA 会话中
rea_open_binary        path=E:\Loomy\resources\app.asar
rea_inspect_electron_fuses path=E:\Loomy\Loomy.exe
rea_analyze_javascript_application input_path=E:\Loomy\resources\app.asar \
  source_paths=[electron/llm/llm-completion.js, electron/utils/request-headers.js, ...] detail=summary
rea_export_evidence_bundle path=<任意临时目录>\loomy-evidence.json
```

> bundle 会把 asar 相关字节一并内联，体积接近 190 MB，因此不入库；需要时导出到临时目录即可。

## 6. REA 覆盖声明（不可当作「不存在」的证明）

REA 明确标注的限制中，与本项目相关的两条：

- 「Caller-selected source analysis leaves 11047 inventoried files outside analysis scope」
  → 除上表 11 个文件外，其余模块（如 OpenCode 运行时、MCP、同步）未被静态分析覆盖。
- 「Static paths and relationships may remain unresolved when expressions are dynamic」
  → 上游地址存在多级覆盖（env → 本地 json → electron-store），本报告以实测为准。

据此，本项目所有关于上游行为的断言都配了第 4 节的实测坐标；
静态结论仅用于解释「客户端为什么这么发」。
