import type { ExecutionSubject, RunTrigger } from '@agentport/shared';
import { ACTIVE_RUN_STATUSES } from '@agentport/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { agentRuns, conversations, messages } from '../../schema.js';

function runSubject(subject: ExecutionSubject) {
  return subject.kind === 'user'
    ? { subjectKind: 'user' as const, initiatedBy: subject.businessId, serviceId: null }
    : { subjectKind: 'service' as const, initiatedBy: null, serviceId: subject.serviceId };
}

export type AgentRun = typeof agentRuns.$inferSelect;
export type RunStatus = NonNullable<typeof agentRuns.$inferInsert.status>;

/** 只更新我关心的字段；worker 也可复用。 */
export interface RunPatch {
  status?: RunStatus;
  sessionId?: string | null;
  sandboxId?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  error?: string | null;
  costUsd?: string | null;
  turns?: number | null;
}

/**
 * 准入时从 DB 读出的续聊状态。worker 只拿 job 里的 id，用它决定
 * 本次是空会话、resume 还是先 fork 再 resume。
 */
export interface ConversationSdkState {
  sdkSessionId: string | null;
  /** 分支建立时记录的待分叉历史点；非空表示本轮必须先 fork。 */
  forkFromSdkMessageUuid: string | null;
}

/** 一组 run 的读数：会话历史里每条回复都按 run_id 回填同一行读数。 */
export interface RunMetricsRow {
  id: string;
  status: RunStatus;
  turns: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  error: string | null;
  endedAt: Date | null;
}

/** 历史消息只带 run_id，读数要按 id 批量取，不能逐条查。 */
export async function listRunMetrics(db: Database, runIds: string[]): Promise<RunMetricsRow[]> {
  if (runIds.length === 0) return [];
  return db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      turns: agentRuns.turns,
      latencyMs: agentRuns.latencyMs,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      costUsd: agentRuns.costUsd,
      error: agentRuns.error,
      endedAt: agentRuns.endedAt,
    })
    .from(agentRuns)
    .where(inArray(agentRuns.id, runIds));
}

/**
 * 续聊状态：worker 只拿到 job 里的 id，靠这里决定空会话 / resume / 先 fork。
 * 分支会话在首轮运行前 sdkSessionId 仍指向来源会话，fork 完成后由运行收尾改写。
 */
export async function getConversationSdkState(
  db: DbHandle,
  conversationId: string,
): Promise<ConversationSdkState | null> {
  const [row] = await db
    .select({
      sdkSessionId: conversations.sdkSessionId,
      forkFromSdkMessageUuid: conversations.forkFromSdkMessageUuid,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) return null;
  return row;
}

export async function createRun(
  db: DbHandle,
  input: {
    id: string;
    conversationId: string;
    agentId: string;
    trigger?: RunTrigger;
    agentVersion?: number | null;
    subject: ExecutionSubject;
    channelId?: string;
    channelTriggerMessageId?: string;
  },
): Promise<AgentRun> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      agentId: input.agentId,
      status: 'queued',
      ...runSubject(input.subject),
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      ...(input.agentVersion === undefined ? {} : { agentVersion: input.agentVersion }),
      ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
      ...(input.channelTriggerMessageId === undefined
        ? {}
        : { channelTriggerMessageId: input.channelTriggerMessageId }),
    })
    .returning();
  if (!row) throw new Error('agent run insert returned no row');
  return row;
}

/** 运行收尾：同一事务里更新会话的 SDK 状态并重映射消息 uuid（fork 会换 uuid）。 */
export async function saveSdkState(
  db: DbHandle,
  input: {
    conversationId: string;
    sdkSessionId: string;
    /** fork 前的旧 uuid → 新 uuid；非 fork 轮为空。 */
    uuidMap?: Array<{ from: string; to: string }>;
  },
): Promise<void> {
  await db
    .update(conversations)
    .set({ sdkSessionId: input.sdkSessionId, forkFromSdkMessageUuid: null })
    .where(eq(conversations.id, input.conversationId));
  if (input.uuidMap === undefined || input.uuidMap.length === 0) return;
  const map = sql.join(
    input.uuidMap.map(({ from, to }) => sql`(${from}::text, ${to}::text)`),
    sql`, `,
  );
  await db.execute(sql`
    update ${messages} m
    set sdk_message_uuid = v.to_uuid
    from (values ${map}) as v(from_uuid, to_uuid)
    where m.conversation_id = ${input.conversationId}
      and m.sdk_message_uuid = v.from_uuid
  `);
}

export async function getRun(db: Database, runId: string): Promise<AgentRun | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return row ?? null;
}

export async function updateRun(
  db: Database,
  runId: string,
  patch: RunPatch,
): Promise<AgentRun | null> {
  if (Object.keys(patch).length === 0) return getRun(db, runId);
  const [row] = await db.update(agentRuns).set(patch).where(eq(agentRuns.id, runId)).returning();
  return row ?? null;
}

/** 已结束的 run 不能被取消覆盖。 */
export async function cancelRun(db: Database, runId: string): Promise<AgentRun | null> {
  const [row] = await db
    .update(agentRuns)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])))
    .returning();
  return row ?? null;
}
