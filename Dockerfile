# 应用镜像：api 与 worker 共用，入口由 compose command 区分。
# 构建：docker build -t agentport/api:dev .
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
# 固定 pnpm 版本，避免 corepack 在构建时联网取最新版。
RUN npm install -g pnpm@12.15.0
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
RUN pnpm --filter @agentport/api deploy --prod /out/api \
 && pnpm --filter @agentport/worker deploy --prod /out/worker

FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
# worker 通过宿主 docker.sock 启沙盒，需要 docker CLI（不含 daemon）。
RUN apk add --no-cache docker-cli
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./api
COPY --from=build --chown=node:node /out/worker ./worker
COPY --from=build --chown=node:node /repo/packages/web/dist ./web
USER node
EXPOSE 3000
CMD ["node", "api/dist/index.js"]
