# 部署手册

两种模式，都不需要在服务器上做 `docker build`（目标服务器 4C/3.8G 无 swap，禁止在机上 build）。

| 模式 | 用什么 | 适用 |
| --- | --- | --- |
| **源码挂载**（默认） | `docker-compose.source.yml` + 官方 `node:22-alpine` | 推荐。零依赖、零构建、零镜像仓库凭据；更新=覆盖 `app/` 后 restart |
| 镜像 | `docker-compose.yml` + `ghcr.io/shuaichao171/loomy-proxy` | 需要版本化/回滚时；私有包要先 `docker login ghcr.io` |

## 目录布局（服务器）

```
/www/wwwroot/docker/loomy-proxy-deploy/
  docker-compose.yml          # install.sh 从 deploy/docker-compose.source.yml 复制
  docker-compose.override.yml # 可选：接入其它 compose 网络时由 install.sh 生成
  .env                        # 环境变量（600，含管理台密码）
  app/                        # 源码（只读挂载到容器 /app）
  config/config.json          # 服务器配置（600）
  data/                       # accounts.json / keys.json / usage.jsonl（600）
  secrets/.env.prod           # 讯飞 AK/SK（600，仅短信登录/校验用）
  # Nginx 入口在宿主机：/www/server/panel/vhost/nginx/loomy.shuaichao.xyz.conf
  #   模板见 deploy/nginx/loomy-proxy.conf
```

容器只绑 `127.0.0.1:8787`。本机访问管理台：

```bash
ssh -L 8787:127.0.0.1:8787 root@154.40.58.3
# 然后浏览器打开 http://127.0.0.1:8787/admin
```

## 一次性安装

```bash
# 本机：把源码推到服务器
rsync -az --delete \
  --exclude .git --exclude data --exclude config/config.json --exclude node_modules \
  E:/ai-work2/LoomyProxy/ root@154.40.58.3:/www/wwwroot/docker/loomy-proxy-src/

# 服务器：安装（会同步到 app/、生成 .env 与 config、拉起容器）
ssh root@154.40.58.3
cd /www/wwwroot/docker/loomy-proxy-src/deploy
bash install.sh                     # 只绑 127.0.0.1，对外走 Nginx
# bash install.sh --network auto    # 可选：接入同机其它 compose 网络（容器名互访）
```

`install.sh` 幂等：已存在的 `.env`、`config/config.json`、`data/` 不会被覆盖。

## 凭据

| 文件 | 作用 | 没有会怎样 |
| --- | --- | --- |
| `data/accounts.json` | Loomy 账号 session 池 | 无可用账号，`/v1/*` 全部 503 |
| `secrets/.env.prod` | 讯飞账号 AK/SK（签名） | 不能发短信登录、不能校验账号会话 |

两者都是 600，且都在 `.gitignore` 里，**永不入库**。

在新机器上重新登录也可以（不搬 session）：

```bash
docker exec -it loomy-proxy node src/cli.js login --phone 1xxxxxxxxxx --send-only
docker exec -it loomy-proxy node src/cli.js login --login-id login_xxx --code 123456
```

## 公网访问（Nginx 反代）

容器只绑 `127.0.0.1:8787`，对外由 Nginx 反代。模板 [`nginx/loomy-proxy.conf`](nginx/loomy-proxy.conf)
提供三个入口：域名、服务器 IP、备用端口 8788。

```bash
# 服务器：装 vhost（把 server_name / IP 改成自己的）
scp deploy/nginx/loomy-proxy.conf root@<server>:/www/server/panel/vhost/nginx/loomy.shuaichao.xyz.conf
nginx -t && nginx -s reload
```

关键点：SSE 必须关闭缓冲，模板里已经带上
`proxy_buffering off; proxy_request_buffering off; proxy_read_timeout 900s; X-Accel-Buffering: no`。

DNS：在 Cloudflare 给 `loomy.shuaichao.xyz` 加 A 记录指向服务器公网 IP。
- 走 Cloudflare 橙云（代理）→ 源站可以用 HTTP，HTTPS 在边缘终结；记得把 SSL 模式设为
  **Flexible**（源站没证书）或 **Full**（源站也装了证书）。
- 想让源站直接上 HTTPS：DNS 生效后在宝塔面板申请 Let's Encrypt 证书即可。

访问形态：

```text
管理台   https://loomy.shuaichao.xyz/admin        # 需要 .env 里的 adminPassword
API      https://loomy.shuaichao.xyz/v1           # 需要 sk-loomy-… 下游密钥
健康检查 https://loomy.shuaichao.xyz/health       # 无需鉴权
```

创建下游密钥（明文只显示一次）：

```bash
docker exec loomy-proxy node src/cli.js key create --name my-client
docker exec loomy-proxy node src/cli.js key list
docker exec loomy-proxy node src/cli.js key rm <key_id>
```

> 密钥/账号从 CLI 写入后会立即生效（`reload-on-miss` / `reload-on-empty`），不需要重启容器。

客户端配置：

```bash
export OPENAI_BASE_URL=https://loomy.shuaichao.xyz/v1
export OPENAI_API_KEY=sk-loomy-…
curl -s "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY" | head -c 200
```

注意：Loomy 上游按 `points_consumed` 真实扣积分，多人共用同一账号池时额度是共享的。

## HTTPS 证书（acme.sh / Let's Encrypt）

已上线的做法（HTTP-01 验证，webroot 走 `/.well-known/acme-challenge/`）：

```bash
# 1) 80 端口要能提供 ACME 验证文件（ssl 模板里已内置该 location）
mkdir -p /www/wwwroot/loomy.shuaichao.xyz/.well-known/acme-challenge

# 2) 装 acme.sh 并签发（ECC 证书，自动挂续期 cron）
curl -s https://get.acme.sh | sh -s email=admin@example.com
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt
~/.acme.sh/acme.sh --issue -d loomy.shuaichao.xyz -w /www/wwwroot/loomy.shuaichao.xyz

# 3) 安装到宝塔证书目录，续期后自动 reload nginx
mkdir -p /www/server/panel/vhost/cert/loomy.shuaichao.xyz
~/.acme.sh/acme.sh --install-cert -d loomy.shuaichao.xyz --ecc   --key-file       /www/server/panel/vhost/cert/loomy.shuaichao.xyz/privkey.pem   --fullchain-file /www/server/panel/vhost/cert/loomy.shuaichao.xyz/fullchain.pem   --reloadcmd      "nginx -s reload"

# 4) 换成 HTTPS 版 vhost（先有证书再启用，否则 nginx 起不来）
cp nginx/loomy-proxy-ssl.conf /www/server/panel/vhost/nginx/loomy.shuaichao.xyz.conf
nginx -t && nginx -s reload
```

验证：`curl -s https://loomy.shuaichao.xyz/health`；续期状态 `~/.acme.sh/acme.sh --list`。
80 端口保留 `/.well-known/acme-challenge/` 直出（不跳转），443 承载业务，其余 http 请求 301 到 https；
HSTS 只给 `max-age=31536000`，未加 `includeSubDomains`。

> 宝塔面板如果后来给同名站点点过「保存」，会重写这份 vhost —— 反代与 SSE 参数需按模板补回。

## 更新

```bash
# 本机
rsync -az --delete --exclude .git --exclude data --exclude config/config.json \
  E:/ai-work2/LoomyProxy/ root@154.40.58.3:/www/wwwroot/docker/loomy-proxy-src/
# 服务器
cd /www/wwwroot/docker/loomy-proxy-src/deploy && bash install.sh --network auto
#   或只同步 app/ 后：cd /www/wwwroot/docker/loomy-proxy-deploy && docker compose restart
```

## 运维

```bash
cd /www/wwwroot/docker/loomy-proxy-deploy
docker compose ps
docker compose logs -f --tail=100
curl -s http://127.0.0.1:8787/health
docker exec loomy-proxy node src/cli.js doctor      # 凭据/账号/模型/连通性自检
docker exec loomy-proxy node src/cli.js accounts    # 账号池
```

回滚：`app/` 是源码副本，保留上一版目录或从 git 重新同步即可；`data/` 不动就不会丢账号与密钥。

## 接入 sub2api（同机 + 分组 lommy）

loomy-proxy 与 sub2api 同在 `sub2api-deploy_sub2api-network` 网络，容器内地址是
`http://loomy-proxy:8787/v1`（OpenAI 兼容）。一次性的接线步骤：

```bash
cd /www/wwwroot/docker/loomy-proxy-deploy
AP=$(grep -m1 '^LOOMY_PROXY_ADMIN_PASSWORD=' .env | cut -d= -f2-)
KEY=$(curl -s -X POST http://127.0.0.1:8787/admin/api/keys \
  -H "Authorization: Bearer $AP" -H 'Content-Type: application/json' \
  -d '{"name":"sub2api"}' | jq -r .plaintext)      # 57 字符，只返回一次

cd /www/wwwroot/docker/sub2api-deploy
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/v1/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$(grep -m1 '^ADMIN_EMAIL=' .env | cut -d= -f2-)\",\"password\":\"$(grep -m1 '^ADMIN_PASSWORD=' .env | cut -d= -f2-)\"}" | jq -r .data.access_token)
curl -s -X POST http://127.0.0.1:8080/api/v1/admin/groups -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"lommy","platform":"openai"}'
curl -s -X POST http://127.0.0.1:8080/api/v1/admin/accounts -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"name\":\"loomy-proxy\",\"platform\":\"openai\",\"type\":\"apikey\",
  \"credentials\":{\"api_key\":\"$KEY\",\"base_url\":\"http://loomy-proxy:8787/v1\",\"model_mapping\":{}},\"group_ids\":[<分组id>]}"
```

注意事项：

- **建密钥必须走管理 API/管理台**。网关进程在跑时用 `docker exec loomy-proxy node src/cli.js key create`
  会先写 `data/keys.json`，紧接着被运行中进程的内存态回写覆盖，表现为“创建成功但校验 401”。
- sub2api 账号（id 3643 / 名称 `loomy-proxy`）绑定分组 `lommy`（id 28）；改完凭据后记得
  `POST /api/v1/admin/accounts/<id>/recover-state` + `POST .../schedulable {"schedulable":true}`，
  否则一次失败的连通测试会把账号停在 `error` / 不可调度。
- 验证：`POST /api/v1/admin/accounts/<id>/test` 会以流式方式回包内容（默认模型 `gpt-5.4`），
  能出字就说明鉴权、转发、SSE 全部通。
- loomy-proxy 的模型目录是 Loomy 上游的 13 个模型（spark-x2.6 / qwen3.8-flash / GLM-5.3-Flash …），
  需要映射成 sub2api 侧模型名时写在账号的 `credentials.model_mapping`。

## 镜像模式（可选）

```bash
gh workflow run docker.yml            # 或 git tag v1.0.0 && git push --tags
# 服务器
echo "$GHCR_PAT" | docker login ghcr.io -u shuaichao171 --password-stdin
cd /www/wwwroot/docker/loomy-proxy-deploy
cp docker-compose.source.yml /tmp/ 2>/dev/null || true
# 用仓库里的 deploy/docker-compose.yml 替换，然后
docker compose pull && docker compose up -d
```

## 安全清单

- [ ] `.env` 里 `LOOMY_PROXY_ADMIN_PASSWORD` 不是空、不是 `change-me`
- [ ] `config/config.json`、`data/*`、`secrets/*` 权限 600，属主 root
- [ ] 宿主端口只绑 `127.0.0.1`，不直接暴露公网
- [ ] 下游密钥按用途分发、可随时 `key rm` 吊销，`limits.requestsPerMinutePerKey` 按需开启
- [ ] 定期看 `data/login-audit.jsonl`（短信登录审计，只含手机号掩码）
