import { AppError } from '@agentport/core';
import { isRecord } from '@agentport/core/record';
import type { AgentDefinition } from '@agentport/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import {
  agentRuns,
  agentServers,
  agents,
  apiTools,
  approvalRequests,
  conversations,
  messages,
  servers,
} from '../schema.js';
import { getAgentVersion } from './agent-versions.js';

export interface OpenUiToolRow {
  serverId: string;
  serverName: string;
  kind: 'http' | 'generated';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  approvalMode: 'allow' | 'ask' | 'deny';
  toolId?: string;
  method?: string;
  pathTemplate?: string;
  paramsIn?: string;
  baseUrl?: string;
}

interface CatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  approvalMode: 'allow' | 'ask' | 'deny';
  toolId?: string;
  method?: string;
  pathTemplate?: string;
  paramsIn?: string;
  baseUrl?: string;
}

function matchesToolPattern(pattern: string, toolName: string, serverName: string): boolean {
  if (pattern === toolName) return true;
  if (pattern === `mcp__${serverName}`) return true;
  return pattern === `mcp__${serverName}__*`;
}

function compareAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function collectOpenUiTools(
  agent: { allowedTools: readonly string[]; disallowedTools: readonly string[] },
  entries: ReadonlyArray<{
    serverId: string;
    serverName: string;
    kind: 'http' | 'generated';
    tools: readonly CatalogTool[];
  }>,
): OpenUiToolRow[] {
  const allow = agent.allowedTools.filter((rule) => rule.startsWith('mcp__'));
  const deny = agent.disallowedTools.filter((rule) => rule.startsWith('mcp__'));
  return entries.flatMap((server) =>
    server.tools.flatMap((tool) => {
      const name = `mcp__${server.serverName}__${tool.name}`;
      if (deny.some((pattern) => matchesToolPattern(pattern, name, server.serverName))) return [];
      if (allow.length > 0 && !allow.some((p) => matchesToolPattern(p, name, server.serverName))) {
        return [];
      }
      return [
        {
          serverId: server.serverId,
          serverName: server.serverName,
          kind: server.kind,
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          approvalMode: tool.approvalMode,
          ...(tool.toolId === undefined ? {} : { toolId: tool.toolId }),
          ...(tool.method === undefined ? {} : { method: tool.method }),
          ...(tool.pathTemplate === undefined ? {} : { pathTemplate: tool.pathTemplate }),
          ...(tool.paramsIn === undefined ? {} : { paramsIn: tool.paramsIn }),
          ...(tool.baseUrl === undefined ? {} : { baseUrl: tool.baseUrl }),
        },
      ];
    }),
  );
}

export async function listOpenUiTools(db: Database, agentId: string): Promise<OpenUiToolRow[]> {
  const [agent] = await db
    .select({ allowedTools: agents.allowedTools, disallowedTools: agents.disallowedTools })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return [];

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
            id: apiTools.id,
            serverId: apiTools.serverId,
            name: apiTools.name,
            description: apiTools.description,
            method: apiTools.method,
            pathTemplate: apiTools.pathTemplate,
            paramsIn: apiTools.paramsIn,
            inputSchema: apiTools.inputSchema,
            outputSchema: apiTools.outputSchema,
            approvalMode: apiTools.approvalMode,
          })
          .from(apiTools)
          .where(and(inArray(apiTools.serverId, generatedIds), eq(apiTools.enabled, true)))
          .orderBy(asc(apiTools.serverId), asc(apiTools.name));
  const toolsByServer = Map.groupBy(generatedTools, (tool) => tool.serverId);

  return collectOpenUiTools(
    agent,
    rows.flatMap((server) => {
      if (server.kind !== 'http' && server.kind !== 'generated') return [];
      const baseUrl = typeof server.config.baseUrl === 'string' ? server.config.baseUrl : '';
      const tools: CatalogTool[] =
        server.kind === 'generated'
          ? (toolsByServer.get(server.serverId) ?? []).map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              ...(isRecord(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
              approvalMode: tool.approvalMode,
              toolId: tool.id,
              method: tool.method,
              pathTemplate: tool.pathTemplate,
              paramsIn: tool.paramsIn,
              baseUrl,
            }))
          : readHttpCatalog(server.config);
      return [
        { serverId: server.serverId, serverName: server.serverName, kind: server.kind, tools },
      ];
    }),
  );
}

export function listOpenUiToolsFromSnapshot(
  agent: { allowedTools: readonly string[]; disallowedTools: readonly string[] },
  serverRows: readonly AgentDefinition['resources']['servers'][number][],
): OpenUiToolRow[] {
  const orderedServers = serverRows
    .filter(
      (
        server,
      ): server is AgentDefinition['resources']['servers'][number] & {
        kind: 'http' | 'generated';
      } => server.kind === 'http' || server.kind === 'generated',
    )
    .toSorted((a, b) => compareAsc(a.name, b.name) || compareAsc(a.id, b.id));

  return collectOpenUiTools(
    agent,
    orderedServers.map((server) => {
      const baseUrl = typeof server.config.baseUrl === 'string' ? server.config.baseUrl : '';
      const tools: CatalogTool[] =
        server.kind === 'generated'
          ? (server.tools ?? [])
              .filter((tool) => tool.enabled)
              .toSorted((a, b) => compareAsc(a.name, b.name))
              .map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                ...(isRecord(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
                approvalMode: tool.approvalMode,
                toolId: tool.id,
                method: tool.method,
                pathTemplate: tool.pathTemplate,
                paramsIn: tool.paramsIn,
                baseUrl,
              }))
          : readHttpCatalog(server.config);
      return { serverId: server.id, serverName: server.name, kind: server.kind, tools };
    }),
  );
}

function readHttpCatalog(config: Record<string, unknown>): CatalogTool[] {
  const catalog = config.toolCatalog;
  if (!Array.isArray(catalog)) return [];
  return catalog.flatMap((item) => {
    if (!isRecord(item)) return [];
    const { name, description, inputSchema, outputSchema } = item;
    if (typeof name !== 'string') return [];
    return [
      {
        name,
        description: typeof description === 'string' ? description : '',
        inputSchema: isRecord(inputSchema) ? inputSchema : { type: 'object', properties: {} },
        ...(isRecord(outputSchema) ? { outputSchema } : {}),
        approvalMode: 'allow' as const,
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
    outputSchema?: Record<string, unknown> | undefined;
  }>,
): Promise<void> {
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    ...(isRecord(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
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
  uiState: unknown;
  runId: string | null;
  sdkMessageUuid: string | null;
} | null> {
  const [row] = await db
    .select({
      id: messages.id,
      role: messages.role,
      uiFormat: messages.uiFormat,
      content: messages.content,
      uiProgram: messages.uiProgram,
      uiState: messages.uiState,
      runId: messages.runId,
      sdkMessageUuid: messages.sdkMessageUuid,
    })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .limit(1);
  return row ?? null;
}

export async function getRunDefinitionSnapshot(
  db: Database,
  runId: string,
): Promise<AgentDefinition | null> {
  const [run] = await db
    .select({
      agentId: agentRuns.agentId,
      agentVersion: agentRuns.agentVersion,
      definitionSnapshot: agentRuns.definitionSnapshot,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) return null;
  if (run.definitionSnapshot !== null) return run.definitionSnapshot;
  if (run.agentVersion === null) return null;
  const version = await getAgentVersion(db, run.agentId, run.agentVersion);
  return version?.definition ?? null;
}

const MAX_FORK_ANCESTOR_DEPTH = 16;

export async function getRunDefinitionSnapshotForMessage(
  db: Database,
  conversationId: string,
  message: { runId: string | null; sdkMessageUuid: string | null },
): Promise<AgentDefinition | null> {
  if (message.runId !== null) {
    return getRunDefinitionSnapshot(db, message.runId);
  }
  if (message.sdkMessageUuid === null) return null;

  let currentConversationId = conversationId;
  const visited = new Set<string>([conversationId]);
  for (let depth = 0; depth < MAX_FORK_ANCESTOR_DEPTH; depth += 1) {
    const [conv] = await db
      .select({ parentId: conversations.parentId })
      .from(conversations)
      .where(eq(conversations.id, currentConversationId))
      .limit(1);
    if (!conv?.parentId || visited.has(conv.parentId)) return null;
    visited.add(conv.parentId);
    currentConversationId = conv.parentId;

    const [ancestorRow] = await db
      .select({ runId: messages.runId })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, currentConversationId),
          eq(messages.sdkMessageUuid, message.sdkMessageUuid),
          eq(messages.role, 'assistant'),
          eq(messages.uiFormat, 'openui'),
          isNotNull(messages.runId),
        ),
      )
      .limit(1);
    if (ancestorRow?.runId !== undefined && ancestorRow.runId !== null) {
      return getRunDefinitionSnapshot(db, ancestorRow.runId);
    }
  }
  return null;
}

export type PatchMessageUiStateResult = 'ok' | 'not_found' | 'too_large';

export async function patchMessageUiState(
  db: Database,
  conversationId: string,
  messageId: string,
  blockKey: string,
  state: Record<string, unknown>,
  maxTotalBytes: number,
): Promise<PatchMessageUiStateResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ uiState: messages.uiState })
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.conversationId, conversationId),
          eq(messages.role, 'assistant'),
          eq(messages.uiFormat, 'openui'),
        ),
      )
      .limit(1)
      .for('update');
    if (!row) return 'not_found';
    const existingBlocks =
      isRecord(row.uiState) && row.uiState.version === 1 && isRecord(row.uiState.blocks)
        ? row.uiState.blocks
        : {};
    const nextEnvelope = {
      version: 1,
      blocks: { ...existingBlocks, [blockKey]: state },
    };
    if (Buffer.byteLength(JSON.stringify(nextEnvelope), 'utf8') > maxTotalBytes) {
      return 'too_large';
    }
    await tx.update(messages).set({ uiState: nextEnvelope }).where(eq(messages.id, messageId));
    return 'ok';
  });
}

export interface OpenUiApproval {
  id: string;
  approvedAt: Date | null;
  authorizationExpiresAt: Date | null;
}

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
        approvedByBusinessId: null,
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

export async function approveOpenUiApproval(
  db: Database,
  conversationId: string,
  approvalId: string,
  approvedByBusinessId: string | null = null,
): Promise<OpenUiApproval | null> {
  const [row] = await db
    .update(approvalRequests)
    .set({
      approvedAt: sql`now()`,
      approvedByBusinessId,
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
