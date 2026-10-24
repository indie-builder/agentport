import type { FastifyInstance } from 'fastify';
import { registerAgentRoutes } from '../features/agents/routes.js';
import { registerAuditRoutes } from '../features/audit/routes.js';
import { registerAuth } from '../features/auth/routes.js';
import { registerChatRoutes } from '../features/chat/routes.js';
import { registerEvalRoutes } from '../features/eval/routes.js';
import { registerExportRoutes } from '../features/export/routes.js';
import { registerImportRoutes } from '../features/import/routes.js';
import { registerMarketRoutes } from '../features/market/routes.js';
import { registerOpsRoutes } from '../features/ops/routes.js';
import { registerOverviewRoutes } from '../features/overview/routes.js';
import { registerRunRoutes } from '../features/runs/routes.js';
import { createInvoker } from '../features/servers/agent-invoker.js';
import { registerAgentToolsEndpoint } from '../features/servers/agent-tools-endpoint.js';
import { registerMcpEndpoint } from '../features/servers/mcp-endpoint.js';
import { registerServerRoutes } from '../features/servers/routes.js';
import { registerSkillRoutes } from '../features/skills/routes.js';
import { registerErrorHandler } from '../plugins/errors.js';
import { registerHealthRoutes } from './health.js';

export async function registerRoutes(app: FastifyInstance) {
  registerErrorHandler(app);
  await registerAuth(app);
  await registerHealthRoutes(app);
  await registerServerRoutes(app);
  await registerMcpEndpoint(app);
  registerAgentToolsEndpoint(app, createInvoker(app));
  await registerAgentRoutes(app);
  await registerSkillRoutes(app);
  registerMarketRoutes(app);
  registerExportRoutes(app);
  registerImportRoutes(app);
  await registerAuditRoutes(app);
  await registerChatRoutes(app);
  registerEvalRoutes(app);
  registerOverviewRoutes(app);
  registerOpsRoutes(app);
  registerRunRoutes(app);
}
