import { AppError } from '@agentport/core';
import type { KnowledgeLocator } from '@agentport/shared';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import {
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeJobs,
} from '../../schema.js';
import { paginate } from '../keyset.js';
import {
  INSERT_CHUNK,
  type KnowledgeChunkRow,
  type KnowledgeDocumentRow,
  type Page,
  type PageOptions,
  pageLimit,
} from './shared.js';
import { type CreateVersionInput, createVersion } from './versions.js';
import { markWikiStaleByDocument } from './wiki.js';

export interface NewChunk {
  ordinal: number;
  parentOrdinal?: number | null | undefined;
  indexRole?: KnowledgeChunkRow['indexRole'] | undefined;
  kind: KnowledgeChunkRow['kind'];
  heading: string | null;
  content: string;
  searchText: string;
  embedding: number[] | null;
  pageFrom: number | null;
  pageTo: number | null;
  locator?: KnowledgeLocator | null | undefined;
  enabled?: boolean | undefined;
  editedByUser?: boolean | undefined;
  tokenCount: number;
  metadata?: Record<string, unknown> | undefined;
}
export async function insertChunks(
  db: DbHandle,
  input: {
    baseId: string;
    documentId: string;
    versionId: string;
    folderId: string | null;
    chunks: NewChunk[];
  },
): Promise<KnowledgeChunkRow[]> {
  if (input.chunks.length === 0) return [];
  const rows = input.chunks.map((chunk) => ({
    id: newId('knowledgeChunk'),
    baseId: input.baseId,
    documentId: input.documentId,
    versionId: input.versionId,
    folderId: input.folderId,
    ...chunk,
  }));
  const inserted: KnowledgeChunkRow[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    inserted.push(
      ...(await db
        .insert(knowledgeChunks)
        .values(rows.slice(i, i + INSERT_CHUNK))
        .returning()),
    );
  }
  return inserted;
}

/** 仅重建未发布草稿；与发布共用文档锁，取消或任一批写入失败时保留原分块。 */
export async function replaceChunks(
  db: Database,
  input: Parameters<typeof insertChunks>[1] & {
    jobId: string;
    isAborted: () => boolean;
  },
): Promise<KnowledgeChunkRow[]> {
  return db.transaction(async (tx) => {
    const [document] = await tx
      .select({ currentVersionId: knowledgeDocuments.currentVersionId })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.id, input.documentId),
          eq(knowledgeDocuments.baseId, input.baseId),
        ),
      )
      .for('update');
    const [version] = await tx
      .select({ metadata: knowledgeDocumentVersions.metadata })
      .from(knowledgeDocumentVersions)
      .where(
        and(
          eq(knowledgeDocumentVersions.id, input.versionId),
          eq(knowledgeDocumentVersions.documentId, input.documentId),
        ),
      )
      .for('update');
    if (
      !document ||
      document.currentVersionId === input.versionId ||
      version?.metadata.publication !== 'draft' ||
      (version.metadata.faqImport === undefined
        ? version.metadata.indexingJobId
        : version.metadata.faqImportJobId) !== input.jobId
    ) {
      throw new AppError('CONFLICT', '只能替换本任务绑定的未发布草稿分块');
    }
    const [job] = await tx
      .select({ payload: knowledgeJobs.payload })
      .from(knowledgeJobs)
      .where(
        and(
          eq(knowledgeJobs.id, input.jobId),
          eq(knowledgeJobs.type, 'ingest'),
          eq(knowledgeJobs.baseId, input.baseId),
          eq(knowledgeJobs.documentId, input.documentId),
          eq(knowledgeJobs.status, 'running'),
        ),
      )
      .for('share');
    if (
      job?.payload.type !== 'ingest' ||
      job.payload.publish !== 'draft' ||
      job.payload.documentId !== input.documentId ||
      job.payload.versionId !== input.versionId ||
      input.isAborted()
    ) {
      throw new AppError('CONFLICT', '草稿索引任务已失效或取消');
    }
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.versionId, input.versionId));
    const inserted = await insertChunks(tx, input);
    if (input.isAborted()) throw new AppError('CONFLICT', '草稿索引任务已取消');
    return inserted;
  });
}

function chunkPageFilters(versionId: string, options: PageOptions): SQL[] {
  const filters: SQL[] = [eq(knowledgeChunks.versionId, versionId)];
  if (options.cursor) {
    // 按 ordinal 排序，游标行用 id 反查序号。
    filters.push(sql`(${knowledgeChunks.ordinal}, ${knowledgeChunks.id}) > (
      select b.ordinal, b.id from ${knowledgeChunks} b where b.id = ${options.cursor}
    )`);
  }
  return filters;
}

export async function listChunks(
  db: Database,
  versionId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeChunkRow>> {
  const limit = pageLimit(options);
  const rows = await db
    .select()
    .from(knowledgeChunks)
    .where(and(...chunkPageFilters(versionId, options)))
    .orderBy(asc(knowledgeChunks.ordinal), asc(knowledgeChunks.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

/** 展示与导出只需要元数据：显式投影，避免把 1024 维向量读出来。 */
const chunkSummaryColumns = {
  id: knowledgeChunks.id,
  documentId: knowledgeChunks.documentId,
  versionId: knowledgeChunks.versionId,
  ordinal: knowledgeChunks.ordinal,
  parentOrdinal: knowledgeChunks.parentOrdinal,
  indexRole: knowledgeChunks.indexRole,
  kind: knowledgeChunks.kind,
  heading: knowledgeChunks.heading,
  content: knowledgeChunks.content,
  enabled: knowledgeChunks.enabled,
  editedByUser: knowledgeChunks.editedByUser,
  pageFrom: knowledgeChunks.pageFrom,
  pageTo: knowledgeChunks.pageTo,
  locator: knowledgeChunks.locator,
  tokenCount: knowledgeChunks.tokenCount,
  metadata: knowledgeChunks.metadata,
};

export type KnowledgeChunkSummary = Pick<KnowledgeChunkRow, keyof typeof chunkSummaryColumns>;

export async function listChunkSummaries(
  db: Database,
  versionId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeChunkSummary>> {
  const limit = pageLimit(options);
  const rows = await db
    .select(chunkSummaryColumns)
    .from(knowledgeChunks)
    .where(and(...chunkPageFilters(versionId, options)))
    .orderBy(asc(knowledgeChunks.ordinal), asc(knowledgeChunks.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

/** 人工编辑总数取整版聚合，不能靠分页首页推断（>200 条时会漏）。 */
export async function countEditedChunks(db: Database, versionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.versionId, versionId), eq(knowledgeChunks.editedByUser, true)));
  const editedCount = row?.count ?? 0;
  if (editedCount > 0) return editedCount;
  // 删除后版本里已没有可标记的叶块；版本级 manualChanges 仍证明人工改过，不能被同步覆盖。
  const [version] = await db
    .select({ metadata: knowledgeDocumentVersions.metadata })
    .from(knowledgeDocumentVersions)
    .where(eq(knowledgeDocumentVersions.id, versionId))
    .limit(1);
  const changes = version?.metadata.manualChanges;
  return changes !== null && typeof changes === 'object' && Object.keys(changes).length > 0 ? 1 : 0;
}

export async function getChunk(db: Database, id: string): Promise<KnowledgeChunkRow | null> {
  const [row] = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.id, id)).limit(1);
  return row ?? null;
}

export interface ChunkPatch {
  content?: string | undefined;
  heading?: string | null | undefined;
  searchText?: string | undefined;
  embedding?: number[] | null | undefined;
  enabled?: boolean | undefined;
  editedByUser?: boolean | undefined;
}

export async function patchChunk(
  db: Database,
  id: string,
  patch: ChunkPatch,
): Promise<KnowledgeChunkRow | null> {
  const [row] = await db
    .update(knowledgeChunks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeChunks.id, id))
    .returning();
  return row ?? null;
}

export type DocumentChunkMutation =
  | {
      type: 'add';
      /** 新增分块不接受 page/locator/父块定位，服务端固定为人工 leaf 块。 */
      chunk: Omit<
        NewChunk,
        | 'ordinal'
        | 'parentOrdinal'
        | 'indexRole'
        | 'locator'
        | 'pageFrom'
        | 'pageTo'
        | 'editedByUser'
      >;
    }
  | {
      type: 'update';
      chunkId: string;
      patch: {
        content?: string;
        heading?: string | null;
        searchText?: string;
        embedding?: number[] | null;
        enabled?: boolean;
      };
    }
  | { type: 'delete'; chunkId: string };

export interface EditDocumentChunksInput {
  documentId: string;
  expectedVersionId: string;
  mutation: DocumentChunkMutation;
  /**
   * API 已按该 ID 把正文文件写完整，再交给事务 INSERT/COW/切指针；
   * 仓储不生成 ID，避免指针先于文件存在。
   */
  preparedVersion: Omit<CreateVersionInput, 'documentId' | 'origin' | 'parentVersionId'> & {
    id: string;
  };
}

type ChunkSeed = Omit<NewChunk, 'ordinal' | 'parentOrdinal'> & {
  sourceOrdinal: number;
  originalParentOrdinal: number | null;
};

function seedFromChunk(chunk: KnowledgeChunkRow): ChunkSeed {
  return {
    sourceOrdinal: chunk.ordinal,
    originalParentOrdinal: chunk.parentOrdinal,
    indexRole: chunk.indexRole,
    kind: chunk.kind,
    heading: chunk.heading,
    content: chunk.content,
    searchText: chunk.searchText,
    embedding: chunk.embedding,
    pageFrom: chunk.pageFrom,
    pageTo: chunk.pageTo,
    locator: chunk.locator,
    enabled: chunk.enabled,
    editedByUser: chunk.editedByUser,
    tokenCount: chunk.tokenCount,
    metadata: chunk.metadata,
  };
}

/** 人工改稿的定位不再指向原件；保留 originalChunkId 仅供追溯。 */
function editedMetadata(chunk: KnowledgeChunkRow): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...chunk.metadata, originalChunkId: chunk.id };
  delete metadata.image;
  delete metadata.imageRole;
  return metadata;
}

/**
 * 人工派生版仍保留音频来源快照（protocol/profileName/model/durationMs），
 * 但旧全文偏移已不适用，必须清空 segments。
 */
function manualVersionMetadata(
  metadata: Record<string, unknown> | undefined,
  parentMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const audio = parentMetadata?.audio ?? metadata?.audio;
  if (audio === null || typeof audio !== 'object' || Array.isArray(audio)) return metadata;
  return { ...metadata, audio: { ...(audio as Record<string, unknown>), segments: [] } };
}

/** 删除/启停后可能没有 editedByUser 叶块，版本级事实供同步冲突判断。 */
function manualChangeMetadata(
  metadata: Record<string, unknown> | undefined,
  chunkId: string,
  change: 'added' | 'edited' | 'enabled' | 'deleted',
): Record<string, unknown> {
  const existing = metadata?.manualChanges;
  const changes =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  changes[chunkId] = change;
  return { ...metadata, manualChanges: changes };
}

/**
 * 人工新增/修改/删除分块：事务内克隆当前版全部 chunks 成新版本并切指针。
 * 旧版本内容保持不可变；纯 enabled 修改保留原定位，正文/标题修改清空原件定位。
 */
export async function editDocumentChunks(
  db: Database,
  input: EditDocumentChunksInput,
): Promise<{ document: KnowledgeDocumentRow; chunk: KnowledgeChunkRow | null }> {
  const result = await db.transaction(async (tx) => {
    const [document] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, input.documentId))
      .for('update');
    if (!document) throw new AppError('NOT_FOUND', '文档不存在，可能已被删除');
    if (!document.currentVersionId || document.currentVersionId !== input.expectedVersionId) {
      throw new AppError('CONFLICT_STALE', '文档版本已变化，请刷新后重试');
    }
    const [parentVersion] = await tx
      .select({ metadata: knowledgeDocumentVersions.metadata })
      .from(knowledgeDocumentVersions)
      .where(eq(knowledgeDocumentVersions.id, input.expectedVersionId))
      .limit(1);
    const chunks = await tx
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.versionId, input.expectedVersionId))
      .orderBy(asc(knowledgeChunks.ordinal), asc(knowledgeChunks.id));
    const targetChunkId = input.mutation.type === 'add' ? null : input.mutation.chunkId;
    const target =
      targetChunkId === null ? null : (chunks.find((chunk) => chunk.id === targetChunkId) ?? null);
    if (targetChunkId !== null && !target) {
      throw new AppError('NOT_FOUND', '分块不存在或不属于当前版本');
    }

    let seeds: ChunkSeed[] = chunks
      .filter((chunk) => input.mutation.type !== 'delete' || chunk.id !== targetChunkId)
      .map(seedFromChunk);
    let editedOrdinal: number | null = null;

    if (input.mutation.type === 'update' && target) {
      const patch = input.mutation.patch;
      const contentChanged = patch.content !== undefined && patch.content !== target.content;
      const headingChanged = patch.heading !== undefined && patch.heading !== target.heading;
      const seed = seeds.find((entry) => entry.sourceOrdinal === target.ordinal);
      if (seed) {
        if (patch.heading !== undefined) seed.heading = patch.heading;
        if (contentChanged) {
          const content = patch.content ?? target.content;
          seed.content = content;
          seed.searchText = patch.searchText ?? content;
          seed.embedding = patch.embedding ?? null;
          seed.tokenCount = Math.ceil(content.length / 2);
        }
        if (contentChanged || headingChanged) {
          seed.pageFrom = null;
          seed.pageTo = null;
          seed.locator = null;
          seed.editedByUser = true;
          seed.metadata = editedMetadata(target);
        }
        if (patch.enabled !== undefined) seed.enabled = patch.enabled;
        editedOrdinal = seeds.indexOf(seed);
      }
    }

    if (input.mutation.type === 'add') {
      const add = input.mutation.chunk;
      seeds = [
        ...seeds,
        {
          sourceOrdinal: Number.MAX_SAFE_INTEGER,
          originalParentOrdinal: null,
          indexRole: 'leaf',
          kind: add.kind,
          heading: add.heading,
          content: add.content,
          searchText: add.searchText,
          embedding: add.embedding,
          pageFrom: null,
          pageTo: null,
          locator: null,
          editedByUser: true,
          tokenCount: add.tokenCount,
          metadata: add.metadata ?? {},
          enabled: true,
        },
      ];
      editedOrdinal = seeds.length - 1;
    }

    // 父块按序号引用同版本中的另一块；克隆时重映射到新的连续序号。
    const ordinalMap = new Map(seeds.map((seed, index) => [seed.sourceOrdinal, index] as const));
    const newChunks: NewChunk[] = seeds.map((seed, index) => ({
      ordinal: index,
      parentOrdinal:
        seed.originalParentOrdinal === null
          ? null
          : (ordinalMap.get(seed.originalParentOrdinal) ?? null),
      indexRole: seed.indexRole,
      kind: seed.kind,
      heading: seed.heading,
      content: seed.content,
      searchText: seed.searchText,
      embedding: seed.embedding,
      pageFrom: seed.pageFrom,
      pageTo: seed.pageTo,
      locator: seed.locator,
      enabled: seed.enabled ?? true,
      editedByUser: seed.editedByUser,
      tokenCount: seed.tokenCount,
      metadata: seed.metadata,
    }));

    const change =
      input.mutation.type === 'delete'
        ? 'deleted'
        : input.mutation.type === 'add'
          ? 'added'
          : input.mutation.patch.content !== undefined || input.mutation.patch.heading !== undefined
            ? 'edited'
            : 'enabled';
    const version = await createVersion(tx, {
      ...input.preparedVersion,
      documentId: input.documentId,
      origin: 'manual',
      parentVersionId: input.expectedVersionId,
      metadata: manualChangeMetadata(
        manualVersionMetadata(input.preparedVersion.metadata, parentVersion?.metadata),
        input.mutation.type === 'add' ? 'added' : input.mutation.chunkId,
        change,
      ),
    });
    const inserted = await insertChunks(tx, {
      baseId: document.baseId,
      documentId: document.id,
      versionId: version.id,
      folderId: document.folderId,
      chunks: newChunks,
    });
    const [updated] = await tx
      .update(knowledgeDocuments)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, document.id))
      .returning();
    if (!updated) throw new Error('knowledge document update returned no row');
    return {
      document: updated,
      chunk: editedOrdinal === null ? null : (inserted[editedOrdinal] ?? null),
    };
  });
  await markWikiStaleByDocument(db, input.documentId);
  return result;
}
