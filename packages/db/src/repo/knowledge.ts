import { AppError } from '@agentport/core';
import {
  type KnowledgeBaseSettings,
  type KnowledgeJobPayload,
  knowledgeBaseSettingsSchema,
} from '@agentport/shared';
import { and, asc, desc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import {
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeDocumentTags,
  knowledgeDocumentVersions,
  knowledgeFolders,
  knowledgeJobs,
  knowledgeModelProfiles,
  knowledgeSourceRanges,
  knowledgeSources,
  knowledgeSyncRuns,
  knowledgeTags,
  knowledgeWikiPages,
  knowledgeWikiSources,
  knowledgeWikiVersions,
} from '../schema.js';

export type KnowledgeBaseRow = typeof knowledgeBases.$inferSelect;
export type KnowledgeFolderRow = typeof knowledgeFolders.$inferSelect;
export type KnowledgeTagRow = typeof knowledgeTags.$inferSelect;
export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;
export type KnowledgeVersionRow = typeof knowledgeDocumentVersions.$inferSelect;
export type KnowledgeChunkRow = typeof knowledgeChunks.$inferSelect;
export type KnowledgeJobRow = typeof knowledgeJobs.$inferSelect;
export type KnowledgeSourceRow = typeof knowledgeSources.$inferSelect;
export type KnowledgeSourceRangeRow = typeof knowledgeSourceRanges.$inferSelect;
export type KnowledgeSyncRunRow = typeof knowledgeSyncRuns.$inferSelect;
export type KnowledgeWikiPageRow = typeof knowledgeWikiPages.$inferSelect;
export type KnowledgeWikiVersionRow = typeof knowledgeWikiVersions.$inferSelect;
export type KnowledgeModelProfileRow = typeof knowledgeModelProfiles.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageOptions {
  cursor?: string | null;
  limit?: number;
}

/** 列表统一按 (created_at, id) 倒序，游标是上一页最后一行 id。 */
function pageLimit(options: PageOptions): number {
  return Math.min(Math.max(options.limit ?? 50, 1), 200);
}

function nextCursor<T extends { id: string }>(rows: T[], limit: number): string | null {
  return rows.length > limit ? (rows[limit - 1]?.id ?? null) : null;
}

// ---------------------------------------------------------------------------
// 知识库

export interface CreateBaseInput {
  slug: string;
  name: string;
  description: string;
  /** 内置 knowledge server；由 API 的 ensureKnowledgeServer 先建后用。 */
  serverId: string;
  embeddingProfileId: string;
  rerankProfileId: string | null;
  settings: KnowledgeBaseSettings;
}

export async function createBase(db: Database, input: CreateBaseInput): Promise<KnowledgeBaseRow> {
  const [row] = await db
    .insert(knowledgeBases)
    .values({ id: newId('knowledgeBase'), ...input })
    .returning();
  if (!row) throw new Error('knowledge base insert returned no row');
  return row;
}

export async function getBase(db: Database, id: string): Promise<KnowledgeBaseRow | null> {
  const [row] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).limit(1);
  return row ?? null;
}

export async function getBaseByServerId(
  db: Database,
  serverId: string,
): Promise<KnowledgeBaseRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.serverId, serverId))
    .limit(1);
  return row ?? null;
}

export async function listBases(
  db: Database,
  options: PageOptions = {},
): Promise<Page<KnowledgeBaseRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [];
  if (options.cursor) {
    filters.push(sql`(${knowledgeBases.createdAt}, ${knowledgeBases.id}) < (
      select b.created_at, b.id from ${knowledgeBases} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeBases)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(knowledgeBases.createdAt), desc(knowledgeBases.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

export interface BasePatch {
  name?: string | undefined;
  description?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  embeddingProfileId?: string | undefined;
  rerankProfileId?: string | null | undefined;
  settings?: KnowledgeBaseSettings | undefined;
}

export async function updateBase(
  db: Database,
  id: string,
  patch: BasePatch,
): Promise<KnowledgeBaseRow | null> {
  const [row] = await db
    .update(knowledgeBases)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeBases.id, id))
    .returning();
  return row ?? null;
}

export async function deleteBase(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeBases)
    .where(eq(knowledgeBases.id, id))
    .returning({ id: knowledgeBases.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// 文件夹 / 标签

export async function createFolder(
  db: Database,
  input: { baseId: string; parentId: string | null; name: string; path: string },
): Promise<KnowledgeFolderRow> {
  const [row] = await db
    .insert(knowledgeFolders)
    .values({ id: newId('knowledgeFolder'), ...input })
    .returning();
  if (!row) throw new Error('knowledge folder insert returned no row');
  return row;
}

export async function listFolders(
  db: Database,
  baseId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeFolderRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeFolders.baseId, baseId)];
  if (options.cursor) filters.push(gt(knowledgeFolders.id, options.cursor));
  const rows = await db
    .select()
    .from(knowledgeFolders)
    .where(and(...filters))
    .orderBy(asc(knowledgeFolders.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

export async function getFolder(db: Database | Tx, id: string): Promise<KnowledgeFolderRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeFolders)
    .where(eq(knowledgeFolders.id, id))
    .limit(1);
  return row ?? null;
}

/** LIKE 默认转义符是反斜杠；路径里的 % _ \ 必须转义后才能当字面前缀匹配。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** 改名或移动后整棵子树的物化路径一起重写；路径唯一冲突交给 409。 */
async function rewriteFolderPath(
  tx: Tx,
  folder: KnowledgeFolderRow,
  nextParentId: string | null,
  nextName: string,
): Promise<KnowledgeFolderRow> {
  let nextPath = `/${nextName}`;
  if (nextParentId) {
    const parent = await getFolder(tx, nextParentId);
    if (!parent) throw new AppError('NOT_FOUND', '父文件夹不存在');
    if (parent.baseId !== folder.baseId)
      throw new AppError('INVALID_INPUT', '父文件夹属于其他知识库');
    if (parent.path === folder.path || parent.path.startsWith(`${folder.path}/`)) {
      throw new AppError('INVALID_INPUT', '不能移动到自身或子孙文件夹下');
    }
    nextPath = `${parent.path}/${nextName}`;
  }
  const [row] = await tx
    .update(knowledgeFolders)
    .set({ parentId: nextParentId, name: nextName, path: nextPath })
    .where(eq(knowledgeFolders.id, folder.id))
    .returning();
  if (!row) throw new Error('knowledge folder update returned no row');
  // JS length 按 UTF-16 计数，emoji 会多算一位；字符偏移交给 PG char_length。
  await tx.execute(sql`
    update ${knowledgeFolders}
    set path = ${nextPath} || substr(path, char_length(${folder.path}::text) + 1)
    where base_id = ${folder.baseId} and path like ${`${escapeLike(folder.path)}/%`}
  `);
  return row;
}

/** 改名与移动合并为一次事务：只写最终 path，冲突时整棵子树都不会留下中间状态。 */
export async function updateFolder(
  db: Database,
  id: string,
  patch: { parentId?: string | null | undefined; name?: string | undefined },
): Promise<KnowledgeFolderRow | null> {
  return db.transaction(async (tx) => {
    const folder = await getFolder(tx, id);
    if (!folder) return null;
    return rewriteFolderPath(
      tx,
      folder,
      patch.parentId === undefined ? folder.parentId : patch.parentId,
      patch.name ?? folder.name,
    );
  });
}

export async function deleteFolder(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeFolders)
    .where(eq(knowledgeFolders.id, id))
    .returning({ id: knowledgeFolders.id });
  return rows.length > 0;
}

export async function upsertTag(
  db: Database,
  baseId: string,
  name: string,
): Promise<KnowledgeTagRow> {
  const [row] = await db
    .insert(knowledgeTags)
    .values({ id: newId('knowledgeTag'), baseId, name })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(knowledgeTags)
    .where(and(eq(knowledgeTags.baseId, baseId), eq(knowledgeTags.name, name)))
    .limit(1);
  if (!existing) throw new Error('knowledge tag upsert lost its row');
  return existing;
}

export async function listTags(db: Database, baseId: string): Promise<KnowledgeTagRow[]> {
  return db
    .select()
    .from(knowledgeTags)
    .where(eq(knowledgeTags.baseId, baseId))
    .orderBy(asc(knowledgeTags.name));
}

export async function deleteTag(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeTags)
    .where(eq(knowledgeTags.id, id))
    .returning({ id: knowledgeTags.id });
  return rows.length > 0;
}

export async function setDocumentTags(
  db: Database,
  documentId: string,
  tagIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(knowledgeDocumentTags).where(eq(knowledgeDocumentTags.documentId, documentId));
    if (tagIds.length > 0) {
      await tx.insert(knowledgeDocumentTags).values(tagIds.map((tagId) => ({ documentId, tagId })));
    }
  });
}

export async function getDocumentTagNames(
  db: Database,
  documentIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>(documentIds.map((id) => [id, []]));
  if (documentIds.length === 0) return result;
  const rows = await db
    .select({ documentId: knowledgeDocumentTags.documentId, name: knowledgeTags.name })
    .from(knowledgeDocumentTags)
    .innerJoin(knowledgeTags, eq(knowledgeTags.id, knowledgeDocumentTags.tagId))
    .where(inArray(knowledgeDocumentTags.documentId, documentIds))
    .orderBy(asc(knowledgeTags.name));
  for (const row of rows) result.get(row.documentId)?.push(row.name);
  return result;
}

// ---------------------------------------------------------------------------
// 文档 / 版本 / chunk

export interface CreateDocumentInput {
  baseId: string;
  folderId: string | null;
  title: string;
  sourceType: KnowledgeDocumentRow['sourceType'];
  sourceId: string | null;
  sourceUrl: string | null;
  sourcePath: string | null;
  mimeType: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
}

export async function createDocument(
  db: Database,
  input: CreateDocumentInput,
): Promise<KnowledgeDocumentRow> {
  const [row] = await db
    .insert(knowledgeDocuments)
    .values({ id: newId('knowledgeDocument'), ...input })
    .returning();
  if (!row) throw new Error('knowledge document insert returned no row');
  return row;
}

export async function getDocument(db: Database, id: string): Promise<KnowledgeDocumentRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, id))
    .limit(1);
  return row ?? null;
}

export interface ListDocumentsFilter extends PageOptions {
  baseId: string;
  folderId?: string | null;
  tag?: string;
  status?: KnowledgeDocumentRow['status'];
  /** 标题模糊匹配（大小写不敏感）。 */
  q?: string;
}

export async function listDocuments(
  db: Database,
  filter: ListDocumentsFilter,
): Promise<Page<KnowledgeDocumentRow>> {
  const limit = pageLimit(filter);
  const filters: SQL[] = [eq(knowledgeDocuments.baseId, filter.baseId)];
  if (filter.folderId !== undefined) {
    filters.push(
      filter.folderId === null
        ? isNull(knowledgeDocuments.folderId)
        : eq(knowledgeDocuments.folderId, filter.folderId),
    );
  }
  if (filter.status) filters.push(eq(knowledgeDocuments.status, filter.status));
  if (filter.q) {
    filters.push(sql`${knowledgeDocuments.title} ilike ${`%${filter.q}%`}`);
  }
  if (filter.tag) {
    filters.push(sql`exists (
      select 1 from ${knowledgeDocumentTags} dt
      join ${knowledgeTags} t on t.id = dt.tag_id
      where dt.document_id = ${knowledgeDocuments.id} and t.name = ${filter.tag}
    )`);
  }
  if (filter.cursor) {
    filters.push(sql`(${knowledgeDocuments.createdAt}, ${knowledgeDocuments.id}) < (
      select b.created_at, b.id from ${knowledgeDocuments} b where b.id = ${filter.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(...filters))
    .orderBy(desc(knowledgeDocuments.createdAt), desc(knowledgeDocuments.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

export interface DocumentPatch {
  title?: string | undefined;
  folderId?: string | null | undefined;
  status?: KnowledgeDocumentRow['status'] | undefined;
  metadata?: Record<string, unknown> | undefined;
  contentHash?: string | null | undefined;
  lastSyncedAt?: Date | null | undefined;
}

export async function updateDocument(
  db: Database | Tx,
  id: string,
  patch: DocumentPatch,
): Promise<KnowledgeDocumentRow | null> {
  const [row] = await db
    .update(knowledgeDocuments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, id))
    .returning();
  return row ?? null;
}

/** 用户显式删除：级联版本、分块与标签关联，返回是否真的删除了一行。 */
export async function deleteDocument(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeDocuments)
    .where(eq(knowledgeDocuments.id, id))
    .returning({ id: knowledgeDocuments.id });
  return rows.length > 0;
}

/** 外部来源失权/删除：文档置 disabled，不物理删、不参与检索。
 * 归属记在 metadata.knowledgeSourceId（source_id 存的是外部条目 ID），不能按 source_id 过滤。
 */
export async function disableDocumentsBySource(
  db: Database,
  sourceId: string,
): Promise<KnowledgeDocumentRow[]> {
  return db
    .update(knowledgeDocuments)
    .set({ status: 'disabled', updatedAt: new Date() })
    .where(
      and(
        sql`${knowledgeDocuments.metadata}->>'knowledgeSourceId' = ${sourceId}`,
        eq(knowledgeDocuments.status, 'ready'),
      ),
    )
    .returning();
}

export interface CreateVersionInput {
  documentId: string;
  blobSha256: string;
  markdownSha256: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sourceRevision: string | null;
  parseStatus: KnowledgeVersionRow['parseStatus'];
  pageMap: KnowledgeVersionRow['pageMap'];
  images: KnowledgeVersionRow['images'];
  embeddingProfileId: string;
}

/** 版本号在事务内取 max+1；并发重解析同一文档时唯一索引兜底。 */
export async function createVersion(
  db: Database,
  input: CreateVersionInput,
): Promise<KnowledgeVersionRow> {
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ max: sql<number>`coalesce(max(${knowledgeDocumentVersions.version}), 0)` })
      .from(knowledgeDocumentVersions)
      .where(eq(knowledgeDocumentVersions.documentId, input.documentId));
    const max = last?.max ?? 0;
    const [row] = await tx
      .insert(knowledgeDocumentVersions)
      .values({
        id: newId('knowledgeVersion'),
        version: max + 1,
        ...input,
      })
      .returning();
    if (!row) throw new Error('knowledge version insert returned no row');
    return row;
  });
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
  /** 运行中取消只走 Redis abort；已观察到的 abort 在事务内也拦一次。 */
  isAborted?: (() => boolean) | undefined;
}

/**
 * 版本切换：current_version_id 与 ready 状态同事务写入，旧版本继续保留可回滚。
 * 带 guard 时在同一事务内核对任务仍 running、库仍 active、profile 与配置未变；
 * 运行中取消走 Redis abort，不能只靠这里读 job 行，调用方须先检查 abort。
 * 返回 null 表示守卫拒绝（任务已收尾/abort、库停用或配置变化），不区分原因。
 */
export async function setCurrentVersion(
  db: Database,
  documentId: string,
  versionId: string,
  guard?: PublishGuard,
): Promise<KnowledgeDocumentRow | null> {
  return db.transaction(async (tx) => {
    if (guard) {
      if (guard.isAborted?.()) return null;
      const [job] = await tx
        .select({ status: knowledgeJobs.status })
        .from(knowledgeJobs)
        .where(eq(knowledgeJobs.id, guard.jobId))
        .limit(1);
      if (job?.status !== 'running') return null;
      const [base] = await tx
        .select({
          status: knowledgeBases.status,
          embeddingProfileId: knowledgeBases.embeddingProfileId,
          settings: knowledgeBases.settings,
        })
        .from(knowledgeBases)
        .where(eq(knowledgeBases.id, guard.baseId))
        .limit(1);
      if (base?.status !== 'active' || base.embeddingProfileId !== guard.embeddingProfileId) {
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
    const [row] = await tx
      .update(knowledgeDocuments)
      .set({ currentVersionId: versionId, status: 'ready', updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, documentId))
      .returning();
    return row ?? null;
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
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

export async function deleteVersionsExcept(
  db: Database,
  documentId: string,
  keepVersionId: string,
): Promise<void> {
  await db
    .delete(knowledgeDocumentVersions)
    .where(
      and(
        eq(knowledgeDocumentVersions.documentId, documentId),
        sql`${knowledgeDocumentVersions.id} <> ${keepVersionId}`,
      ),
    );
}

export interface NewChunk {
  ordinal: number;
  kind: KnowledgeChunkRow['kind'];
  heading: string | null;
  content: string;
  searchText: string;
  embedding: number[] | null;
  pageFrom: number | null;
  pageTo: number | null;
  tokenCount: number;
  metadata?: Record<string, unknown>;
}

export async function insertChunks(
  db: Database | Tx,
  input: {
    baseId: string;
    documentId: string;
    versionId: string;
    folderId: string | null;
    chunks: NewChunk[];
  },
): Promise<KnowledgeChunkRow[]> {
  if (input.chunks.length === 0) return [];
  return db
    .insert(knowledgeChunks)
    .values(
      input.chunks.map((chunk) => ({
        id: newId('knowledgeChunk'),
        baseId: input.baseId,
        documentId: input.documentId,
        versionId: input.versionId,
        folderId: input.folderId,
        ...chunk,
      })),
    )
    .returning();
}

/** 重建版本时整批替换：同事务内清空旧 chunk 再插入。 */
export async function replaceChunks(
  db: Database,
  input: {
    baseId: string;
    documentId: string;
    versionId: string;
    folderId: string | null;
    chunks: NewChunk[];
  },
): Promise<KnowledgeChunkRow[]> {
  return db.transaction(async (tx) => {
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.versionId, input.versionId));
    return insertChunks(tx, input);
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
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

/** 展示与导出只需要元数据：显式投影，避免把 1024 维向量读出来。 */
const chunkSummaryColumns = {
  id: knowledgeChunks.id,
  documentId: knowledgeChunks.documentId,
  versionId: knowledgeChunks.versionId,
  ordinal: knowledgeChunks.ordinal,
  kind: knowledgeChunks.kind,
  heading: knowledgeChunks.heading,
  content: knowledgeChunks.content,
  enabled: knowledgeChunks.enabled,
  editedByUser: knowledgeChunks.editedByUser,
  pageFrom: knowledgeChunks.pageFrom,
  pageTo: knowledgeChunks.pageTo,
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
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

/** 人工编辑总数取整版聚合，不能靠分页首页推断（>200 条时会漏）。 */
export async function countEditedChunks(db: Database, versionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.versionId, versionId), eq(knowledgeChunks.editedByUser, true)));
  return row?.count ?? 0;
}

/** 新增分块的序号取整版最大值：分页只读首页会漏掉超出 200 条的尾部。 */
export async function nextChunkOrdinal(db: Database, versionId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${knowledgeChunks.ordinal}), -1)` })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.versionId, versionId));
  return (row?.max ?? -1) + 1;
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

export async function deleteChunk(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeChunks)
    .where(eq(knowledgeChunks.id, id))
    .returning({ id: knowledgeChunks.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// 任务

export interface CreateJobInput {
  type: KnowledgeJobRow['type'];
  baseId: string | null;
  documentId: string | null;
  sourceId: string | null;
  payload: KnowledgeJobPayload;
}

export async function createJob(db: Database, input: CreateJobInput): Promise<KnowledgeJobRow> {
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

export interface ListJobsFilter extends PageOptions {
  baseId?: string;
  status?: KnowledgeJobRow['status'];
}

export async function listJobs(
  db: Database,
  filter: ListJobsFilter = {},
): Promise<Page<KnowledgeJobRow>> {
  const limit = pageLimit(filter);
  const filters: SQL[] = [];
  if (filter.baseId) filters.push(eq(knowledgeJobs.baseId, filter.baseId));
  if (filter.status) filters.push(eq(knowledgeJobs.status, filter.status));
  if (filter.cursor) {
    filters.push(sql`(${knowledgeJobs.createdAt}, ${knowledgeJobs.id}) < (
      select b.created_at, b.id from ${knowledgeJobs} b where b.id = ${filter.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeJobs)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(knowledgeJobs.createdAt), desc(knowledgeJobs.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

/** 条件更新认领：BullMQ 重复投递时只有一个 worker 能把 queued 改成 running。 */
export async function claimJob(db: Database, id: string): Promise<KnowledgeJobRow | null> {
  const [row] = await db
    .update(knowledgeJobs)
    .set({
      status: 'running',
      startedAt: new Date(),
      attempts: sql`${knowledgeJobs.attempts} + 1`,
    })
    .where(and(eq(knowledgeJobs.id, id), eq(knowledgeJobs.status, 'queued')))
    .returning();
  return row ?? null;
}

export interface FinishJobInput {
  status: Extract<KnowledgeJobRow['status'], 'succeeded' | 'failed' | 'cancelled'>;
  error?: string | null;
  step?: string | null;
  progress?: number;
}

/** 终态只写一次：非 running 的行不会被覆盖。 */
export async function finishJob(
  db: Database,
  id: string,
  input: FinishJobInput,
): Promise<KnowledgeJobRow | null> {
  const [row] = await db
    .update(knowledgeJobs)
    .set({
      status: input.status,
      error: input.error ?? null,
      step: input.step ?? null,
      progress: input.progress ?? 100,
      endedAt: new Date(),
    })
    .where(and(eq(knowledgeJobs.id, id), eq(knowledgeJobs.status, 'running')))
    .returning();
  return row ?? null;
}

/** 只取消仍未开始的 job；运行中的取消由 worker 侧 cancel key + AbortController 完成。 */
export async function requestCancel(db: Database, id: string): Promise<KnowledgeJobRow | null> {
  const [row] = await db
    .update(knowledgeJobs)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(and(eq(knowledgeJobs.id, id), eq(knowledgeJobs.status, 'queued')))
    .returning();
  return row ?? null;
}
// ---------------------------------------------------------------------------
// 外部来源 / 同步

export interface CreateSourceInput {
  baseId: string;
  type: KnowledgeSourceRow['type'];
  name: string;
  config: Record<string, unknown>;
  secretsEncrypted: string | null;
  syncCron: string | null;
}

export async function createSource(
  db: Database,
  input: CreateSourceInput,
): Promise<KnowledgeSourceRow> {
  const [row] = await db
    .insert(knowledgeSources)
    .values({ id: newId('knowledgeSource'), ...input })
    .returning();
  if (!row) throw new Error('knowledge source insert returned no row');
  return row;
}

export async function getSource(db: Database, id: string): Promise<KnowledgeSourceRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, id))
    .limit(1);
  return row ?? null;
}

export async function listSources(
  db: Database,
  baseId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeSourceRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeSources.baseId, baseId)];
  if (options.cursor) {
    filters.push(sql`(${knowledgeSources.createdAt}, ${knowledgeSources.id}) < (
      select b.created_at, b.id from ${knowledgeSources} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(and(...filters))
    .orderBy(desc(knowledgeSources.createdAt), desc(knowledgeSources.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

export interface SourcePatch {
  name?: string | undefined;
  config?: Record<string, unknown> | undefined;
  secretsEncrypted?: string | null | undefined;
  status?: KnowledgeSourceRow['status'] | undefined;
  syncCron?: string | null | undefined;
  cursor?: Record<string, unknown> | undefined;
  lastSyncAt?: Date | null | undefined;
  lastSyncStatus?: string | null | undefined;
  lastError?: string | null | undefined;
}

export async function updateSource(
  db: Database,
  id: string,
  patch: SourcePatch,
): Promise<KnowledgeSourceRow | null> {
  const [row] = await db
    .update(knowledgeSources)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeSources.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSource(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeSources)
    .where(eq(knowledgeSources.id, id))
    .returning({ id: knowledgeSources.id });
  return rows.length > 0;
}

export interface RangeInput {
  kind: KnowledgeSourceRangeRow['kind'];
  externalId: string;
  ref: string | null;
  paths: string[];
  enabled: boolean;
}

export async function replaceRanges(
  db: Database,
  sourceId: string,
  ranges: RangeInput[],
): Promise<KnowledgeSourceRangeRow[]> {
  return db.transaction(async (tx) => {
    await tx.delete(knowledgeSourceRanges).where(eq(knowledgeSourceRanges.sourceId, sourceId));
    if (ranges.length === 0) return [];
    return tx
      .insert(knowledgeSourceRanges)
      .values(
        ranges.map((range) => ({
          id: newId('knowledgeSourceRange'),
          sourceId,
          ...range,
        })),
      )
      .returning();
  });
}

export async function listRanges(
  db: Database,
  sourceId: string,
): Promise<KnowledgeSourceRangeRow[]> {
  return db
    .select()
    .from(knowledgeSourceRanges)
    .where(eq(knowledgeSourceRanges.sourceId, sourceId))
    .orderBy(asc(knowledgeSourceRanges.id));
}

export async function createSyncRun(
  db: Database,
  sourceId: string,
  cursorBefore: Record<string, unknown> | null,
): Promise<KnowledgeSyncRunRow> {
  const [row] = await db
    .insert(knowledgeSyncRuns)
    .values({
      id: newId('knowledgeSyncRun'),
      sourceId,
      status: 'running',
      startedAt: new Date(),
      cursorBefore,
    })
    .returning();
  if (!row) throw new Error('knowledge sync run insert returned no row');
  return row;
}

export interface FinishSyncRunInput {
  status: Extract<KnowledgeSyncRunRow['status'], 'succeeded' | 'failed' | 'cancelled'>;
  cursorAfter?: Record<string, unknown> | null;
  stats?: KnowledgeSyncRunRow['stats'];
  error?: string | null;
}

export async function finishSyncRun(
  db: Database,
  id: string,
  input: FinishSyncRunInput,
): Promise<KnowledgeSyncRunRow | null> {
  const [row] = await db
    .update(knowledgeSyncRuns)
    .set({
      status: input.status,
      endedAt: new Date(),
      cursorAfter: input.cursorAfter ?? null,
      ...(input.stats ? { stats: input.stats } : {}),
      error: input.error ?? null,
    })
    .where(eq(knowledgeSyncRuns.id, id))
    .returning();
  return row ?? null;
}

export async function listSyncRuns(
  db: Database,
  sourceId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeSyncRunRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeSyncRuns.sourceId, sourceId)];
  if (options.cursor) {
    filters.push(sql`(${knowledgeSyncRuns.createdAt}, ${knowledgeSyncRuns.id}) < (
      select b.created_at, b.id from ${knowledgeSyncRuns} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeSyncRuns)
    .where(and(...filters))
    .orderBy(desc(knowledgeSyncRuns.createdAt), desc(knowledgeSyncRuns.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

// ---------------------------------------------------------------------------
// Wiki

export async function createWikiPage(
  db: Database,
  input: { baseId: string; slug: string; title: string },
): Promise<KnowledgeWikiPageRow> {
  const [row] = await db
    .insert(knowledgeWikiPages)
    .values({ id: newId('knowledgeWikiPage'), ...input })
    .returning();
  if (!row) throw new Error('knowledge wiki page insert returned no row');
  return row;
}

export async function getWikiPage(
  db: Database | Tx,
  id: string,
): Promise<KnowledgeWikiPageRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeWikiPages)
    .where(eq(knowledgeWikiPages.id, id))
    .limit(1);
  return row ?? null;
}

export async function listWikiPages(
  db: Database,
  baseId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeWikiPageRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeWikiPages.baseId, baseId)];
  if (options.cursor) {
    filters.push(sql`(${knowledgeWikiPages.createdAt}, ${knowledgeWikiPages.id}) < (
      select b.created_at, b.id from ${knowledgeWikiPages} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeWikiPages)
    .where(and(...filters))
    .orderBy(desc(knowledgeWikiPages.createdAt), desc(knowledgeWikiPages.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

export interface SaveWikiVersionInput {
  markdown: string;
  sourceChunkIds: string[];
  model: string;
  generatedBy: KnowledgeWikiVersionRow['generatedBy'];
  /** 人工编辑时的乐观锁：页面当前版本已变则 409，避免静默覆盖别人刚发布的内容。 */
  expectedVersion?: string | null;
  /** 版本来源关系（可选）；仅在该版本成为当前版本时替换。 */
  sources?: Array<{ documentId: string | null; versionId: string | null; chunkId: string | null }>;
}

/**
 * 页面有已发布内容（stale 仍指向已发布版本）。draft 表示当前版本尚未发布；
 * 不能用「current 非空」推断，否则首个 SDK 草稿会被误当成已发布。
 */
function hasPublishedVersion(page: KnowledgeWikiPageRow): boolean {
  return page.currentVersionId !== null && (page.status === 'published' || page.status === 'stale');
}

/**
 * 来源必须仍可读且是文档当前版本：chunk 未禁用、文档 ready、
 * chunk.versionId 等于文档 currentVersionId（旧版本的 chunk 不能再当证据）。
 * 缺失或已撤权的 id 单独计数，由调用方决定拒绝发布还是标 stale。
 */
async function usableSourceChunks(
  tx: Tx,
  page: KnowledgeWikiPageRow,
  chunkIds: string[],
): Promise<{
  usable: Array<{ chunkId: string; documentId: string; versionId: string }>;
  unusable: number;
}> {
  const wanted = new Set(chunkIds);
  if (wanted.size === 0) return { usable: [], unusable: 0 };
  const rows = await tx
    .select({
      chunkId: knowledgeChunks.id,
      documentId: knowledgeChunks.documentId,
      versionId: knowledgeChunks.versionId,
    })
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
    .where(
      and(
        eq(knowledgeChunks.baseId, page.baseId),
        inArray(knowledgeChunks.id, [...wanted]),
        eq(knowledgeChunks.enabled, true),
        eq(knowledgeDocuments.status, 'ready'),
        eq(knowledgeChunks.versionId, knowledgeDocuments.currentVersionId),
      ),
    );
  return { usable: rows, unusable: wanted.size - rows.length };
}

/**
 * 追加新版本。sdk 只追加：已发布页面不动 current_version_id/来源关系，
 * 草稿从版本列表人工发布；未发布页面才把草稿设为当前版本。
 * 人工编辑等于发布：沿用上一版来源；来源已撤权时仍保存，但页面保持 stale。
 */
export async function saveWikiVersion(
  db: Database,
  pageId: string,
  input: SaveWikiVersionInput,
): Promise<KnowledgeWikiVersionRow | null> {
  return db.transaction(async (tx) => {
    const [page] = await tx
      .select()
      .from(knowledgeWikiPages)
      .where(eq(knowledgeWikiPages.id, pageId))
      .for('update');
    if (!page) return null;
    if (
      input.expectedVersion !== undefined &&
      (page.currentVersionId ?? null) !== input.expectedVersion
    ) {
      throw new AppError('CONFLICT_STALE', 'Wiki 页面已被修改，请刷新后重试');
    }
    const becomesCurrent = input.generatedBy === 'manual' || !hasPublishedVersion(page);
    let manualSources: Array<{ chunkId: string; documentId: string; versionId: string }> | null =
      null;
    let sourcesRevoked = false;
    if (becomesCurrent && input.generatedBy === 'manual') {
      const checked = await usableSourceChunks(tx, page, input.sourceChunkIds);
      // 人工改稿照常保存，但来源被撤权时页面保持 stale，别把撤权悄悄洗成正常发布。
      sourcesRevoked = checked.unusable > 0;
      manualSources = checked.usable;
    }

    const [last] = await tx
      .select({ max: sql<number>`coalesce(max(${knowledgeWikiVersions.version}), 0)` })
      .from(knowledgeWikiVersions)
      .where(eq(knowledgeWikiVersions.pageId, pageId));
    const max = last?.max ?? 0;
    const [version] = await tx
      .insert(knowledgeWikiVersions)
      .values({
        id: newId('knowledgeWikiVersion'),
        pageId,
        version: max + 1,
        markdown: input.markdown,
        sourceChunkIds: input.sourceChunkIds,
        model: input.model,
        generatedBy: input.generatedBy,
      })
      .returning();
    if (!version) throw new Error('knowledge wiki version insert returned no row');

    if (becomesCurrent) {
      await tx
        .update(knowledgeWikiPages)
        .set({
          currentVersionId: version.id,
          status: input.generatedBy !== 'sdk' ? (sourcesRevoked ? 'stale' : 'published') : 'draft',
          updatedAt: new Date(),
        })
        .where(eq(knowledgeWikiPages.id, pageId));
      const sources = manualSources ?? input.sources;
      if (sources !== undefined) {
        await tx.delete(knowledgeWikiSources).where(eq(knowledgeWikiSources.pageId, pageId));
        if (sources.length > 0) {
          await tx
            .insert(knowledgeWikiSources)
            .values(sources.map((source) => ({ pageId, ...source, stale: false })));
        }
      }
    }
    return version;
  });
}

/**
 * 发布指定版本：只切指针，不复制内容。来源必须仍可检索，
 * 否则 409——草稿不能绕过来源撤权。
 */
export async function publishWikiVersion(
  db: Database,
  pageId: string,
  versionId: string,
): Promise<KnowledgeWikiPageRow | null> {
  return db.transaction(async (tx) => {
    const [page] = await tx
      .select()
      .from(knowledgeWikiPages)
      .where(eq(knowledgeWikiPages.id, pageId))
      .for('update');
    if (!page) return null;
    const [version] = await tx
      .select()
      .from(knowledgeWikiVersions)
      .where(and(eq(knowledgeWikiVersions.id, versionId), eq(knowledgeWikiVersions.pageId, pageId)))
      .limit(1);
    if (!version) return null;

    const checked = await usableSourceChunks(tx, page, version.sourceChunkIds);
    if (checked.unusable > 0) {
      throw new AppError('CONFLICT', '草稿引用的来源已删除或禁用，请重新生成后再发布');
    }
    const [row] = await tx
      .update(knowledgeWikiPages)
      .set({ currentVersionId: version.id, status: 'published', updatedAt: new Date() })
      .where(eq(knowledgeWikiPages.id, pageId))
      .returning();
    await tx.delete(knowledgeWikiSources).where(eq(knowledgeWikiSources.pageId, pageId));
    if (checked.usable.length > 0) {
      await tx
        .insert(knowledgeWikiSources)
        .values(checked.usable.map((source) => ({ pageId, ...source, stale: false })));
    }
    return row ?? null;
  });
}

/** 回退 = 复制目标版本内容成新版本并发布，历史版本不删。 */
export async function rollbackWikiPage(
  db: Database,
  pageId: string,
  versionId: string,
): Promise<KnowledgeWikiVersionRow | null> {
  const [source] = await db
    .select()
    .from(knowledgeWikiVersions)
    .where(and(eq(knowledgeWikiVersions.id, versionId), eq(knowledgeWikiVersions.pageId, pageId)))
    .limit(1);
  if (!source) return null;
  return saveWikiVersion(db, pageId, {
    markdown: source.markdown,
    sourceChunkIds: source.sourceChunkIds,
    model: source.model,
    generatedBy: 'manual',
  });
}

export async function listWikiVersions(
  db: Database,
  pageId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeWikiVersionRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeWikiVersions.pageId, pageId)];
  if (options.cursor) {
    filters.push(sql`(${knowledgeWikiVersions.createdAt}, ${knowledgeWikiVersions.id}) < (
      select b.created_at, b.id from ${knowledgeWikiVersions} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeWikiVersions)
    .where(and(...filters))
    .orderBy(desc(knowledgeWikiVersions.createdAt), desc(knowledgeWikiVersions.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

/**
 * 文档删除/禁用/更新后，引用它的 Wiki 页来源标 stale，供人工确认后重生成。
 * 只有已发布（含已 stale）页面改 status：从未发布的草稿保持 draft，
 * 否则「是否发布过」会与新鲜度混成一个状态而被误判。
 */
export async function markWikiStaleByDocument(db: Database, documentId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const staleRows = await tx
      .update(knowledgeWikiSources)
      .set({ stale: true })
      .where(eq(knowledgeWikiSources.documentId, documentId))
      .returning({ pageId: knowledgeWikiSources.pageId });
    const pageIds = [...new Set(staleRows.map((row) => row.pageId))];
    if (pageIds.length === 0) return 0;
    await tx
      .update(knowledgeWikiPages)
      .set({ status: 'stale', updatedAt: new Date() })
      .where(
        and(
          inArray(knowledgeWikiPages.id, pageIds),
          inArray(knowledgeWikiPages.status, ['published', 'stale']),
        ),
      );
    // 计数按「有引用被标 stale 的页面」，未发布草稿同样包含在内。
    return pageIds.length;
  });
}

// ---------------------------------------------------------------------------
// 模型 profile

export interface CreateModelProfileInput {
  kind: KnowledgeModelProfileRow['kind'];
  name: string;
  endpointUrl: string;
  model: string;
  dimensions: number | null;
  /** 缺省交给列默认值：openai / false。 */
  embeddingProtocol?: KnowledgeModelProfileRow['embeddingProtocol'];
  imageInputEnabled?: boolean;
  secretsEncrypted: string | null;
  enabled: boolean;
}

export async function createModelProfile(
  db: Database,
  input: CreateModelProfileInput,
): Promise<KnowledgeModelProfileRow> {
  const [row] = await db
    .insert(knowledgeModelProfiles)
    .values({ id: newId('knowledgeModelProfile'), ...input })
    .returning();
  if (!row) throw new Error('knowledge model profile insert returned no row');
  return row;
}

export type ModelProfileListRow = Omit<KnowledgeModelProfileRow, 'secretsEncrypted'> & {
  hasSecret: boolean;
};

/** 列表不带密文，只回 hasSecret；API 可直接返回。 */
export async function listModelProfiles(db: Database): Promise<ModelProfileListRow[]> {
  const rows = await db
    .select({
      id: knowledgeModelProfiles.id,
      kind: knowledgeModelProfiles.kind,
      name: knowledgeModelProfiles.name,
      endpointUrl: knowledgeModelProfiles.endpointUrl,
      model: knowledgeModelProfiles.model,
      dimensions: knowledgeModelProfiles.dimensions,
      embeddingProtocol: knowledgeModelProfiles.embeddingProtocol,
      imageInputEnabled: knowledgeModelProfiles.imageInputEnabled,
      enabled: knowledgeModelProfiles.enabled,
      createdAt: knowledgeModelProfiles.createdAt,
      updatedAt: knowledgeModelProfiles.updatedAt,
      hasSecret: sql<boolean>`${knowledgeModelProfiles.secretsEncrypted} is not null`,
    })
    .from(knowledgeModelProfiles)
    .orderBy(asc(knowledgeModelProfiles.kind), asc(knowledgeModelProfiles.name));
  return rows;
}

/** worker/API 内部解密用；永不直接回传。 */
export async function getModelProfileWithSecret(
  db: Database,
  id: string,
): Promise<KnowledgeModelProfileRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeModelProfiles)
    .where(eq(knowledgeModelProfiles.id, id))
    .limit(1);
  return row ?? null;
}

export interface ModelProfilePatch {
  name?: string | undefined;
  endpointUrl?: string | undefined;
  model?: string | undefined;
  dimensions?: number | null | undefined;
  embeddingProtocol?: KnowledgeModelProfileRow['embeddingProtocol'] | undefined;
  imageInputEnabled?: boolean | undefined;
  secretsEncrypted?: string | null | undefined;
  enabled?: boolean | undefined;
}

export async function updateModelProfile(
  db: Database,
  id: string,
  patch: ModelProfilePatch,
): Promise<KnowledgeModelProfileRow | null> {
  const [row] = await db
    .update(knowledgeModelProfiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeModelProfiles.id, id))
    .returning();
  return row ?? null;
}
