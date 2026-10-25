# 沙盒运行时镜像：只含 runner，不含业务代码与智能体定义。
# 构建：docker build -t agentport/sandbox:dev packages/sandbox
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# 容器内用独立 manifest：workspace 协议无法在镜像里解析。
# 不能用 --omit=dev / --omit=optional：Agent SDK 的平台原生 CLI 在 optionalDependencies 里。
# zod 是 @agentport/shared 的运行时依赖，runner 在 stdin 边界用它校验任务。
# 锁文件由 package.docker.json 生成（npm install --package-lock-only），用 npm ci 冻结安装。
COPY package.docker.json ./package.json
COPY package.docker-lock.json ./package-lock.json
RUN npm ci --no-audit --no-fund

COPY dist/ ./dist/

# runner 在 stdin 边界用 @agentport/shared 的 schema 校验任务，shared 必须进镜像。
COPY shared/ ./node_modules/@agentport/shared/
COPY package.shared.json ./node_modules/@agentport/shared/package.json

# 只读根文件系统运行时，SDK 需要写会话/缓存目录；worker 会给这个路径挂 tmpfs，
# 并注入同名 CLAUDE_CONFIG_DIR。预先建好可写目录，standalone 运行也不至于 EROFS。
RUN mkdir -p /home/node/.claude && chown node:node /home/node/.claude
ENV CLAUDE_CONFIG_DIR=/home/node/.claude

USER node
ENTRYPOINT ["node", "dist/runner.js"]
