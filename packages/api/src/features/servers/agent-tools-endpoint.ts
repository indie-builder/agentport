import { schema } from '@agentport/db';
import type { NodeIncomingMessageLike, NodeServerResponseLike } from '@modelcontextprotocol/node';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { reject } from '../../plugins/errors.js';
import { mcpRateLimit } from '../../plugins/security.js';
import type { AgentInvoker } from './agent-tools.js';
import { agentHandler, platformMcpToken } from './agent-tools.js';
import { bearerToken, tokenMatches } from './bearer.js';

/**
 * 平台自身的 MCP 端点：把已启用的智能体暴露为工具。
 * 与 /mcp/:serverId（HTTP→MCP）方向相反，这里是「智能体 → MCP」。
 */
export function registerAgentToolsEndpoint(app: FastifyInstance, invoker: AgentInvoker): void {
  const expected = platformMcpToken(process.env);
  if (!expected) {
    app.log.warn('PLATFORM_MCP_TOKEN not set; /mcp disabled');
    return;
  }

  app.all(
    '/mcp',
    {
      ...mcpRateLimit,
      // 非浏览器客户端访问，CSP 无意义。
      config: { ...mcpRateLimit.config, helmet: { contentSecurityPolicy: false } },
    },
    async (request, reply) => {
      if (!tokenMatches(expected, bearerToken(request.headers.authorization))) {
        reply.header('WWW-Authenticate', 'Bearer realm="agentport-platform"');
        return reject(reply, 'UNAUTHORIZED', 'invalid bearer token');
      }

      const rows = await app.db
        .select({
          slug: schema.agents.slug,
          name: schema.agents.name,
          description: schema.agents.description,
        })
        .from(schema.agents)
        .where(eq(schema.agents.enabled, true));

      reply.hijack();
      const handler = toNodeHandler(agentHandler(invoker, rows), {
        onerror: (err) => app.log.error({ err }, 'platform mcp endpoint error'),
      });
      await handler(
        request.raw as unknown as NodeIncomingMessageLike,
        reply.raw as unknown as NodeServerResponseLike,
        request.body,
      );
    },
  );
}
