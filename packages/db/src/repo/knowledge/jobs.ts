import type { KnowledgeJobPayload, KnowledgeSourceProbeResult } from '@agentport/shared';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import {
  knowledgeDocuments,
  knowledgeJobs,
  knowledgeSources,
  knowledgeSyncRuns,
} from '../../schema.js';
import { paginate } from '../keyset.js';
import {
  type KnowledgeJobRow,
  type KnowledgeSyncRunRow,
  type PageOptions,
  pageLimit,
} from './shared.js';

// ---------------------------------------------------------------------------
// 任务

export interface CreateJobInput {
  type: KnowledgeJobRow['type'];
  baseId: string | null;
  documentId: string | null;
  sourceId: string | null;
  payload: KnowledgeJobPayload;
  result?: KnowledgeSourceProbeResult | null;
}

export async function createJob(db: DbHandle, input: CreateJobInput): Promise<KnowledgeJobRow> {
  const [row] = await db
    .insert(knowledgeJobs)
    .values({ id: newId('knowledgeJob'), ...input })
    .returning();
  if (!row) throw new Error('knowledge job insert returned no row');
  return row;
}

export async function getJob(db: Database, id: string): Promise<KnowledgeJobRow | null> {
  const [row] = await db.select().from(knowledgeJobs).where(eq(knowledgeJobs.id, id)).limit(1);
  return row ?? null;
}

export interface ListJobsFilter extends PageOptions {
  baseId?: string;
  documentId?: string;
  status?: KnowledgeJobRow['status'];
}

/** 列表只需展示字段：payload 与来源 config 留给 getJob/worker，避免读出整块任务载荷。 */
const jobSummaryColumns = {
  id: knowledgeJobs.id,
  type: knowledgeJobs.type,
  status: knowledgeJobs.status,
  step: knowledgeJobs.step,
  progress: knowledgeJobs.progress,
  attempts: knowledgeJobs.attempts,
  error: knowledgeJobs.error,
  result: knowledgeJobs.result,
  documentId: knowledgeJobs.documentId,
  sourceId: knowledgeJobs.sourceId,
  createdAt: knowledgeJobs.createdAt,
  startedAt: knowledgeJobs.startedAt,
  endedAt: knowledgeJobs.endedAt,
};

export async function listJobs(db: Database, filter: ListJobsFilter = {}) {
  const limit = pageLimit(filter);
  const filters: SQL[] = [];
  if (filter.baseId) filters.push(eq(knowledgeJobs.baseId, filter.baseId));
  if (filter.documentId) filters.push(eq(knowledgeJobs.documentId, filter.documentId));
  if (filter.status) filters.push(eq(knowledgeJobs.status, filter.status));
  if (filter.cursor) {
    filters.push(sql`(${knowledgeJobs.createdAt}, ${knowledgeJobs.id}) < (
      select b.created_at, b.id from ${knowledgeJobs} b where b.id = ${filter.cursor}
    )`);
  }
  const rows = await db
    .select({
      ...jobSummaryColumns,
      documentTitle: knowledgeDocuments.title,
      sourceName: knowledgeSources.name,
    })
    .from(knowledgeJobs)
    .leftJoin(knowledgeDocuments, eq(knowledgeJobs.documentId, knowledgeDocuments.id))
    .leftJoin(knowledgeSources, eq(knowledgeJobs.sourceId, knowledgeSources.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(knowledgeJobs.createdAt), desc(knowledgeJobs.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

/** 同步任务的 payload 关联；缺失或与行上的 sourceId 不一致都是跨行数据错误。 */
function syncRefOf(job: KnowledgeJobRow): { syncRunId: string; sourceId: string } {
  const payload = job.payload;
  if (
    payload.type !== 'sync' ||
    typeof payload.syncRunId !== 'string' ||
    payload.syncRunId === ''
  ) {
    throw new Error(`knowledge sync job ${job.id} has no syncRunId`);
  }
  if (
    job.sourceId === null ||
    (payload.sourceId !== undefined && payload.sourceId !== job.sourceId)
  ) {
    throw new Error(`knowledge sync job ${job.id} has an invalid sourceId`);
  }
  return { syncRunId: payload.syncRunId, sourceId: job.sourceId };
}

/** 条件更新认领：BullMQ 重复投递时只有一个 worker 能把 queued 改成 running。 */
export async function claimJob(db: Database, id: string): Promise<KnowledgeJobRow | null> {
  return db.transaction(async (tx) => {
    const startedAt = new Date();
    const startedAtIso = startedAt.toISOString();
    const [row] = await tx
      .update(knowledgeJobs)
      .set({
        status: 'running',
        startedAt,
        attempts: sql`${knowledgeJobs.attempts} + 1`,
      })
      .where(and(eq(knowledgeJobs.id, id), eq(knowledgeJobs.status, 'queued')))
      .returning();
    if (!row) return null;
    if (row.type === 'sync') {
      const { syncRunId, sourceId } = syncRefOf(row);
      // 只有 queued run 需要进入 running；内部重试保持已写入的 startedAt 与检查点。
      const [run] = await tx
        .update(knowledgeSyncRuns)
        .set({
          status: 'running',
          startedAt: sql`coalesce(${knowledgeSyncRuns.startedAt}, ${startedAtIso})`,
        })
        .where(
          and(
            eq(knowledgeSyncRuns.id, syncRunId),
            eq(knowledgeSyncRuns.sourceId, sourceId),
            inArray(knowledgeSyncRuns.status, ['queued', 'running']),
          ),
        )
        .returning({ id: knowledgeSyncRuns.id });
      if (!run) throw new Error(`sync run ${syncRunId} is not active for job ${row.id}`);
    }
    return row;
  });
}

export interface SyncRunResult {
  cursorAfter: Record<string, unknown>;
  stats: KnowledgeSyncRunRow['stats'];
}

export interface FinishJobInput {
  /** 允许转换的唯一前态；排队取消与调度入队失败传 queued。 */
  fromStatus?: Extract<KnowledgeJobRow['status'], 'queued' | 'running'>;
  status: Extract<KnowledgeJobRow['status'], 'succeeded' | 'failed' | 'cancelled'>;
  error?: string | null;
  step?: string | null;
  progress?: number;
  /** 仅成功的 sync 任务必须携带；同一事务写入 run 与 source 游标。 */
  result?: SyncRunResult;
  /** source_probe 的可见结果，不修改 source 游标或同步状态。 */
  probeResult?: KnowledgeSourceProbeResult | null;
}

/**
 * 一个 job 的原子终态提交：job CAS、sync run 终态、source 摘要与成功游标一次提交。
 * 任何后续写入失败都回滚 job，让重投/对账仍能看到活动行。
 */
export async function finishJob(
  db: Database,
  id: string,
  input: FinishJobInput,
): Promise<KnowledgeJobRow | null> {
  const fromStatus = input.fromStatus ?? 'running';
  const syncResult = input.result;
  const probeResult = input.probeResult ?? null;
  return db.transaction(async (tx) => {
    const endedAt = new Date();
    const [row] = await tx
      .update(knowledgeJobs)
      .set({
        status: input.status,
        error: input.error ?? null,
        step: input.step ?? null,
        progress: input.progress ?? 100,
        result: probeResult,
        endedAt,
      })
      .where(and(eq(knowledgeJobs.id, id), eq(knowledgeJobs.status, fromStatus)))
      .returning();
    if (row?.type !== 'sync') return row ?? null;

    const { syncRunId, sourceId } = syncRefOf(row);
    if (input.status === 'succeeded' && !syncResult) {
      throw new Error(`sync job ${row.id} succeeded without cursorAfter`);
    }
    const [run] = await tx
      .update(knowledgeSyncRuns)
      .set({
        status: input.status,
        endedAt,
        error: input.error ?? null,
        ...(input.status === 'succeeded' && syncResult
          ? { cursorAfter: syncResult.cursorAfter, stats: syncResult.stats }
          : {}),
      })
      .where(
        and(
          eq(knowledgeSyncRuns.id, syncRunId),
          eq(knowledgeSyncRuns.sourceId, sourceId),
          inArray(knowledgeSyncRuns.status, ['queued', 'running']),
        ),
      )
      .returning({ id: knowledgeSyncRuns.id });
    if (!run) throw new Error(`sync run ${syncRunId} is not active for job ${row.id}`);

    await tx
      .update(knowledgeSources)
      .set({
        lastSyncAt: endedAt,
        lastSyncStatus: input.status,
        lastError: input.error ?? null,
        updatedAt: endedAt,
        ...(input.status === 'succeeded' && syncResult ? { cursor: syncResult.cursorAfter } : {}),
      })
      .where(eq(knowledgeSources.id, sourceId));
    return row;
  });
}
