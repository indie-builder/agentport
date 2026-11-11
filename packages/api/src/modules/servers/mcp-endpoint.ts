import { fail, hashMcpToken } from '@agentport/core';
import { repo } from '@agentport/db';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AppContext, RequestContext } from '../../http/context.js';
import { isRunCancelRequested, publishChannelEvent } from '../../queue/producer.js';
import { buildKnowledgeServer } from '../knowledge/mcp.js';
import { bearerToken, tokenMatches } from './bearer.js';
import { buildGeneratedServer } from './generated.js';
import { getServerRow, listTools, toApiServer } from './repo.js';
import { summarizeToolArguments } from './tool-arguments.js';

function handlerFor(app: AppContext, serverId: string, runId: string | null): McpHttpHandler {
  return createMcpHandler(
    async () => {
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
      const denied = trustedRunId
        ? await repo.runs.getDeniedToolNames(app.db, trustedRunId, serverId)
        : [];
      return buildGeneratedServer({
        name: server.name,
        baseUrl: server.baseUrl,
        headers: server.headers,
        tools,
        approvals,
        denied,
        nodeEnv: app.config.NODE_ENV,
        privateHostAllowlist: app.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
        // 只有真实 run 才挂起等待：外部客户端没有页面可批准，立即拒绝更诚实。
        ...(trustedRunId === null ? {} : { approvalWaitMs: app.config.APPROVAL_WAIT_MS }),
        ...(trustedRunId === null
          ? {}
          : {
              refreshApprovals: () =>
                repo.runs.getApprovedToolNames(app.db, trustedRunId, serverId),
              refreshDenied: () => repo.runs.getDeniedToolNames(app.db, trustedRunId, serverId),
              // run 结束后挂起的调用要立刻停下，不能等批准或把请求发到上游。
              // running 的取消只发 Redis 信号，终态由 worker 收尾；等待方据此提前停止。
              isRunActive: async () =>
                (await repo.runs.isRunActive(app.db, trustedRunId)) &&
                !(await isRunCancelRequested(trustedRunId)),
              onApprovalRequired: async (toolName, args, expiresAt) => {
                const approval = await repo.runs.requestApproval(app.db, {
                  runId: trustedRunId,
                  serverId,
                  toolName,
                  expiresAt,
                  argumentsSummary: summarizeToolArguments(args),
                });
                // 只有频道 run 需要实时提示；私有 run 仍走运行详情轮询，行为不变。
                if (approval.channelId === null) return;
                try {
                  await publishChannelEvent(approval.channelId, {
                    type: 'approval.requested',
                    channelId: approval.channelId,
                    runId: trustedRunId,
                    approvalId: approval.id,
                    toolName: approval.toolName,
                  });
                } catch (err) {
                  // 事件只是唤醒提示：发布失败不能把工具调用或 run 报失败。
                  app.log.warn(
                    {
                      err,
                      channelId: approval.channelId,
                      runId: trustedRunId,
                      approvalId: approval.id,
                    },
                    'channel approval event publish failed',
                  );
                }
              },
            }),
      });
    },
    {
      onerror: (err) => app.log.error({ err, serverId, runId }, 'mcp endpoint error'),
    },
  );
}

export async function serverMcpResponse(
  request: Request,
  context: RequestContext,
  serverId: string,
): Promise<Response> {
  const row = await getServerRow(context.db, serverId);
  const runId = request.headers.get('x-agentport-run-id');
  const token = bearerToken(request.headers.get('authorization') ?? undefined);
  if (row?.kind === 'knowledge') {
    const runToken =
      runId === null ? null : await repo.runs.getRunToken(context.db, runId, serverId);
    const ok =
      runToken !== null &&
      runToken.hash !== null &&
      runToken.expiresAt !== null &&
      runToken.expiresAt.getTime() > Date.now() &&
      tokenMatches(runToken.hash, token, hashMcpToken);
    if (!ok || runId === null) {
      context.responseHeaders.set('WWW-Authenticate', 'Bearer realm="agentport-mcp"');
      fail('UNAUTHORIZED', 'invalid bearer token');
    }
    const baseId = row.config.knowledgeBaseId;
    if (typeof baseId !== 'string') fail('NOT_FOUND', 'knowledge server unbound');
    return buildKnowledgeServer({
      db: context.db,
      baseId,
      serverId,
      runId,
      secretKey: context.config.APP_SECRET_KEY,
      knowledgeDir: context.config.KNOWLEDGE_DIR,
    }).fetch(request);
  }
  if (row?.kind !== 'generated') fail('NOT_FOUND', 'generated server not found');
  const runToken = runId === null ? null : await repo.runs.getRunToken(context.db, runId, serverId);
  const runTokenOk =
    runToken !== null &&
    runToken.hash !== null &&
    runToken.expiresAt !== null &&
    runToken.expiresAt.getTime() > Date.now() &&
    tokenMatches(runToken.hash, token, hashMcpToken);
  if (!runTokenOk && !tokenMatches(row.config.mcpToken, token)) {
    context.responseHeaders.set('WWW-Authenticate', 'Bearer realm="agentport-mcp"');
    fail('UNAUTHORIZED', 'invalid bearer token');
  }
  return handlerFor(context, serverId, runId).fetch(request);
}
