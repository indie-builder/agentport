import { fail, hashMcpToken } from '@agentport/core';
import { repo } from '@agentport/db';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AppContext, RequestContext } from '../../http/context.js';
import { isRunCancelRequested } from '../../queue/producer.js';
import { buildDataDomainServer } from '../data-domains/mcp.js';
import { buildKnowledgeServer } from '../knowledge/mcp.js';
import { checkOutboundToolArgs } from '../security/outbound-policy.js';
import { auditToolPolicyDenial, createApprovalEvaluator } from './approval-policy.js';
import { requestToolApproval } from './approvals.js';
import { bearerToken, tokenMatches } from './bearer.js';
import { buildGeneratedServer } from './generated.js';
import { listTools, str, toApiServer } from './repo.js';
import { decryptSecrets } from './secrets.js';

export async function validRunToken(
  context: RequestContext,
  runId: string | null,
  serverId: string,
  token: string | undefined,
): Promise<boolean> {
  if (runId === null) return false;
  const runToken = await repo.runs.getRunToken(context.db, runId, serverId);
  return (
    runToken !== null &&
    runToken.hash !== null &&
    runToken.expiresAt !== null &&
    runToken.expiresAt.getTime() > Date.now() &&
    tokenMatches(runToken.hash, token, hashMcpToken)
  );
}

function handlerFor(app: AppContext, serverId: string, runId: string | null): McpHttpHandler {
  return createMcpHandler(
    async () => {
      const row = await repo.servers.getServer(app.db, serverId);
      if (!row) throw new Error('连接器已不存在');
      const snapshot =
        runId === null ? null : await repo.runs.getRunServerSnapshot(app.db, runId, serverId);
      const server = snapshot
        ? {
            kind: snapshot.kind,
            name: snapshot.name,
            baseUrl: str(snapshot.config.baseUrl),
            headers: snapshot.secretsEncrypted
              ? decryptSecrets(snapshot.secretsEncrypted, app.config.APP_SECRET_KEY)
              : {},
          }
        : toApiServer(row, app.config.APP_SECRET_KEY);
      if (server.kind !== 'generated') throw new Error('连接器不是生成式 MCP');
      const tools = snapshot?.tools ?? (await listTools(app.db, serverId));
      const agentId = runId === null ? null : await repo.runs.getRunAgentId(app.db, runId);
      return buildGeneratedServer({
        name: server.name,
        baseUrl: server.baseUrl,
        headers: server.headers,
        tools,
        nodeEnv: app.config.NODE_ENV,
        privateHostAllowlist: app.config.GENERATED_PRIVATE_HOST_ALLOWLIST,
        checkOutbound: (toolName, args) =>
          checkOutboundToolArgs({
            db: app.db,
            agentId,
            runId,
            sourceId: `${serverId}/${toolName}`,
            args,
          }),
        onDenied: (toolName, args, matchedRuleIds) =>
          auditToolPolicyDenial(app, {
            runId,
            serverId,
            toolName,
            args,
            ...(matchedRuleIds && { matchedRuleIds }),
          }),
        ...(runId === null
          ? {}
          : {
              evaluateApproval: createApprovalEvaluator({ db: app.db, runId, serverId }),
              isRunActive: async () =>
                (await repo.runs.isRunActive(app.db, runId)) &&
                !(await isRunCancelRequested(runId)),
              onApprovalRequired: async (toolName, args, decision) => {
                await requestToolApproval(app, runId, serverId, toolName, args, decision);
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
  const row = await repo.servers.getServer(context.db, serverId);
  const runId = request.headers.get('x-agentport-run-id');
  const token = bearerToken(request.headers.get('authorization') ?? undefined);
  if (row?.kind === 'knowledge') {
    if (runId === null || !(await validRunToken(context, runId, serverId, token))) {
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
  if (row?.kind === 'data_domain') {
    if (runId === null || !(await validRunToken(context, runId, serverId, token))) {
      context.responseHeaders.set('WWW-Authenticate', 'Bearer realm="agentport-mcp"');
      fail('UNAUTHORIZED', 'invalid bearer token');
    }
    const dataDomainId = row.config.dataDomainId;
    if (typeof dataDomainId !== 'string') fail('NOT_FOUND', 'data domain server unbound');
    return buildDataDomainServer({
      db: context.db,
      serverId,
      dataDomainId,
      runId,
      secretKey: context.config.APP_SECRET_KEY,
      wrenRuntimeUrl: context.config.WREN_RUNTIME_URL,
      log: context.log,
    }).fetch(request);
  }
  if (row?.kind !== 'generated') fail('NOT_FOUND', 'generated server not found');
  const hasRunToken = await validRunToken(context, runId, serverId, token);
  if (!hasRunToken && !tokenMatches(row.config.mcpToken, token)) {
    context.responseHeaders.set('WWW-Authenticate', 'Bearer realm="agentport-mcp"');
    fail('UNAUTHORIZED', 'invalid bearer token');
  }
  return handlerFor(context, serverId, hasRunToken ? runId : null).fetch(request);
}
