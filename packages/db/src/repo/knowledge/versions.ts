import {
  AppError,
  DOCUMENT_VERSION_STALE_MESSAGE,
  KNOWLEDGE_DOCUMENT_NOT_FOUND_MESSAGE,
} from '@agentport/core';
import {
  type KnowledgeFaq,
  knowledgeBaseSettingsSchema,
  knowledgeJobPayloadSchema,
} from '@agentport/shared';
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
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

export async function latestUnpublishedDraft(
  db: DbHandle,
  document: { id: string; currentVersionId: string | null },
): Promise<{ id: string; version: number } | undefined> {
  const [row] = await db
    .select({ id: knowledgeDocumentVersions.id, version: knowledgeDocumentVersions.version })
    .from(knowledgeDocumentVersions)
    .where(
      and(
        eq(knowledgeDocumentVersions.documentId, document.id),
        sql`${knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
        document.currentVersionId === null
          ? undefined
          : sql`${knowledgeDocumentVersions.id} <> ${document.currentVersionId}`,
      ),
    )
    .orderBy(desc(knowledgeDocumentVersions.version))
    .limit(1);
  return row;
}

export async function hasUnpublishedDraft(
  db: DbHandle,
  document: {
    id: string;
    sourceType: string;
    contentKind: string;
    currentVersionId: string | null;
  },
): Promise<boolean> {
  return (await latestUnpublishedDraft(db, document)) !== undefined;
}

export async function supersedeDraftVersionsTx(
  tx: Transaction,
  documentId: string,
  keepVersionId: string,
): Promise<void> {
  await tx
    .update(knowledgeDocumentVersions)
    .set({
      metadata: sql`${knowledgeDocumentVersions.metadata} || '{"publication":"superseded"}'::jsonb`,
    })
    .where(
      and(
        eq(knowledgeDocumentVersions.documentId, documentId),
        sql`${knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
        sql`${knowledgeDocumentVersions.id} <> ${keepVersionId}`,
      ),
    );
}

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

export async function getVersionsByIds(
  db: Database,
  ids: string[],
): Promise<Map<string, KnowledgeVersionRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(knowledgeDocumentVersions)
    .where(inArray(knowledgeDocumentVersions.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
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

export async function setCurrentVersion(
  db: DbHandle,
  documentId: string,
  versionId: string,
  guard?: PublishGuard,
  options?: { expectedCurrentVersionId: string | null; forbidUnpublishedDraft?: boolean },
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
    if (version.metadata?.publication === 'superseded') return null;
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
    const [lockedVersion] = await tx
      .select({
        version: knowledgeDocumentVersions.version,
        metadata: knowledgeDocumentVersions.metadata,
      })
      .from(knowledgeDocumentVersions)
      .where(eq(knowledgeDocumentVersions.id, versionId))
      .limit(1);
    if (!lockedVersion) return null;
    if (lockedVersion.metadata.publication === 'superseded') return null;
    if (lockedVersion.metadata.publication === 'draft') {
      const latestDraft = await latestUnpublishedDraft(tx, document);
      if (latestDraft && lockedVersion.version < latestDraft.version) return null;
    }
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
    if (options?.forbidUnpublishedDraft && (await hasUnpublishedDraft(tx, document))) {
      return null;
    }
    if (
      lockedVersion.metadata.faqImport !== undefined &&
      lockedVersion.metadata.publication !== 'published'
    ) {
      return null;
    }
    if (
      lockedVersion.metadata.publication === 'draft' &&
      !(await draftIndexJobAllowsVersionTx(tx, document, {
        ...version,
        metadata: lockedVersion.metadata,
      }))
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
    if (lockedVersion.metadata.publication === 'draft') {
      await supersedeDraftVersionsTx(tx, documentId, versionId);
    }
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
    if (!preview) throw new AppError('NOT_FOUND', KNOWLEDGE_DOCUMENT_NOT_FOUND_MESSAGE);
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
    if (!document) throw new AppError('NOT_FOUND', KNOWLEDGE_DOCUMENT_NOT_FOUND_MESSAGE);
    if (document.currentVersionId !== input.expectedVersionId) {
      throw new AppError('CONFLICT_STALE', DOCUMENT_VERSION_STALE_MESSAGE);
    }
    const [version] = await tx
      .select({
        documentId: knowledgeDocumentVersions.documentId,
        version: knowledgeDocumentVersions.version,
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
    if (version.metadata.publication === 'superseded') {
      throw new AppError('CONFLICT', '该版本已被新草稿取代');
    }
    if (version.metadata.publication === 'draft') {
      const latestDraft = await latestUnpublishedDraft(tx, document);
      if (latestDraft && version.version < latestDraft.version) {
        throw new AppError('CONFLICT_STALE', '存在更新的草稿，请先发布或放弃后再切换');
      }
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
    if (version.metadata.publication === 'draft') {
      await supersedeDraftVersionsTx(tx, input.documentId, input.versionId);
    }
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
