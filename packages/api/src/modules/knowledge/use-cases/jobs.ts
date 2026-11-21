import { AppError } from '@agentport/core';
import { repo, schema, type Transaction } from '@agentport/db';
import {
  type KnowledgeJob,
  knowledgeFaqImportMetadataSchema,
  knowledgeJobPayloadSchema,
  type ResourceAccessFilter,
} from '@agentport/shared';
import { and, eq, sql } from 'drizzle-orm';
import { requireCursorPage } from '../../../http/pagination.js';
import { publishKnowledgeCancel } from '../../../queue/producer.js';
import { createJob, enqueueKnowledgeJobAfterCommit } from '../service.js';
import { enqueue, type KnowledgeDeps, notFound, type PageQuery, pageOptions } from './shared.js';

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

async function assertDocumentIdle(tx: Transaction, baseId: string | null, documentId: string) {
  if (baseId !== null) {
    const [base] = await tx
      .select({ id: schema.knowledgeBases.id })
      .from(schema.knowledgeBases)
      .where(eq(schema.knowledgeBases.id, baseId))
      .limit(1)
      .for('key share');
    if (!base) notFound('文档');
  }
  const [document] = await tx
    .select({ id: schema.knowledgeDocuments.id })
    .from(schema.knowledgeDocuments)
    .where(eq(schema.knowledgeDocuments.id, documentId))
    .limit(1)
    .for('update');
  if (!document) notFound('文档');
  if ((await repo.knowledge.findActiveReprocessJobId(tx, documentId)) !== null) {
    throw new AppError('CONFLICT', '文档有正在进行的处理任务，请稍后重试');
  }
}

export function getJob(row: JobRow) {
  return toJob(row);
}

export async function retryJob(deps: KnowledgeDeps, row: JobRow) {
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
    await enqueueKnowledgeJobAfterCommit(deps.log, created.job);
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
    const documentId = row.documentId;
    if (documentId === null) notFound('文档');
    const job = await deps.db.transaction(async (tx) => {
      await assertDocumentIdle(tx, row.baseId, documentId);
      const created = await createJob(tx, {
        baseId: row.baseId,
        documentId,
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
    await enqueueKnowledgeJobAfterCommit(deps.log, job);
    return { jobId: job.id };
  }
  if ((payload.type === 'ingest' || payload.type === 'reindex') && row.documentId !== null) {
    const documentId = row.documentId;
    const job = await deps.db.transaction(async (tx) => {
      await assertDocumentIdle(tx, row.baseId, documentId);
      return createJob(tx, {
        baseId: row.baseId,
        documentId,
        sourceId: row.sourceId,
        payload,
      });
    });
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
          '摘要生成已取消',
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
