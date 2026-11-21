import { AppError } from '@agentport/core';
import type {
  AccessFilter,
  AgentDefinition,
  AgentDefinitionServer,
  PublicRunQuestion,
  ResolvedRuntimeEnvironment,
  RunStatus,
  RunTrigger,
} from '@agentport/shared';
import {
  agentPermissionAllows,
  decodeCursor,
  encodeCursor,
  isActiveRunStatus,
} from '@agentport/shared';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  agentRuns,
  agentServers,
  agents,
  approvalRequests,
  conversations,
  messages,
  servers,
} from '../schema.js';
import { getAgentRelation, getUserAccess } from './access.js';
import { getAuthUserForPrincipal } from './accounts.js';
import { getAgentVersion } from './agent-versions.js';
import { getAgentsByIds, getBoundServersByAgentIds } from './agents.js';
import { getRunChannelAccess } from './channels.js';
import { messageText } from './chat/messages.js';
import { markBySource } from './notifications.js';
import { type CursorPage, isCanonicalTimestamp, keysetPage } from './pagination.js';

export interface RunListItem {
  id: string;
  scheduleId: string | null;
  agentId: string;
  agentName: string | null;
  status: RunStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  latencyMs: number | null;
  costUsd: string | null;
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  agentVersion: number | null;
}

export interface RunDetailRow extends RunListItem {
  conversationId: string;
  channelId: string | null;
  channelTriggerMessageId: string | null;
  initiatedBy: string | null;
  sessionId: string | null;
  sandboxId: string | null;
  runtimeEnvironment: ResolvedRuntimeEnvironment | null;
}

export type RunStep =
  | { kind: 'user'; at: string; text: string; messageId?: string }
  | { kind: 'assistant'; at: string; text: string; messageId?: string }
  | {
      kind: 'tool';
      at: string;
      name: string | null;
      toolUseId: string | null;
      content: unknown;
      result?: unknown;
      parentToolUseId: string | null;
      question?: PublicRunQuestion;
    };

export function mergeToolSteps(steps: RunStep[]): RunStep[] {
  const merged: RunStep[] = [];
  const byToolUse = new Map<string, Extract<RunStep, { kind: 'tool' }>>();
  for (const step of steps) {
    if (step.kind !== 'tool' || step.toolUseId === null) {
      merged.push(step);
      continue;
    }
    const existing = byToolUse.get(step.toolUseId);
    if (!existing) {
      const copy = { ...step };
      byToolUse.set(step.toolUseId, copy);
      merged.push(copy);
      continue;
    }
    if (step.result !== undefined) existing.result = step.result;
    if (step.content !== null && step.content !== undefined) existing.content = step.content;
    if (step.question !== undefined) existing.question = step.question;
  }
  return merged;
}

export interface RunDetail {
  run: RunDetailRow;
  steps: RunStep[];
  conversation: { id: string; agentId: string; title: string };
}

const runStartedAtCursor = sql<
  string | null
>`to_char(${agentRuns.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const runColumns = {
  id: agentRuns.id,
  agentId: agentRuns.agentId,
  agentName: agents.name,
  status: agentRuns.status,
  trigger: agentRuns.trigger,
  scheduleId: agentRuns.scheduleId,
  startedAt: agentRuns.startedAt,
  endedAt: agentRuns.endedAt,
  latencyMs: agentRuns.latencyMs,
  costUsd: agentRuns.costUsd,
  turns: agentRuns.turns,
  inputTokens: agentRuns.inputTokens,
  outputTokens: agentRuns.outputTokens,
  error: agentRuns.error,
  agentVersion: agentRuns.agentVersion,
};

export async function listRuns(
  db: Database,
  options: {
    agentId?: string;
    status?: RunStatus;
    trigger?: RunTrigger;
    since?: Date;
    cursor?: string;
    limit: number;
    access: AccessFilter;
  },
): Promise<CursorPage<RunListItem> | null> {
  const filters: SQL[] = [isNull(agentRuns.channelId)];
  if (options.access.scopes.includes('platform')) {
  } else if (options.access.scopes.includes('own_data')) {
    filters.push(eq(agentRuns.initiatedBy, options.access.businessId));
  } else {
    filters.push(sql`false`);
  }
  if (options.agentId !== undefined) filters.push(eq(agentRuns.agentId, options.agentId));
  if (options.status !== undefined) filters.push(eq(agentRuns.status, options.status));
  if (options.trigger !== undefined) filters.push(eq(agentRuns.trigger, options.trigger));
  if (options.since !== undefined) filters.push(gte(agentRuns.startedAt, options.since));

  if (options.cursor !== undefined) {
    const parts = decodeCursor(options.cursor, 2);
    if (parts === null) return null;
    const cursorStartedAt = parts[0];
    const anchorId = parts[1];
    if (cursorStartedAt === undefined || anchorId === undefined) return null;
    if (anchorId === '' || anchorId.includes('\u0000')) return null;
    if (cursorStartedAt !== '' && !isCanonicalTimestamp(cursorStartedAt)) return null;
    const [anchor] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(...filters, eq(agentRuns.id, anchorId)))
      .limit(1);
    if (!anchor) return null;
    if (cursorStartedAt === '') {
      filters.push(sql`(${agentRuns.startedAt} is null and ${agentRuns.id} < ${anchorId})`);
    } else {
      filters.push(
        sql`(${agentRuns.startedAt} is null or (${agentRuns.startedAt}, ${agentRuns.id}) < (${cursorStartedAt}::timestamptz, ${anchorId}))`,
      );
    }
  }

  // drizzle 0.45 的 ORDER BY 没有 nullsLast 构造器（只有索引列有），保留原始 sql。
  const rows = await db
    .select({ ...runColumns, startedAtCursor: runStartedAtCursor })
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(...filters))
    .orderBy(sql`${agentRuns.startedAt} desc nulls last`, desc(agentRuns.id))
    .limit(options.limit + 1);

  const last = rows.length > options.limit ? rows[options.limit - 1] : undefined;
  return {
    items: rows.slice(0, options.limit).map(({ startedAtCursor, ...item }) => item),
    nextCursor: last === undefined ? null : encodeCursor([last.startedAtCursor ?? '', last.id]),
  };
}

export interface PersonalRunRow extends RunListItem {
  trigger: RunTrigger;
  createdAt: Date;
  /** 仅来源会话确属本人时返回；他人的会话不提供给个人页跳转。 */
  conversationId: string | null;
}

export interface PersonalRunPage {
  items: PersonalRunRow[];
  nextCursor: string | null;
}

export interface PersonalUsageSummaryRow {
  runCount: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timeout: number;
  queued: number;
  running: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string | null;
  costRecordedRuns: number;
  costMissingRuns: number;
}

function personalRunWhere(businessId: string, since: Date, until: Date): SQL[] {
  return [
    eq(agentRuns.subjectKind, 'user'),
    eq(agentRuns.initiatedBy, businessId),
    gte(agentRuns.createdAt, since),
    lte(agentRuns.createdAt, until),
  ];
}

function personalRunRows(
  db: Database,
  options: { businessId: string; where: SQL | undefined; limit: number },
) {
  return db
    .select({
      ...runColumns,
      createdAt: agentRuns.createdAt,
      conversationId: sql<string | null>`case
        when ${conversations.createdBy} = ${options.businessId} then ${agentRuns.conversationId}
        else null
      end`,
    })
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(conversations, eq(conversations.id, agentRuns.conversationId))
    .where(options.where)
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(options.limit);
}

/** 「我的运行」按 (createdAt, id) 倒序翻页；游标锚点必须落在同一本人窗口与筛选内。 */
export async function listPersonalRuns(
  db: Database,
  options: {
    businessId: string;
    since: Date;
    until: Date;
    agentId?: string;
    status?: RunStatus;
    trigger?: RunTrigger;
    cursor?: string;
    limit: number;
  },
): Promise<PersonalRunPage | null> {
  const filters = personalRunWhere(options.businessId, options.since, options.until);
  filters.push(isNull(agentRuns.channelId));
  if (options.agentId !== undefined) filters.push(eq(agentRuns.agentId, options.agentId));
  if (options.status !== undefined) filters.push(eq(agentRuns.status, options.status));
  if (options.trigger !== undefined) filters.push(eq(agentRuns.trigger, options.trigger));

  return keysetPage(db, {
    table: agentRuns,
    cursor: options.cursor,
    limit: options.limit,
    where: filters,
    load: ({ where, limit }) =>
      personalRunRows(db, { businessId: options.businessId, where, limit }),
  });
}

export async function listPersonalRunsForExport(
  db: Database,
  options: {
    businessId: string;
    since: Date;
    until: Date;
    agentId?: string;
    status?: RunStatus;
    trigger?: RunTrigger;
  },
): Promise<{ items: PersonalRunRow[]; truncated: boolean }> {
  const EXPORT_LIMIT = 5000;
  const filters = personalRunWhere(options.businessId, options.since, options.until);
  filters.push(isNull(agentRuns.channelId));
  if (options.agentId !== undefined) filters.push(eq(agentRuns.agentId, options.agentId));
  if (options.status !== undefined) filters.push(eq(agentRuns.status, options.status));
  if (options.trigger !== undefined) filters.push(eq(agentRuns.trigger, options.trigger));

  const rows = await personalRunRows(db, {
    businessId: options.businessId,
    where: and(...filters),
    limit: EXPORT_LIMIT + 1,
  });

  return { items: rows.slice(0, EXPORT_LIMIT), truncated: rows.length > EXPORT_LIMIT };
}

export async function personalUsageSummary(
  db: Database,
  options: { businessId: string; since: Date; until: Date },
): Promise<PersonalUsageSummaryRow> {
  const [row] = await db
    .select({
      runCount: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
      cancelled: sql<number>`count(*) filter (where ${agentRuns.status} = 'cancelled')::int`,
      timeout: sql<number>`count(*) filter (where ${agentRuns.status} = 'timeout')::int`,
      queued: sql<number>`count(*) filter (where ${agentRuns.status} = 'queued')::int`,
      running: sql<number>`count(*) filter (where ${agentRuns.status} = 'running')::int`,
      inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`,
      // numeric 在浏览器求和不精确：数据库求和后按原文返回，null 表示一条都没记录。
      costUsd: sql<string | null>`sum(${agentRuns.costUsd})::text`,
      costRecordedRuns: sql<number>`count(*) filter (where ${agentRuns.costUsd} is not null)::int`,
    })
    .from(agentRuns)
    .where(and(...personalRunWhere(options.businessId, options.since, options.until)));

  const runCount = row?.runCount ?? 0;
  const costRecordedRuns = row?.costRecordedRuns ?? 0;
  return {
    runCount,
    succeeded: row?.succeeded ?? 0,
    failed: row?.failed ?? 0,
    cancelled: row?.cancelled ?? 0,
    timeout: row?.timeout ?? 0,
    queued: row?.queued ?? 0,
    running: row?.running ?? 0,
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    costUsd: row?.costUsd ?? null,
    costRecordedRuns,
    costMissingRuns: runCount - costRecordedRuns,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function questionOf(content: Record<string, unknown>): PublicRunQuestion | undefined {
  const question = content.question;
  return typeof question === 'object' && question !== null
    ? (question as PublicRunQuestion)
    : undefined;
}

export function toStep(message: {
  id?: string;
  role: string;
  content: unknown;
  createdAt: Date;
}): RunStep | null {
  const content = asRecord(message.content);
  const at = message.createdAt.toISOString();
  const text = messageText(message.content);
  const messageId = message.id === undefined ? {} : { messageId: message.id };

  if (message.role === 'user' && text !== null) {
    return { kind: 'user', at, text, ...messageId };
  }
  if (message.role === 'assistant' && content?.type === 'text' && text !== null) {
    return { kind: 'assistant', at, text, ...messageId };
  }
  if (message.role === 'tool' && content?.type === 'tool_use') {
    const question = questionOf(content);
    return {
      kind: 'tool',
      at,
      name: typeof content.name === 'string' ? content.name : null,
      toolUseId: typeof content.id === 'string' ? content.id : null,
      content: content.input,
      parentToolUseId: typeof content.parentToolUseId === 'string' ? content.parentToolUseId : null,
      ...(question === undefined ? {} : { question }),
    };
  }
  if (message.role === 'tool' && content?.type === 'tool_result') {
    const question = questionOf(content);
    return {
      kind: 'tool',
      at,
      name: typeof content.name === 'string' ? content.name : null,
      toolUseId: typeof content.toolUseId === 'string' ? content.toolUseId : null,
      content: null,
      result: content.content,
      parentToolUseId: typeof content.parentToolUseId === 'string' ? content.parentToolUseId : null,
      ...(question === undefined ? {} : { question }),
    };
  }
  return null;
}

/** run 是否还能执行：queued 尚未开始，running 进行中；其余均为终态。 */
export async function isRunActive(db: Database, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return isActiveRunStatus(row?.status);
}

/**
 * run 的沙盒只挂载两类 server：所属智能体自己绑定的，以及它启用的直接子智能体绑定的。
 * 外部传入的 run header 不可信，不满足时按「没有 run」处理，审批不会跨 agent/server 复用。
 */
function runMayUseServer(): SQL {
  return sql`${agentServers.agentId} = ${agentRuns.agentId} or exists (
    select 1 from ${agents} child
    where child.id = ${agentServers.agentId}
      and child.parent_id = ${agentRuns.agentId}
      and child.enabled
  )`;
}

function runServerScope(serverId: string): SQL {
  return sql`((${agentRuns.serverIds} is not null and ${agentRuns.serverIds} @> ${JSON.stringify([serverId])}::jsonb) or (
    ${agentRuns.serverIds} is null and exists (
      select 1 from ${agentServers}
      where ${agentServers.serverId} = ${serverId}
        and (${runMayUseServer()})
    )
  ))`;
}

function toDefinitionServer(row: typeof servers.$inferSelect): AgentDefinitionServer {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: row.config,
    secretsEncrypted: row.secretsEncrypted,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 还原 worker 为本 run 选择的 server 定义：根与子级快照优先，未固定的子级用当前定义。
 * 审批与执行必须和 worker 看到同一份定义，任一层无法唯一确定都按不存在处理。
 */
export async function getRunServerSnapshot(
  db: DbHandle,
  runId: string,
  serverId: string,
): Promise<AgentDefinitionServer | null> {
  const [run] = await db
    .select({
      agentId: agentRuns.agentId,
      agentVersion: agentRuns.agentVersion,
      definitionSnapshot: agentRuns.definitionSnapshot,
      startedAt: agentRuns.startedAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) return null;
  const definition =
    run.definitionSnapshot ??
    (run.agentVersion !== null
      ? (await getAgentVersion(db, run.agentId, run.agentVersion))?.definition
      : null) ??
    null;
  const childRefs =
    definition === null
      ? (
          await db
            .select({
              id: agents.id,
              publishedVersion: agents.publishedVersion,
              publishedAt: agents.publishedAt,
              enabled: agents.enabled,
            })
            .from(agents)
            .where(eq(agents.parentId, run.agentId))
            .orderBy(asc(agents.id))
        ).map(({ id, publishedVersion, publishedAt, enabled }) => ({
          id,
          publishedVersion,
          publishedAt,
          enabled,
        }))
      : definition.resources.subAgents.map(({ id, publishedVersion }) => ({
          id,
          publishedVersion,
          publishedAt: null,
          enabled: true,
        }));
  const liveChildren =
    definition === null
      ? new Map(childRefs.map(({ id, enabled }) => [id, enabled]))
      : new Map(
          (
            await getAgentsByIds(
              db,
              childRefs.map(({ id }) => id),
            )
          ).map((row) => [row.id, row.enabled]),
        );
  const children: Array<{ agentId: string; definition: AgentDefinition | null }> = [];
  let ambiguous = false;
  for (const ref of childRefs) {
    if (liveChildren.get(ref.id) !== true) continue;
    const version =
      ref.publishedVersion === null
        ? null
        : await getAgentVersion(db, ref.id, ref.publishedVersion);
    if (ref.publishedVersion !== null && version === null) continue;
    if (
      definition === null &&
      run.startedAt !== null &&
      ref.publishedVersion !== null &&
      (ref.publishedAt === null || ref.publishedAt.getTime() > run.startedAt.getTime())
    ) {
      ambiguous = true;
      continue;
    }
    children.push({ agentId: ref.id, definition: version?.definition ?? null });
  }
  const liveIds = [
    run.agentId,
    ...children.filter(({ definition: child }) => child === null).map(({ agentId }) => agentId),
  ];
  const liveServers = await getBoundServersByAgentIds(db, liveIds);
  const serversOf = (agentId: string, agentDefinition: AgentDefinition | null) =>
    agentDefinition !== null
      ? agentDefinition.resources.servers
      : (liveServers.get(agentId) ?? []).map(toDefinitionServer);
  const server = [
    ...serversOf(run.agentId, definition),
    ...children.flatMap(({ agentId, definition: child }) => serversOf(agentId, child)),
  ].find((entry) => entry.id === serverId);
  if (ambiguous) throw new AppError('FORBIDDEN', '子专家在运行开始后重新发布，无法确认工具定义');
  if (server) return server;
  return null;
}

export async function getRunConversationId(db: Database, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ conversationId: agentRuns.conversationId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.conversationId ?? null;
}

export async function getRunInitiator(db: DbHandle, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ initiatedBy: agentRuns.initiatedBy })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.initiatedBy ?? null;
}

export async function getRunApprovalSubject(db: DbHandle, runId: string) {
  const [run] = await db
    .select({
      agentId: agentRuns.agentId,
      subjectKind: agentRuns.subjectKind,
      initiatedBy: agentRuns.initiatedBy,
      serviceId: agentRuns.serviceId,
      channelId: agentRuns.channelId,
      conversationId: agentRuns.conversationId,
      trigger: agentRuns.trigger,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) return null;
  const { agentId, subjectKind, initiatedBy, serviceId, channelId, conversationId, trigger } = run;
  if (trigger === 'channel' && channelId === null) return null;
  if (subjectKind === 'service') {
    return serviceId === 'system' || serviceId === 'mcp'
      ? { agentId, subjectKind, roles: [`service:${serviceId}`] }
      : null;
  }
  if (subjectKind !== 'user' || initiatedBy === null) return null;
  const [account, access, relation] = await Promise.all([
    getAuthUserForPrincipal(db, initiatedBy),
    getUserAccess(db, initiatedBy),
    getAgentRelation(db, agentId, initiatedBy),
  ]);
  if (!account || account.disabled || !relation.exists || relation.inactive) return null;
  let channelRole: string | null = null;
  if (channelId === null) {
    if (!agentPermissionAllows(access.grants, 'agents.use', relation, initiatedBy)) return null;
  } else {
    const lane =
      conversationId === null
        ? null
        : await getRunChannelAccess(db, {
            channelId,
            agentId,
            conversationId,
            businessId: initiatedBy,
          });
    if (
      !lane ||
      lane.conversationChannelId !== channelId ||
      lane.conversationAgentId !== agentId ||
      lane.archivedAt !== null ||
      lane.role === null ||
      lane.role === 'viewer' ||
      lane.bindingStatus !== 'active'
    )
      return null;
    channelRole = lane.role;
  }
  const roles = access.roles.map((role) => `platform:${role.id}`);
  if (relation.ownerBusinessId === initiatedBy) roles.push('agent:owner');
  if (relation.canMaintain) roles.push('agent:maintainer');
  if (relation.canUse || relation.canMaintain || relation.organizationVisible || relation.isDefault)
    roles.push('agent:user');
  if (channelRole !== null) roles.push(`channel:${channelRole}`);
  return { agentId, subjectKind, roles };
}

export async function getRunAgentId(db: DbHandle, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.agentId ?? null;
}

export async function isRunBoundToServer(
  db: DbHandle,
  runId: string,
  serverId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ runId: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), runServerScope(serverId)))
    .limit(1);
  return row !== undefined;
}

export async function setRunMcpToken(
  db: Database,
  runId: string,
  tokenHash: string,
  expiresAt: Date,
  modelTokenHash?: string | null,
  serverIds?: string[],
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      mcpTokenHash: tokenHash,
      mcpTokenExpiresAt: expiresAt,
      ...(modelTokenHash === undefined ? {} : { modelTokenHash }),
      ...(serverIds === undefined ? {} : { serverIds }),
    })
    .where(eq(agentRuns.id, runId));
}

export async function setRunModelTokenHash(
  db: Database,
  runId: string,
  tokenHash: string | null,
): Promise<void> {
  await db.update(agentRuns).set({ modelTokenHash: tokenHash }).where(eq(agentRuns.id, runId));
}

export async function clearRunTokens(db: Database, runId: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ mcpTokenHash: null, mcpTokenExpiresAt: null, modelTokenHash: null })
    .where(eq(agentRuns.id, runId));
}

export async function findRunByModelToken(
  db: Database,
  tokenHash: string,
): Promise<{ runId: string; conversationId: string; agentId: string } | null> {
  const [row] = await db
    .select({
      id: agentRuns.id,
      conversationId: agentRuns.conversationId,
      agentId: agentRuns.agentId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.modelTokenHash, tokenHash), eq(agentRuns.status, 'running')))
    .limit(1);
  return row ? { runId: row.id, conversationId: row.conversationId, agentId: row.agentId } : null;
}

/**
 * run 仍持有的短期 token（父或其启用子级绑定该 server 时返回）。
 * 行存在但 hash 为空表示 run 已结束，token 立即失效。
 */
export async function getRunToken(
  db: Database,
  runId: string,
  serverId: string,
): Promise<{ hash: string | null; expiresAt: Date | null } | null> {
  const [row] = await db
    .select({ hash: agentRuns.mcpTokenHash, expiresAt: agentRuns.mcpTokenExpiresAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), runServerScope(serverId)))
    .limit(1);
  return row ?? null;
}

export interface ApprovalRequestRow {
  id: string;
  runId: string;
  serverId: string;
  serverName: string | null;
  toolName: string;
  createdAt: Date;
  approvedAt: Date | null;
  deniedAt: Date | null;
  expiresAt: Date | null;
}

type RunToolApproval = { runId: string; serverId: string; toolName: string; decisionHash: string };

function runToolApprovalScope({
  runId,
  serverId,
  toolName,
}: Omit<RunToolApproval, 'decisionHash'>) {
  return and(
    eq(approvalRequests.runId, runId),
    eq(approvalRequests.serverId, serverId),
    eq(approvalRequests.toolName, toolName),
    isNull(approvalRequests.supersededAt),
  );
}

export async function getCurrentApproval(db: DbHandle, input: RunToolApproval) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(runToolApprovalScope(input), eq(approvalRequests.decisionHash, input.decisionHash)))
    .limit(1);
  return row ?? null;
}

export async function getApprovalById(
  db: DbHandle,
  input: Omit<RunToolApproval, 'decisionHash'> & { approvalId: string },
) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.id, input.approvalId),
        eq(approvalRequests.runId, input.runId),
        eq(approvalRequests.serverId, input.serverId),
        eq(approvalRequests.toolName, input.toolName),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function supersedeMismatchedApprovals(
  db: Transaction,
  input: Omit<RunToolApproval, 'decisionHash'> & { decisionHash: string | null },
) {
  const rows = await db
    .update(approvalRequests)
    .set({ supersededAt: sql`clock_timestamp()` })
    .where(
      and(
        runToolApprovalScope(input),
        isNotNull(approvalRequests.decisionHash),
        input.decisionHash === null
          ? undefined
          : ne(approvalRequests.decisionHash, input.decisionHash),
      ),
    )
    .returning({ id: approvalRequests.id, channelId: approvalRequests.channelId });
  await Promise.all(
    rows.map((row) =>
      markBySource(
        db,
        'approval',
        row.channelId === null ? `approval:${input.runId}:${row.id}` : `channel-approval:${row.id}`,
      ),
    ),
  );
}

export async function lockRunForApproval(tx: Transaction, runId: string) {
  const [run] = await tx
    .select({ channelId: agentRuns.channelId, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for('update');
  return run ?? null;
}

export async function requestApproval(
  tx: Transaction,
  input: RunToolApproval & {
    expiresAt?: Date | null;
    argumentsSummary?: Record<string, unknown> | null;
  },
) {
  const run = await lockRunForApproval(tx, input.runId);
  const existing = await getCurrentApproval(tx, input);
  if (
    existing &&
    (existing.approvedAt !== null ||
      existing.deniedAt !== null ||
      existing.expiresAt === null ||
      existing.expiresAt.getTime() > Date.now())
  )
    return existing;
  if (existing) {
    await tx
      .update(approvalRequests)
      .set({ supersededAt: sql`clock_timestamp()` })
      .where(eq(approvalRequests.id, existing.id));
  }
  const [inserted] = await tx
    .insert(approvalRequests)
    .values({ id: newId('approval'), ...input, channelId: run?.channelId ?? null })
    .returning();
  if (!inserted) throw new Error('approval request insert returned no row');
  return inserted;
}

export async function expireStaleApprovals(
  db: DbHandle,
  now: Date,
): Promise<
  Array<{
    id: string;
    runId: string | null;
    serverId: string;
    toolName: string;
    conversationId: string | null;
    channelId: string | null;
  }>
> {
  return db
    .update(approvalRequests)
    .set({ expiredAt: now })
    .where(
      and(
        isNull(approvalRequests.approvedAt),
        isNull(approvalRequests.deniedAt),
        isNull(approvalRequests.expiredAt),
        isNotNull(approvalRequests.expiresAt),
        lte(approvalRequests.expiresAt, now),
      ),
    )
    .returning({
      id: approvalRequests.id,
      runId: approvalRequests.runId,
      serverId: approvalRequests.serverId,
      toolName: approvalRequests.toolName,
      conversationId: approvalRequests.conversationId,
      channelId: approvalRequests.channelId,
    });
}

export async function listApprovalRequests(
  db: Database,
  runId: string,
): Promise<ApprovalRequestRow[]> {
  const rows = await db
    .select({
      id: approvalRequests.id,
      serverId: approvalRequests.serverId,
      serverName: servers.name,
      toolName: approvalRequests.toolName,
      createdAt: approvalRequests.createdAt,
      approvedAt: approvalRequests.approvedAt,
      deniedAt: approvalRequests.deniedAt,
      expiresAt: approvalRequests.expiresAt,
    })
    .from(approvalRequests)
    .leftJoin(servers, eq(servers.id, approvalRequests.serverId))
    .where(
      and(
        eq(approvalRequests.runId, runId),
        isNull(approvalRequests.supersededAt),
        isNotNull(approvalRequests.decisionHash),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id));
  return rows.map((row) => ({ ...row, runId }));
}

export type RecheckApproval = (
  tx: Transaction,
  input: { runId: string; serverId: string; toolName: string },
) => Promise<string | null>;

export async function decideToolApproval(
  db: Database,
  input: { runId: string; approvalId: string; businessId: string; decision: 'approve' | 'deny' },
  recheck: RecheckApproval,
) {
  return db.transaction(async (tx) => {
    const run = await lockRunForApproval(tx, input.runId);
    const [approval] = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.id, input.approvalId), eq(approvalRequests.runId, input.runId)),
      );
    if (!run || run.channelId !== null || !approval) return { kind: 'not_found' } as const;
    if (run.status !== 'running') return { kind: 'conflict' } as const;
    if (approval.decisionHash === null || approval.supersededAt !== null)
      return { kind: 'conflict' } as const;
    const current = await recheck(tx, {
      runId: input.runId,
      serverId: approval.serverId,
      toolName: approval.toolName,
    });
    if (current !== approval.decisionHash) return { kind: 'conflict' } as const;
    if (input.decision === 'approve' && approval.approvedAt !== null) {
      return {
        kind: 'ok',
        approval,
        waiting: approval.expiresAt !== null && approval.expiresAt.getTime() > Date.now(),
      } as const;
    }
    const [decided] = await tx
      .update(approvalRequests)
      .set(
        input.decision === 'approve'
          ? { approvedAt: sql`clock_timestamp()`, approvedByBusinessId: input.businessId }
          : { deniedAt: sql`clock_timestamp()`, deniedByBusinessId: input.businessId },
      )
      .where(
        and(
          eq(approvalRequests.id, input.approvalId),
          eq(approvalRequests.runId, input.runId),
          eq(approvalRequests.decisionHash, current),
          isNull(approvalRequests.supersededAt),
          isNull(approvalRequests.approvedAt),
          isNull(approvalRequests.deniedAt),
          or(
            isNull(approvalRequests.expiresAt),
            gt(approvalRequests.expiresAt, sql`clock_timestamp()`),
          ),
        ),
      )
      .returning();
    return decided
      ? ({ kind: 'ok', approval: decided, waiting: decided.expiresAt !== null } as const)
      : ({ kind: 'conflict' } as const);
  });
}

export async function getRunDetail(db: Database, runId: string): Promise<RunDetail | null> {
  const [row] = await db
    .select({
      ...runColumns,
      conversationId: agentRuns.conversationId,
      channelId: agentRuns.channelId,
      channelTriggerMessageId: agentRuns.channelTriggerMessageId,
      initiatedBy: agentRuns.initiatedBy,
      sessionId: agentRuns.sessionId,
      sandboxId: agentRuns.sandboxId,
      runtimeEnvironmentId: agentRuns.runtimeEnvironmentId,
      runtimeEnvironmentName: agentRuns.runtimeEnvironmentName,
      runtimeEnvironmentVersionId: agentRuns.runtimeEnvironmentVersionId,
      runtimeEnvironmentImageId: agentRuns.runtimeEnvironmentImageId,
      conversationAgentId: conversations.agentId,
      conversationTitle: conversations.title,
    })
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(conversations, eq(conversations.id, agentRuns.conversationId))
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!row) return null;

  const {
    conversationAgentId,
    conversationTitle,
    runtimeEnvironmentId,
    runtimeEnvironmentName,
    runtimeEnvironmentVersionId,
    runtimeEnvironmentImageId,
    ...run
  } = row;
  const runtimeEnvironment: ResolvedRuntimeEnvironment | null =
    runtimeEnvironmentId === null ||
    runtimeEnvironmentName === null ||
    runtimeEnvironmentVersionId === null ||
    runtimeEnvironmentImageId === null
      ? null
      : {
          environmentId: runtimeEnvironmentId,
          environmentName: runtimeEnvironmentName,
          versionId: runtimeEnvironmentVersionId,
          imageId: runtimeEnvironmentImageId,
        };
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.runId, runId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const steps = mergeToolSteps(rows.map(toStep).filter((step): step is RunStep => step !== null));

  return {
    run: { ...run, runtimeEnvironment },
    steps,
    conversation: {
      id: run.conversationId,
      agentId: conversationAgentId ?? run.agentId,
      title: conversationTitle ?? '',
    },
  };
}
