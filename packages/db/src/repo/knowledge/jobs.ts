import type {
  KnowledgeJobPayload,
  KnowledgeSourceProbeResult,
  ResourceAccessFilter,
} from '@agentport/shared';
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeJobs,
  knowledgeSources,
  knowledgeSyncRuns,
} from '../../schema.js';
import { resourceScopeWhere } from '../access.js';
import { keysetPage } from '../pagination.js';
import {
  type KnowledgeJobRow,
  type KnowledgeSyncRunRow,
  type PageOptions,
  pageLimit,
} from './shared.js';

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

async function findActiveDocumentJobId(
  db: DbHandle,
  documentId: string,
  types: KnowledgeJobRow['type'][],
): Promise<string | null> {
  const [row] = await db
    .select({ id: knowledgeJobs.id })
    .from(knowledgeJobs)
    .where(
      and(
        eq(knowledgeJobs.documentId, documentId),
        inArray(knowledgeJobs.type, types),
        inArray(knowledgeJobs.status, ['queued', 'running']),
      ),
    )
    .orderBy(desc(knowledgeJobs.createdAt), desc(knowledgeJobs.id))
    .limit(1);
  return row?.id ?? null;
}

export async function findActiveIngestJobId(
  db: DbHandle,
  documentId: string,
): Promise<string | null> {
  return findActiveDocumentJobId(db, documentId, ['ingest']);
}

export async function findActiveReprocessJobId(
  db: DbHandle,
  documentId: string,
): Promise<string | null> {
  return findActiveDocumentJobId(db, documentId, ['ingest', 'reindex']);
}

export interface ListJobsFilter extends PageOptions {
  baseId?: string;
  documentId?: string;
  status?: KnowledgeJobRow['status'];
  ids?: string[];
  access?: ResourceAccessFilter;
}

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
  if (filter.ids !== undefined && filter.ids.length > 0) {
    filters.push(inArray(knowledgeJobs.id, filter.ids));
  }
  if (filter.access) {
    const scope = resourceScopeWhere(
      filter.access,
      knowledgeBases.id,
      knowledgeBases.ownerBusinessId,
    );
    if (scope) {
      filters.push(
        inArray(
          knowledgeJobs.baseId,
          db.select({ id: knowledgeBases.id }).from(knowledgeBases).where(scope),
        ),
      );
    }
  }
  return keysetPage(db, {
    table: knowledgeJobs,
    cursor: filter.cursor,
    limit,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select({
          ...jobSummaryColumns,
          documentTitle: knowledgeDocuments.title,
          sourceName: knowledgeSources.name,
        })
        .from(knowledgeJobs)
        .leftJoin(knowledgeDocuments, eq(knowledgeJobs.documentId, knowledgeDocuments.id))
        .leftJoin(knowledgeSources, eq(knowledgeJobs.sourceId, knowledgeSources.id))
        .where(where)
        .orderBy(desc(knowledgeJobs.createdAt), desc(knowledgeJobs.id))
        .limit(limit),
  });
}

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

export async function requeueKnowledgeJob(
  db: Database,
  id: string,
  input: { error?: string; keepStartedAt?: boolean } = {},
): Promise<boolean> {
  const rows = await db
    .update(knowledgeJobs)
    .set({
      status: 'queued',
      ...(input.keepStartedAt === true ? {} : { startedAt: null }),
      step: null,
      ...(input.error === undefined ? {} : { error: input.error }),
    })
    .where(and(eq(knowledgeJobs.id, id), eq(knowledgeJobs.status, 'running')))
    .returning({ id: knowledgeJobs.id });
  return rows.length > 0;
}

export interface SyncRunResult {
  cursorAfter: Record<string, unknown>;
  stats: KnowledgeSyncRunRow['stats'];
}

export interface FinishJobInput {
  fromStatus?: Extract<KnowledgeJobRow['status'], 'queued' | 'running'>;
  status: Extract<KnowledgeJobRow['status'], 'succeeded' | 'failed' | 'cancelled'>;
  error?: string | null;
  step?: string | null;
  progress?: number;
  result?: SyncRunResult;
  probeResult?: KnowledgeSourceProbeResult | null;
}

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
