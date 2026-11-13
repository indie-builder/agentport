import { AppError } from '@agentport/core';
import {
  type KnowledgeFaq,
  type KnowledgeFaqImportMetadata,
  type KnowledgeFaqImportMode,
  type KnowledgeFaqImportState,
  knowledgeFaqImportMetadataSchema,
} from '@agentport/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../client.js';
import {
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeJobs,
} from '../../schema.js';
import { createJob } from './jobs.js';
import type { KnowledgeDocumentRow } from './shared.js';
import { type CreateVersionInput, createVersion } from './versions.js';

// ---------------------------------------------------------------------------
// FAQ 批次导入

const FAQ_IMPORT_MAX_ITEMS = 500;

/** 规划时读取的两版指针快照；事务锁定后逐项复核。 */
function sameFaqState(a: KnowledgeFaqImportState, b: KnowledgeFaqImportState): boolean {
  return (
    a.currentVersionId === b.currentVersionId &&
    a.latestDraftVersionId === b.latestDraftVersionId &&
    new Date(a.updatedAt).getTime() === new Date(b.updatedAt).getTime()
  );
}

/** excludeBatchId 用于批发布时忽略本批刚建的草稿，对比旧集合是否被外部改动。 */
async function faqStateSnapshot(
  tx: Transaction,
  baseId: string,
  excludeBatchId?: string,
): Promise<KnowledgeFaqImportState[]> {
  const excludeBatch =
    excludeBatchId === undefined
      ? sql``
      : sql`and coalesce(v.metadata -> 'faqImport' ->> 'batchId', '') <> ${excludeBatchId}`;
  const result = await tx.execute<{
    documentId: string;
    currentVersionId: string | null;
    latestDraftVersionId: string | null;
    updatedAt: Date | string;
  }>(sql`
    select d.id as "documentId",
      d.current_version_id as "currentVersionId",
      (
        select v.id from knowledge_document_versions v
        where v.document_id = d.id
          and v.metadata ->> 'publication' = 'draft'
          ${excludeBatch}
        order by v.version desc
        limit 1
      ) as "latestDraftVersionId",
      d.updated_at as "updatedAt"
    from knowledge_documents d
    where d.base_id = ${baseId} and d.content_kind = 'faq'
    order by d.id
  `);
  return result.map((row) => ({
    documentId: row.documentId,
    currentVersionId: row.currentVersionId,
    latestDraftVersionId: row.latestDraftVersionId,
    updatedAt: new Date(row.updatedAt).toISOString(),
  }));
}

export interface FaqImportDraftInput {
  operation: 'add' | 'merge';
  /** add 为预分配文档 ID，merge 为已有文档 ID。 */
  documentId: string;
  faq: KnowledgeFaq;
  enabled: boolean;
  /** F 已按内容寻址写完整的版本文件；repo 不读写文件、不调用模型。 */
  version: Omit<
    CreateVersionInput,
    'documentId' | 'origin' | 'parentVersionId' | 'metadata' | 'faq' | 'embeddingProfileId'
  > & { id: string };
  /** 仅 add 使用；默认取标准问。 */
  title?: string;
  folderId?: string | null;
}

export interface SaveFaqImportDraftsInput {
  baseId: string;
  importBatchId: string;
  mode: KnowledgeFaqImportMode;
  /** 本次读取并将修改/替换的文档两版指针；任一变化整批 409。 */
  expectedState: KnowledgeFaqImportState[];
  drafts: FaqImportDraftInput[];
}

export interface SaveFaqImportDraftsResult {
  items: Array<{ documentId: string; expectedVersionId: string | null; jobId: string }>;
}

/**
 * 真实导入的原子落库：同一事务建立全部新增/合并 FAQ 草稿与 ingest job。
 * 不调用文件、模型或队列；F 在调用前已把文件写完整，之后自行投递返回的 jobId。
 */
export async function saveFaqImportDrafts(
  db: Database,
  input: SaveFaqImportDraftsInput,
): Promise<SaveFaqImportDraftsResult> {
  return db.transaction(async (tx) => {
    const [base] = await tx
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, input.baseId))
      .limit(1);
    if (!base) throw new AppError('NOT_FOUND', '知识库不存在，可能已被删除');
    if (input.drafts.length === 0) {
      throw new AppError('INVALID_INPUT', '导入批次没有可写入的 FAQ');
    }
    if (input.drafts.length > FAQ_IMPORT_MAX_ITEMS) {
      throw new AppError('PAYLOAD_TOO_LARGE', `FAQ 导入最多 ${FAQ_IMPORT_MAX_ITEMS} 条`);
    }
    const draftIds = new Set(input.drafts.map((draft) => draft.documentId));
    if (draftIds.size !== input.drafts.length) {
      throw new AppError('INVALID_INPUT', '导入批次存在重复 FAQ 文档');
    }

    // 全库 FAQ 文档按 ID 排序加锁，避免与另一批导入交叉写入。
    const existingDocs = await tx
      .select()
      .from(knowledgeDocuments)
      .where(
        and(eq(knowledgeDocuments.baseId, input.baseId), eq(knowledgeDocuments.contentKind, 'faq')),
      )
      .orderBy(asc(knowledgeDocuments.id))
      .for('update');
    const existingById = new Map(existingDocs.map((document) => [document.id, document]));
    const snapshot = await faqStateSnapshot(tx, input.baseId);
    const snapshotById = new Map(snapshot.map((state) => [state.documentId, state]));
    const addIds = new Set(
      input.drafts.filter((draft) => draft.operation === 'add').map((draft) => draft.documentId),
    );

    for (const state of input.expectedState) {
      if (addIds.has(state.documentId)) continue;
      const current = snapshotById.get(state.documentId);
      if (!current || !sameFaqState(current, state)) {
        throw new AppError('CONFLICT_STALE', 'FAQ 已变化，请重新读取后再导入');
      }
    }

    let replaceTargets: KnowledgeFaqImportState[] | undefined;
    if (input.mode === 'replace') {
      if (snapshot.length > FAQ_IMPORT_MAX_ITEMS) {
        throw new AppError('CONFLICT', `旧 FAQ 超过 ${FAQ_IMPORT_MAX_ITEMS} 条，无法整批替换`);
      }
      // replace 会替换整个旧集合，expectedState 必须覆盖当时的全部旧 FAQ。
      const expectedIds = new Set(
        input.expectedState.map((state) => state.documentId).filter((id) => !addIds.has(id)),
      );
      if (
        expectedIds.size !== snapshot.length ||
        snapshot.some((state) => !expectedIds.has(state.documentId))
      ) {
        throw new AppError('CONFLICT_STALE', '旧 FAQ 集合已变化，请重新读取后再导入');
      }
      replaceTargets = snapshot;
    }

    const items: SaveFaqImportDraftsResult['items'] = [];
    for (const draft of input.drafts) {
      const existing = existingById.get(draft.documentId);
      let parentVersionId: string | null = null;
      if (draft.operation === 'add') {
        if (existing) throw new AppError('CONFLICT_STALE', 'FAQ 已存在，请刷新后重试');
        await tx.insert(knowledgeDocuments).values({
          id: draft.documentId,
          baseId: input.baseId,
          folderId: draft.folderId ?? null,
          title: draft.title ?? draft.faq.question,
          sourceType: 'manual',
          sourceId: null,
          sourceUrl: null,
          sourcePath: null,
          mimeType: draft.version.mimeType,
          sizeBytes: draft.version.sizeBytes,
          contentKind: 'faq',
          disabledReason: null,
          sourceConnectionId: null,
          metadata: { originalFilename: draft.version.originalFilename },
        });
      } else {
        if (!existing) throw new AppError('CONFLICT_STALE', 'FAQ 不存在或已删除');
        parentVersionId = existing.currentVersionId;
        const state = snapshotById.get(draft.documentId);
        parentVersionId = state?.latestDraftVersionId ?? parentVersionId;
      }

      const job = await createJob(tx, {
        type: 'ingest',
        baseId: input.baseId,
        documentId: draft.documentId,
        sourceId: null,
        payload: {
          type: 'ingest',
          documentId: draft.documentId,
          publish: 'draft',
          versionId: draft.version.id,
        },
      });
      const expectedVersionId = existing?.currentVersionId ?? null;
      const faqImport: KnowledgeFaqImportMetadata = {
        batchId: input.importBatchId,
        mode: input.mode,
        enabled: draft.enabled,
        // 锁定保存时的线上版本，而不是合并草稿的 parent（可能是未发布草稿）。
        expectedVersionId,
        ...(replaceTargets === undefined ? {} : { replaceTargets }),
      };
      await createVersion(tx, {
        ...draft.version,
        id: draft.version.id,
        documentId: draft.documentId,
        origin: 'faq',
        parentVersionId,
        // jobId 与契约规定的 faqImport 形状分开存，批发布据此核索引任务。
        metadata: { publication: 'draft', faqImport, faqImportJobId: job.id },
        faq: draft.faq,
        embeddingProfileId: base.embeddingProfileId,
      });
      items.push({
        documentId: draft.documentId,
        expectedVersionId,
        jobId: job.id,
      });
    }
    return { items };
  });
}

export interface PublishFaqImportInput {
  baseId: string;
  importBatchId: string;
  /** 本批全部非 skipped 条目，不能分片。 */
  items: Array<{ documentId: string; versionId: string; expectedVersionId: string | null }>;
}

/**
 * 显式整批发布：核本批 job/索引/旧集合，再同事务切新集合。
 * replace 只在全部校验通过后删除快照中的旧 FAQ；任何失败回滚且旧集合不变。
 */
export async function publishFaqImport(
  db: Database,
  input: PublishFaqImportInput,
): Promise<KnowledgeDocumentRow[]> {
  return db.transaction(async (tx) => {
    if (input.items.length === 0) {
      throw new AppError('INVALID_INPUT', '没有可发布的 FAQ');
    }
    const itemIds = new Set(input.items.map((item) => item.documentId));
    if (itemIds.size !== input.items.length) {
      throw new AppError('INVALID_INPUT', '批发布存在重复 FAQ 文档');
    }
    const [base] = await tx
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, input.baseId))
      .limit(1);
    if (!base) throw new AppError('NOT_FOUND', '知识库不存在，可能已被删除');
    // 整批发布前先核库可用与模型空间；失配时不进入任何指针切换或 replace 删除。
    if (base.status !== 'active') {
      throw new AppError('CONFLICT', '知识库已停用，不能发布 FAQ 批次');
    }
    const documents = await tx
      .select()
      .from(knowledgeDocuments)
      .where(
        and(eq(knowledgeDocuments.baseId, input.baseId), eq(knowledgeDocuments.contentKind, 'faq')),
      )
      .orderBy(asc(knowledgeDocuments.id))
      .for('update');
    const documentById = new Map(documents.map((document) => [document.id, document]));

    const versions = await tx
      .select()
      .from(knowledgeDocumentVersions)
      .where(
        inArray(
          knowledgeDocumentVersions.id,
          input.items.map((item) => item.versionId),
        ),
      );
    const versionById = new Map(versions.map((version) => [version.id, version]));

    const coverage = await tx.execute<{ documentId: string }>(sql`
      select distinct v.document_id as "documentId"
      from knowledge_document_versions v
      join knowledge_documents d on d.id = v.document_id
      where d.base_id = ${input.baseId}
        and d.content_kind = 'faq'
        and v.metadata -> 'faqImport' ->> 'batchId' = ${input.importBatchId}
        and v.id is distinct from d.current_version_id
    `);
    const coverageIds = new Set(coverage.map((row) => row.documentId));
    if (
      coverageIds.size !== itemIds.size ||
      [...itemIds].some((documentId) => !coverageIds.has(documentId))
    ) {
      throw new AppError('CONFLICT_STALE', '导入批次不完整或已发布，请刷新后重试');
    }

    let mode: KnowledgeFaqImportMode | null = null;
    let replaceTargets: KnowledgeFaqImportState[] | undefined;
    const metadataByDocument = new Map<string, KnowledgeFaqImportMetadata>();
    for (const item of input.items) {
      const document = documentById.get(item.documentId);
      const version = versionById.get(item.versionId);
      if (!document || !version || version.documentId !== item.documentId) {
        throw new AppError('NOT_FOUND', 'FAQ 草稿版本不存在或不属于该文档');
      }
      // 草稿建好后库可能换过 embedding 空间；混空间发布会让新指针与索引不兼容。
      if (version.embeddingProfileId !== base.embeddingProfileId) {
        throw new AppError('CONFLICT', 'FAQ 草稿与知识库 embedding 模型不一致，请重新导入');
      }
      const parsed = knowledgeFaqImportMetadataSchema.safeParse(
        (version.metadata as Record<string, unknown>).faqImport,
      );
      if (!parsed.success || parsed.data.batchId !== input.importBatchId) {
        throw new AppError('CONFLICT', 'FAQ 版本不属于该导入批次');
      }
      const metadata = parsed.data;
      // 提交值必须等于保存草稿时锁定的版本，不能借当前指针或 parent 重新猜。
      if (metadata.expectedVersionId !== item.expectedVersionId) {
        throw new AppError('CONFLICT_STALE', 'FAQ 保存时的线上版本已变化，请刷新后重试');
      }
      if (mode === null) mode = metadata.mode;
      if (mode !== metadata.mode) {
        throw new AppError('CONFLICT', '同一批次不能混用 append 与 replace');
      }
      if (replaceTargets === undefined && metadata.replaceTargets !== undefined) {
        replaceTargets = metadata.replaceTargets;
      }
      // 重试会新建任务而不改版本绑定：只看本版本最近一次 ingest 任务，
      // 不借其他版本的成功任务，也不在重试仍未完成时发布。
      const [job] = await tx
        .select({ status: knowledgeJobs.status })
        .from(knowledgeJobs)
        .where(
          and(
            eq(knowledgeJobs.baseId, input.baseId),
            eq(knowledgeJobs.documentId, item.documentId),
            eq(knowledgeJobs.type, 'ingest'),
            sql`${knowledgeJobs.payload} ->> 'versionId' = ${version.id}`,
          ),
        )
        .orderBy(desc(knowledgeJobs.createdAt), desc(knowledgeJobs.id))
        .limit(1);
      if (job?.status !== 'succeeded') {
        throw new AppError('CONFLICT', 'FAQ 草稿索引尚未完成');
      }
      const [chunkCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.versionId, version.id));
      if (!chunkCount || chunkCount.count === 0) {
        throw new AppError('CONFLICT', 'FAQ 草稿索引尚未就绪');
      }
      if (document.currentVersionId !== item.expectedVersionId) {
        throw new AppError('CONFLICT_STALE', 'FAQ 线上版本已变化，请刷新后重试');
      }
      const [latestBatchDraft] = await tx
        .select({ id: knowledgeDocumentVersions.id })
        .from(knowledgeDocumentVersions)
        .where(
          and(
            eq(knowledgeDocumentVersions.documentId, item.documentId),
            sql`${knowledgeDocumentVersions.metadata} -> 'faqImport' ->> 'batchId' = ${input.importBatchId}`,
          ),
        )
        .orderBy(desc(knowledgeDocumentVersions.version))
        .limit(1);
      if (latestBatchDraft?.id !== version.id) {
        throw new AppError('CONFLICT_STALE', 'FAQ 批次存在更新的草稿，请刷新后重试');
      }
      metadataByDocument.set(item.documentId, metadata);
    }

    if (mode === 'replace') {
      if (!replaceTargets) throw new AppError('CONFLICT', '替换批次缺少旧 FAQ 快照');
      if (replaceTargets.length > FAQ_IMPORT_MAX_ITEMS) {
        throw new AppError('CONFLICT', `旧 FAQ 超过 ${FAQ_IMPORT_MAX_ITEMS} 条，无法整批替换`);
      }
      const targetIds = new Set(replaceTargets.map((state) => state.documentId));
      const addedIds = new Set([...itemIds].filter((documentId) => !targetIds.has(documentId)));
      const currentOldIds = documents
        .filter((document) => !addedIds.has(document.id))
        .map((document) => document.id);
      if (
        currentOldIds.length !== replaceTargets.length ||
        currentOldIds.some((documentId) => !targetIds.has(documentId))
      ) {
        throw new AppError('CONFLICT_STALE', '旧 FAQ 集合已变化，请刷新后重试');
      }
      for (const target of replaceTargets) {
        const document = documentById.get(target.documentId);
        if (!document) throw new AppError('CONFLICT_STALE', '旧 FAQ 已删除，请刷新后重试');
        if (document.currentVersionId !== target.currentVersionId) {
          throw new AppError('CONFLICT_STALE', '旧 FAQ 线上版本已变化，请刷新后重试');
        }
        if (new Date(document.updatedAt).getTime() !== new Date(target.updatedAt).getTime()) {
          throw new AppError('CONFLICT_STALE', '旧 FAQ 已变化，请刷新后重试');
        }
        const [latest] = await tx
          .select({ id: knowledgeDocumentVersions.id })
          .from(knowledgeDocumentVersions)
          .where(
            and(
              eq(knowledgeDocumentVersions.documentId, target.documentId),
              sql`${knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
              sql`coalesce(${knowledgeDocumentVersions.metadata} -> 'faqImport' ->> 'batchId', '') <> ${input.importBatchId}`,
            ),
          )
          .orderBy(desc(knowledgeDocumentVersions.version))
          .limit(1);
        if ((latest?.id ?? null) !== target.latestDraftVersionId) {
          throw new AppError('CONFLICT_STALE', '旧 FAQ 草稿已变化，请刷新后重试');
        }
      }
    }

    await tx
      .update(knowledgeDocumentVersions)
      .set({
        metadata: sql`${knowledgeDocumentVersions.metadata} || '{"publication":"published"}'::jsonb`,
      })
      .where(
        and(
          inArray(
            knowledgeDocumentVersions.id,
            input.items.map((item) => item.versionId),
          ),
          sql`${knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
        ),
      );
    const published: KnowledgeDocumentRow[] = [];
    for (const item of input.items) {
      const metadata = metadataByDocument.get(item.documentId);
      if (!metadata) throw new AppError('CONFLICT', 'FAQ 导入元数据缺失');
      const version = versionById.get(item.versionId);
      if (!version) throw new AppError('NOT_FOUND', 'FAQ 草稿版本不存在');
      const current = documentById.get(item.documentId);
      const manualDisabled = current?.status === 'disabled' && current.disabledReason === 'manual';
      const enabled = manualDisabled ? false : metadata.enabled;
      const [row] = await tx
        .update(knowledgeDocuments)
        .set({
          currentVersionId: item.versionId,
          // 切指针同时更新正文指纹，避免沿用上一版 contentHash。
          contentHash: version.blobSha256,
          status: enabled ? 'ready' : 'disabled',
          disabledReason: enabled ? null : 'manual',
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, item.documentId))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 'FAQ 不存在，可能已被删除');
      published.push(row);
    }

    if (mode === 'replace' && replaceTargets) {
      const deletedIds = replaceTargets
        .map((target) => target.documentId)
        .filter((documentId) => !itemIds.has(documentId));
      if (deletedIds.length > 0) {
        await tx.delete(knowledgeDocuments).where(inArray(knowledgeDocuments.id, deletedIds));
      }
    }
    return published;
  });
}
