# LoomyProxy 运行镜像
#
# 零依赖项目：不需要 npm install，构建只是 COPY 源码 + 建非 root 用户，秒级完成。
# 服务器上禁止 docker build，因此这个文件主要给 GitHub Actions 用（见 .github/workflows/docker.yml）。

FROM node:22-alpine

ENV NODE_ENV=production \
    LOOMY_PROXY_HOST=0.0.0.0 \
    LOOMY_PROXY_PORT=8787

WORKDIR /app

# 只复制运行所需内容，测试/文档不入镜像
COPY package.json ./
COPY src ./src
COPY config/config.example.json ./config/config.example.json

RUN addgroup -S loomy && adduser -S loomy -G loomy \
 && mkdir -p /app/data /app/config /app/secrets \
 && chown -R loomy:loomy /app

USER loomy

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LOOMY_PROXY_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/cli.js", "serve"]
