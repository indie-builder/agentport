import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DbHandle, Transaction } from '../../client.js';
import {
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocuments,
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
} from '../../schema.js';

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
export function pageLimit(options: PageOptions): number {
  return Math.min(Math.max(options.limit ?? 50, 1), 200);
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
    and (${d}.source_connection_id is null or ${sourceScopeSql({
      id: sql`${d}.id`,
      baseId: sql`${d}.base_id`,
      sourceConnectionId: sql`${d}.source_connection_id`,
      sourcePath: sql`${d}.source_path`,
    })})`;
}

function sourceScopeSql(document: {
  id: SQL;
  baseId: SQL;
  sourceConnectionId: SQL;
  sourcePath: SQL;
}): SQL {
  return sql`exists (
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
          and (
            jsonb_array_length(r.paths) = 0
            or (${document.sourcePath} is not null and exists (
              select 1 from jsonb_array_elements_text(r.paths) p
              where ${document.sourcePath} = p
                or left(${document.sourcePath}, char_length(p) + 1) = p || '/'
            ))
          )
      )
  )`;
}

/** 发布前只核对来源/范围授权；文档自身的 ready/current 由发布动作建立。 */
export async function sourceScopeAllowsDocument(
  db: DbHandle,
  document: KnowledgeDocumentRow,
): Promise<boolean> {
  if (document.sourceConnectionId === null) return true;
  const result = await db.execute<{ ok: boolean }>(sql`
    select ${sourceScopeSql({
      id: sql`${document.id}`,
      baseId: sql`${document.baseId}`,
      sourceConnectionId: sql`${document.sourceConnectionId}`,
      sourcePath: sql`${document.sourcePath}::text`,
    })} as ok
  `);
  return result[0]?.ok === true;
}
/**
 * 快照仍与线上来源一致：在 source 共享锁下比较 type/baseId/config/密文与全部范围。
 * config 用 jsonb 相等（忽略键顺序）；范围按 id 与字段逐一比较，忽略时间戳。
 */
export async function sourceSnapshotMatchesTx(
  tx: Transaction,
  snapshot: SourceReadSnapshot,
): Promise<boolean> {
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
export async function disableDocumentsBySourceTx(
  tx: Transaction,
  sourceId: string,
): Promise<KnowledgeDocumentRow[]> {
  return tx
    .update(knowledgeDocuments)
    .set({
      status: 'disabled',
      disabledReason: sql`coalesce(${knowledgeDocuments.disabledReason}, 'source')`,
      updatedAt: new Date(),
    })
    .where(eq(knowledgeDocuments.sourceConnectionId, sourceId))
    .returning();
}
/** 单条 INSERT 的绑定参数上限是 65535；按 500 行分段，远低于该上限。 */
export const INSERT_CHUNK = 500;
/**
 * 来源必须仍可读且是文档当前版本：chunk 未禁用、文档 ready 且来源/范围授权仍有效、
 * chunk.versionId 等于文档 currentVersionId（旧版本 chunk 不能再当证据）。
 */
export async function usableSourceChunks(
  tx: DbHandle,
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
/**
 * 与范围撤权统一锁序：先来源、再文档、最后 Wiki 页/关联。
 * 撤权事务按 source -> document -> wiki page -> sources 表写，这里在取完前两级后重核来源。
 */
export async function lockWikiSourceScope(
  tx: Transaction,
  baseId: string,
  chunkIds: string[],
): Promise<void> {
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
export async function markWikiStaleByDocumentsTx(tx: Transaction, documentIds: string[]): Promise<number> {
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
