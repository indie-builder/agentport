import { AppError } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import {
  knowledgeFaqImportMetadataSchema,
  knowledgeJobPayloadSchema,
} from '@agentport/shared';
import { and, eq, sql } from 'drizzle-orm';
import { publishKnowledgeCancel } from '../../../queue/producer.js';
import { createJob, enqueueKnowledgeJob } from '../service.js';
import {
  type KnowledgeDeps,
  type PageQuery,
  pageOptions,
  notFound,
  enqueue,
} from './shared.js';

function toJob(
  row:
    | Awaited<ReturnType<typeof repo.knowledge.listJobs>>['items'][number]
    | NonNullable<Awaited<ReturnType<typeof repo.knowledge.getJob>>>,
) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    step: row.step,
    progress: row.progress,
    attempts: row.attempts,
    error: row.error,
    result: row.result,
    documentId: row.documentId,
    sourceId: row.sourceId,
    documentTitle: 'documentTitle' in row ? row.documentTitle : null,
    sourceName: 'sourceName' in row ? row.sourceName : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

// ---- jobs -----------------------------------------------------------------

export async function listJobs(
  deps: KnowledgeDeps,
  query: PageQuery & {
    baseId?: string | undefined;
    documentId?: string | undefined;
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | undefined;
  },
) {
  const { baseId, documentId, status, ...rest } = query;
  const page = await repo.knowledge.listJobs(deps.db, {
    ...pageOptions(rest),
    ...(baseId === undefined ? {} : { baseId }),
    ...(documentId === undefined ? {} : { documentId }),
    ...(status === undefined ? {} : { status }),
  });
  return { items: page.items.map(toJob), nextCursor: page.nextCursor };
}

export async function getJob(deps: KnowledgeDeps, jobId: string) {
  const row = await repo.knowledge.getJob(deps.db, jobId);
  if (!row) notFound('任务');
  return toJob(row);
}

export async function retryJob(deps: KnowledgeDeps, jobId: string) {
  const row = await repo.knowledge.getJob(deps.db, jobId);
  if (!row) notFound('任务');
  if (row.status !== 'failed' && row.status !== 'cancelled') {
    throw new AppError('CONFLICT', '只有失败或已取消的任务可以重试');
  }
  const payload = knowledgeJobPayloadSchema.parse(row.payload);
  if (payload.type === 'sync') {
    const created = await repo.knowledge.createSyncJob(deps.db, payload.sourceId);
    if (created.status === 'not_found') notFound('来源');
    if (created.status === 'not_active') throw new AppError('CONFLICT', '来源未启用，无法同步');
    if (created.status === 'in_progress') {
      throw new AppError('CONFLICT', '该来源已有同步任务在进行中');
    }
    await enqueueKnowledgeJob(created.job);
    return { jobId: created.job.id };
  }
  let faqDraftBinding: {
    versionId: string;
    jobKey: 'indexingJobId' | 'faqImportJobId';
  } | null = null;
  if (payload.type === 'ingest' && payload.publish === 'draft' && payload.versionId !== undefined) {
    const document = await repo.knowledge.getDocument(deps.db, payload.documentId);
    const version = document ? await repo.knowledge.getVersion(deps.db, payload.versionId) : null;
    if (
      document?.contentKind === 'faq' &&
      document.id === row.documentId &&
      document.baseId === row.baseId &&
      version?.documentId === document.id &&
      version.metadata.publication === 'draft'
    ) {
      if (version.metadata.faqImport === undefined) {
        faqDraftBinding = { versionId: version.id, jobKey: 'indexingJobId' };
      } else if (knowledgeFaqImportMetadataSchema.safeParse(version.metadata.faqImport).success) {
        faqDraftBinding = { versionId: version.id, jobKey: 'faqImportJobId' };
      }
    }
  }
  if (faqDraftBinding) {
    const { versionId, jobKey } = faqDraftBinding;
    const job = await deps.db.transaction(async (tx) => {
      const created = await createJob(tx, {
        baseId: row.baseId,
        documentId: row.documentId,
        sourceId: row.sourceId,
        payload,
      });
      const rebind =
        jobKey === 'indexingJobId'
          ? sql`jsonb_build_object('indexingJobId', ${created.id}::text)`
          : sql`jsonb_build_object('faqImportJobId', ${created.id}::text)`;
      const [bound] = await tx
        .update(schema.knowledgeDocumentVersions)
        .set({ metadata: sql`${schema.knowledgeDocumentVersions.metadata} || ${rebind}` })
        .where(
          and(
            eq(schema.knowledgeDocumentVersions.id, versionId),
            sql`${schema.knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
            jobKey === 'indexingJobId'
              ? sql`${schema.knowledgeDocumentVersions.metadata} -> 'faqImport' is null`
              : sql`${schema.knowledgeDocumentVersions.metadata} -> 'faqImport' is not null`,
          ),
        )
        .returning({ id: schema.knowledgeDocumentVersions.id });
      if (!bound) throw new AppError('CONFLICT', '目标 FAQ 草稿已变化，请刷新后重试');
      return created;
    });
    await enqueueKnowledgeJob(job);
    return { jobId: job.id };
  }
  const job = await enqueue(deps, payload, {
    baseId: row.baseId,
    documentId: row.documentId,
    sourceId: row.sourceId,
  });
  return { jobId: job.id };
}

export async function cancelJob(deps: KnowledgeDeps, jobId: string) {
  const row = await repo.knowledge.getJob(deps.db, jobId);
  if (!row) notFound('任务');
  if (row.status === 'queued') {
    const cancelled = await repo.knowledge.finishJob(deps.db, row.id, {
      fromStatus: 'queued',
      status: 'cancelled',
      error: 'cancelled',
    });
    if (cancelled) return toJob(cancelled);
    const claimed = await repo.knowledge.getJob(deps.db, row.id);
    if (claimed?.status !== 'running') {
      throw new AppError('CONFLICT', '任务已结束，无法取消');
    }
    await publishKnowledgeCancel(claimed.id);
    return toJob(claimed);
  }
  if (row.status !== 'running') throw new AppError('CONFLICT', '任务已结束，无法取消');
  await publishKnowledgeCancel(row.id);
  return toJob(row);
}
