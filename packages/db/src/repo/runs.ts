import { fail } from '@agentport/core';
import type {
  AccessFilter,
  PublicRunQuestion,
  ResolvedRuntimeEnvironment,
  RunTrigger,
} from '@agentport/shared';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database } from '../client.js';
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
import { messageText, type Tx } from './chat.js';

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunListItem {
  id: string;
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
  sessionId: string | null;
  sandboxId: string | null;
  /** 容器实际使用的身份；queued 尚未创建容器时为 null。 */
  runtimeEnvironment: ResolvedRuntimeEnvironment | null;
}

export type RunStep =
  | { kind: 'user'; at: string; text: string }
  | { kind: 'assistant'; at: string; text: string }
  | {
      kind: 'tool';
      at: string;
      name: string | null;
      toolUseId: string | null;
      /** 调用参数；tool_result 合进来后仍保留 input。 */
      content: unknown;
      /** 调用结果；与 input 分开，前端才能并排展示「传了什么/拿回什么」。 */
      result?: unknown;
      /** 子智能体内部的调用：父侧 Agent 的 tool_use id；顶层为空。 */
      parentToolUseId: string | null;
      /** 原生提问的最终展示快照；只有提问工具行才带。 */
      question?: PublicRunQuestion;
    };

/**
 * tool_use 与 tool_result 是同一次调用的两半，按 toolUseId 合成一步。
 * 分开返回会让界面出现两个同名步骤，读者无法判断哪个是参数、哪个是结果。
 */
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
    // 后到的 result 补进已有步骤；后到的 use 补回 input。
    if (step.result !== undefined) existing.result = step.result;
    if (step.content !== null && step.content !== undefined) existing.content = step.content;
    // 最终快照可能落在任一半上；后到的快照覆盖旧的 pending。
    if (step.question !== undefined) existing.question = step.question;
  }
  return merged;
}

export interface RunDetail {
  run: RunDetailRow;
  steps: RunStep[];
  conversation: { id: string; agentId: string; title: string };
}

const runColumns = {
  id: agentRuns.id,
  agentId: agentRuns.agentId,
  agentName: agents.name,
  status: agentRuns.status,
  trigger: agentRuns.trigger,
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

/** 运行列表：join agents 取名字，按开始时间倒序（尚未开始的排在最后）。 */
export async function listRuns(
  db: Database,
  options: {
    agentId?: string;
    status?: RunStatus;
    trigger?: RunTrigger;
    limit?: number;
    access: AccessFilter;
  },
): Promise<RunListItem[]> {
  const filters: SQL[] = [isNull(agentRuns.channelId)];
  if (options.access.scopes.includes('platform')) {
    // P 看全平台私有运行；频道运行只从频道入口访问。
  } else if (options.access.scopes.includes('own_data')) {
    filters.push(eq(agentRuns.initiatedBy, options.access.businessId));
  } else {
    filters.push(sql`false`);
  }
  if (options.agentId !== undefined) filters.push(eq(agentRuns.agentId, options.agentId));
  if (options.status !== undefined) filters.push(eq(agentRuns.status, options.status));
  if (options.trigger !== undefined) filters.push(eq(agentRuns.trigger, options.trigger));

  // drizzle 0.45 的 ORDER BY 没有 nullsLast 构造器（只有索引列有），保留原始 sql。
  return db
    .select(runColumns)
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(...filters))
    .orderBy(sql`${agentRuns.startedAt} desc nulls last`, desc(agentRuns.id))
    .limit(options.limit ?? 50);
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

/** 个人数据固定本人：platform 范围也不放宽，专家创建人不参与过滤。 */
function personalRunWhere(businessId: string, since: Date, until: Date): SQL[] {
  return [
    eq(agentRuns.subjectKind, 'user'),
    eq(agentRuns.initiatedBy, businessId),
    gte(agentRuns.createdAt, since),
    lte(agentRuns.createdAt, until),
  ];
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

  if (options.cursor !== undefined) {
    const [anchor] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, options.cursor), ...filters))
      .limit(1);
    if (!anchor) return null;
    filters.push(sql`(${agentRuns.createdAt}, ${agentRuns.id}) < (
      select cursor.created_at, cursor.id from ${agentRuns} cursor
      where cursor.id = ${options.cursor}
    )`);
  }

  const rows = await db
    .select({
      ...runColumns,
      createdAt: agentRuns.createdAt,
      // 会话归属另行判定：运行属本人，不代表来源会话也属本人。
      conversationId: sql<string | null>`case
        when ${conversations.createdBy} = ${options.businessId} then ${agentRuns.conversationId}
        else null
      end`,
    })
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(conversations, eq(conversations.id, agentRuns.conversationId))
    .where(and(...filters))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(options.limit + 1);

  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

/** 个人使用汇总：窗口按 run.createdAt，tokens/cost 只统计已记录值。 */
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

/** 消息内容里的公开问题快照；写入时已经脱敏投影。 */
function questionOf(content: Record<string, unknown>): PublicRunQuestion | undefined {
  const question = content.question;
  return typeof question === 'object' && question !== null
    ? (question as PublicRunQuestion)
    : undefined;
}

/** messages 行 → trace 步骤。无法识别的行直接跳过，避免脏数据打断回放。 */
export function toStep(message: {
  role: string;
  content: unknown;
  createdAt: Date;
}): RunStep | null {
  const content = asRecord(message.content);
  const at = message.createdAt.toISOString();
  const text = messageText(message.content);

  if (message.role === 'user' && text !== null) {
    return { kind: 'user', at, text };
  }
  if (message.role === 'assistant' && content?.type === 'text' && text !== null) {
    return { kind: 'assistant', at, text };
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
      // result 消息没有 input；content 留空，由 mergeToolSteps 补回来。
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
  return row?.status === 'queued' || row?.status === 'running';
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

export async function isRunBoundToServer(
  db: Database,
  runId: string,
  serverId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ runId: agentRuns.id })
    .from(agentRuns)
    .innerJoin(agentServers, runMayUseServer())
    .where(and(eq(agentRuns.id, runId), eq(agentServers.serverId, serverId)))
    .limit(1);
  return row !== undefined;
}

/** 写入本次 run 的短期 MCP token hash 与过期时间（明文只进工作区文件）。 */
export async function setRunMcpToken(
  db: Database,
  runId: string,
  tokenHash: string,
  expiresAt: Date,
  modelTokenHash?: string | null,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      mcpTokenHash: tokenHash,
      mcpTokenExpiresAt: expiresAt,
      ...(modelTokenHash === undefined ? {} : { modelTokenHash }),
    })
    .where(eq(agentRuns.id, runId));
}

/** 模型代理 token 在 run 结束时单独清空：它与 MCP token 的生命周期无关。 */
export async function clearModelToken(db: Database, runId: string): Promise<void> {
  await db.update(agentRuns).set({ modelTokenHash: null }).where(eq(agentRuns.id, runId));
}

/** 模型代理校验：token 的 sha256 必须匹配，且 run 仍处于 running。 */
export async function findRunByModelToken(
  db: Database,
  tokenHash: string,
): Promise<{ runId: string } | null> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.modelTokenHash, tokenHash), eq(agentRuns.status, 'running')))
    .limit(1);
  return row ? { runId: row.id } : null;
}

/** 清空后该 run 的 token 立即失效；重复调用无副作用。 */
export async function clearRunMcpToken(db: Database, runId: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ mcpTokenHash: null, mcpTokenExpiresAt: null })
    .where(eq(agentRuns.id, runId));
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
    .innerJoin(agentServers, runMayUseServer())
    .where(and(eq(agentRuns.id, runId), eq(agentServers.serverId, serverId)))
    .limit(1);
  return row ?? null;
}

export interface ApprovalRequestRow {
  id: string;
  /** 沙盒内调用所属的 run；生成式 UI 的会话级审批不在这份列表里。 */
  runId: string;
  serverId: string;
  serverName: string | null;
  toolName: string;
  createdAt: Date;
  approvedAt: Date | null;
  expiresAt: Date | null;
}

export interface RequestedApproval {
  id: string;
  /** 频道触发的 run 才有值；私有对话为空，旧审批路径行为不变。 */
  channelId: string | null;
  runId: string;
  serverId: string;
  toolName: string;
  createdAt: Date;
  approvedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * 被拒绝的工具调用落一条 pending 记录；重复调用只延后到期，不覆盖已有批准。
 * 返回持久化后的行：频道 run 的调用方要拿 approvalId 发审批事件。
 */
export async function requestApproval(
  db: Database,
  input: { runId: string; serverId: string; toolName: string; expiresAt?: Date | null },
): Promise<RequestedApproval> {
  // 审批行归属频道：从 run 读取，调用方不必再传一次，也不会与 run 归属分叉。
  const [run] = await db
    .select({ channelId: agentRuns.channelId })
    .from(agentRuns)
    .where(eq(agentRuns.id, input.runId))
    .limit(1);
  const columns = {
    id: approvalRequests.id,
    channelId: approvalRequests.channelId,
    runId: approvalRequests.runId,
    serverId: approvalRequests.serverId,
    toolName: approvalRequests.toolName,
    createdAt: approvalRequests.createdAt,
    approvedAt: approvalRequests.approvedAt,
    expiresAt: approvalRequests.expiresAt,
  };
  const [inserted] = await db
    .insert(approvalRequests)
    .values({
      id: newId('approval'),
      ...input,
      channelId: run?.channelId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [approvalRequests.runId, approvalRequests.serverId, approvalRequests.toolName],
      set: { expiresAt: sql`greatest(${approvalRequests.expiresAt}, excluded.expires_at)` },
      setWhere: isNull(approvalRequests.approvedAt),
    })
    .returning(columns);
  if (inserted) return { ...inserted, runId: input.runId };

  // 已批准的行不参与 upsert，returning 为空：读回既有行给调用方，行为保持幂等。
  const [existing] = await db
    .select(columns)
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.runId, input.runId),
        eq(approvalRequests.serverId, input.serverId),
        eq(approvalRequests.toolName, input.toolName),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('approval request conflict without existing row');
  return { ...existing, runId: input.runId };
}

/** MCP handler 每次调用前读取：只认该 run 在该 server 上已批准的工具。 */
export async function getApprovedToolNames(
  db: Database,
  runId: string,
  serverId: string,
): Promise<string[]> {
  const rows = await db
    .select({ toolName: approvalRequests.toolName })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.runId, runId),
        eq(approvalRequests.serverId, serverId),
        isNotNull(approvalRequests.approvedAt),
      ),
    );
  return rows.map((row) => row.toolName);
}

export async function listApprovalRequests(
  db: Database,
  runId: string,
): Promise<ApprovalRequestRow[]> {
  // 查询按 run_id 精确匹配，生成式 UI 的会话级行（run_id 为空）不会命中。
  const rows = await db
    .select({
      id: approvalRequests.id,
      serverId: approvalRequests.serverId,
      serverName: servers.name,
      toolName: approvalRequests.toolName,
      createdAt: approvalRequests.createdAt,
      approvedAt: approvalRequests.approvedAt,
      expiresAt: approvalRequests.expiresAt,
    })
    .from(approvalRequests)
    .leftJoin(servers, eq(servers.id, approvalRequests.serverId))
    .where(eq(approvalRequests.runId, runId))
    .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id));
  return rows.map((row) => ({ ...row, runId }));
}

/**
 * 新 run 继承同一会话上一次 run 已批准的工具：批准原本绑定单次 run，
 * 用户重发消息会新建 run，不继承则批准立刻失效。跨会话不继承。
 * run id 是 uuidv7，按 id 倒序即按创建时间倒序；排除刚创建的本 run。
 */
export async function inheritApprovals(
  db: Database | Tx,
  input: { conversationId: string; runId: string },
): Promise<string[]> {
  const previous = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.conversationId, input.conversationId), ne(agentRuns.id, input.runId)))
    .orderBy(desc(agentRuns.id))
    .limit(1);

  const approved = await db
    .select({
      serverId: approvalRequests.serverId,
      toolName: approvalRequests.toolName,
      approvedAt: approvalRequests.approvedAt,
    })
    .from(approvalRequests)
    .where(and(inArray(approvalRequests.runId, previous), isNotNull(approvalRequests.approvedAt)));
  if (approved.length === 0) return [];

  await db
    .insert(approvalRequests)
    .values(
      approved.map((row) => ({
        id: newId('approval'),
        runId: input.runId,
        serverId: row.serverId,
        toolName: row.toolName,
        approvedAt: row.approvedAt,
      })),
    )
    .onConflictDoNothing();
  return approved.map((row) => row.toolName);
}

/**
 * 只批准已存在且 run 仍在 running 的请求；run 不存在返回 null（调用方按找不到请求处理）。
 * 锁 agent_runs 行再更新请求：与 cancelRun / worker 的 updateRun 串行，状态检查才不会被并发覆盖。
 * waiting 表示批准后调用方是否还应等这个被挂起的调用：已过期则不追加等待。
 */
export async function approveTool(
  db: Database,
  runId: string,
  serverId: string,
  toolName: string,
): Promise<{ serverId: string; toolName: string; approvedAt: Date; waiting: boolean } | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1)
      .for('update');
    if (!run) return null;
    if (run.status !== 'running') {
      fail('CONFLICT', '运行已结束或尚未开始，无法批准；请刷新运行状态');
    }

    const [row] = await tx
      .update(approvalRequests)
      .set({ approvedAt: sql`coalesce(${approvalRequests.approvedAt}, now())` })
      .where(
        and(
          eq(approvalRequests.runId, runId),
          eq(approvalRequests.serverId, serverId),
          eq(approvalRequests.toolName, toolName),
        ),
      )
      .returning({
        serverId: approvalRequests.serverId,
        toolName: approvalRequests.toolName,
        approvedAt: approvalRequests.approvedAt,
        waiting: sql<boolean>`coalesce(${approvalRequests.expiresAt} > now(), false)`,
      });
    return row && row.approvedAt !== null ? { ...row, approvedAt: row.approvedAt } : null;
  });
}

export async function getRunDetail(db: Database, runId: string): Promise<RunDetail | null> {
  const [row] = await db
    .select({
      ...runColumns,
      conversationId: agentRuns.conversationId,
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
  // worker 一次写入四列；任一缺失时容器尚未创建，不拼出半套身份。
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
