import { AppError } from '@agentport/core';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentServers, agents, apiTools, approvalRequests, messages, servers } from '../schema.js';

export interface OpenUiToolRow {
  serverId: string;
  serverName: string;
  kind: 'http' | 'generated';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  approvalMode: 'allow' | 'ask' | 'deny';
}

/** 与 SDK 的 MCP 工具名匹配一致：精确名、server 通配 `mcp__srv__*`、整个 server。 */
function matchesToolPattern(pattern: string, toolName: string, serverName: string): boolean {
  if (pattern === toolName) return true;
  if (pattern === `mcp__${serverName}`) return true;
  return pattern === `mcp__${serverName}__*`;
}

/**
 * 智能体在生成式 UI 里能调用的工具：已绑定的 http / generated server。
 * stdio 由用户提供任意命令，只在沙盒里可见，不进 UI 工具目录。
 * 过滤规则与工作区渲染一致：disallowedTools 始终排除；allowedTools 非空时作为白名单。
 */
export async function listOpenUiTools(db: Database, agentId: string): Promise<OpenUiToolRow[]> {
  const [agent] = await db
    .select({ allowedTools: agents.allowedTools, disallowedTools: agents.disallowedTools })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return [];
  const allow = agent.allowedTools.filter((rule) => rule.startsWith('mcp__'));
  const deny = agent.disallowedTools.filter((rule) => rule.startsWith('mcp__'));

  const rows = await db
    .select({
      serverId: servers.id,
      serverName: servers.name,
      kind: servers.kind,
      config: servers.config,
    })
    .from(agentServers)
    .innerJoin(servers, eq(agentServers.serverId, servers.id))
    .where(
      and(eq(agentServers.agentId, agentId), inArray(servers.kind, ['http', 'generated'] as const)),
    )
    .orderBy(asc(servers.name), asc(servers.id));

  const generatedIds = rows.filter((row) => row.kind === 'generated').map((row) => row.serverId);
  const generatedTools =
    generatedIds.length === 0
      ? []
      : await db
          .select({
            serverId: apiTools.serverId,
            name: apiTools.name,
            description: apiTools.description,
            inputSchema: apiTools.inputSchema,
            approvalMode: apiTools.approvalMode,
          })
          .from(apiTools)
          .where(and(inArray(apiTools.serverId, generatedIds), eq(apiTools.enabled, true)))
          .orderBy(asc(apiTools.serverId), asc(apiTools.name));
  const toolsByServer = Map.groupBy(generatedTools, (tool) => tool.serverId);

  const out: OpenUiToolRow[] = [];
  for (const server of rows) {
    if (server.kind !== 'http' && server.kind !== 'generated') continue;
    const tools =
      server.kind === 'generated'
        ? (toolsByServer.get(server.serverId) ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            approvalMode: tool.approvalMode,
          }))
        : readHttpCatalog(server.config);
    for (const tool of tools) {
      const name = `mcp__${server.serverName}__${tool.name}`;
      if (deny.some((pattern) => matchesToolPattern(pattern, name, server.serverName))) continue;
      if (allow.length > 0 && !allow.some((p) => matchesToolPattern(p, name, server.serverName))) {
        continue;
      }
      out.push({
        serverId: server.serverId,
        serverName: server.serverName,
        kind: server.kind,
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        approvalMode: tool.approvalMode,
      });
    }
  }
  return out;
}

function readHttpCatalog(config: Record<string, unknown>): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  approvalMode: 'allow' | 'ask' | 'deny';
}> {
  const catalog = config.toolCatalog;
  if (!Array.isArray(catalog)) return [];
  return catalog.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { name, description, inputSchema } = item as Record<string, unknown>;
    if (typeof name !== 'string') return [];
    return [
      {
        name,
        description: typeof description === 'string' ? description : '',
        inputSchema:
          typeof inputSchema === 'object' && inputSchema !== null
            ? (inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} },
        approvalMode: 'allow',
      },
    ];
  });
}

export async function cacheServerToolCatalog(
  db: Database,
  serverId: string,
  tools: Array<{
    name: string;
    title?: string | undefined;
    description?: string | undefined;
    inputSchema?: Record<string, unknown> | undefined;
  }>,
): Promise<void> {
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
  await db
    .update(servers)
    .set({
      config: sql`jsonb_set(${servers.config}, '{toolCatalog}', ${JSON.stringify(catalog)}::jsonb, true)`,
    })
    .where(eq(servers.id, serverId));
}

export async function getMessageInConversation(
  db: Database,
  conversationId: string,
  messageId: string,
): Promise<{
  id: string;
  role: string;
  uiFormat: string;
  content: unknown;
  uiProgram: string | null;
} | null> {
  const [row] = await db
    .select({
      id: messages.id,
      role: messages.role,
      uiFormat: messages.uiFormat,
      content: messages.content,
      uiProgram: messages.uiProgram,
    })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .limit(1);
  return row ?? null;
}

/**
 * 合并写入一个 blockKey。读当前值与写入是同一条 UPDATE：
 * 并发写不同 block 时后到的语句看到前一条的结果，不会用旧快照覆盖。
 * 已存值不是合法 envelope（旧版本/手工写入）时整体换成空 envelope，不把脏形状带给前端。
 */
export async function patchMessageUiState(
  db: Database,
  conversationId: string,
  messageId: string,
  blockKey: string,
  state: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({
      uiState: sql`jsonb_set(
        case
          when jsonb_typeof(${messages.uiState}) = 'object'
            and jsonb_typeof(${messages.uiState} -> 'blocks') = 'object'
            and ${messages.uiState} ->> 'version' = '1'
          then ${messages.uiState}
          else '{"version":1,"blocks":{}}'::jsonb
        end,
        array['blocks', ${blockKey}]::text[],
        ${JSON.stringify(state)}::jsonb,
        true
      )`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        eq(messages.role, 'assistant'),
        eq(messages.uiFormat, 'openui'),
      ),
    )
    .returning({ id: messages.id });
  return rows.length > 0;
}

export interface OpenUiApproval {
  id: string;
  approvedAt: Date | null;
  authorizationExpiresAt: Date | null;
}

/**
 * 会话级审批：同一 (conversation, server, tool) 只保留一行，重复调用不新增。
 * 与 run 级审批并存；run 级仍由 approval_requests.run_id 表达。
 */
export async function requestOpenUiApproval(
  db: Database,
  input: {
    conversationId: string;
    messageId: string;
    serverId: string;
    toolName: string;
  },
): Promise<OpenUiApproval> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      id: newId('approval'),
      runId: null,
      conversationId: input.conversationId,
      messageId: input.messageId,
      source: 'openui',
      serverId: input.serverId,
      toolName: input.toolName,
    })
    .onConflictDoUpdate({
      target: [
        approvalRequests.conversationId,
        approvalRequests.serverId,
        approvalRequests.toolName,
      ],
      targetWhere: isNull(approvalRequests.runId),
      set: {
        messageId: input.messageId,
        approvedAt: null,
        authorizationExpiresAt: null,
      },
      setWhere: sql`${approvalRequests.approvedAt} is null or ${approvalRequests.authorizationExpiresAt} is null or ${approvalRequests.authorizationExpiresAt} < now()`,
    })
    .returning({
      id: approvalRequests.id,
      approvedAt: approvalRequests.approvedAt,
      authorizationExpiresAt: approvalRequests.authorizationExpiresAt,
    });
  if (row) return row;
  const [existing] = await db
    .select({
      id: approvalRequests.id,
      approvedAt: approvalRequests.approvedAt,
      authorizationExpiresAt: approvalRequests.authorizationExpiresAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.conversationId, input.conversationId),
        isNull(approvalRequests.runId),
        eq(approvalRequests.serverId, input.serverId),
        eq(approvalRequests.toolName, input.toolName),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('approval insert returned no row');
  return existing;
}

/**
 * 只批准本会话里待批（approvedAt 为空）的那一条；跨会话/未知 id 返回 null。
 * 已有效的批准重复请求原样返回、不延长有效期；过期记录不在这里复活，
 * 必须先由 requestOpenUiApproval 重置为待批，才能再次批准。
 */
export async function approveOpenUiApproval(
  db: Database,
  conversationId: string,
  approvalId: string,
): Promise<OpenUiApproval | null> {
  const [row] = await db
    .update(approvalRequests)
    .set({
      approvedAt: sql`now()`,
      authorizationExpiresAt: sql`now() + interval '8 hours'`,
    })
    .where(
      and(
        eq(approvalRequests.id, approvalId),
        eq(approvalRequests.conversationId, conversationId),
        isNull(approvalRequests.runId),
        isNull(approvalRequests.approvedAt),
      ),
    )
    .returning({
      id: approvalRequests.id,
      approvedAt: approvalRequests.approvedAt,
      authorizationExpiresAt: approvalRequests.authorizationExpiresAt,
    });
  if (row) return row;

  const [existing] = await db
    .select({
      id: approvalRequests.id,
      approvedAt: approvalRequests.approvedAt,
      authorizationExpiresAt: approvalRequests.authorizationExpiresAt,
      valid: sql<boolean>`${approvalRequests.authorizationExpiresAt} > now()`,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.id, approvalId),
        eq(approvalRequests.conversationId, conversationId),
        isNull(approvalRequests.runId),
      ),
    )
    .limit(1);
  if (!existing) return null;
  if (existing.valid === true) {
    return {
      id: existing.id,
      approvedAt: existing.approvedAt,
      authorizationExpiresAt: existing.authorizationExpiresAt,
    };
  }
  throw new AppError(
    'CONFLICT',
    '该批准已过期，不能直接重新批准；请重新发起工具调用生成新的待批准记录',
  );
}

/** 某会话某工具的批准状态；未批准、已过期或不存在返回 null。 */
export async function getOpenUiApproval(
  db: Database,
  conversationId: string,
  serverId: string,
  toolName: string,
): Promise<OpenUiApproval | null> {
  const [row] = await db
    .select({
      id: approvalRequests.id,
      approvedAt: approvalRequests.approvedAt,
      authorizationExpiresAt: approvalRequests.authorizationExpiresAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.conversationId, conversationId),
        eq(approvalRequests.serverId, serverId),
        eq(approvalRequests.toolName, toolName),
        isNull(approvalRequests.runId),
        gt(approvalRequests.authorizationExpiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return row ?? null;
}
