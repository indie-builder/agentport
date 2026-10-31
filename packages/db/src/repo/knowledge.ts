import { AppError } from '@agentport/core';
import {
  type KnowledgeBaseSettings,
  type KnowledgeFaq,
  type KnowledgeFaqImportMetadata,
  type KnowledgeFaqImportMode,
  type KnowledgeFaqImportState,
  type KnowledgeJobPayload,
  type KnowledgeLocator,
  type KnowledgeSourceProbeResult,
  knowledgeBaseSettingsSchema,
  knowledgeFaqImportMetadataSchema,
  knowledgeJobPayloadSchema,
} from '@agentport/shared';
import { and, asc, desc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import {
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocumentSourceRanges,
  knowledgeDocuments,
  knowledgeDocumentTags,
  knowledgeDocumentVersions,
  knowledgeFolders,
  knowledgeJobs,
  knowledgeModelProfiles,
  knowledgeSourceRanges,
  knowledgeSources,
  knowledgeSyncItems,
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
export type KnowledgeSyncItemRow = typeof knowledgeSyncItems.$inferSelect;
export type KnowledgeWikiPageRow = typeof knowledgeWikiPages.$inferSelect;
export type KnowledgeWikiVersionRow = typeof knowledgeWikiVersions.$inferSelect;
export type KnowledgeModelProfileRow = typeof knowledgeModelProfiles.$inferSelect;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** 一次成功读取看到的来源授权；凭证只保留密文，仅在内存中传递。 */
export type SourceReadSnapshot = {
  sourceId: string;
  baseId: string;
  type: KnowledgeSourceRow['type'];
  config: Record<string, unknown>;
  secretsEncrypted: string | null;
  ranges: Array<
    Pick<KnowledgeSourceRangeRow, 'id' | 'kind' | 'externalId' | 'ref' | 'paths' | 'enabled'>
  >;
};

export type SourceDocumentPatch = Pick<
  KnowledgeDocumentRow,
  'title' | 'sourceUrl' | 'sourcePath' | 'mimeType' | 'sizeBytes' | 'metadata'
>;

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

/**
 * 外部文档可读的 SQL 判定：来源存在且 active/paused，且至少一条启用范围覆盖条目路径。
 * 检索、单条读取与列表共用这一处，避免各自实现一套授权。alias 是调用方 SQL 中的文档别名。
 */
export function readableDocumentSql(alias: string): SQL {
  const d = sql.raw(alias);
  return sql`${d}.status = 'ready'
    and ${d}.current_version_id is not null
    and ${d}.disabled_reason is null
    and (${d}.source_connection_id is null or exists (
      select 1 from knowledge_sources s
      where s.id = ${d}.source_connection_id
        and s.base_id = ${d}.base_id
        and s.status in ('active', 'paused')
        and exists (
          select 1 from knowledge_document_source_ranges dsr
          join knowledge_source_ranges r on r.id = dsr.range_id
          where dsr.document_id = ${d}.id
            and r.source_id = s.id
            and r.enabled
            and (
              jsonb_array_length(r.paths) = 0
              or (${d}.source_path is not null and exists (
                select 1 from jsonb_array_elements_text(r.paths) p
                where ${d}.source_path = p
                  or left(${d}.source_path, char_length(p) + 1) = p || '/'
              ))
            )
        )
    ))`;
}

/** 发布前只核对来源/范围授权；文档自身的 ready/current 由发布动作建立。 */
async function sourceScopeAllowsDocument(
  db: Database | Tx,
  document: KnowledgeDocumentRow,
): Promise<boolean> {
  if (document.sourceConnectionId === null) return true;
  const pathClause =
    document.sourcePath === null
      ? sql`false`
      : sql`(${document.sourcePath} = p or left(${document.sourcePath}, char_length(p) + 1) = p || '/')`;
  const result = await db.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from knowledge_sources s
      where s.id = ${document.sourceConnectionId}
        and s.base_id = ${document.baseId}
        and s.status in ('active', 'paused')
        and exists (
          select 1 from knowledge_document_source_ranges dsr
          join knowledge_source_ranges r on r.id = dsr.range_id
          where dsr.document_id = ${document.id}
            and r.source_id = s.id
            and r.enabled
            and (jsonb_array_length(r.paths) = 0 or exists (
              select 1 from jsonb_array_elements_text(r.paths) p where ${pathClause}
            ))
        )
    ) as ok
  `);
  return result.rows[0]?.ok === true;
}

/** 读来源授权快照：source FOR SHARE 后再读全部范围，调用方只消费这一份一致视图。 */
export async function getSourceReadSnapshot(
  db: Database,
  sourceId: string,
): Promise<{ source: KnowledgeSourceRow; snapshot: SourceReadSnapshot } | null> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .for('share');
    if (!source) return null;
    const ranges = await tx
      .select({
        id: knowledgeSourceRanges.id,
        kind: knowledgeSourceRanges.kind,
        externalId: knowledgeSourceRanges.externalId,
        ref: knowledgeSourceRanges.ref,
        paths: knowledgeSourceRanges.paths,
        enabled: knowledgeSourceRanges.enabled,
      })
      .from(knowledgeSourceRanges)
      .where(eq(knowledgeSourceRanges.sourceId, sourceId))
      .orderBy(asc(knowledgeSourceRanges.id));
    return {
      source,
      snapshot: {
        sourceId: source.id,
        baseId: source.baseId,
        type: source.type,
        config: source.config,
        secretsEncrypted: source.secretsEncrypted,
        ranges,
      },
    };
  });
}

/**
 * 快照仍与线上来源一致：在 source 共享锁下比较 type/baseId/config/密文与全部范围。
 * config 用 jsonb 相等（忽略键顺序）；范围按 id 与字段逐一比较，忽略时间戳。
 */
async function sourceSnapshotMatchesTx(tx: Tx, snapshot: SourceReadSnapshot): Promise<boolean> {
  const [source] = await tx
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.id, snapshot.sourceId),
        eq(knowledgeSources.status, 'active'),
        eq(knowledgeSources.baseId, snapshot.baseId),
        eq(knowledgeSources.type, snapshot.type),
        sql`${knowledgeSources.config} = ${JSON.stringify(snapshot.config)}::jsonb`,
        sql`${knowledgeSources.secretsEncrypted} is not distinct from ${snapshot.secretsEncrypted}`,
      ),
    )
    .for('share')
    .limit(1);
  if (!source) return false;
  const ranges = await tx
    .select({
      id: knowledgeSourceRanges.id,
      kind: knowledgeSourceRanges.kind,
      externalId: knowledgeSourceRanges.externalId,
      ref: knowledgeSourceRanges.ref,
      paths: knowledgeSourceRanges.paths,
      enabled: knowledgeSourceRanges.enabled,
    })
    .from(knowledgeSourceRanges)
    .where(eq(knowledgeSourceRanges.sourceId, snapshot.sourceId))
    .orderBy(asc(knowledgeSourceRanges.id));
  if (ranges.length !== snapshot.ranges.length) return false;
  return ranges.every((range, index) => {
    const expected = snapshot.ranges[index];
    return (
      expected !== undefined &&
      range.id === expected.id &&
      range.kind === expected.kind &&
      range.externalId === expected.externalId &&
      range.ref === expected.ref &&
      range.enabled === expected.enabled &&
      JSON.stringify(range.paths) === JSON.stringify(expected.paths)
    );
  });
}

function rangeCoversSourcePath(
  range: Pick<KnowledgeSourceRangeRow, 'paths'>,
  sourcePath: string | null,
): boolean {
  if (range.paths.length === 0) return true;
  if (sourcePath === null) return false;
  return range.paths.some((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`));
}

/** 草稿只能由同文档、同库、已成功的 draft ingest 任务发布，且任务输入必须就是该版本。 */
async function draftIndexJobAllowsVersionTx(
  tx: Tx,
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
  /** 绑定音频转录模型时必须存在、kind=asr 且启用；null 表示关闭。 */
  asrProfileId?: string | null | undefined;
  settings: KnowledgeBaseSettings;
}

/** ASR 绑定与 embedding/rerank 同一条规则：换绑只能指向存在、类型正确且启用的 profile。 */
async function assertUsableAsrProfile(db: Database, profileId: string): Promise<void> {
  const [profile] = await db
    .select({
      kind: knowledgeModelProfiles.kind,
      enabled: knowledgeModelProfiles.enabled,
    })
    .from(knowledgeModelProfiles)
    .where(eq(knowledgeModelProfiles.id, profileId))
    .limit(1);
  if (profile?.kind !== 'asr' || !profile.enabled) {
    throw new AppError('INVALID_INPUT', 'ASR profile 不存在、类型不符或已禁用');
  }
}

export async function createBase(db: Database, input: CreateBaseInput): Promise<KnowledgeBaseRow> {
  if (input.asrProfileId !== null && input.asrProfileId !== undefined) {
    await assertUsableAsrProfile(db, input.asrProfileId);
  }
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
  /** undefined 保持，null 关闭，非空 ID 必须是启用的 ASR profile。 */
  asrProfileId?: string | null | undefined;
  settings?: KnowledgeBaseSettings | undefined;
}

export async function updateBase(
  db: Database,
  id: string,
  patch: BasePatch,
): Promise<KnowledgeBaseRow | null> {
  if (patch.asrProfileId !== null && patch.asrProfileId !== undefined) {
    await assertUsableAsrProfile(db, patch.asrProfileId);
  }
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

export async function upsertTags(
  db: Database | Tx,
  baseId: string,
  names: string[],
): Promise<KnowledgeTagRow[]> {
  if (names.length === 0) return [];
  const unique = [...new Set(names)];
  const rows: KnowledgeTagRow[] = [];
  for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
    rows.push(
      ...(await db
        .insert(knowledgeTags)
        .values(
          unique
            .slice(i, i + INSERT_CHUNK)
            .map((name) => ({ id: newId('knowledgeTag'), baseId, name })),
        )
        .onConflictDoNothing()
        .returning()),
    );
  }
  const returned = new Set(rows.map((row) => row.name));
  const missing = unique.filter((name) => !returned.has(name));
  if (missing.length > 0) {
    rows.push(
      ...(await db
        .select()
        .from(knowledgeTags)
        .where(and(eq(knowledgeTags.baseId, baseId), inArray(knowledgeTags.name, missing)))),
    );
  }
  const byName = new Map(rows.map((row) => [row.name, row]));
  return unique.map((name) => {
    const row = byName.get(name);
    if (!row) throw new Error('knowledge tag upsert lost its row');
    return row;
  });
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
  contentKind?: KnowledgeDocumentRow['contentKind'];
  disabledReason?: KnowledgeDocumentRow['disabledReason'];
  sourceConnectionId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createDocument(
  db: Database | Tx,
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
  /** 精确匹配 sourceConnectionId（同步删除推导内部使用）。 */
  sourceConnectionId?: string;
  /** 普通文档列表传 'document'，FAQ 专用列表传 'faq'，避免 Wiki 内部索引混入。 */
  contentKind?: KnowledgeDocumentRow['contentKind'];
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
  if (filter.sourceConnectionId) {
    filters.push(eq(knowledgeDocuments.sourceConnectionId, filter.sourceConnectionId));
  }
  if (filter.contentKind) {
    filters.push(eq(knowledgeDocuments.contentKind, filter.contentKind));
  }
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
  disabledReason?: KnowledgeDocumentRow['disabledReason'] | undefined;
  sourceConnectionId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  contentHash?: string | null | undefined;
  lastSyncedAt?: Date | null | undefined;
  currentVersionId?: string | null | undefined;
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

/** 管理端/MCP 直接读取：必须同库、非 Wiki 内部索引，且来源/范围仍授权。 */
export async function getReadableDocument(
  db: Database,
  baseId: string,
  documentId: string,
): Promise<KnowledgeDocumentRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.baseId, baseId),
        sql`${knowledgeDocuments.contentKind} <> 'wiki'`,
        readableDocumentSql('knowledge_documents'),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface ListReadableDocumentsFilter extends PageOptions {
  kinds?: Array<Extract<KnowledgeDocumentRow['contentKind'], 'document' | 'faq'>>;
}

/** knowledge_list 的文档/FAQ 分页；Wiki 由 listReadableWikiPages 单独提供。 */
export async function listReadableDocuments(
  db: Database,
  baseId: string,
  filter: ListReadableDocumentsFilter = {},
): Promise<Page<KnowledgeDocumentRow>> {
  const limit = pageLimit(filter);
  const filters: SQL[] = [
    eq(knowledgeDocuments.baseId, baseId),
    sql`${knowledgeDocuments.contentKind} <> 'wiki'`,
    readableDocumentSql('knowledge_documents'),
  ];
  const kinds = filter.kinds ?? ['document', 'faq'];
  filters.push(inArray(knowledgeDocuments.contentKind, kinds));
  if (filter.cursor) {
    filters.push(sql`(${knowledgeDocuments.updatedAt}, ${knowledgeDocuments.id}) < (
      select b.updated_at, b.id from ${knowledgeDocuments} b where b.id = ${filter.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(...filters))
    .orderBy(desc(knowledgeDocuments.updatedAt), desc(knowledgeDocuments.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

/** 外部来源失权/删除：文档置 disabled，不物理删、不参与检索。
 * 人工停用原因不被来源同步覆盖；归属只看 source_connection_id。
 */
export async function disableDocumentsBySource(
  db: Database,
  sourceId: string,
): Promise<KnowledgeDocumentRow[]> {
  return db
    .update(knowledgeDocuments)
    .set({
      status: 'disabled',
      disabledReason: sql`coalesce(${knowledgeDocuments.disabledReason}, 'source')`,
      updatedAt: new Date(),
    })
    .where(eq(knowledgeDocuments.sourceConnectionId, sourceId))
    .returning();
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
  db: Database | Tx,
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
      if ((document.currentVersionId ?? null) !== guard.expectedCurrentVersionId) return null;
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
    if ((document.currentVersionId ?? null) !== input.expectedVersionId) {
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
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
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

/** 单条 INSERT 的绑定参数上限是 65535；按 500 行分段，远低于该上限。 */
const INSERT_CHUNK = 500;

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
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
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
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

/** 人工编辑总数取整版聚合，不能靠分页首页推断（>200 条时会漏）。 */
export async function countEditedChunks(db: Database, versionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.versionId, versionId), eq(knowledgeChunks.editedByUser, true)));
  if ((row?.count ?? 0) > 0) return row?.count ?? 0;
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
  tx: Tx,
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
  return result.rows.map((row) => ({
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
    const coverageIds = new Set(coverage.rows.map((row) => row.documentId));
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
      if ((document.currentVersionId ?? null) !== item.expectedVersionId) {
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
        if ((document.currentVersionId ?? null) !== target.currentVersionId) {
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
      const [row] = await tx
        .update(knowledgeDocuments)
        .set({
          currentVersionId: item.versionId,
          // 切指针同时更新正文指纹，避免沿用上一版 contentHash。
          contentHash: version.blobSha256,
          status: metadata.enabled ? 'ready' : 'disabled',
          disabledReason: metadata.enabled ? null : 'manual',
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

// ---------------------------------------------------------------------------
// 任务

export interface CreateJobInput {
  type: KnowledgeJobRow['type'];
  baseId: string | null;
  documentId: string | null;
  sourceId: string | null;
  payload: KnowledgeJobPayload;
  result?: KnowledgeSourceProbeResult | null;
}

export async function createJob(
  db: Database | Tx,
  input: CreateJobInput,
): Promise<KnowledgeJobRow> {
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
  documentId?: string;
  status?: KnowledgeJobRow['status'];
}

/** 列表只需展示字段：payload 与来源 config 留给 getJob/worker，避免读出整块任务载荷。 */
const jobSummaryColumns = {
  id: knowledgeJobs.id,
  type: knowledgeJobs.type,
  status: knowledgeJobs.status,
  step: knowledgeJobs.step,
  progress: knowledgeJobs.progress,
  attempts: knowledgeJobs.attempts,
  error: knowledgeJobs.error,
  result: knowledgeJobs.result,
  documentId: knowledgeJobs.documentId,
  sourceId: knowledgeJobs.sourceId,
  createdAt: knowledgeJobs.createdAt,
  startedAt: knowledgeJobs.startedAt,
  endedAt: knowledgeJobs.endedAt,
};

export async function listJobs(db: Database, filter: ListJobsFilter = {}) {
  const limit = pageLimit(filter);
  const filters: SQL[] = [];
  if (filter.baseId) filters.push(eq(knowledgeJobs.baseId, filter.baseId));
  if (filter.documentId) filters.push(eq(knowledgeJobs.documentId, filter.documentId));
  if (filter.status) filters.push(eq(knowledgeJobs.status, filter.status));
  if (filter.cursor) {
    filters.push(sql`(${knowledgeJobs.createdAt}, ${knowledgeJobs.id}) < (
      select b.created_at, b.id from ${knowledgeJobs} b where b.id = ${filter.cursor}
    )`);
  }
  const rows = await db
    .select({
      ...jobSummaryColumns,
      documentTitle: knowledgeDocuments.title,
      sourceName: knowledgeSources.name,
    })
    .from(knowledgeJobs)
    .leftJoin(knowledgeDocuments, eq(knowledgeJobs.documentId, knowledgeDocuments.id))
    .leftJoin(knowledgeSources, eq(knowledgeJobs.sourceId, knowledgeSources.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(knowledgeJobs.createdAt), desc(knowledgeJobs.id))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

/** 同步任务的 payload 关联；缺失或与行上的 sourceId 不一致都是跨行数据错误。 */
function syncRefOf(job: KnowledgeJobRow): { syncRunId: string; sourceId: string } {
  const payload = job.payload;
  if (
    payload.type !== 'sync' ||
    typeof payload.syncRunId !== 'string' ||
    payload.syncRunId === ''
  ) {
    throw new Error(`knowledge sync job ${job.id} has no syncRunId`);
  }
  if (
    job.sourceId === null ||
    (payload.sourceId !== undefined && payload.sourceId !== job.sourceId)
  ) {
    throw new Error(`knowledge sync job ${job.id} has an invalid sourceId`);
  }
  return { syncRunId: payload.syncRunId, sourceId: job.sourceId };
}

/** 条件更新认领：BullMQ 重复投递时只有一个 worker 能把 queued 改成 running。 */
export async function claimJob(db: Database, id: string): Promise<KnowledgeJobRow | null> {
  return db.transaction(async (tx) => {
    const startedAt = new Date();
    const [row] = await tx
      .update(knowledgeJobs)
      .set({
        status: 'running',
        startedAt,
        attempts: sql`${knowledgeJobs.attempts} + 1`,
      })
      .where(and(eq(knowledgeJobs.id, id), eq(knowledgeJobs.status, 'queued')))
      .returning();
    if (!row) return null;
    if (row.type === 'sync') {
      const { syncRunId, sourceId } = syncRefOf(row);
      // 只有 queued run 需要进入 running；内部重试保持已写入的 startedAt 与检查点。
      const [run] = await tx
        .update(knowledgeSyncRuns)
        .set({
          status: 'running',
          startedAt: sql`coalesce(${knowledgeSyncRuns.startedAt}, ${startedAt})`,
        })
        .where(
          and(
            eq(knowledgeSyncRuns.id, syncRunId),
            eq(knowledgeSyncRuns.sourceId, sourceId),
            inArray(knowledgeSyncRuns.status, ['queued', 'running']),
          ),
        )
        .returning({ id: knowledgeSyncRuns.id });
      if (!run) throw new Error(`sync run ${syncRunId} is not active for job ${row.id}`);
    }
    return row;
  });
}

export interface SyncRunResult {
  cursorAfter: Record<string, unknown>;
  stats: KnowledgeSyncRunRow['stats'];
}

export interface FinishJobInput {
  /** 允许转换的唯一前态；排队取消与调度入队失败传 queued。 */
  fromStatus?: Extract<KnowledgeJobRow['status'], 'queued' | 'running'>;
  status: Extract<KnowledgeJobRow['status'], 'succeeded' | 'failed' | 'cancelled'>;
  error?: string | null;
  step?: string | null;
  progress?: number;
  /** 仅成功的 sync 任务必须携带；同一事务写入 run 与 source 游标。 */
  result?: SyncRunResult;
  /** source_probe 的可见结果，不修改 source 游标或同步状态。 */
  probeResult?: KnowledgeSourceProbeResult | null;
}

/**
 * 一个 job 的原子终态提交：job CAS、sync run 终态、source 摘要与成功游标一次提交。
 * 任何后续写入失败都回滚 job，让重投/对账仍能看到活动行。
 */
export async function finishJob(
  db: Database,
  id: string,
  input: FinishJobInput,
): Promise<KnowledgeJobRow | null> {
  const fromStatus = input.fromStatus ?? 'running';
  const syncResult = input.result;
  const probeResult = input.probeResult ?? null;
  return db.transaction(async (tx) => {
    const endedAt = new Date();
    const [row] = await tx
      .update(knowledgeJobs)
      .set({
        status: input.status,
        error: input.error ?? null,
        step: input.step ?? null,
        progress: input.progress ?? 100,
        result: probeResult,
        endedAt,
      })
      .where(and(eq(knowledgeJobs.id, id), eq(knowledgeJobs.status, fromStatus)))
      .returning();
    if (row?.type !== 'sync') return row ?? null;

    const { syncRunId, sourceId } = syncRefOf(row);
    if (input.status === 'succeeded' && !syncResult) {
      throw new Error(`sync job ${row.id} succeeded without cursorAfter`);
    }
    const [run] = await tx
      .update(knowledgeSyncRuns)
      .set({
        status: input.status,
        endedAt,
        error: input.error ?? null,
        ...(input.status === 'succeeded' && syncResult
          ? { cursorAfter: syncResult.cursorAfter, stats: syncResult.stats }
          : {}),
      })
      .where(
        and(
          eq(knowledgeSyncRuns.id, syncRunId),
          eq(knowledgeSyncRuns.sourceId, sourceId),
          inArray(knowledgeSyncRuns.status, ['queued', 'running']),
        ),
      )
      .returning({ id: knowledgeSyncRuns.id });
    if (!run) throw new Error(`sync run ${syncRunId} is not active for job ${row.id}`);

    await tx
      .update(knowledgeSources)
      .set({
        lastSyncAt: endedAt,
        lastSyncStatus: input.status,
        lastError: input.error ?? null,
        updatedAt: endedAt,
        ...(input.status === 'succeeded' && syncResult ? { cursor: syncResult.cursorAfter } : {}),
      })
      .where(eq(knowledgeSources.id, sourceId));
    return row;
  });
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

function rangeKey(range: { kind: string; externalId: string; ref: string | null }): string {
  return `${range.kind}\u0000${range.externalId}\u0000${range.ref ?? ''}`;
}

/** 范围删除/停用/路径收缩后，移除不再被任何有效范围覆盖的条目归属。 */
async function pruneSourceRangeMemberships(tx: Tx, sourceId: string): Promise<void> {
  await tx.execute(sql`
    delete from knowledge_document_source_ranges dsr
    using knowledge_source_ranges r, knowledge_documents d
    where dsr.range_id = r.id
      and dsr.document_id = d.id
      and r.source_id = ${sourceId}
      and (
        d.source_connection_id is distinct from ${sourceId}
        or not (
          r.enabled
          and (
            jsonb_array_length(r.paths) = 0
            or (
              d.source_path is not null
              and exists (
                select 1 from jsonb_array_elements_text(r.paths) p
                where d.source_path = p or left(d.source_path, char_length(p) + 1) = p || '/'
              )
            )
          )
        )
      )
  `);
}

async function replaceRangesTx(
  tx: Tx,
  sourceId: string,
  ranges: RangeInput[],
): Promise<KnowledgeSourceRangeRow[]> {
  const existing = await tx
    .select()
    .from(knowledgeSourceRanges)
    .where(eq(knowledgeSourceRanges.sourceId, sourceId))
    .for('update');
  const byKey = new Map(existing.map((row) => [rangeKey(row), row]));
  const seen = new Set<string>();
  const keepIds = new Set<string>();
  const rows: KnowledgeSourceRangeRow[] = [];
  for (const range of ranges) {
    const key = rangeKey(range);
    if (seen.has(key)) throw new AppError('CONFLICT', '存在重复的来源范围');
    seen.add(key);
    const current = byKey.get(key);
    if (current) {
      const [updated] = await tx
        .update(knowledgeSourceRanges)
        .set({ paths: range.paths, enabled: range.enabled })
        .where(eq(knowledgeSourceRanges.id, current.id))
        .returning();
      if (!updated) throw new Error('knowledge source range update returned no row');
      rows.push(updated);
      keepIds.add(updated.id);
    } else {
      const [inserted] = await tx
        .insert(knowledgeSourceRanges)
        .values({ id: newId('knowledgeSourceRange'), sourceId, ...range })
        .returning();
      if (!inserted) throw new Error('knowledge source range insert returned no row');
      rows.push(inserted);
      keepIds.add(inserted.id);
    }
  }
  const removed = existing.filter((row) => !keepIds.has(row.id)).map((row) => row.id);
  if (removed.length > 0) {
    await tx.delete(knowledgeSourceRanges).where(inArray(knowledgeSourceRanges.id, removed));
  }
  await pruneSourceRangeMemberships(tx, sourceId);
  return rows;
}

/**
 * 按 (sourceId, kind, externalId, ref) 保留范围 ID 更新；删除失效项并按新 paths 重核条目归属。
 * 范围收缩的撤权由 replaceSourceScope 统一完成。
 */
export async function replaceRanges(
  db: Database,
  sourceId: string,
  ranges: RangeInput[],
): Promise<KnowledgeSourceRangeRow[]> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .for('update');
    if (!source) throw new AppError('NOT_FOUND', '来源不存在，可能已被删除');
    return replaceRangesTx(tx, sourceId, ranges);
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

export interface SourceScopePatch {
  name?: string | undefined;
  config?: Record<string, unknown> | undefined;
  secretsEncrypted?: string | null | undefined;
  status?: KnowledgeSourceRow['status'] | undefined;
  syncCron?: string | null | undefined;
  ranges?: RangeInput[] | undefined;
}

export interface SourceScopeResult {
  source: KnowledgeSourceRow;
  ranges: KnowledgeSourceRangeRow[];
  disabledDocumentIds: string[];
}

/**
 * 同一事务内改来源配置/范围并立即撤权：
 * 移除失效归属，停用所有已无有效范围覆盖的文档（含 pending/processing/failed），
 * 并让引用它们的 Wiki 页显式 stale。锁序 source -> document（文档 ID 排序）。
 */
export async function replaceSourceScope(
  db: Database,
  sourceId: string,
  patch: SourceScopePatch,
): Promise<SourceScopeResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .for('update');
    if (!current) throw new AppError('NOT_FOUND', '来源不存在，可能已被删除');

    const fields: Partial<KnowledgeSourceRow> = { updatedAt: new Date() };
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.config !== undefined) fields.config = patch.config;
    if (patch.secretsEncrypted !== undefined) fields.secretsEncrypted = patch.secretsEncrypted;
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.syncCron !== undefined) fields.syncCron = patch.syncCron;
    const [source] = await tx
      .update(knowledgeSources)
      .set(fields)
      .where(eq(knowledgeSources.id, sourceId))
      .returning();
    if (!source) throw new Error('knowledge source update returned no row');

    const ranges =
      patch.ranges === undefined
        ? await tx
            .select()
            .from(knowledgeSourceRanges)
            .where(eq(knowledgeSourceRanges.sourceId, sourceId))
            .orderBy(asc(knowledgeSourceRanges.id))
        : await replaceRangesTx(tx, sourceId, patch.ranges);

    const documents = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceConnectionId, sourceId))
      .orderBy(asc(knowledgeDocuments.id))
      .for('update');
    const covered = await tx.execute<{ id: string }>(sql`
      select distinct dsr.document_id as id
      from knowledge_document_source_ranges dsr
      join knowledge_source_ranges r on r.id = dsr.range_id
      join knowledge_documents d on d.id = dsr.document_id
      where r.source_id = ${sourceId}
        and d.source_connection_id = ${sourceId}
        and r.enabled
        and (
          jsonb_array_length(r.paths) = 0
          or (
            d.source_path is not null
            and exists (
              select 1 from jsonb_array_elements_text(r.paths) p
              where d.source_path = p or left(d.source_path, char_length(p) + 1) = p || '/'
            )
          )
        )
    `);
    const coveredIds = new Set(covered.rows.map((row) => row.id));
    const statusAllowsRead = source.status === 'active' || source.status === 'paused';
    const reason: Exclude<KnowledgeDocumentRow['disabledReason'], null> =
      source.status === 'disabled' ? 'source' : source.status === 'auth_error' ? 'remote' : 'range';
    const disabledDocumentIds: string[] = [];
    for (const document of documents) {
      if (statusAllowsRead && coveredIds.has(document.id)) continue;
      await tx
        .update(knowledgeDocuments)
        .set({
          status: 'disabled',
          disabledReason: document.disabledReason === 'manual' ? 'manual' : reason,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, document.id));
      disabledDocumentIds.push(document.id);
    }
    // 一次汇总本事务受影响的 Wiki 页并按全局页 ID 取锁：逐文档加锁会在双来源交叉引用时形成锁环。
    await markWikiStaleByDocumentsTx(tx, disabledDocumentIds);
    return { source, ranges, disabledDocumentIds };
  });
}

/**
 * 外部条目读取成功后的授权写入：快照、patch、实际范围归属与停用恢复同事务。
 * 锁序 source FOR SHARE -> document FOR UPDATE；快照已失效时零写返回 null。
 */
export async function setDocumentSourceRanges(
  db: Database,
  documentId: string,
  rangeIds: string[],
  snapshot: SourceReadSnapshot,
  patch: SourceDocumentPatch,
): Promise<KnowledgeDocumentRow | null> {
  const unique = [...new Set(rangeIds)];
  return db.transaction(async (tx) => {
    if (!(await sourceSnapshotMatchesTx(tx, snapshot))) return null;
    const [document] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .for('update');
    if (
      !document ||
      document.baseId !== snapshot.baseId ||
      document.sourceConnectionId !== snapshot.sourceId
    ) {
      return null;
    }
    // 只挂该条目实际命中的范围；范围必须仍在快照内且覆盖本次路径。
    const selected: SourceReadSnapshot['ranges'] = [];
    for (const rangeId of unique) {
      const range = snapshot.ranges.find((entry) => entry.id === rangeId);
      if (!range?.enabled) {
        throw new AppError('INVALID_INPUT', '范围不属于该来源的当前快照');
      }
      selected.push(range);
    }
    if (!selected.some((range) => rangeCoversSourcePath(range, patch.sourcePath))) {
      throw new AppError('INVALID_INPUT', '来源范围未覆盖条目路径');
    }
    // 人工停用不因来源同步复活；来源/范围/远端失权由成功读取恢复。
    const manualDisabled = document.disabledReason === 'manual';
    const [row] = await tx
      .update(knowledgeDocuments)
      .set({
        title: patch.title,
        sourceUrl: patch.sourceUrl,
        sourcePath: patch.sourcePath,
        mimeType: patch.mimeType,
        sizeBytes: patch.sizeBytes,
        metadata: patch.metadata,
        lastSyncedAt: new Date(),
        ...(manualDisabled
          ? {}
          : {
              status: document.currentVersionId ? ('ready' as const) : ('processing' as const),
              disabledReason: null,
            }),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, documentId))
      .returning();
    await tx
      .delete(knowledgeDocumentSourceRanges)
      .where(eq(knowledgeDocumentSourceRanges.documentId, documentId));
    await tx
      .insert(knowledgeDocumentSourceRanges)
      .values(unique.map((rangeId) => ({ documentId, rangeId })));
    return row ?? null;
  });
}

export type CreateSyncJobResult =
  | { status: 'created'; job: KnowledgeJobRow; run: KnowledgeSyncRunRow }
  | { status: 'not_found' }
  | { status: 'not_active' }
  | { status: 'in_progress' };

/**
 * 手动、重试与定时触发共用的一次创建事务：来源级 advisory lock + 在途检查后，
 * queued sync run 与 queued job 全有或全无；Redis add 必须等本事务提交后再做。
 */
export async function createSyncJob(db: Database, sourceId: string): Promise<CreateSyncJobResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sourceId}))`);
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .limit(1);
    if (!source) return { status: 'not_found' } as const;
    if (source.status !== 'active') return { status: 'not_active' } as const;
    const [active] = await tx
      .select({ id: knowledgeJobs.id })
      .from(knowledgeJobs)
      .where(
        and(
          eq(knowledgeJobs.sourceId, sourceId),
          inArray(knowledgeJobs.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (active) return { status: 'in_progress' } as const;

    const runId = newId('knowledgeSyncRun');
    const jobId = newId('knowledgeJob');
    const [run] = await tx
      .insert(knowledgeSyncRuns)
      .values({
        id: runId,
        sourceId,
        status: 'queued',
        cursorBefore: source.cursor,
      })
      .returning();
    const [job] = await tx
      .insert(knowledgeJobs)
      .values({
        id: jobId,
        type: 'sync',
        baseId: source.baseId,
        documentId: null,
        sourceId,
        status: 'queued',
        payload: { type: 'sync', sourceId, syncRunId: runId },
      })
      .returning();
    if (!run || !job) throw new Error('knowledge sync pair insert returned no row');
    return { status: 'created', job, run } as const;
  });
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

export interface RecordSyncItemInput {
  syncRunId: string;
  sourceId: string;
  rangeId: string | null;
  externalId: string;
  documentId: string | null;
  status: KnowledgeSyncItemRow['status'];
  code: string;
  message: string;
  retryable: boolean;
}

export async function recordSyncItem(
  db: Database,
  input: RecordSyncItemInput,
): Promise<KnowledgeSyncItemRow> {
  const [row] = await db
    .insert(knowledgeSyncItems)
    .values({ id: newId('knowledgeSyncItem'), ...input })
    .returning();
  if (!row) throw new Error('knowledge sync item insert returned no row');
  return row;
}

export interface ListSyncItemsFilter extends PageOptions {
  status?: KnowledgeSyncItemRow['status'];
}

export async function listSyncItems(
  db: Database,
  syncRunId: string,
  filter: ListSyncItemsFilter = {},
): Promise<Page<KnowledgeSyncItemRow>> {
  const limit = pageLimit(filter);
  const filters: SQL[] = [eq(knowledgeSyncItems.syncRunId, syncRunId)];
  if (filter.status) filters.push(eq(knowledgeSyncItems.status, filter.status));
  if (filter.cursor) {
    filters.push(sql`(${knowledgeSyncItems.createdAt}, ${knowledgeSyncItems.id}) < (
      select b.created_at, b.id from ${knowledgeSyncItems} b where b.id = ${filter.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeSyncItems)
    .where(and(...filters))
    .orderBy(desc(knowledgeSyncItems.createdAt), desc(knowledgeSyncItems.id))
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
  /** 草稿乐观锁：最新草稿版本已变则 409。 */
  expectedVersion?: string | null;
  /** 与正文同事务落库的标题/目录结构；先核 expectedVersion 再写任何字段。 */
  structure?: {
    title?: string;
    slug?: string;
    parentId?: string | null;
    position?: number;
  };
  /** 兼容来源快照入参；发布时以 sourceChunkIds 实际校验结果为准。 */
  sources?: Array<{ documentId: string | null; versionId: string | null; chunkId: string | null }>;
}

/**
 * 来源必须仍可读且是文档当前版本：chunk 未禁用、文档 ready 且来源/范围授权仍有效、
 * chunk.versionId 等于文档 currentVersionId（旧版本 chunk 不能再当证据）。
 */
async function usableSourceChunks(
  tx: Database | Tx,
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
        // Wiki 内部索引不是可授权来源；引用它会把撤权递归洗成新的可见内容。
        sql`${knowledgeDocuments.contentKind} <> 'wiki'`,
        readableDocumentSql('knowledge_documents'),
        eq(knowledgeChunks.versionId, knowledgeDocuments.currentVersionId),
      ),
    );
  return { usable: rows, unusable: wanted.size - rows.length };
}

async function latestWikiVersionId(db: Database | Tx, pageId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: knowledgeWikiVersions.id })
    .from(knowledgeWikiVersions)
    .where(eq(knowledgeWikiVersions.pageId, pageId))
    .orderBy(desc(knowledgeWikiVersions.version))
    .limit(1);
  return row?.id ?? null;
}

/**
 * 保存草稿：只追加版本，不改线上 currentVersionId 与发布状态。
 * sdk/manual 一视同仁；publish/rollback 才切指针并核来源。
 */
export async function saveWikiDraft(
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
    if (input.expectedVersion !== undefined) {
      const latest = await latestWikiVersionId(tx, pageId);
      if (latest !== input.expectedVersion) {
        throw new AppError('CONFLICT_STALE', 'Wiki 页面已被修改，请刷新后重试');
      }
    }
    if (input.structure !== undefined) {
      await applyWikiStructureTx(tx, page, input.structure);
    }
    const [version] = await tx
      .insert(knowledgeWikiVersions)
      .values({
        id: newId('knowledgeWikiVersion'),
        pageId,
        // 版本号在 INSERT 内计算，少一次往返；并发由上面的页面行锁与唯一索引兜底。
        version: sql`(select coalesce(max(${knowledgeWikiVersions.version}), 0) + 1 from ${knowledgeWikiVersions} where ${knowledgeWikiVersions.pageId} = ${pageId})`,
        markdown: input.markdown,
        sourceChunkIds: input.sourceChunkIds,
        model: input.model,
        generatedBy: input.generatedBy,
      })
      .returning();
    if (!version) throw new Error('knowledge wiki version insert returned no row');
    return version;
  });
}

/** 既有调用名沿用；语义已改为「只追加草稿」。 */
export { saveWikiDraft as saveWikiVersion };

/**
 * 与范围撤权统一锁序：先来源、再文档、最后 Wiki 页/关联。
 * 撤权事务按 source -> document -> wiki page -> sources 表写，这里在取完前两级后重核来源。
 */
async function lockWikiSourceScope(tx: Tx, baseId: string, chunkIds: string[]): Promise<void> {
  const wanted = [...new Set(chunkIds)];
  if (wanted.length === 0) return;
  const rows = await tx
    .select({
      documentId: knowledgeChunks.documentId,
      sourceConnectionId: knowledgeDocuments.sourceConnectionId,
    })
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
    .where(and(eq(knowledgeChunks.baseId, baseId), inArray(knowledgeChunks.id, wanted)));
  const sourceIds = [
    ...new Set(
      rows
        .map((row) => row.sourceConnectionId)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ].sort();
  if (sourceIds.length > 0) {
    await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(inArray(knowledgeSources.id, sourceIds))
      .orderBy(asc(knowledgeSources.id))
      .for('share');
  }
  const documentIds = [...new Set(rows.map((row) => row.documentId))].sort();
  if (documentIds.length > 0) {
    await tx
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.id, documentIds))
      .orderBy(asc(knowledgeDocuments.id))
      .for('share');
  }
}

/**
 * 发布指定版本：只切指针，不复制内容。来源必须仍可检索，
 * 否则 409——草稿不能绕过来源撤权。
 * Tx 版本不自开事务，供发布方把索引文档/任务与页面指针一次提交。
 */
export async function publishWikiVersionTx(
  tx: Tx,
  pageId: string,
  versionId: string,
): Promise<KnowledgeWikiPageRow | null> {
  // 先无锁读出页面与来源，按统一锁序拿锁后再重核；页面行锁放到来源/文档之后。
  const [preview] = await tx
    .select()
    .from(knowledgeWikiPages)
    .where(eq(knowledgeWikiPages.id, pageId))
    .limit(1);
  if (!preview) return null;
  const [version] = await tx
    .select()
    .from(knowledgeWikiVersions)
    .where(and(eq(knowledgeWikiVersions.id, versionId), eq(knowledgeWikiVersions.pageId, pageId)))
    .limit(1);
  if (!version) return null;
  // 模型生成必须保留来源快照；人工正文允许无来源。
  if (version.generatedBy === 'sdk' && version.sourceChunkIds.length === 0) {
    throw new AppError('CONFLICT', '模型生成的 Wiki 没有来源，不能发布');
  }
  await lockWikiSourceScope(tx, preview.baseId, version.sourceChunkIds);
  const [page] = await tx
    .select()
    .from(knowledgeWikiPages)
    .where(eq(knowledgeWikiPages.id, pageId))
    .for('update');
  if (!page) return null;

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
}

export async function publishWikiVersion(
  db: Database,
  pageId: string,
  versionId: string,
): Promise<KnowledgeWikiPageRow | null> {
  return db.transaction((tx) => publishWikiVersionTx(tx, pageId, versionId));
}

/** 回退 = 复制目标版本内容成新草稿并发布，历史版本不删；来源失效时 409。 */
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
  const page = await getWikiPage(db, pageId);
  if (!page) return null;
  // 模型生成必须保留来源快照；回退不能把空来源版本洗成人工正文再发布。
  if (source.generatedBy === 'sdk' && source.sourceChunkIds.length === 0) {
    throw new AppError('CONFLICT', '模型生成的 Wiki 没有来源，不能回退');
  }
  // 先核来源再落草稿；publish 事务仍会再核一次，避免并发撤权绕过。
  const checked = await usableSourceChunks(db, page, source.sourceChunkIds);
  if (checked.unusable > 0) {
    throw new AppError('CONFLICT', '草稿引用的来源已删除或禁用，请重新生成后再发布');
  }
  const draft = await saveWikiDraft(db, pageId, {
    markdown: source.markdown,
    sourceChunkIds: source.sourceChunkIds,
    model: source.model,
    generatedBy: source.generatedBy,
  });
  if (!draft) return null;
  await publishWikiVersion(db, pageId, draft.id);
  return draft;
}

export async function listWikiVersions(
  db: Database,
  pageId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeWikiVersionRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeWikiVersions.pageId, pageId)];
  if (options.cursor) {
    // 版本号在页内唯一且单调；created_at 取事务开始时间，早开晚写会倒挂。
    // 游标行必须属于本页，否则视为未知游标返回空页（与其它列表一致）。
    filters.push(sql`${knowledgeWikiVersions.version} < (
      select b.version from ${knowledgeWikiVersions} b
      where b.id = ${options.cursor} and b.page_id = ${pageId}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeWikiVersions)
    .where(and(...filters))
    .orderBy(desc(knowledgeWikiVersions.version))
    .limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: nextCursor(rows, limit) };
}

/**
 * 已发布 Wiki 的读取边界：同库、status=published，且每个来源快照都仍能在当前可读文档版本中找到。
 * 检索与直接读取共用；索引是否追上线上指针由检索侧另加条件。
 */
export function readableWikiPageSql(alias: string, baseId: string): SQL {
  const p = sql.raw(alias);
  return sql`${p}.base_id = ${baseId}
    and ${p}.status = 'published'
    and ${p}.current_version_id is not null
    and not exists (
      select 1 from knowledge_wiki_sources ws
      where ws.page_id = ${p}.id
        and (
          ws.chunk_id is null
          or not exists (
            select 1 from knowledge_chunks c
            join knowledge_documents d on d.id = c.document_id
            where c.id = ws.chunk_id
              and c.base_id = ${p}.base_id
              and c.enabled
              and c.version_id = d.current_version_id
              and ${readableDocumentSql('d')}
          )
        )
    )`;
}

export interface ReadableWikiPage {
  page: KnowledgeWikiPageRow;
  version: KnowledgeWikiVersionRow;
}

export async function getReadableWikiPage(
  db: Database,
  baseId: string,
  pageId: string,
): Promise<ReadableWikiPage | null> {
  const [row] = await db
    .select({ page: knowledgeWikiPages, version: knowledgeWikiVersions })
    .from(knowledgeWikiPages)
    .innerJoin(
      knowledgeWikiVersions,
      and(
        eq(knowledgeWikiVersions.id, knowledgeWikiPages.currentVersionId),
        eq(knowledgeWikiVersions.pageId, knowledgeWikiPages.id),
      ),
    )
    .where(
      and(eq(knowledgeWikiPages.id, pageId), readableWikiPageSql('knowledge_wiki_pages', baseId)),
    )
    .limit(1);
  return row ?? null;
}

export async function listReadableWikiPages(
  db: Database,
  baseId: string,
  options: PageOptions = {},
): Promise<Page<ReadableWikiPage>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [readableWikiPageSql('knowledge_wiki_pages', baseId)];
  if (options.cursor) {
    filters.push(sql`(${knowledgeWikiPages.updatedAt}, ${knowledgeWikiPages.id}) < (
      select b.updated_at, b.id from ${knowledgeWikiPages} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select({ page: knowledgeWikiPages, version: knowledgeWikiVersions })
    .from(knowledgeWikiPages)
    .innerJoin(
      knowledgeWikiVersions,
      and(
        eq(knowledgeWikiVersions.id, knowledgeWikiPages.currentVersionId),
        eq(knowledgeWikiVersions.pageId, knowledgeWikiPages.id),
      ),
    )
    .where(and(...filters))
    .orderBy(desc(knowledgeWikiPages.updatedAt), desc(knowledgeWikiPages.id))
    .limit(limit + 1);
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? (rows[limit - 1]?.page.id ?? null) : null,
  };
}

export interface WikiPageStructurePatch {
  title?: string;
  slug?: string;
  parentId?: string | null;
  position?: number;
  /** 与最新草稿版本比较；不传则不做乐观锁。 */
  expectedVersionId?: string | null;
}

/** 结构/标题变更的唯一写入口；调用方负责先锁页面并完成 expectedVersion 校验。 */
async function applyWikiStructureTx(
  tx: Tx,
  page: KnowledgeWikiPageRow,
  patch: Omit<WikiPageStructurePatch, 'expectedVersionId'>,
): Promise<KnowledgeWikiPageRow> {
  const pageId = page.id;
  if (patch.parentId !== undefined && patch.parentId !== null) {
    const [parent] = await tx
      .select({ baseId: knowledgeWikiPages.baseId })
      .from(knowledgeWikiPages)
      .where(eq(knowledgeWikiPages.id, patch.parentId))
      .limit(1);
    if (!parent) throw new AppError('NOT_FOUND', '父 Wiki 页面不存在');
    if (parent.baseId !== page.baseId) {
      throw new AppError('INVALID_INPUT', '父 Wiki 页面属于其他知识库');
    }
    const cycle = await tx.execute<{ id: string }>(sql`
      with recursive ancestors as (
        select id, parent_id from knowledge_wiki_pages where id = ${patch.parentId}
        union all
        select p.id, p.parent_id
        from knowledge_wiki_pages p
        join ancestors a on p.id = a.parent_id
      )
      select id from ancestors where id = ${pageId} limit 1
    `);
    if (cycle.rows.length > 0) {
      throw new AppError('INVALID_INPUT', '不能把 Wiki 页面移动到自身或子孙页面下');
    }
  }
  const [row] = await tx
    .update(knowledgeWikiPages)
    .set({
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.slug === undefined ? {} : { slug: patch.slug }),
      ...(patch.parentId === undefined ? {} : { parentId: patch.parentId }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      updatedAt: new Date(),
    })
    .where(eq(knowledgeWikiPages.id, pageId))
    .returning();
  if (!row) throw new Error('knowledge wiki page update returned no row');
  return row;
}

/** 标题/目录结构更新：同事务校验同库、无循环与 expectedVersion。 */
export async function updateWikiPageStructure(
  db: Database,
  pageId: string,
  patch: WikiPageStructurePatch,
): Promise<KnowledgeWikiPageRow | null> {
  return db.transaction(async (tx) => {
    const [page] = await tx
      .select()
      .from(knowledgeWikiPages)
      .where(eq(knowledgeWikiPages.id, pageId))
      .for('update');
    if (!page) return null;
    if (patch.expectedVersionId !== undefined) {
      const latest = await latestWikiVersionId(tx, pageId);
      if (latest !== patch.expectedVersionId) {
        throw new AppError('CONFLICT_STALE', 'Wiki 页面已被修改，请刷新后重试');
      }
    }
    return applyWikiStructureTx(tx, page, patch);
  });
}

/** 版本贡献差异：按行多重集合保留重复计数；来源差异按集合。 */
export async function getWikiVersionDiff(
  db: Database,
  pageId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<{
  fromVersionId: string;
  toVersionId: string;
  addedLines: string[];
  removedLines: string[];
  addedSourceChunkIds: string[];
  removedSourceChunkIds: string[];
} | null> {
  const versions = await db
    .select()
    .from(knowledgeWikiVersions)
    .where(
      and(
        eq(knowledgeWikiVersions.pageId, pageId),
        inArray(knowledgeWikiVersions.id, [fromVersionId, toVersionId]),
      ),
    );
  const from = versions.find((version) => version.id === fromVersionId);
  const to = versions.find((version) => version.id === toVersionId);
  if (!from || !to) return null;
  const counts = (lines: string[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const line of lines) result.set(line, (result.get(line) ?? 0) + 1);
    return result;
  };
  const fromLines = from.markdown.split('\n');
  const toLines = to.markdown.split('\n');
  const remainingFrom = counts(fromLines);
  const addedLines: string[] = [];
  for (const line of toLines) {
    const count = remainingFrom.get(line) ?? 0;
    if (count > 0) remainingFrom.set(line, count - 1);
    else addedLines.push(line);
  }
  const remainingTo = counts(toLines);
  const removedLines: string[] = [];
  for (const line of fromLines) {
    const count = remainingTo.get(line) ?? 0;
    if (count > 0) remainingTo.set(line, count - 1);
    else removedLines.push(line);
  }
  const fromSources = new Set(from.sourceChunkIds);
  const toSources = new Set(to.sourceChunkIds);
  return {
    fromVersionId,
    toVersionId,
    addedLines,
    removedLines,
    addedSourceChunkIds: to.sourceChunkIds.filter((id) => !fromSources.has(id)),
    removedSourceChunkIds: from.sourceChunkIds.filter((id) => !toSources.has(id)),
  };
}

async function markWikiStaleByDocumentsTx(tx: Tx, documentIds: string[]): Promise<number> {
  if (documentIds.length === 0) return 0;
  const linked = await tx
    .select({ pageId: knowledgeWikiSources.pageId })
    .from(knowledgeWikiSources)
    .where(inArray(knowledgeWikiSources.documentId, documentIds));
  const pageIds = [...new Set(linked.map((row) => row.pageId))].sort();
  if (pageIds.length === 0) return 0;
  // 与 Wiki 发布统一：先按 page ID 全局排序一次取锁，再写来源关联，避免交叉引用反向加锁死锁。
  const locked = await tx
    .select({ id: knowledgeWikiPages.id, status: knowledgeWikiPages.status })
    .from(knowledgeWikiPages)
    .where(inArray(knowledgeWikiPages.id, pageIds))
    .orderBy(asc(knowledgeWikiPages.id))
    .for('update');
  await tx
    .update(knowledgeWikiSources)
    .set({ stale: true })
    .where(inArray(knowledgeWikiSources.documentId, documentIds));
  const staleIds = locked
    .filter((page) => page.status === 'published' || page.status === 'stale')
    .map((page) => page.id);
  if (staleIds.length > 0) {
    await tx
      .update(knowledgeWikiPages)
      .set({ status: 'stale', updatedAt: new Date() })
      .where(inArray(knowledgeWikiPages.id, staleIds));
  }
  return pageIds.length;
}

async function markWikiStaleByDocumentTx(tx: Tx, documentId: string): Promise<number> {
  return markWikiStaleByDocumentsTx(tx, [documentId]);
}

/**
 * 文档删除/禁用/更新后，引用它的 Wiki 页来源标 stale，供人工确认后重生成。
 * 只有已发布（含已 stale）页面改 status：从未发布的草稿保持 draft，
 * 否则「是否发布过」会与新鲜度混成一个状态而被误判。
 */
export async function markWikiStaleByDocument(db: Database, documentId: string): Promise<number> {
  return db.transaction((tx) => markWikiStaleByDocumentTx(tx, documentId));
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
