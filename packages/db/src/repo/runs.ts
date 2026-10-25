import { fail } from '@agentport/core';
import { and, asc, desc, eq, isNotNull, isNull, ne, type SQL, sql } from 'drizzle-orm';
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
    trigger?: 'chat' | 'mcp' | 'schedule' | 'event';
    limit?: number;
  } = {},
): Promise<RunListItem[]> {
  const filters: SQL[] = [];
  if (options.agentId !== undefined) filters.push(eq(agentRuns.agentId, options.agentId));
  if (options.status !== undefined) filters.push(eq(agentRuns.status, options.status));
  if (options.trigger !== undefined) filters.push(eq(agentRuns.trigger, options.trigger));

  // drizzle 0.45 的 ORDER BY 没有 nullsLast 构造器（只有索引列有），保留原始 sql。
  return db
    .select(runColumns)
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(sql`${agentRuns.startedAt} desc nulls last`, desc(agentRuns.id))
    .limit(options.limit ?? 50);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
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
    return {
      kind: 'tool',
      at,
      name: typeof content.name === 'string' ? content.name : null,
      toolUseId: typeof content.id === 'string' ? content.id : null,
      content: content.input,
      parentToolUseId: typeof content.parentToolUseId === 'string' ? content.parentToolUseId : null,
    };
  }
  if (message.role === 'tool' && content?.type === 'tool_result') {
    return {
      kind: 'tool',
      at,
      name: typeof content.name === 'string' ? content.name : null,
      toolUseId: typeof content.toolUseId === 'string' ? content.toolUseId : null,
      // result 消息没有 input；content 留空，由 mergeToolSteps 补回来。
      content: null,
      result: content.content,
      parentToolUseId: typeof content.parentToolUseId === 'string' ? content.parentToolUseId : null,
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

export async function getRunAgentId(db: Database, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.agentId ?? null;
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
  runId: string;
  serverId: string;
  serverName: string | null;
  toolName: string;
  createdAt: Date;
  approvedAt: Date | null;
  expiresAt: Date | null;
}

/** 被拒绝的工具调用落一条 pending 记录；重复调用只延后到期，不覆盖已有批准。 */
export async function requestApproval(
  db: Database,
  input: { runId: string; serverId: string; toolName: string; expiresAt?: Date | null },
): Promise<void> {
  await db
    .insert(approvalRequests)
    .values({ id: newId('approval'), ...input, expiresAt: input.expiresAt ?? null })
    .onConflictDoUpdate({
      target: [approvalRequests.runId, approvalRequests.serverId, approvalRequests.toolName],
      set: { expiresAt: sql`greatest(${approvalRequests.expiresAt}, excluded.expires_at)` },
      setWhere: isNull(approvalRequests.approvedAt),
    });
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
  return db
    .select({
      id: approvalRequests.id,
      runId: approvalRequests.runId,
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
  const [previous] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.conversationId, input.conversationId), ne(agentRuns.id, input.runId)))
    .orderBy(desc(agentRuns.id))
    .limit(1);
  if (!previous) return [];

  const approved = await db
    .select({
      serverId: approvalRequests.serverId,
      toolName: approvalRequests.toolName,
      approvedAt: approvalRequests.approvedAt,
    })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.runId, previous.id), isNotNull(approvalRequests.approvedAt)));
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
      conversationAgentId: conversations.agentId,
      conversationTitle: conversations.title,
    })
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(conversations, eq(conversations.id, agentRuns.conversationId))
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!row) return null;

  const { conversationAgentId, conversationTitle, ...run } = row;
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
    run,
    steps,
    conversation: {
      id: run.conversationId,
      agentId: conversationAgentId ?? run.agentId,
      title: conversationTitle ?? '',
    },
  };
}
