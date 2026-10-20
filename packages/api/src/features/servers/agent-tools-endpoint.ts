import { timingSafeEqual } from 'node:crypto';
import { AppError } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import type { NodeIncomingMessageLike, NodeServerResponseLike } from '@modelcontextprotocol/node';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { runMcp } from '../../plugins/concurrency.js';
import { problem } from '../../plugins/errors.js';
import type { AgentInvoker } from './agent-tools.js';
import { agentHandler, platformMcpToken } from './agent-tools.js';

const limits = { off: process.env.RATE_LIMIT_DISABLED === '1' };

function tokenMatches(expected: string, header: string | undefined): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match?.[1]) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(match[1]);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
      config: {
        ...(limits.off ? {} : { rateLimit: { max: 60, timeWindow: '1 minute' } }),
        helmet: { contentSecurityPolicy: false },
      },
    },
    async (request, reply) => {
      if (!tokenMatches(expected, request.headers.authorization)) {
        return reply
          .status(401)
          .header('WWW-Authenticate', 'Bearer realm="agentport-platform"')
          .send(problem(request.id, new AppError('UNAUTHORIZED', 'invalid bearer token')));
      }

      const rows = await app.db
        .select({
          slug: schema.agents.slug,
          name: schema.agents.name,
          description: schema.agents.description,
        })
        .from(schema.agents)
        .where(eq(schema.agents.enabled, true));
      void repo;

      reply.hijack();
      const handler = toNodeHandler(agentHandler(invoker, rows), {
        onerror: (err) => app.log.error({ err }, 'platform mcp endpoint error'),
      });
      await runMcp(() =>
        handler(
          request.raw as unknown as NodeIncomingMessageLike,
          reply.raw as unknown as NodeServerResponseLike,
          request.body,
        ),
      );
    },
  );
}
