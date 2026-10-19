import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { agentRuns, agents, conversations, messages } from '../schema.js';

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
      content: unknown;
    };

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
  startedAt: agentRuns.startedAt,
  endedAt: agentRuns.endedAt,
  latencyMs: agentRuns.latencyMs,
  costUsd: agentRuns.costUsd,
  turns: agentRuns.turns,
  inputTokens: agentRuns.inputTokens,
  outputTokens: agentRuns.outputTokens,
  error: agentRuns.error,
};

/** 运行列表：join agents 取名字，按开始时间倒序（尚未开始的排在最后）。 */
export async function listRuns(
  db: Database,
  options: { agentId?: string; status?: RunStatus; limit?: number } = {},
): Promise<RunListItem[]> {
  const filters: SQL[] = [];
  if (options.agentId !== undefined) filters.push(eq(agentRuns.agentId, options.agentId));
  if (options.status !== undefined) filters.push(eq(agentRuns.status, options.status));

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

  if (message.role === 'user' && typeof content?.text === 'string') {
    return { kind: 'user', at, text: content.text };
  }
  if (
    message.role === 'assistant' &&
    content?.type === 'text' &&
    typeof content.text === 'string'
  ) {
    return { kind: 'assistant', at, text: content.text };
  }
  if (message.role === 'tool' && content?.type === 'tool_result') {
    return {
      kind: 'tool',
      at,
      name: typeof content.name === 'string' ? content.name : null,
      toolUseId: typeof content.toolUseId === 'string' ? content.toolUseId : null,
      content: content.content,
    };
  }
  return null;
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

  const steps = rows.map(toStep).filter((step): step is RunStep => step !== null);

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
