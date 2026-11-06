import { fail } from '@agentport/core';
import { schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppContext, HttpEnv } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { createInvoker } from './agent-invoker.js';
import type { AgentInvoker } from './agent-tools.js';
import { agentHandler, platformMcpToken } from './agent-tools.js';
import { bearerToken, tokenMatches } from './bearer.js';
import { serverMcpResponse } from './mcp-endpoint.js';

export type ServersHttpDependencies = AppContext & {
  invoker?: AgentInvoker;
};

export function registerServersHttp(app: Hono<HttpEnv>, deps: ServersHttpDependencies): void {
  const invoker = deps.invoker ?? createInvoker(deps);
  const mcpRateLimit: MiddlewareHandler<HttpEnv> = async (c, next) => {
    await c.get('context').limit(60, c.req.path === '/mcp' ? 'mcp:platform' : 'mcp:server');
    await next();
  };
  const mcpBodyLimit = bodyLimit({
    maxSize: 1_048_576,
    onError: () => fail('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试'),
  });
  const expected = platformMcpToken(process.env);
  if (expected === null) {
    deps.log.warn('PLATFORM_MCP_TOKEN not set; /mcp disabled');
  } else {
    app.all(
      '/mcp',
      mcpRateLimit,
      mcpBodyLimit,
      access({
        kind: 'service',
        boundary: 'mcp',
        reason: 'platform MCP endpoint authenticates with PLATFORM_MCP_TOKEN',
      }),
      async (c) => {
        const context = c.get('context');
        if (!tokenMatches(expected, bearerToken(c.req.header('authorization')))) {
          context.responseHeaders.set('WWW-Authenticate', 'Bearer realm="agentport-platform"');
          fail('UNAUTHORIZED', 'invalid bearer token');
        }
        const rows = await context.db
          .select({
            slug: schema.agents.slug,
            name: schema.agents.name,
            description: schema.agents.description,
          })
          .from(schema.agents)
          .where(eq(schema.agents.enabled, true));
        return agentHandler(invoker, rows, {
          onerror: (err) =>
            context.log.error({ err, requestId: context.requestId }, 'platform mcp endpoint error'),
        }).fetch(c.req.raw);
      },
    );
  }
  app.all(
    '/mcp/:serverId',
    mcpRateLimit,
    mcpBodyLimit,
    access({
      kind: 'service',
      boundary: 'mcp',
      reason: 'MCP endpoint uses bearer/run token',
    }),
    async (c) => {
      const context = c.get('context');
      return serverMcpResponse(c.req.raw, context, c.req.param('serverId'));
    },
  );
}
