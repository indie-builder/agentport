import type {
  MemoryContentSnapshot,
  MemoryReviewDecision,
  MemoryReviewProposal,
  MemoryReviewSource,
  MemoryReviewTarget,
} from '@agentport/shared';
import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, memoryReviews } from '../schema.js';

export type MemoryReviewRow = typeof memoryReviews.$inferSelect;

export interface InsertMemoryReviewInput {
  runId: string;
  userId: string;
  modelAgentId: string;
  requestKey: string;
  requestHash: string;
  target: MemoryReviewTarget;
  sources: MemoryReviewSource[];
  instruction: string;
  before: MemoryContentSnapshot;
}

/** 审核详情需要的运行字段；审核运行不写消息、不挂沙盒。 */
const runColumns = {
  status: agentRuns.status,
  error: agentRuns.error,
  costUsd: agentRuns.costUsd,
  runAgentId: agentRuns.agentId,
  conversationId: agentRuns.conversationId,
};

const reviewColumns = {
  runId: memoryReviews.runId,
  userId: memoryReviews.userId,
  modelAgentId: memoryReviews.modelAgentId,
  requestKey: memoryReviews.requestKey,
  requestHash: memoryReviews.requestHash,
  target: memoryReviews.target,
  sources: memoryReviews.sources,
  instruction: memoryReviews.instruction,
  before: memoryReviews.before,
  proposal: memoryReviews.proposal,
  decision: memoryReviews.decision,
  appliedChangeId: memoryReviews.appliedChangeId,
  createdAt: memoryReviews.createdAt,
};

export type MemoryReviewDetail = Pick<MemoryReviewRow, keyof typeof reviewColumns> & {
  status: (typeof agentRuns.$inferSelect)['status'];
  error: string | null;
  costUsd: string | null;
  runAgentId: string;
  conversationId: string;
};

export async function insert(
  db: Database,
  input: InsertMemoryReviewInput,
): Promise<MemoryReviewRow> {
  const [row] = await db.insert(memoryReviews).values(input).returning();
  if (!row) throw new Error('memory review insert returned no row');
  return row;
}

/** run 与审核行同事务落库；sources 至少一条，首条会话承载运行归属。 */
export async function createWithRun(
  db: Database,
  input: Omit<InsertMemoryReviewInput, 'runId'> & { agentVersion: number | null },
): Promise<MemoryReviewRow> {
  const first = input.sources[0];
  if (!first) throw new Error('memory review needs at least one source');
  return db.transaction(async (tx) => {
    const txdb = tx as unknown as Database;
    const runId = newId('run');
    await tx.insert(agentRuns).values({
      id: runId,
      conversationId: first.conversationId,
      agentId: input.modelAgentId,
      status: 'queued',
      trigger: 'review',
      agentVersion: input.agentVersion,
    });
    return insert(txdb, { ...input, runId });
  });
}

export async function find(db: Database, runId: string): Promise<MemoryReviewRow | null> {
  const [row] = await db
    .select()
    .from(memoryReviews)
    .where(eq(memoryReviews.runId, runId))
    .limit(1);
  return row ?? null;
}

export async function findByRequest(
  db: Database,
  userId: string,
  requestKey: string,
): Promise<MemoryReviewRow | null> {
  const [row] = await db
    .select()
    .from(memoryReviews)
    .where(and(eq(memoryReviews.userId, userId), eq(memoryReviews.requestKey, requestKey)))
    .limit(1);
  return row ?? null;
}

export async function findForUser(
  db: Database,
  userId: string,
  runId: string,
): Promise<MemoryReviewDetail | null> {
  const [row] = await db
    .select({ ...reviewColumns, ...runColumns })
    .from(memoryReviews)
    .innerJoin(agentRuns, eq(agentRuns.id, memoryReviews.runId))
    .where(and(eq(memoryReviews.userId, userId), eq(memoryReviews.runId, runId)))
    .limit(1);
  return row ?? null;
}

export interface ListMemoryReviewsOptions {
  limit: number;
  before?: Date;
  conversationId?: string;
  agentId?: string;
}

export async function listForUser(
  db: Database,
  userId: string,
  options: ListMemoryReviewsOptions,
): Promise<MemoryReviewDetail[]> {
  const filters: SQL[] = [eq(memoryReviews.userId, userId)];
  if (options.before) filters.push(lt(memoryReviews.createdAt, options.before));
  if (options.conversationId) filters.push(eq(agentRuns.conversationId, options.conversationId));
  if (options.agentId) {
    // 既覆盖「谁执行审核」，也覆盖「审核哪个专家的记忆」。
    const agentFilter = or(
      eq(agentRuns.agentId, options.agentId),
      sql`${memoryReviews.target}->>'agentId' = ${options.agentId}`,
    );
    if (agentFilter) filters.push(agentFilter);
  }
  return db
    .select({ ...reviewColumns, ...runColumns })
    .from(memoryReviews)
    .innerJoin(agentRuns, eq(agentRuns.id, memoryReviews.runId))
    .where(and(...filters))
    .orderBy(desc(memoryReviews.createdAt), desc(memoryReviews.runId))
    .limit(options.limit);
}

/** 只有 pending 才能迁移；并发请求抢到同一行时后者得到 null。 */
export async function updateDecisionIfPending(
  db: Database,
  runId: string,
  decision: Exclude<MemoryReviewDecision, 'pending'>,
  appliedChangeId?: string | null,
): Promise<MemoryReviewRow | null> {
  const [row] = await db
    .update(memoryReviews)
    .set({ decision, ...(appliedChangeId !== undefined ? { appliedChangeId } : {}) })
    .where(and(eq(memoryReviews.runId, runId), eq(memoryReviews.decision, 'pending')))
    .returning();
  return row ?? null;
}

export async function updateProposal(
  db: Database,
  runId: string,
  proposal: MemoryReviewProposal | null,
): Promise<MemoryReviewRow | null> {
  const [row] = await db
    .update(memoryReviews)
    .set({ proposal })
    .where(eq(memoryReviews.runId, runId))
    .returning();
  return row ?? null;
}
