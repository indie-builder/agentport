import { timingSafeEqual } from 'node:crypto';
import { AppError, hashMcpToken } from '@agentport/core';
import { repo } from '@agentport/db';
import type { NodeIncomingMessageLike, NodeServerResponseLike } from '@modelcontextprotocol/node';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { runMcp } from '../../plugins/concurrency.js';
import { problem, reject } from '../../plugins/errors.js';
import { buildGeneratedServer } from './generated.js';
import { getServerRow, listTools, toApiServer } from './repo.js';

const limits = { off: process.env.RATE_LIMIT_DISABLED === '1' };

function tokenMatches(
  expected: unknown,
  header: string | undefined,
  actual: (token: string) => string = (token) => token,
): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match?.[1]) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual(match[1]));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 每个请求按 serverId 重建 handler：工具定义改动无需重启，也避免跨 server 复用实例。
 * createMcpHandler 的实例同时服务 2025/2026 两个协议时代。
 */
function handlerFor(app: FastifyInstance, serverId: string, runId: string | null): McpHttpHandler {
  return createMcpHandler(async () => {
    const row = await getServerRow(app.db, serverId);
    // 鉴权已在路由层完成；这里再查一次是为了拿到最新工具定义。
    if (!row) throw new Error('server disappeared');
    const server = toApiServer(row, app.config.APP_SECRET_KEY);
    if (server.kind !== 'generated') throw new Error('not a generated server');
    const tools = await listTools(app.db, serverId);
    // runId 由路由层从当前 HTTP 请求头读入；外部客户端没有 run，审批工具一律拒绝。
    // run header 来自沙盒，外部客户端也能伪造：只有 run 存在且该智能体绑定了本 server 才采信。
    const trustedRunId =
      runId !== null && (await repo.runs.isRunBoundToServer(app.db, runId, serverId))
        ? runId
        : null;
    const approvals = trustedRunId
      ? await repo.runs.getApprovedToolNames(app.db, trustedRunId, serverId)
      : [];
    return buildGeneratedServer({
      name: server.name,
      baseUrl: server.baseUrl,
      headers: server.headers,
      tools,
      approvals,
      nodeEnv: app.config.NODE_ENV,
      // 只有真实 run 才挂起等待：外部客户端没有页面可批准，立即拒绝更诚实。
      ...(trustedRunId === null ? {} : { approvalWaitMs: app.config.APPROVAL_WAIT_MS }),
      ...(trustedRunId === null
        ? {}
        : {
            refreshApprovals: () => repo.runs.getApprovedToolNames(app.db, trustedRunId, serverId),
            onApprovalRequired: (toolName) =>
              repo.runs.requestApproval(app.db, {
                runId: trustedRunId,
                serverId,
                toolName,
              }),
          }),
    });
  });
}

export function registerMcpEndpoint(app: FastifyInstance): void {
  app.all(
    '/mcp/:serverId',
    {
      config: {
        ...(limits.off ? {} : { rateLimit: { max: 60, timeWindow: '1 minute' } }),
        helmet: { contentSecurityPolicy: false },
      },
    },
    async (request, reply) => {
      const { serverId } = request.params as { serverId: string };
      const row = await getServerRow(app.db, serverId);
      if (row?.kind !== 'generated') {
        return reject(reply, 'NOT_FOUND', 'generated server not found');
      }
      const expected = row.config.mcpToken;
      // 先认 run 的短期 token（沙盒内嵌在 .mcp.json），失败再回退长期 token（外部客户端）。
      const headerRunId = request.headers['x-agentport-run-id'];
      const runId = typeof headerRunId === 'string' ? headerRunId : null;
      const runToken = runId === null ? null : await repo.runs.getRunToken(app.db, runId, serverId);
      const runTokenOk =
        runToken !== null &&
        runToken.hash !== null &&
        runToken.expiresAt !== null &&
        runToken.expiresAt.getTime() > Date.now() &&
        tokenMatches(runToken.hash, request.headers.authorization, hashMcpToken);
      if (!runTokenOk && !tokenMatches(expected, request.headers.authorization)) {
        return reply
          .status(401)
          .header('WWW-Authenticate', 'Bearer realm="agentport-mcp"')
          .send(problem(request.id, new AppError('UNAUTHORIZED', 'invalid bearer token')));
      }

      // 交给 MCP 适配器自己读写原始 req/res，Fastify 不再参与响应。
      reply.hijack();
      // 每个 HTTP 请求重建 handler，header 在请求边界读取一次，不依赖工厂回调时机。
      const nodeHandler = toNodeHandler(handlerFor(app, serverId, runId), {
        onerror: (err) => app.log.error({ err, serverId }, 'mcp endpoint error'),
      });
      await runMcp(() =>
        nodeHandler(
          // Node 的 IncomingMessage.method 类型是 string | undefined，适配器按可选字段声明。
          request.raw as unknown as NodeIncomingMessageLike,
          reply.raw as unknown as NodeServerResponseLike,
          request.body,
        ),
      );
    },
  );
}
