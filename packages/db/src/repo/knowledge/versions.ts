import { AppError } from '@agentport/core';
import {
  type KnowledgeFaq,
  knowledgeBaseSettingsSchema,
  knowledgeJobPayloadSchema,
} from '@agentport/shared';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
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
import { paginate } from '../keyset.js';
import {
  type KnowledgeDocumentRow,
  type KnowledgeVersionRow,
  type Page,
  type PageOptions,
  type SourceReadSnapshot,
  lockWikiSourceScope,
  pageLimit,
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
  /** COW 等调用方可预分配，保证文件先按该 ID 写完整；缺省由仓储生成。 */
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

/** 发布守卫：摄取开始时记下的任务与库快照，切版事务内再核一次。 */
export interface PublishGuard {
  jobId: string;
  baseId: string;
  embeddingProfileId: string;
  /** 启动时解析后的 imageProcessing JSON；库配置变了就不发布。 */
  imageProcessingJson: string;
  /** 启动时看到的当前版本；期间有人切版就拒绝，避免覆盖并发结果。 */
  expectedCurrentVersionId: string | null;
  /**
   * 仅音频摄取设置：执行时使用的 ASR profile ID。
   * 发布前库的 asrProfileId 被关闭/切换时拒绝，旧任务结果不能上线。
   */
  asrProfileId?: string | null | undefined;
  /** 外部来源版本必须带读取快照；锁内重核来源配置、密文与范围。 */
  sourceSnapshot?: SourceReadSnapshot | undefined;
  /** 运行中取消只走 Redis abort；已观察到的 abort 在事务内也拦一次。 */
  isAborted?: (() => boolean) | undefined;
}

/**
 * 版本切换：current_version_id 与 ready 状态同事务写入，旧版本继续保留可回滚。
 * 所有调用（带不带 guard）都核版本归属、人工停用与来源/范围授权；
 * 带 guard 时再核任务仍 running、库仍 active、profile 与配置未变、当前指针未变。
 * 返回 null 表示守卫拒绝（任务已收尾/abort、库停用、配置/指针变化或来源失权），不区分原因。
 */
export async function setCurrentVersion(
  db: Database,
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
    // Wiki 发布先锁来源/来源文档，再锁页面，最后更新内部索引文档；切版必须同序。
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
    // 外部同步发布不得退回无快照路径；快照在来源锁内重核，失效即零写返回。
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
    // 批次导入的草稿只能走 publishFaqImport 整批发布，逐条切版会破坏 replace 原子性；
    // 已正式发布的批次历史与普通发布版一样可回退。
    if (
      version.metadata?.faqImport !== undefined &&
      version.metadata?.publication !== 'published'
    ) {
      return null;
    }
    // 普通草稿必须关联本版本自己的成功索引任务，不能借另一成功任务上线。
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
    // 不同模型空间的版本不能直接发布/回退，必须重建。
    if (!base || base.embeddingProfileId !== version.embeddingProfileId) return null;
    // 只对本次音频生效：没有 asrProfileId 的普通文档不依赖 ASR 可用性。
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
      // 两次 await 期间可能收到取消；写在切版前，避免已取消任务发布新版本。
      if (guard.isAborted?.()) return null;
    }
    // 只把草稿标记翻成已发布；无标记版本本就从未暴露为草稿，保持原 metadata。
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
    // 与来源范围调整统一锁序：先来源共享锁，再文档行锁。
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
    // 批次导入草稿只能走 publishFaqImport 整批发布；普通手写草稿仍可显式发布。
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
    // 不同模型空间的旧版本不能直接回退：向量与当前检索空间不兼容。
    if (!base || base.embeddingProfileId !== version.embeddingProfileId) {
      throw new AppError('CONFLICT', '版本来自不同的 embedding 模型空间，请重建后再回退');
    }
    // 来源撤权后回退同样拒绝，不能靠切旧指针绕过范围/路径授权。
    if (!(await sourceScopeAllowsDocument(tx, document))) {
      throw new AppError('CONFLICT', '来源权限已失效，不能切换到该版本');
    }
    // 回退也是发布：只翻转草稿标记，无标记版本已有发布事实。
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
    return row;
  });
}

export async function listVersions(
  db: Database,
  documentId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeVersionRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeDocumentVersions.documentId, documentId)];
  if (options.cursor) {
    filters.push(sql`(${knowledgeDocumentVersions.createdAt}, ${knowledgeDocumentVersions.id}) < (
      select b.created_at, b.id from ${knowledgeDocumentVersions} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeDocumentVersions)
    .where(and(...filters))
    .orderBy(desc(knowledgeDocumentVersions.createdAt), desc(knowledgeDocumentVersions.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

/** 版本列表：复用 listVersions，并标出哪一版是当前可读版。 */
export async function listDocumentVersions(
  db: Database,
  documentId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeVersionRow & { isCurrent: boolean }>> {
  const [document, page] = await Promise.all([
    db
      .select({ currentVersionId: knowledgeDocuments.currentVersionId })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .limit(1),
    listVersions(db, documentId, options),
  ]);
  const currentVersionId = document[0]?.currentVersionId ?? null;
  return {
    items: page.items.map((row) => ({ ...row, isCurrent: row.id === currentVersionId })),
    nextCursor: page.nextCursor,
  };
}
