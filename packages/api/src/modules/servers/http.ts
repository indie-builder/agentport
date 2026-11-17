import { fail } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppContext, HttpEnv } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { isRunCancelRequested } from '../../queue/producer.js';
import { createInvoker } from './agent-invoker.js';
import type { AgentInvoker } from './agent-tools.js';
import { agentHandler, platformMcpToken } from './agent-tools.js';
import { requestToolApproval } from './approvals.js';
import { bearerToken, tokenMatches } from './bearer.js';
import { serverMcpResponse, validRunToken } from './mcp-endpoint.js';

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
  app.on(
    ['PUT', 'GET'],
    '/tool-approvals/:runId/:serverId/:toolName',
    mcpRateLimit,
    mcpBodyLimit,
    access({
      kind: 'service',
      boundary: 'mcp',
      reason: 'tool approval uses bound run bearer token',
    }),
    async (c) => {
      const context = c.get('context');
      const { runId, serverId, toolName } = c.req.param();
      if (
        c.req.header('x-agentport-run-id') !== runId ||
        !(await validRunToken(context, runId, serverId, bearerToken(c.req.header('authorization'))))
      )
        fail('UNAUTHORIZED', 'invalid bearer token');
      const snapshot = await repo.runs.getRunServerSnapshot(context.db, runId, serverId);
      if (snapshot?.tools !== undefined) {
        const tool =
          snapshot.kind === 'generated'
            ? snapshot.tools.find((candidate) => candidate.name === toolName)
            : undefined;
        if (!tool?.enabled || tool.approvalMode !== 'ask') {
          fail('NOT_FOUND', 'approval tool not found');
        }
      } else {
        const [server, tool] = await Promise.all([
          repo.servers.getServer(context.db, serverId),
          repo.servers.getApiToolByName(context.db, serverId, toolName),
        ]);
        if (server?.kind !== 'generated' || !tool?.enabled || tool.approvalMode !== 'ask') {
          fail('NOT_FOUND', 'approval tool not found');
        }
      }
      const active =
        (await repo.runs.isRunActive(context.db, runId)) && !(await isRunCancelRequested(runId));
      const approval =
        active && c.req.method === 'PUT'
          ? await requestToolApproval(
              context,
              runId,
              serverId,
              toolName,
              z
                .record(z.string(), z.unknown())
                .parse(
                  await c.req.json().catch(() => fail('INVALID_INPUT', '请求体必须是有效 JSON')),
                ),
            )
          : await repo.runs.getApprovalRequest(context.db, runId, serverId, toolName);
      if (!active)
        return c.json({
          status: 'cancelled',
          approvalId: approval?.id ?? null,
          expiresAt: approval?.expiresAt?.toISOString() ?? null,
        });
      if (approval === null) fail('NOT_FOUND', 'approval request not found');
      const status =
        approval.deniedAt !== null
          ? 'denied'
          : approval.approvedAt !== null
            ? 'approved'
            : approval.expiresAt !== null && approval.expiresAt.getTime() <= Date.now()
              ? 'expired'
              : 'pending';
      return c.json({
        status,
        approvalId: approval.id,
        expiresAt: approval.expiresAt?.toISOString() ?? null,
      });
    },
  );
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
