import type { FastifyInstance } from 'fastify';
import { registerAgentRoutes } from '../features/agents/routes.js';
import { registerAuth } from '../features/auth/routes.js';
import { registerChatRoutes } from '../features/chat/routes.js';
import { registerOverviewRoutes } from '../features/overview/routes.js';
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
  await registerAgentRoutes(app);
  await registerSkillRoutes(app);
  await registerChatRoutes(app);
  registerOverviewRoutes(app);
}
