import { AppError } from '@agentport/core';
import {
  type KnowledgeFaq,
  knowledgeBaseSettingsSchema,
  knowledgeJobPayloadSchema,
} from '@agentport/shared';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../../client.js';
import { newId } from '../../id.js';
import {
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeJobs,
  knowledgeSources,
  knowledgeWikiPages,
  knowledgeWikiVersions,
} from '../../schema.js';
import { keysetPage } from '../pagination.js';
import {
  type KnowledgeDocumentRow,
  type KnowledgeVersionRow,
  lockWikiSourceScope,
  markWikiStaleByDocumentsTx,
  type Page,
  type PageOptions,
  pageLimit,
  type SourceReadSnapshot,
  sourceScopeAllowsDocument,
  sourceSnapshotMatchesTx,
  usableSourceChunks,
} from './shared.js';

/** 草稿只能由同文档、同库、已成功的 draft ingest 任务发布，且任务输入必须就是该版本。 */
async function draftIndexJobAllowsVersionTx(
  tx: Transaction,
  document: Pick<KnowledgeDocumentRow, 'id' | 'baseId'>,
  version: Pick<
    KnowledgeVersionRow,
    'blobSha256' | 'originalFilename' | 'mimeType' | 'parentVersionId' | 'metadata'
  >,
): Promise<boolean> {
  const jobId = version.metadata.indexingJobId;
  if (typeof jobId !== 'string' || jobId.length === 0) return false;
  const [job] = await tx
    .select({
      type: knowledgeJobs.type,
      baseId: knowledgeJobs.baseId,
      documentId: knowledgeJobs.documentId,
      status: knowledgeJobs.status,
      payload: knowledgeJobs.payload,
    })
    .from(knowledgeJobs)
    .where(eq(knowledgeJobs.id, jobId))
    .limit(1);
  if (
    job?.type !== 'ingest' ||
    job.baseId !== document.baseId ||
    job.documentId !== document.id ||
    job.status !== 'succeeded'
  ) {
    return false;
  }
  const parsed = knowledgeJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success || parsed.data.type !== 'ingest') return false;
  const payload = parsed.data;
  if (payload.documentId !== document.id || payload.publish !== 'draft' || !payload.input) {
    return false;
  }
  return (
    payload.input.blobSha256 === version.blobSha256 &&
    payload.input.filename === version.originalFilename &&
    payload.input.mimeType === version.mimeType &&
    payload.input.expectedCurrentVersionId === (version.parentVersionId ?? null)
  );
}
export interface CreateVersionInput {
  id?: string;
  documentId: string;
  blobSha256: string;
  markdownSha256: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sourceRevision: string | null;
  origin?: KnowledgeVersionRow['origin'];
  parentVersionId?: string | null;
  metadata?: Record<string, unknown>;
  faq?: KnowledgeFaq | null;
  parseStatus: KnowledgeVersionRow['parseStatus'];
  pageMap: KnowledgeVersionRow['pageMap'];
  images: KnowledgeVersionRow['images'];
  embeddingProfileId: string;
}

/** 版本号在 INSERT 内用按文档过滤的 coalesce(max)+1 子查询算出，单次往返即可。
 * 同文档并发没有行锁兜底，仍可能撞唯一索引；冲突原样抛出，不自动重试。 */
export async function createVersion(
  db: DbHandle,
  input: CreateVersionInput,
): Promise<KnowledgeVersionRow> {
  const { id, ...rest } = input;
  const [row] = await db
    .insert(knowledgeDocumentVersions)
    .values({
      id: id ?? newId('knowledgeVersion'),
      version: sql`(select coalesce(max(${knowledgeDocumentVersions.version}), 0) + 1 from ${knowledgeDocumentVersions} where ${knowledgeDocumentVersions.documentId} = ${input.documentId})`,
      ...rest,
    })
    .returning();
  if (!row) throw new Error('knowledge version insert returned no row');
  return row;
}

export async function getVersion(db: Database, id: string): Promise<KnowledgeVersionRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeDocumentVersions)
    .where(eq(knowledgeDocumentVersions.id, id))
    .limit(1);
  return row ?? null;
}

export interface PublishGuard {
  jobId: string;
  baseId: string;
  embeddingProfileId: string;
  imageProcessingJson: string;
  expectedCurrentVersionId: string | null;
  asrProfileId?: string | null | undefined;
  sourceSnapshot?: SourceReadSnapshot | undefined;
  isAborted?: (() => boolean) | undefined;
}

/**
 * 版本切换：current_version_id 与 ready 状态同事务写入，旧版本继续保留可回滚。
 * 所有调用（带不带 guard）都核版本归属、人工停用与来源/范围授权；
 * 带 guard 时再核任务仍 running、库仍 active、profile 与配置未变、当前指针未变。
 * 返回 null 表示守卫拒绝（任务已收尾/abort、库停用、配置/指针变化或来源失权），不区分原因。
 */
export async function setCurrentVersion(
  db: DbHandle,
  documentId: string,
  versionId: string,
  guard?: PublishGuard,
  options?: { expectedCurrentVersionId: string | null },
): Promise<KnowledgeDocumentRow | null> {
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select({
        documentId: knowledgeDocumentVersions.documentId,
        embeddingProfileId: knowledgeDocumentVersions.embeddingProfileId,
        metadata: knowledgeDocumentVersions.metadata,
        blobSha256: knowledgeDocumentVersions.blobSha256,
        originalFilename: knowledgeDocumentVersions.originalFilename,
        mimeType: knowledgeDocumentVersions.mimeType,
        parentVersionId: knowledgeDocumentVersions.parentVersionId,
      })
      .from(knowledgeDocumentVersions)
      .where(eq(knowledgeDocumentVersions.id, versionId))
      .limit(1);
    if (version?.documentId !== documentId) return null;
    const [preview] = await tx
      .select({
        sourceConnectionId: knowledgeDocuments.sourceConnectionId,
        contentKind: knowledgeDocuments.contentKind,
        baseId: knowledgeDocuments.baseId,
        metadata: knowledgeDocuments.metadata,
      })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .limit(1);
    if (!preview) return null;
    if (preview.contentKind === 'wiki') {
      const { wikiPageId, wikiVersionId } = version.metadata;
      if (typeof wikiPageId !== 'string' || typeof wikiVersionId !== 'string') return null;
      if (preview.metadata.wikiPageId !== wikiPageId) return null;
      const [wikiVersion] = await tx
        .select()
        .from(knowledgeWikiVersions)
        .where(
          and(
            eq(knowledgeWikiVersions.id, wikiVersionId),
            eq(knowledgeWikiVersions.pageId, wikiPageId),
          ),
        )
        .limit(1);
      if (!wikiVersion) return null;
      await lockWikiSourceScope(tx, preview.baseId, wikiVersion.sourceChunkIds);
      const [page] = await tx
        .select()
        .from(knowledgeWikiPages)
        .where(eq(knowledgeWikiPages.id, wikiPageId))
        .for('update');
      if (
        !page ||
        page.baseId !== preview.baseId ||
        page.status !== 'published' ||
        page.currentVersionId !== wikiVersionId
      )
        return null;
      if ((await usableSourceChunks(tx, page, wikiVersion.sourceChunkIds)).unusable > 0)
        return null;
    }
    if (preview.sourceConnectionId) {
      await tx
        .select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, preview.sourceConnectionId))
        .for('share');
    }
    if (guard?.sourceSnapshot) {
      if (preview.sourceConnectionId !== guard.sourceSnapshot.sourceId) return null;
      if (!(await sourceSnapshotMatchesTx(tx, guard.sourceSnapshot))) return null;
    } else if (guard && preview.sourceConnectionId) {
      return null;
    }
    const [document] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .for('update');
    if (!document) return null;
    if (document.status === 'disabled' || document.disabledReason !== null) return null;
    if (
      guard?.sourceSnapshot &&
      (document.baseId !== guard.sourceSnapshot.baseId ||
        document.sourceConnectionId !== guard.sourceSnapshot.sourceId)
    ) {
      return null;
    }
    if (guard) {
      if (guard.isAborted?.()) return null;
      if (document.currentVersionId !== guard.expectedCurrentVersionId) return null;
    }
    if (options !== undefined && document.currentVersionId !== options.expectedCurrentVersionId) {
      return null;
    }
    if (
      version.metadata?.faqImport !== undefined &&
      version.metadata?.publication !== 'published'
    ) {
      return null;
    }
    if (
      version.metadata?.publication === 'draft' &&
      !(await draftIndexJobAllowsVersionTx(tx, document, version))
    ) {
      return null;
    }
    if (!(await sourceScopeAllowsDocument(tx, document))) return null;
    const [base] = await tx
      .select({
        status: knowledgeBases.status,
        embeddingProfileId: knowledgeBases.embeddingProfileId,
        asrProfileId: knowledgeBases.asrProfileId,
        settings: knowledgeBases.settings,
      })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, document.baseId))
      .limit(1);
    if (!base || base.embeddingProfileId !== version.embeddingProfileId) return null;
    if (guard?.asrProfileId !== undefined && (base.asrProfileId ?? null) !== guard.asrProfileId) {
      return null;
    }
    if (guard) {
      if (document.baseId !== guard.baseId) return null;
      const [job] = await tx
        .select({ status: knowledgeJobs.status })
        .from(knowledgeJobs)
        .where(eq(knowledgeJobs.id, guard.jobId))
        .limit(1);
      if (job?.status !== 'running') return null;
      if (base.status !== 'active' || base.embeddingProfileId !== guard.embeddingProfileId) {
        return null;
      }
      if (
        JSON.stringify(knowledgeBaseSettingsSchema.parse(base.settings).imageProcessing) !==
        guard.imageProcessingJson
      ) {
        return null;
      }
      if (guard.isAborted?.()) return null;
    }
    await tx
      .update(knowledgeDocumentVersions)
      .set({
        metadata: sql`${knowledgeDocumentVersions.metadata} || '{"publication":"published"}'::jsonb`,
      })
      .where(
        and(
          eq(knowledgeDocumentVersions.id, versionId),
          sql`${knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
        ),
      );
    const [row] = await tx
      .update(knowledgeDocuments)
      .set({
        currentVersionId: versionId,
        contentHash: version.blobSha256,
        status: 'ready',
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, documentId))
      .returning();
    return row ?? null;
  });
}

/** 管理端显式回退：只切当前指针，不改变停用状态；版本必须属于本文档。 */
export async function activateDocumentVersion(
  db: Database,
  input: { documentId: string; versionId: string; expectedVersionId: string | null },
): Promise<KnowledgeDocumentRow> {
  return db.transaction(async (tx) => {
    const [preview] = await tx
      .select({ sourceConnectionId: knowledgeDocuments.sourceConnectionId })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, input.documentId))
      .limit(1);
    if (!preview) throw new AppError('NOT_FOUND', '文档不存在，可能已被删除');
    if (preview.sourceConnectionId) {
      await tx
        .select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, preview.sourceConnectionId))
        .for('share');
    }
    const [document] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, input.documentId))
      .for('update');
    if (!document) throw new AppError('NOT_FOUND', '文档不存在，可能已被删除');
    if (document.currentVersionId !== input.expectedVersionId) {
      throw new AppError('CONFLICT_STALE', '文档版本已变化，请刷新后重试');
    }
    const [version] = await tx
      .select({
        documentId: knowledgeDocumentVersions.documentId,
        embeddingProfileId: knowledgeDocumentVersions.embeddingProfileId,
        metadata: knowledgeDocumentVersions.metadata,
        blobSha256: knowledgeDocumentVersions.blobSha256,
        originalFilename: knowledgeDocumentVersions.originalFilename,
        mimeType: knowledgeDocumentVersions.mimeType,
        parentVersionId: knowledgeDocumentVersions.parentVersionId,
      })
      .from(knowledgeDocumentVersions)
      .where(eq(knowledgeDocumentVersions.id, input.versionId))
      .limit(1);
    if (version?.documentId !== input.documentId) {
      throw new AppError('NOT_FOUND', '版本文档不属于该文档');
    }
    if (version.metadata.faqImport !== undefined && version.metadata.publication !== 'published') {
      throw new AppError('CONFLICT', '该 FAQ 草稿尚未正式批发布，不能逐条上线');
    }
    if (
      version.metadata.publication === 'draft' &&
      version.metadata.faqImport === undefined &&
      !(await draftIndexJobAllowsVersionTx(tx, document, version))
    ) {
      throw new AppError('CONFLICT', '草稿缺少本版本已成功的索引任务，不能发布');
    }
    const [base] = await tx
      .select({ embeddingProfileId: knowledgeBases.embeddingProfileId })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, document.baseId))
      .limit(1);
    if (!base || base.embeddingProfileId !== version.embeddingProfileId) {
      throw new AppError('CONFLICT', '版本来自不同的 embedding 模型空间，请重建后再回退');
    }
    if (!(await sourceScopeAllowsDocument(tx, document))) {
      throw new AppError('CONFLICT', '来源权限已失效，不能切换到该版本');
    }
    await tx
      .update(knowledgeDocumentVersions)
      .set({
        metadata: sql`${knowledgeDocumentVersions.metadata} || '{"publication":"published"}'::jsonb`,
      })
      .where(
        and(
          eq(knowledgeDocumentVersions.id, input.versionId),
          sql`${knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
        ),
      );
    const [row] = await tx
      .update(knowledgeDocuments)
      .set({
        currentVersionId: input.versionId,
        contentHash: version.blobSha256,
        ...(document.status === 'disabled' ? {} : { status: 'ready' }),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, input.documentId))
      .returning();
    if (!row) throw new Error('knowledge document update returned no row');
    if (document.currentVersionId !== input.versionId) {
      await markWikiStaleByDocumentsTx(tx, [input.documentId]);
    }
    return row;
  });
}

export async function listVersions(
  db: Database,
  documentId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeVersionRow> | null> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeDocumentVersions.documentId, documentId)];
  return keysetPage(db, {
    table: knowledgeDocumentVersions,
    cursor: options.cursor,
    limit,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select()
        .from(knowledgeDocumentVersions)
        .where(where)
        .orderBy(desc(knowledgeDocumentVersions.createdAt), desc(knowledgeDocumentVersions.id))
        .limit(limit),
  });
}

export async function listDocumentVersions(
  db: Database,
  documentId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeVersionRow & { isCurrent: boolean }> | null> {
  const [document, page] = await Promise.all([
    db
      .select({ currentVersionId: knowledgeDocuments.currentVersionId })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .limit(1),
    listVersions(db, documentId, options),
  ]);
  if (page === null) return null;
  const currentVersionId = document[0]?.currentVersionId ?? null;
  return {
    items: page.items.map((row) => ({ ...row, isCurrent: row.id === currentVersionId })),
    nextCursor: page.nextCursor,
  };
}
