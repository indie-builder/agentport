FROM node:24-alpine

# 沙盒只包含运行时；智能体定义在运行时只读挂载到 /workspace
WORKDIR /app

# 容器内用独立 manifest：workspace 协议无法在镜像里解析，且 @agentport/shared
# 不是运行时依赖（runner 只输出 NDJSON，宿主负责校验）。
# 不能用 --omit=dev / --omit=optional：Agent SDK 的平台原生 CLI 在 optionalDependencies 里。
COPY package.docker.json ./package.json
RUN npm install --no-audit --no-fund

COPY dist/ ./dist/

USER node
ENTRYPOINT ["node", "dist/runner.js"]
