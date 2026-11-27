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

type VersionActivationResult =
  | { ok: true; document: KnowledgeDocumentRow | null }
  | { ok: false; code: 'NOT_FOUND' | 'CONFLICT_STALE' | 'CONFLICT'; message: string };

interface VersionActivationOptions {
  documentId: string;
  versionId: string;
  expectedCurrentVersionId?: string | null;
  forbidUnpublishedDraft?: boolean;
  guard?: PublishGuard;
  verifyWikiIndex: boolean;
  allowDisabledDocument: boolean;
  markWikiStale: boolean;
}

function rejectVersionActivation(
  code: 'NOT_FOUND' | 'CONFLICT_STALE' | 'CONFLICT',
  message: string,
): VersionActivationResult {
  return { ok: false, code, message };
}

async function verifyWikiIndexTx(
  tx: Transaction,
  documentId: string,
  versionId: string,
  preview: { baseId: string; metadata: Record<string, unknown> },
): Promise<VersionActivationResult | null> {
  const [wikiTarget] = await tx
    .select({
      documentId: knowledgeDocumentVersions.documentId,
      metadata: knowledgeDocumentVersions.metadata,
    })
    .from(knowledgeDocumentVersions)
    .where(eq(knowledgeDocumentVersions.id, versionId))
    .limit(1);
  if (wikiTarget?.documentId !== documentId) {
    return rejectVersionActivation('NOT_FOUND', '版本文档不属于该文档');
  }
  if (wikiTarget.metadata?.publication === 'superseded') {
    return rejectVersionActivation('CONFLICT', '该版本已被新草稿取代');
  }
  const { wikiPageId, wikiVersionId } = wikiTarget.metadata;
  if (typeof wikiPageId !== 'string' || typeof wikiVersionId !== 'string') {
    return rejectVersionActivation('CONFLICT', 'Wiki 索引版本缺少关联页面信息');
  }
  if (preview.metadata.wikiPageId !== wikiPageId) {
    return rejectVersionActivation('CONFLICT', 'Wiki 索引版本与文档所属页面不一致');
  }
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
  if (!wikiVersion) return rejectVersionActivation('NOT_FOUND', 'Wiki 版本不存在');
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
  ) {
    return rejectVersionActivation('CONFLICT', 'Wiki 页面当前已发布版本已变化');
  }
  if ((await usableSourceChunks(tx, page, wikiVersion.sourceChunkIds)).unusable > 0) {
    return rejectVersionActivation('CONFLICT', 'Wiki 引用来源已失效');
  }
  return null;
}

async function activateVersionTx(
  tx: Transaction,
  options: VersionActivationOptions,
): Promise<VersionActivationResult> {
  const { documentId, versionId, guard } = options;

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
  if (!preview) return rejectVersionActivation('NOT_FOUND', KNOWLEDGE_DOCUMENT_NOT_FOUND_MESSAGE);

  if (options.verifyWikiIndex && preview.contentKind === 'wiki') {
    const wikiFailure = await verifyWikiIndexTx(tx, documentId, versionId, preview);
    if (wikiFailure) return wikiFailure;
  }

  if (preview.sourceConnectionId) {
    await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, preview.sourceConnectionId))
      .for('share');
  }

  if (guard?.sourceSnapshot) {
    if (preview.sourceConnectionId !== guard.sourceSnapshot.sourceId) {
      return rejectVersionActivation('CONFLICT', '文档来源连接与读取快照不一致');
    }
    if (!(await sourceSnapshotMatchesTx(tx, guard.sourceSnapshot))) {
      return rejectVersionActivation('CONFLICT', '来源读取快照已失效');
    }
  } else if (guard && preview.sourceConnectionId) {
    return rejectVersionActivation('CONFLICT', '缺少来源读取快照');
  }

  const [document] = await tx
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, documentId))
    .for('update');
  if (!document) return rejectVersionActivation('NOT_FOUND', KNOWLEDGE_DOCUMENT_NOT_FOUND_MESSAGE);

  if (
    !options.allowDisabledDocument &&
    (document.status === 'disabled' || document.disabledReason !== null)
  ) {
    return rejectVersionActivation('CONFLICT', '文档已停用');
  }

  if (guard) {
    if (
      guard.sourceSnapshot &&
      (document.baseId !== guard.sourceSnapshot.baseId ||
        document.sourceConnectionId !== guard.sourceSnapshot.sourceId)
    ) {
      return rejectVersionActivation('CONFLICT', '文档来源信息与读取快照不一致');
    }
    if (guard.isAborted?.()) return rejectVersionActivation('CONFLICT', '发布任务已取消');
    if (document.currentVersionId !== guard.expectedCurrentVersionId) {
      return rejectVersionActivation('CONFLICT_STALE', DOCUMENT_VERSION_STALE_MESSAGE);
    }
  }

  if (
    options.expectedCurrentVersionId !== undefined &&
    document.currentVersionId !== options.expectedCurrentVersionId
  ) {
    return rejectVersionActivation('CONFLICT_STALE', DOCUMENT_VERSION_STALE_MESSAGE);
  }

  if (options.forbidUnpublishedDraft && (await hasUnpublishedDraft(tx, document))) {
    return rejectVersionActivation('CONFLICT', '存在未发布的草稿');
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
    .where(eq(knowledgeDocumentVersions.id, versionId))
    .limit(1);
  if (version?.documentId !== documentId) {
    return rejectVersionActivation('NOT_FOUND', '版本文档不属于该文档');
  }
  if (version.metadata.publication === 'superseded') {
    return rejectVersionActivation('CONFLICT', '该版本已被新草稿取代');
  }
  if (version.metadata.publication === 'draft') {
    const latestDraft = await latestUnpublishedDraft(tx, document);
    if (latestDraft && version.version < latestDraft.version) {
      return rejectVersionActivation('CONFLICT_STALE', '存在更新的草稿，请先发布或放弃后再切换');
    }
  }
  if (version.metadata.faqImport !== undefined && version.metadata.publication !== 'published') {
    return rejectVersionActivation('CONFLICT', '该 FAQ 草稿尚未正式批发布，不能逐条上线');
  }
  if (
    version.metadata.publication === 'draft' &&
    version.metadata.faqImport === undefined &&
    !(await draftIndexJobAllowsVersionTx(tx, document, version))
  ) {
    return rejectVersionActivation('CONFLICT', '草稿缺少本版本已成功的索引任务，不能发布');
  }

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
  if (!base || base.embeddingProfileId !== version.embeddingProfileId) {
    return rejectVersionActivation('CONFLICT', '版本来自不同的 embedding 模型空间，请重建后再回退');
  }

  if (!(await sourceScopeAllowsDocument(tx, document))) {
    return rejectVersionActivation('CONFLICT', '来源权限已失效，不能切换到该版本');
  }

  if (guard) {
    if (guard.asrProfileId !== undefined && (base.asrProfileId ?? null) !== guard.asrProfileId) {
      return rejectVersionActivation('CONFLICT', 'ASR 配置已变化');
    }
    if (document.baseId !== guard.baseId) {
      return rejectVersionActivation('CONFLICT', '文档所属知识库不匹配');
    }
    const [job] = await tx
      .select({ status: knowledgeJobs.status })
      .from(knowledgeJobs)
      .where(eq(knowledgeJobs.id, guard.jobId))
      .limit(1);
    if (job?.status !== 'running') {
      return rejectVersionActivation('CONFLICT', '索引任务未处于运行状态');
    }
    if (base.status !== 'active' || base.embeddingProfileId !== guard.embeddingProfileId) {
      return rejectVersionActivation('CONFLICT', '知识库状态或 embedding 配置已变化');
    }
    if (
      JSON.stringify(knowledgeBaseSettingsSchema.parse(base.settings).imageProcessing) !==
      guard.imageProcessingJson
    ) {
      return rejectVersionActivation('CONFLICT', '知识库图片处理配置已变化');
    }
    if (guard.isAborted?.()) return rejectVersionActivation('CONFLICT', '发布任务已取消');
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
  if (version.metadata.publication === 'draft') {
    await supersedeDraftVersionsTx(tx, documentId, versionId);
  }
  const [row] = await tx
    .update(knowledgeDocuments)
    .set({
      currentVersionId: versionId,
      contentHash: version.blobSha256,
      ...(options.allowDisabledDocument && document.status === 'disabled'
        ? {}
        : { status: 'ready' as const }),
      updatedAt: new Date(),
    })
    .where(eq(knowledgeDocuments.id, documentId))
    .returning();
  if (row && options.markWikiStale && document.currentVersionId !== versionId) {
    await markWikiStaleByDocumentsTx(tx, [documentId]);
  }
  return { ok: true, document: row ?? null };
}

export async function setCurrentVersion(
  db: DbHandle,
  documentId: string,
  versionId: string,
  guard?: PublishGuard,
  options?: { expectedCurrentVersionId: string | null; forbidUnpublishedDraft?: boolean },
): Promise<KnowledgeDocumentRow | null> {
  const result = await db.transaction((tx) =>
    activateVersionTx(tx, {
      documentId,
      versionId,
      ...(options !== undefined
        ? { expectedCurrentVersionId: options.expectedCurrentVersionId }
        : {}),
      ...(options?.forbidUnpublishedDraft !== undefined
        ? { forbidUnpublishedDraft: options.forbidUnpublishedDraft }
        : {}),
      ...(guard !== undefined ? { guard } : {}),
      verifyWikiIndex: true,
      allowDisabledDocument: false,
      markWikiStale: false,
    }),
  );
  return result.ok ? result.document : null;
}

export async function activateDocumentVersion(
  db: Database,
  input: { documentId: string; versionId: string; expectedVersionId: string | null },
): Promise<KnowledgeDocumentRow> {
  const result = await db.transaction((tx) =>
    activateVersionTx(tx, {
      documentId: input.documentId,
      versionId: input.versionId,
      expectedCurrentVersionId: input.expectedVersionId,
      verifyWikiIndex: false,
      allowDisabledDocument: true,
      markWikiStale: true,
    }),
  );
  if (!result.ok) throw new AppError(result.code, result.message);
  if (!result.document) throw new Error('knowledge document update returned no row');
  return result.document;
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
