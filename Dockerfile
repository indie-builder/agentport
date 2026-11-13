FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS bun
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo

FROM base AS manifests
COPY package.json bun.lock .npmrc ./
COPY packages/api/package.json packages/api/
COPY packages/contract/package.json packages/contract/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/

FROM manifests AS deps
RUN bun install --frozen-lockfile

FROM deps AS source
COPY tsconfig.base.json biome.json vitest.config.ts ./
COPY packages ./packages

FROM source AS build
RUN bun run build

FROM source AS build-sandbox
RUN bun run --filter @agentport/sandbox build

FROM manifests AS production-deps
RUN bun install --production --frozen-lockfile --filter @agentport/api --filter @agentport/worker

FROM production-deps AS production-app
COPY --from=build /repo/packages/api/dist packages/api/dist
COPY --from=build /repo/packages/contract/dist packages/contract/dist
COPY --from=build /repo/packages/core/dist packages/core/dist
COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/packages/db/scripts packages/db/scripts
COPY --from=build /repo/packages/db/migrations packages/db/migrations
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/worker/dist packages/worker/dist

FROM manifests AS production-sandbox
RUN bun install --production --frozen-lockfile --filter @agentport/sandbox
COPY --from=build-sandbox /repo/packages/sandbox/dist packages/sandbox/dist
COPY --from=build-sandbox /repo/packages/shared/dist packages/shared/dist

FROM base AS sandbox
RUN apk add --no-cache git poppler-utils bash \
 && command -v bash \
 && bash --version | grep -q 'GNU bash' \
 && command -v pdftoppm \
 && command -v pdfinfo
WORKDIR /app
COPY --from=production-sandbox --chown=node:node /repo ./
RUN ln -s packages/sandbox/dist dist \
 && test -f dist/runner.js \
 && test -f dist/session-supervisor.js \
 && bun -e "const {createRequire}=require('node:module');const base=createRequire('/app/packages/sandbox/package.json');const sdk=createRequire(base.resolve('@anthropic-ai/claude-agent-sdk'));const cli=sdk.resolve('@anthropic-ai/claude-agent-sdk-linux-'+process.arch+'-musl/claude');if(!(require('node:fs').statSync(cli).mode&0o111))throw new Error('SDK native CLI is not executable: '+cli)"
RUN mkdir -p /home/node/.claude && chown node:node /home/node/.claude
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
USER node
ENTRYPOINT ["bun", "dist/runner.js"]

FROM bun AS runtime
RUN apk add --no-cache docker-cli docker-cli-buildx \
 && rm -rf /usr/local/bun-node-fallback-bin \
 && test ! -e /usr/local/bun-node-fallback-bin/node \
 && bun --version
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-app --chown=1000:1000 /repo ./
COPY --from=build --chown=1000:1000 /repo/packages/web/dist ./web
USER bun
EXPOSE 3000
CMD ["bun", "packages/api/dist/index.js"]
