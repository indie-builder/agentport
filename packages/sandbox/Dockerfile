# 沙盒运行时镜像：只含 runner，不含业务代码与智能体定义。
# 构建：docker build -t agentport/sandbox:dev packages/sandbox
FROM node:24-alpine

# 容器内用独立 manifest：workspace 协议无法在镜像里解析，且 @agentport/shared
# 不是运行时依赖（runner 只输出 NDJSON，宿主负责校验）。
# 不能用 --omit=dev / --omit=optional：Agent SDK 的平台原生 CLI 在 optionalDependencies 里。
COPY package.docker.json ./package.json
RUN npm install --no-audit --no-fund

COPY dist/ ./dist/

# 只读根文件系统运行时，SDK 需要写会话/缓存目录；worker 会给这个路径挂 tmpfs，
# 并注入同名 CLAUDE_CONFIG_DIR。预先建好可写目录，standalone 运行也不至于 EROFS。
RUN mkdir -p /home/node/.claude && chown node:node /home/node/.claude
ENV CLAUDE_CONFIG_DIR=/home/node/.claude

USER node
ENTRYPOINT ["node", "dist/runner.js"]
