import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { newId } from '../../id.js';
import {
  knowledgeJobs,
  knowledgeSources,
  knowledgeSyncItems,
  knowledgeSyncRuns,
} from '../../schema.js';
import { paginate } from '../keyset.js';
import {
  type KnowledgeJobRow,
  type KnowledgeSyncItemRow,
  type KnowledgeSyncRunRow,
  type Page,
  type PageOptions,
  pageLimit,
} from './shared.js';

export type CreateSyncJobResult =
  | { status: 'created'; job: KnowledgeJobRow; run: KnowledgeSyncRunRow }
  | { status: 'not_found' }
  | { status: 'not_active' }
  | { status: 'in_progress' };

/**
 * 手动、重试与定时触发共用的一次创建事务：来源级 advisory lock + 在途检查后，
 * queued sync run 与 queued job 全有或全无；Redis add 必须等本事务提交后再做。
 */
export async function createSyncJob(db: Database, sourceId: string): Promise<CreateSyncJobResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sourceId}))`);
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .limit(1);
    if (!source) return { status: 'not_found' } as const;
    if (source.status !== 'active') return { status: 'not_active' } as const;
    const [active] = await tx
      .select({ id: knowledgeJobs.id })
      .from(knowledgeJobs)
      .where(
        and(
          eq(knowledgeJobs.sourceId, sourceId),
          inArray(knowledgeJobs.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (active) return { status: 'in_progress' } as const;

    const runId = newId('knowledgeSyncRun');
    const jobId = newId('knowledgeJob');
    const [run] = await tx
      .insert(knowledgeSyncRuns)
      .values({
        id: runId,
        sourceId,
        status: 'queued',
        cursorBefore: source.cursor,
      })
      .returning();
    const [job] = await tx
      .insert(knowledgeJobs)
      .values({
        id: jobId,
        type: 'sync',
        baseId: source.baseId,
        documentId: null,
        sourceId,
        status: 'queued',
        payload: { type: 'sync', sourceId, syncRunId: runId },
      })
      .returning();
    if (!run || !job) throw new Error('knowledge sync pair insert returned no row');
    return { status: 'created', job, run } as const;
  });
}

export async function listSyncRuns(
  db: Database,
  sourceId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeSyncRunRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeSyncRuns.sourceId, sourceId)];
  if (options.cursor) {
    filters.push(sql`(${knowledgeSyncRuns.createdAt}, ${knowledgeSyncRuns.id}) < (
      select b.created_at, b.id from ${knowledgeSyncRuns} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeSyncRuns)
    .where(and(...filters))
    .orderBy(desc(knowledgeSyncRuns.createdAt), desc(knowledgeSyncRuns.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

export interface RecordSyncItemInput {
  syncRunId: string;
  sourceId: string;
  rangeId: string | null;
  externalId: string;
  documentId: string | null;
  status: KnowledgeSyncItemRow['status'];
  code: string;
  message: string;
  retryable: boolean;
}

export async function recordSyncItem(
  db: Database,
  input: RecordSyncItemInput,
): Promise<KnowledgeSyncItemRow> {
  const [row] = await db
    .insert(knowledgeSyncItems)
    .values({ id: newId('knowledgeSyncItem'), ...input })
    .returning();
  if (!row) throw new Error('knowledge sync item insert returned no row');
  return row;
}

export interface ListSyncItemsFilter extends PageOptions {
  status?: KnowledgeSyncItemRow['status'];
}

export async function listSyncItems(
  db: Database,
  syncRunId: string,
  filter: ListSyncItemsFilter = {},
): Promise<Page<KnowledgeSyncItemRow>> {
  const limit = pageLimit(filter);
  const filters: SQL[] = [eq(knowledgeSyncItems.syncRunId, syncRunId)];
  if (filter.status) filters.push(eq(knowledgeSyncItems.status, filter.status));
  if (filter.cursor) {
    filters.push(sql`(${knowledgeSyncItems.createdAt}, ${knowledgeSyncItems.id}) < (
      select b.created_at, b.id from ${knowledgeSyncItems} b where b.id = ${filter.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeSyncItems)
    .where(and(...filters))
    .orderBy(desc(knowledgeSyncItems.createdAt), desc(knowledgeSyncItems.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}
