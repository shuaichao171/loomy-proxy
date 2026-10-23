#!/usr/bin/env bash
# LoomyProxy 服务器安装脚本（源码挂载模式，无需 docker build、无需镜像仓库登录）
#
#   bash install.sh                       # 默认装到 /www/wwwroot/docker/loomy-proxy-deploy
#   bash install.sh --port 8788           # 换宿主端口
#   bash install.sh --network auto        # 自动把容器接入 sub2api 的 compose 网络
#
# 幂等：重复执行只更新 compose/配置，不会覆盖已有的 config/config.json、data/、.env。
set -euo pipefail

DIR="/www/wwwroot/docker/loomy-proxy-deploy"
PORT="8787"
NETWORK=""
# 默认源码根 = deploy 的上一级目录（即 /www/wwwroot/docker/loomy-proxy-src）
SOURCE="$(cd "$(dirname "$0")/.." && pwd)"
NODE_IMAGE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --node-image) NODE_IMAGE="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

say() { printf '\033[36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }

command -v docker >/dev/null || { echo "服务器没有 docker"; exit 1; }
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"          # 老服务器只有独立二进制（如 /usr/bin/docker-compose v2.x）
else
  echo "缺少 docker compose（插件或独立二进制都没有）"; exit 1
fi
say_runtime() { :; }

say "目标目录 $DIR"
mkdir -p "$DIR"/{app,config,data,secrets}

# 1) 同步源码（只读挂载用；排除运行期数据）
if [ -f "$SOURCE/src/cli.js" ] && [ "$SOURCE" != "$DIR/app" ]; then
  if command -v rsync >/dev/null; then
    rsync -a --delete \
      --exclude '.git' --exclude 'data' --exclude 'node_modules' --exclude 'secrets' \
      --exclude 'config/config.json' \
      "$SOURCE"/ "$DIR/app"/
  else
    (cd "$SOURCE" && tar --exclude=.git --exclude=data --exclude=node_modules --exclude=secrets \
        --exclude=config/config.json -cf - .) | (cd "$DIR/app" && tar -xf -)
  fi
  say "源码已同步到 $DIR/app"
else
  warn "跳过源码同步（未找到 $SOURCE/src/cli.js，或已直接挂在 app/）"
fi

# 2) compose 文件
cp -f "$DIR/app/deploy/docker-compose.source.yml" "$DIR/docker-compose.yml"
sed -i "s/127.0.0.1:8787:8787/127.0.0.1:${PORT}:8787/" "$DIR/docker-compose.yml"
say "docker-compose.yml 已就绪（宿主 127.0.0.1:${PORT} → 容器 8787）"

# 3) .env（已存在则保留）
if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/app/deploy/.env.example" "$DIR/.env"
  ADMIN_PW="$(openssl rand -hex 12 2>/dev/null || head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  sed -i "s|^LOOMY_PROXY_ADMIN_PASSWORD=.*|LOOMY_PROXY_ADMIN_PASSWORD=${ADMIN_PW}|" "$DIR/.env"
  chmod 600 "$DIR/.env"
  say "已生成 .env，管理台密码：${ADMIN_PW}（请自行保存，之后可用编辑 $DIR/.env 修改）"
else
  say ".env 已存在，保留原值"
fi

# 4) config/config.json（保留已有）
if [ ! -f "$DIR/config/config.json" ]; then
  node -e '
    const fs=require("fs");
    const src=process.argv[1], dst=process.argv[2];
    const cfg=JSON.parse(fs.readFileSync(src,"utf8"));
    cfg.server.host="0.0.0.0";
    cfg.auth.loomyInstallDir="";
    cfg.auth.envFile="/app/secrets/.env.prod";
    fs.writeFileSync(dst, JSON.stringify(cfg,null,2)+"\n");
  ' "$DIR/app/config/config.example.json" "$DIR/config/config.json" 2>/dev/null \
  || cp "$DIR/app/config/config.example.json" "$DIR/config/config.json"
  chmod 600 "$DIR/config/config.json"
  say "已生成 config/config.json（adminPassword 由 .env 覆盖）"
else
  say "config/config.json 已存在，保留原值"
fi

# 5) 接入 sub2api 网络（可选，便于 sub2api 用 http://loomy-proxy:8787/v1）
if [ "$NETWORK" = "auto" ]; then
  NETWORK="$(docker network ls --format '{{.Name}}' | grep -E '^sub2api' | head -1 || true)"
fi
if [ -n "$NETWORK" ] && docker network inspect "$NETWORK" >/dev/null 2>&1; then
  cat > "$DIR/docker-compose.override.yml" <<EOF
services:
  loomy-proxy:
    networks:
      - default
      - sub2api
networks:
  sub2api:
    external: true
    name: ${NETWORK}
EOF
  say "已接入 Docker 网络 ${NETWORK}（sub2api 里可用 http://loomy-proxy:8787/v1）"
else
  rm -f "$DIR/docker-compose.override.yml"
  [ -n "$NETWORK" ] && warn "网络 $NETWORK 不存在，跳过接入"
fi

# 6) 凭据检查
chmod 600 "$DIR"/config/config.json "$DIR"/.env 2>/dev/null || true
chmod 700 "$DIR/secrets" 2>/dev/null || true
chmod 600 "$DIR"/secrets/* 2>/dev/null || true
[ -f "$DIR/secrets/.env.prod" ] || warn "缺少 secrets/.env.prod：短信登录/账号校验不可用（可先用已导入的 session 跑）"

# 7) 启动
cd "$DIR"
if [ -n "$NODE_IMAGE" ]; then
  if grep -q '^LOOMY_PROXY_NODE_IMAGE=' "$DIR/.env"; then
    sed -i "s|^LOOMY_PROXY_NODE_IMAGE=.*|LOOMY_PROXY_NODE_IMAGE=${NODE_IMAGE}|" "$DIR/.env"
  else
    printf 'LOOMY_PROXY_NODE_IMAGE=%s
' "$NODE_IMAGE" >> "$DIR/.env"
  fi
  say "使用 node 镜像 $NODE_IMAGE"
fi
IMG="$(grep -E '^LOOMY_PROXY_NODE_IMAGE=' "$DIR/.env" 2>/dev/null | cut -d= -f2 || true)"
[ -n "$IMG" ] || IMG="node:22-alpine"
docker image inspect "$IMG" >/dev/null 2>&1 || { say "拉取 $IMG …"; docker pull "$IMG"; }
$DC up -d
say "等待健康检查…"
for i in $(seq 1 30); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' loomy-proxy 2>/dev/null || echo starting)"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done

echo
$DC ps
echo
say "健康检查: $(curl -s -m 5 "http://127.0.0.1:${PORT}/health" || echo '失败')"
cat <<EOF

下一步：
  1) 建下游密钥:  docker exec loomy-proxy node src/cli.js key create --name sub2api
  2) 管理台（仅本机）: ssh -L ${PORT}:127.0.0.1:${PORT} root@<server> 后访问 http://127.0.0.1:${PORT}/admin
  3) 若已接入 sub2api 网络，sub2api 里建 OpenAI 渠道：
       base_url = http://loomy-proxy:8787/v1
       api_key  = 上一步生成的 sk-loomy-…
EOF
