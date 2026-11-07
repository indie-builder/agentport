import { apiContract, type authNativeContract } from '@agentport/contract';
import { AppError } from '@agentport/core';
import { ATTACHMENT_LIMITS } from '@agentport/shared';
import type { Router } from '@orpc/server';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppContext, HttpEnv, RequestContext } from '../http/context.js';
import { healthOpenAPIPaths } from '../http/health-openapi.js';
import { nativeOpenAPIPaths } from '../http/native-openapi.js';
import { createOpenAPIHandler } from '../http/orpc.js';
import { registerAgentsHttp } from '../modules/agents/http.js';
import { agentsRouter } from '../modules/agents/router.js';
import { registerAuditHttp } from '../modules/audit/http.js';
import { auditRouter } from '../modules/audit/router.js';
import { authRouter } from '../modules/auth/router.js';
import { registerAuthRoutes } from '../modules/auth/routes.js';
import { registerChannelsHttp } from '../modules/channels/http.js';
import { channelsRouter } from '../modules/channels/router.js';
import { type NativeHttpDependencies, registerChatHttp } from '../modules/chat/http.js';
import { chatRouter } from '../modules/chat/router.js';
import { registerEvalHttp } from '../modules/eval/http.js';
import { evalRouter } from '../modules/eval/router.js';
import { registerKnowledgeHttp } from '../modules/knowledge/http.js';
import { KNOWLEDGE_PACKAGE_MAX_BYTES } from '../modules/knowledge/package.js';
import { knowledgeRouter } from '../modules/knowledge/router.js';
import { KNOWLEDGE_UPLOAD_BODY_LIMIT } from '../modules/knowledge/use-cases.js';
import { marketRouter } from '../modules/market/router.js';
import { registerMemoryHttp } from '../modules/memory/http.js';
import { memoryRouter } from '../modules/memory/router.js';
import { memoryReviewsRouter } from '../modules/memory-reviews/router.js';
import { opsRouter } from '../modules/ops/router.js';
import { registerOutputSharesHttp } from '../modules/output-shares/http.js';
import { outputSharesRouter } from '../modules/output-shares/router.js';
import { overviewRouter } from '../modules/overview/router.js';
import { personalRouter } from '../modules/personal/router.js';
import { registerPluginsHttp } from '../modules/plugins/http.js';
import { pluginsRouter } from '../modules/plugins/router.js';
import { registerRunExportHttp, runsRouter } from '../modules/runs/router.js';
import { runtimeEnvironmentsRouter } from '../modules/runtime-environments/router.js';
import { registerServersHttp } from '../modules/servers/http.js';
import { serversRouter } from '../modules/servers/router.js';
import { registerSkillsHttp } from '../modules/skills/http.js';
import { skillsRouter } from '../modules/skills/router.js';
import { registerOpenApi } from '../plugins/openapi.js';

type RpcContract = Omit<typeof apiContract, 'auth'> & {
  auth: Omit<typeof apiContract.auth, keyof typeof authNativeContract>;
};

export const apiRouter: Router<RpcContract, RequestContext> = {
  agents: agentsRouter,
  audit: auditRouter,
  auth: authRouter,
  channels: channelsRouter,
  chat: chatRouter,
  eval: evalRouter,
  knowledge: knowledgeRouter,
  market: marketRouter,
  memory: memoryRouter,
  memoryReviews: memoryReviewsRouter,
  ops: opsRouter,
  outputShares: outputSharesRouter,
  overview: overviewRouter,
  personal: personalRouter,
  plugins: pluginsRouter,
  runs: runsRouter,
  runtimeEnvironments: runtimeEnvironmentsRouter,
  servers: serversRouter,
  skills: skillsRouter,
};

const JSON_BODY_LIMIT = 1_048_576;

const bodyLimits: ReadonlyArray<{ route: RegExp; maxSize: number }> = [
  { route: /^POST \/api\/chat$/, maxSize: ATTACHMENT_LIMITS.bodyBytes },
  { route: /^POST \/api\/servers\/import-file$/, maxSize: 8 * 1024 * 1024 },
  {
    route: /^PUT \/api\/knowledge\/bases\/[^/]+\/documents\/upload$/,
    maxSize: KNOWLEDGE_UPLOAD_BODY_LIMIT,
  },
];

export function registerRoutes(
  app: Hono<HttpEnv>,
  runtime: AppContext,
  native: NativeHttpDependencies,
): void {
  app.on(
    'POST',
    '/api/knowledge/bases/import',
    bodyLimit({
      maxSize: KNOWLEDGE_PACKAGE_MAX_BYTES,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试');
      },
    }),
  );
  registerAuthRoutes(app, runtime);
  registerAgentsHttp(app);
  registerSkillsHttp(app);
  registerPluginsHttp(app);
  registerServersHttp(app, runtime);
  registerKnowledgeHttp(app);
  registerAuditHttp(app);
  registerEvalHttp(app);
  registerMemoryHttp(app);
  registerOutputSharesHttp(app);
  registerChatHttp(app, native);
  registerChannelsHttp(app, native);
  registerRunExportHttp(app);
  registerOpenApi(app, apiContract, { ...healthOpenAPIPaths, ...nativeOpenAPIPaths });
  const handler = createOpenAPIHandler(apiRouter);
  app.use('/api/*', (c, next) => {
    const route = `${c.req.method} ${c.req.path}`;
    return bodyLimit({
      maxSize: bodyLimits.find((entry) => entry.route.test(route))?.maxSize ?? JSON_BODY_LIMIT,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试');
      },
    })(c, next);
  });
  app.all('/api/*', async (c) => {
    const result = await handler.handle(c.req.raw, { prefix: '/api', context: c.get('context') });
    return result.matched ? result.response : c.notFound();
  });
}
