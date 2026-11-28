import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import {
  type KnowledgeJob,
  knowledgeFaqImportMetadataSchema,
  knowledgeJobPayloadSchema,
  type ResourceAccessFilter,
  SUMMARY_CANCELLED_MESSAGE,
} from '@agentport/shared';
import { type PageQuery, pageOptions, requireCursorPage } from '../../../http/pagination.js';
import { publishKnowledgeCancel } from '../../../queue/producer.js';
import { enqueueKnowledgeJobAfterCommit } from '../service.js';
import { enqueue, enqueueSourceSync, type KnowledgeDeps, notFound } from './shared.js';

function toJob(
  row:
    | NonNullable<Awaited<ReturnType<typeof repo.knowledge.listJobs>>>['items'][number]
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

export async function listJobs(
  deps: KnowledgeDeps,
  query: PageQuery & {
    baseId?: string | undefined;
    documentId?: string | undefined;
    status?: KnowledgeJob['status'] | undefined;
    ids?: string[] | undefined;
  },
  access?: ResourceAccessFilter,
) {
  const { baseId, documentId, status, ids, ...rest } = query;
  const page = requireCursorPage(
    await repo.knowledge.listJobs(deps.db, {
      ...pageOptions(rest),
      ...(baseId === undefined ? {} : { baseId }),
      ...(documentId === undefined ? {} : { documentId }),
      ...(status === undefined ? {} : { status }),
      ...(ids === undefined ? {} : { ids }),
      ...(access === undefined ? {} : { access }),
    }),
  );
  return { items: page.items.map(toJob), nextCursor: page.nextCursor };
}

type JobRow = NonNullable<Awaited<ReturnType<typeof repo.knowledge.getJob>>>;

export function getJob(row: JobRow) {
  return toJob(row);
}

export async function retryJob(deps: KnowledgeDeps, row: JobRow) {
  if (row.status !== 'failed' && row.status !== 'cancelled') {
    throw new AppError('CONFLICT', '只有失败或已取消的任务可以重试');
  }
  const payload = knowledgeJobPayloadSchema.parse(row.payload);
  if (payload.type === 'sync') {
    const created = await enqueueSourceSync(deps, payload.sourceId);
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
    const documentId = row.documentId;
    if (documentId === null) notFound('文档');
    const job = await repo.knowledge.createDocumentRetryJob(deps.db, {
      baseId: row.baseId,
      documentId,
      sourceId: row.sourceId,
      payload,
      faqDraftBinding,
    });
    if (!job) notFound('文档');
    await enqueueKnowledgeJobAfterCommit(deps.log, job);
    return { jobId: job.id };
  }
  if ((payload.type === 'ingest' || payload.type === 'reindex') && row.documentId !== null) {
    const job = await repo.knowledge.createDocumentRetryJob(deps.db, {
      baseId: row.baseId,
      documentId: row.documentId,
      sourceId: row.sourceId,
      payload,
    });
    if (!job) notFound('文档');
    await enqueueKnowledgeJobAfterCommit(deps.log, job);
    return { jobId: job.id };
  }
  const job = await enqueue(deps, payload, {
    baseId: row.baseId,
    documentId: row.documentId,
    sourceId: row.sourceId,
  });
  return { jobId: job.id };
}

export async function cancelJob(deps: KnowledgeDeps, row: JobRow) {
  if (row.status === 'queued') {
    const cancelled = await repo.knowledge.finishJob(deps.db, row.id, {
      fromStatus: 'queued',
      status: 'cancelled',
      error: 'cancelled',
    });
    if (cancelled) {
      if (cancelled.type === 'summary' && cancelled.documentId !== null) {
        const payload = knowledgeJobPayloadSchema.safeParse(cancelled.payload);
        await repo.knowledge.failDocumentSummary(
          deps.db,
          cancelled.documentId,
          SUMMARY_CANCELLED_MESSAGE,
          payload.success && payload.data.type === 'summary' ? payload.data.versionId : undefined,
        );
      }
      return toJob(cancelled);
    }
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
