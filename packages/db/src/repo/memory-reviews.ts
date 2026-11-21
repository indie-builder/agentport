import type {
  MemoryContentSnapshot,
  MemoryReviewDecision,
  MemoryReviewProposal,
  MemoryReviewSource,
  MemoryReviewTarget,
} from '@agentport/shared';
import { and, desc, eq, exists, or, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, agents, memoryReviews } from '../schema.js';
import { getAgentVersion } from './agent-versions.js';
import { getDepartmentIdForBusinessId } from './governance.js';
import { type CursorPage, keysetPage } from './pagination.js';

export type MemoryReviewRow = typeof memoryReviews.$inferSelect;

export interface InsertMemoryReviewInput {
  runId: string;
  businessId: string;
  modelAgentId: string;
  requestKey: string;
  requestHash: string;
  target: MemoryReviewTarget;
  sources: MemoryReviewSource[];
  instruction: string;
  before: MemoryContentSnapshot;
}

const runColumns = {
  status: agentRuns.status,
  error: agentRuns.error,
  costUsd: agentRuns.costUsd,
  runAgentId: agentRuns.agentId,
  conversationId: agentRuns.conversationId,
};

const reviewColumns = {
  runId: memoryReviews.runId,
  businessId: memoryReviews.businessId,
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
  db: DbHandle,
  input: InsertMemoryReviewInput,
): Promise<MemoryReviewRow> {
  const [row] = await db.insert(memoryReviews).values(input).returning();
  if (!row) throw new Error('memory review insert returned no row');
  return row;
}

export async function createWithRun(
  db: Database,
  input: Omit<InsertMemoryReviewInput, 'runId'> & { agentVersion: number | null },
): Promise<MemoryReviewRow> {
  const first = input.sources[0];
  if (!first) throw new Error('memory review needs at least one source');
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ model: agents.model })
      .from(agents)
      .where(eq(agents.id, input.modelAgentId))
      .limit(1);
    if (!agent) throw new Error('memory review model agent not found');
    const definition =
      input.agentVersion === null
        ? null
        : ((await getAgentVersion(tx, input.modelAgentId, input.agentVersion))?.definition ?? null);
    const runId = newId('run');
    await tx.insert(agentRuns).values({
      id: runId,
      conversationId: first.conversationId,
      agentId: input.modelAgentId,
      status: 'queued',
      trigger: 'review',
      subjectKind: 'user',
      initiatedBy: input.businessId,
      agentVersion: input.agentVersion,
      model: definition?.agent.model ?? agent.model,
      departmentId: await getDepartmentIdForBusinessId(tx, input.businessId),
    });
    return insert(tx, { ...input, runId });
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

export async function deleteByRunId(db: DbHandle, runId: string): Promise<void> {
  await db.delete(memoryReviews).where(eq(memoryReviews.runId, runId));
}

export async function findByRequest(
  db: Database,
  businessId: string,
  requestKey: string,
): Promise<MemoryReviewRow | null> {
  const [row] = await db
    .select()
    .from(memoryReviews)
    .where(and(eq(memoryReviews.businessId, businessId), eq(memoryReviews.requestKey, requestKey)))
    .limit(1);
  return row ?? null;
}

export async function findForUser(
  db: Database,
  businessId: string,
  runId: string,
): Promise<MemoryReviewDetail | null> {
  const [row] = await db
    .select({ ...reviewColumns, ...runColumns })
    .from(memoryReviews)
    .innerJoin(agentRuns, eq(agentRuns.id, memoryReviews.runId))
    .where(and(eq(memoryReviews.businessId, businessId), eq(memoryReviews.runId, runId)))
    .limit(1);
  return row ?? null;
}

export interface ListMemoryReviewsOptions {
  limit: number;
  cursor?: string;
  conversationId?: string;
  agentId?: string;
}

export async function listForUser(
  db: Database,
  businessId: string,
  options: ListMemoryReviewsOptions,
): Promise<CursorPage<MemoryReviewDetail> | null> {
  const run = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, memoryReviews.runId),
        options.conversationId === undefined
          ? undefined
          : eq(agentRuns.conversationId, options.conversationId),
        options.agentId === undefined
          ? undefined
          : or(
              eq(agentRuns.agentId, options.agentId),
              sql`${memoryReviews.target}->>'agentId' = ${options.agentId}`,
            ),
      ),
    );
  const page = await keysetPage(db, {
    table: memoryReviews,
    id: memoryReviews.runId,
    column: memoryReviews.createdAt,
    cursor: options.cursor,
    limit: options.limit,
    where: [
      eq(memoryReviews.businessId, businessId),
      options.conversationId === undefined && options.agentId === undefined
        ? undefined
        : exists(run),
    ],
    load: ({ where, limit }) =>
      db
        .select({ id: memoryReviews.runId, ...reviewColumns, ...runColumns })
        .from(memoryReviews)
        .innerJoin(agentRuns, eq(agentRuns.id, memoryReviews.runId))
        .where(where)
        .orderBy(desc(memoryReviews.createdAt), desc(memoryReviews.runId))
        .limit(limit),
  });
  if (page === null) return null;
  return { items: page.items.map(({ id: _, ...row }) => row), nextCursor: page.nextCursor };
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
