# 部署手册

两种模式，都不需要在服务器上做 `docker build`（服务器 4C/3.8G 无 swap，见 `sub2api_alt` 的铁律）。

| 模式 | 用什么 | 适用 |
| --- | --- | --- |
| **源码挂载**（默认） | `docker-compose.source.yml` + 官方 `node:22-alpine` | 推荐。零依赖、零构建、零镜像仓库凭据；更新=覆盖 `app/` 后 restart |
| 镜像 | `docker-compose.yml` + `ghcr.io/shuaichao171/loomy-proxy` | 需要版本化/回滚时；私有包要先 `docker login ghcr.io` |

## 目录布局（服务器）

```
/www/wwwroot/docker/loomy-proxy-deploy/
  docker-compose.yml          # install.sh 从 deploy/docker-compose.source.yml 复制
  docker-compose.override.yml # 可选：接入 sub2api 网络时由 install.sh 生成
  .env                        # 环境变量（600，含管理台密码）
  app/                        # 源码（只读挂载到容器 /app）
  config/config.json          # 服务器配置（600）
  data/                       # accounts.json / keys.json / usage.jsonl（600）
  secrets/.env.prod           # 讯飞 AK/SK（600，仅短信登录/校验用）
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
  E:/Loomy/LoomyProxy/ root@154.40.58.3:/www/wwwroot/docker/loomy-proxy-src/

# 服务器：安装（会同步到 app/、生成 .env 与 config、拉起容器）
ssh root@154.40.58.3
cd /www/wwwroot/docker/loomy-proxy-src/deploy
bash install.sh --network auto      # auto = 自动接入 sub2api 的 compose 网络
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

## 给 sub2api 当上游

容器接入 sub2api 网络后，sub2api 里新建 **OpenAI 类型渠道**：

```text
base_url = http://loomy-proxy:8787/v1
api_key  = sk-loomy-…（在 LoomyProxy 里创建）
models   = spark-x2.6, qwen3.8-flash, …（先 GET /v1/models 看）
```

创建密钥：

```bash
docker exec loomy-proxy node src/cli.js key create --name sub2api
```

注意：Loomy 上游按 `points_consumed` 真实扣积分，sub2api 侧的倍率/额度只是本地记账。

## 更新

```bash
# 本机
rsync -az --delete --exclude .git --exclude data --exclude config/config.json \
  E:/Loomy/LoomyProxy/ root@154.40.58.3:/www/wwwroot/docker/loomy-proxy-src/
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
