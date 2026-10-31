# 应用镜像：api 与 worker 共用，入口由 compose command 区分。
# 构建：docker build -t agentport/api:dev .
# 沙盒镜像由同一 root context 的 sandbox target 产出：
#   docker build --target sandbox -t agentport/sandbox:dev .
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base
# 固定 pnpm 版本，避免 corepack 在构建时联网取最新版。
RUN npm install -g pnpm@12.16.1
WORKDIR /repo

# 先只复制 manifest，依赖层可被源码变更复用。
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/api/package.json packages/api/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json biome.json vitest.config.ts ./
COPY packages ./packages
RUN pnpm -r build

# deploy 生成自包含目录：dist + production deps + workspace 包（已带 dist）。
# 不使用 --no-optional：Agent SDK 的平台原生 CLI 在 optionalDependencies 里。
RUN pnpm --filter @agentport/api deploy --prod /out/api \
 && pnpm --filter @agentport/worker deploy --prod /out/worker \
 && pnpm --filter @agentport/sandbox deploy --prod /out/sandbox

# 沙盒运行时镜像：只含 runner 与官方 SDK，不含业务代码与智能体定义。
# 必须放在 runtime 之前，默认 target 仍是 api/worker 镜像。
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS sandbox

# git：原生插件安装由官方 CLI 克隆市场仓库；poppler-utils：官方长 PDF 分页读取依赖
# （pdftoppm/pdfinfo）；bash：官方 CLI 只认 PATH 上的 bash/zsh，缺失即报
# "No suitable shell found"，Bash 工具无法开箱使用。不装其余工具。
RUN apk add --no-cache git poppler-utils bash \
 && command -v bash \
 && bash --version | grep -q 'GNU bash' \
 && command -v pdftoppm \
 && command -v pdfinfo

WORKDIR /app
COPY --from=build --chown=node:node /out/sandbox ./
# 原生 CLI 在 optionalDependencies；构建期验证 pnpm deploy 确实装入了可执行文件。
# 容器默认入口仍是 runner（probe 与单次运行）；worker 复用容器时显式改用 supervisor。
RUN test -f dist/runner.js \
 && test -f dist/session-supervisor.js \
 && node -e "const {createRequire}=require('node:module');const base=createRequire('/app/package.json');const sdk=createRequire(base.resolve('@anthropic-ai/claude-agent-sdk'));const cli=sdk.resolve('@anthropic-ai/claude-agent-sdk-linux-'+process.arch+'-musl/claude');if(!(require('node:fs').statSync(cli).mode&0o111))throw new Error('SDK native CLI is not executable: '+cli)"

# 只读根文件系统运行时，SDK 需要写会话/缓存目录；worker 会给这个路径挂 tmpfs，
# 并注入同名 CLAUDE_CONFIG_DIR。预先建好可写目录，standalone 运行也不至于 EROFS。
RUN mkdir -p /home/node/.claude && chown node:node /home/node/.claude
ENV CLAUDE_CONFIG_DIR=/home/node/.claude

USER node
ENTRYPOINT ["node", "dist/runner.js"]

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
# worker 通过宿主 docker.sock 启沙盒，需要 docker CLI（不含 daemon）；
# 运行环境构建另需 buildx 插件，只在 runtime target 安装。
RUN apk add --no-cache docker-cli docker-cli-buildx
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./api
COPY --from=build --chown=node:node /out/worker ./worker
COPY --from=build --chown=node:node /repo/packages/web/dist ./web
USER node
EXPOSE 3000
CMD ["node", "api/dist/index.js"]
