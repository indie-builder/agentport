import { apiContract, type authNativeContract } from '@agentport/contract';
import type { Router } from '@orpc/server';
import type { Hono } from 'hono';
import { requestBodyLimit } from '../http/body-limit.js';
import type {
  AppContext,
  HttpEnv,
  NativeHttpDependencies,
  RequestContext,
} from '../http/context.js';
import { healthOpenAPIPaths } from '../http/health-openapi.js';
import { nativeOpenAPIPaths } from '../http/native-openapi.js';
import { registerOpenApi } from '../http/openapi.js';
import { createOpenAPIHandler } from '../http/orpc.js';
import { registerAgentsHttp } from '../modules/agents/http.js';
import { agentsRouter } from '../modules/agents/router.js';
import { registerAuditHttp } from '../modules/audit/http.js';
import { auditRouter } from '../modules/audit/router.js';
import { authRouter } from '../modules/auth/router.js';
import { registerAuthRoutes } from '../modules/auth/routes.js';
import { registerChannelsHttp } from '../modules/channels/http.js';
import { channelsRouter } from '../modules/channels/router.js';
import { registerChatHttp } from '../modules/chat/http.js';
import { chatRouter } from '../modules/chat/router.js';
import { dataDomainsRouter } from '../modules/data-domains/router.js';
import { registerEvalHttp } from '../modules/eval/http.js';
import { evalRouter } from '../modules/eval/router.js';
import { governanceRouter } from '../modules/governance/router.js';
import { registerIntegrationsHttp } from '../modules/integrations/http.js';
import { integrationsRouter } from '../modules/integrations/router.js';
import { registerKnowledgeHttp } from '../modules/knowledge/http.js';
import { knowledgeRouter } from '../modules/knowledge/router.js';
import { marketRouter } from '../modules/market/router.js';
import { registerMemoryHttp } from '../modules/memory/http.js';
import { memoryRouter } from '../modules/memory/router.js';
import { memoryReviewsRouter } from '../modules/memory-reviews/router.js';
import { modelProvidersRouter } from '../modules/model-providers/router.js';
import { notificationsRouter } from '../modules/notifications/router.js';
import { observabilityRouter } from '../modules/observability/router.js';
import { registerOpsQueuesHttp } from '../modules/ops/http.js';
import { opsRouter } from '../modules/ops/router.js';
import { registerOutputSharesHttp } from '../modules/output-shares/http.js';
import { outputSharesRouter } from '../modules/output-shares/router.js';
import { overviewRouter } from '../modules/overview/router.js';
import { personalRouter } from '../modules/personal/router.js';
import { registerPluginsHttp } from '../modules/plugins/http.js';
import { pluginsRouter } from '../modules/plugins/router.js';
import { registerRunExportHttp } from '../modules/runs/http.js';
import { runsRouter } from '../modules/runs/router.js';
import { runtimeEnvironmentsRouter } from '../modules/runtime-environments/router.js';
import { searchRouter } from '../modules/search/router.js';
import { securityRouter } from '../modules/security/router.js';
import { registerServersHttp } from '../modules/servers/http.js';
import { serversRouter } from '../modules/servers/router.js';
import { registerSkillsHttp } from '../modules/skills/http.js';
import { skillsRouter } from '../modules/skills/router.js';
import { workflowsRouter } from '../modules/workflows/router.js';

type RpcContract = Omit<typeof apiContract, 'auth'> & {
  auth: Omit<typeof apiContract.auth, keyof typeof authNativeContract>;
};

const apiRouter: Router<RpcContract, RequestContext> = {
  agents: agentsRouter,
  audit: auditRouter,
  auth: authRouter,
  channels: channelsRouter,
  chat: chatRouter,
  dataDomains: dataDomainsRouter,
  eval: evalRouter,
  governance: governanceRouter,
  integrations: integrationsRouter,
  knowledge: knowledgeRouter,
  market: marketRouter,
  memory: memoryRouter,
  memoryReviews: memoryReviewsRouter,
  modelProviders: modelProvidersRouter,
  notifications: notificationsRouter,
  observability: observabilityRouter,
  ops: opsRouter,
  outputShares: outputSharesRouter,
  overview: overviewRouter,
  personal: personalRouter,
  plugins: pluginsRouter,
  runs: runsRouter,
  runtimeEnvironments: runtimeEnvironmentsRouter,
  search: searchRouter,
  security: securityRouter,
  servers: serversRouter,
  skills: skillsRouter,
  workflows: workflowsRouter,
};

const JSON_BODY_LIMIT = 1_048_576;

export function registerRoutes(
  app: Hono<HttpEnv>,
  runtime: AppContext,
  native: NativeHttpDependencies,
  bootstrap: () => Promise<void>,
): void {
  registerAuthRoutes(app, bootstrap);
  registerAgentsHttp(app);
  registerSkillsHttp(app);
  registerPluginsHttp(app);
  registerServersHttp(app, runtime);
  registerKnowledgeHttp(app);
  registerAuditHttp(app);
  registerOpsQueuesHttp(app, runtime);
  registerEvalHttp(app);
  registerMemoryHttp(app);
  registerOutputSharesHttp(app);
  registerIntegrationsHttp(app);
  registerChatHttp(app, native);
  registerChannelsHttp(app, native);
  registerRunExportHttp(app);
  registerOpenApi(app, apiContract, { ...healthOpenAPIPaths, ...nativeOpenAPIPaths });
  const handler = createOpenAPIHandler(apiRouter);
  const apiBodyLimit = requestBodyLimit(JSON_BODY_LIMIT);
  app.use('/api/*', (c, next) =>
    c.get('bodyLimitApplied') === true ? next() : apiBodyLimit(c, next),
  );
  app.all('/api/*', async (c) => {
    const result = await handler.handle(c.req.raw, { prefix: '/api', context: c.get('context') });
    return result.matched ? result.response : c.notFound();
  });
}
