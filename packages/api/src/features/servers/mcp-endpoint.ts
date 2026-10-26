import { hashMcpToken } from '@agentport/core';
import { repo } from '@agentport/db';
import type { NodeIncomingMessageLike, NodeServerResponseLike } from '@modelcontextprotocol/node';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reject } from '../../plugins/errors.js';
import { mcpRateLimit } from '../../plugins/security.js';
import { typed } from '../../types.js';
import { buildKnowledgeServer } from '../knowledge/mcp.js';
import { bearerToken, tokenMatches } from './bearer.js';
import { buildGeneratedServer } from './generated.js';
import { getServerRow, listTools, toApiServer } from './repo.js';

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
            // run 结束后挂起的调用要立刻停下，不能等批准或把请求发到上游。
            isRunActive: () => repo.runs.isRunActive(app.db, trustedRunId),
            onApprovalRequired: (toolName, expiresAt) =>
              repo.runs.requestApproval(app.db, {
                runId: trustedRunId,
                serverId,
                toolName,
                expiresAt,
              }),
          }),
    });
  });
}

const params = z.object({ serverId: z.string().min(1) });

/** JSON-RPC tools/call 里的工具名；其他方法没有，也是唯一不读参数内容的来源。 */
function toolNameOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (method !== 'tools/call' || typeof params !== 'object' || params === null) return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

export function registerMcpEndpoint(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  app.all(
    '/mcp/:serverId',
    {
      ...mcpRateLimit,
      // 非浏览器客户端访问，CSP 无意义。
      config: { ...mcpRateLimit.config, helmet: { contentSecurityPolicy: false } },
      schema: { params },
    },
    async (request, reply) => {
      const { serverId } = request.params;
      const row = await getServerRow(app.db, serverId);
      const headerRunId = request.headers['x-agentport-run-id'];
      const runId = typeof headerRunId === 'string' ? headerRunId : null;

      if (row?.kind === 'knowledge') {
        // 内置知识库没有长期 token：只认绑定该 server 的 run 的短期 token，其余一律 401。
        const runToken =
          runId === null ? null : await repo.runs.getRunToken(app.db, runId, serverId);
        const ok =
          runToken !== null &&
          runToken.hash !== null &&
          runToken.expiresAt !== null &&
          runToken.expiresAt.getTime() > Date.now() &&
          tokenMatches(runToken.hash, bearerToken(request.headers.authorization), hashMcpToken);
        if (!ok || runId === null) {
          reply.header('WWW-Authenticate', 'Bearer realm="agentport-mcp"');
          return reject(reply, 'UNAUTHORIZED', 'invalid bearer token');
        }
        const baseId = row.config.knowledgeBaseId;
        if (typeof baseId !== 'string')
          return reject(reply, 'NOT_FOUND', 'knowledge server unbound');

        reply.hijack();
        const fields = { serverId, tool: toolNameOf(request.body), runId, requestId: request.id };
        const nodeHandler = toNodeHandler(
          buildKnowledgeServer({
            db: app.db,
            baseId,
            serverId,
            runId,
            secretKey: app.config.APP_SECRET_KEY,
            knowledgeDir: app.config.KNOWLEDGE_DIR,
          }),
          { onerror: (err) => app.log.error({ err, ...fields }, 'mcp endpoint error') },
        );
        await nodeHandler(
          request.raw as unknown as NodeIncomingMessageLike,
          reply.raw as unknown as NodeServerResponseLike,
          request.body,
        );
        return;
      }

      if (row?.kind !== 'generated') {
        return reject(reply, 'NOT_FOUND', 'generated server not found');
      }
      const expected = row.config.mcpToken;
      // 先认 run 的短期 token（沙盒内嵌在 .mcp.json），失败再回退长期 token（外部客户端）。
      const runToken = runId === null ? null : await repo.runs.getRunToken(app.db, runId, serverId);
      const runTokenOk =
        runToken !== null &&
        runToken.hash !== null &&
        runToken.expiresAt !== null &&
        runToken.expiresAt.getTime() > Date.now() &&
        tokenMatches(runToken.hash, bearerToken(request.headers.authorization), hashMcpToken);
      if (!runTokenOk && !tokenMatches(expected, bearerToken(request.headers.authorization))) {
        reply.header('WWW-Authenticate', 'Bearer realm="agentport-mcp"');
        return reject(reply, 'UNAUTHORIZED', 'invalid bearer token');
      }

      // 交给 MCP 适配器自己读写原始 req/res，Fastify 不再参与响应。
      reply.hijack();
      // 一次工具调用失败后要能在日志里对上具体哪个工具、哪个 run：
      // 只记 serverId 时运维无从下手。tool 名来自 JSON-RPC 方法名，不含参数。
      const fields = {
        serverId,
        tool: toolNameOf(request.body),
        runId,
        requestId: request.id,
      };
      // 每个 HTTP 请求重建 handler，header 在请求边界读取一次，不依赖工厂回调时机。
      const nodeHandler = toNodeHandler(handlerFor(app, serverId, runId), {
        onerror: (err) => app.log.error({ err, ...fields }, 'mcp endpoint error'),
      });
      await nodeHandler(
        // Node 的 IncomingMessage.method 类型是 string | undefined，适配器按可选字段声明。
        request.raw as unknown as NodeIncomingMessageLike,
        reply.raw as unknown as NodeServerResponseLike,
        request.body,
      );
    },
  );
}
