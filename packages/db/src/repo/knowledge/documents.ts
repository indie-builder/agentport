import { decodeCursor, encodeCursor } from '@agentport/shared';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import { knowledgeDocuments, knowledgeDocumentTags, knowledgeTags } from '../../schema.js';
import { cursorValueSql, keysetPage } from '../pagination.js';
import {
  clampDocumentTitle,
  disableDocumentsBySourceTx,
  escapeLike,
  type KnowledgeDocumentRow,
  markWikiStaleByDocumentsTx,
  type Page,
  type PageOptions,
  pageLimit,
  readableDocumentSql,
} from './shared.js';

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
  db: DbHandle,
  input: CreateDocumentInput,
): Promise<KnowledgeDocumentRow> {
  const [row] = await db
    .insert(knowledgeDocuments)
    .values({ id: newId('knowledgeDocument'), ...input, title: clampDocumentTitle(input.title) })
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

export async function getDocumentsByIds(
  db: Database,
  ids: string[],
): Promise<Map<string, KnowledgeDocumentRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(knowledgeDocuments)
    .where(inArray(knowledgeDocuments.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function isDocumentReadable(db: Database, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, id), readableDocumentSql('knowledge_documents')))
    .limit(1);
  return row !== undefined;
}

export async function sourceScopeAllowsDocumentById(
  db: Database,
  documentId: string,
): Promise<boolean> {
  const result = await db.execute<{ ok: boolean }>(sql`
    select ${readableDocumentSql('probe')} as ok
    from (
      select d.id, 'ready'::text as status, d.current_version_id, null::text as disabled_reason,
             d.source_connection_id, d.base_id, d.source_path
      from knowledge_documents d
      where d.id = ${documentId}
    ) probe
  `);
  return result[0]?.ok === true;
}

export interface ListDocumentsFilter extends PageOptions {
  baseId: string;
  folderId?: string | null;
  tag?: string;
  status?: KnowledgeDocumentRow['status'];
  sourceConnectionId?: string;
  contentKind?: KnowledgeDocumentRow['contentKind'];
  q?: string;
  sort?: 'updated' | 'created' | 'title';
  order?: 'asc' | 'desc';
}

export async function listDocuments(
  db: Database,
  filter: ListDocumentsFilter,
): Promise<Page<KnowledgeDocumentRow> | null> {
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
    filters.push(sql`${knowledgeDocuments.title} ilike ${`%${escapeLike(filter.q)}%`}`);
  }
  if (filter.tag) {
    filters.push(sql`exists (
      select 1 from ${knowledgeDocumentTags} dt
      join ${knowledgeTags} t on t.id = dt.tag_id
      where dt.document_id = ${knowledgeDocuments.id} and t.name = ${filter.tag}
    )`);
  }
  const sort = filter.sort ?? 'created';
  const direction = filter.order ?? (sort === 'title' ? 'asc' : 'desc');
  const sortColumn =
    sort === 'updated'
      ? knowledgeDocuments.updatedAt
      : sort === 'title'
        ? knowledgeDocuments.title
        : knowledgeDocuments.createdAt;
  const orderBy = direction === 'asc' ? asc : desc;
  const defaultOrder = sort === 'created' && direction === 'desc';
  const anchor = filter.cursor == null ? null : decodeCursor(filter.cursor, 3);
  const cursorId =
    filter.cursor == null
      ? undefined
      : anchor === null
        ? defaultOrder
          ? filter.cursor
          : null
        : anchor[0] === sort && anchor[1] === direction
          ? anchor[2]
          : null;
  if (cursorId === null) return null;
  const page = await keysetPage(db, {
    table: knowledgeDocuments,
    cursor: cursorId,
    limit,
    column: sortColumn,
    direction,
    ...(sort === 'updated' || sort === 'title'
      ? {
          valueCursor: (row: { cursorValue: string }) => row.cursorValue,
          cursorKind: sort === 'updated' ? ('timestamp' as const) : ('text' as const),
        }
      : {}),
    where: filters,
    load: ({ where, limit }: { where: SQL | undefined; limit: number }) =>
      db
        .select({
          ...getTableColumns(knowledgeDocuments),
          cursorValue:
            sort === 'title'
              ? knowledgeDocuments.title
              : cursorValueSql(knowledgeDocuments.updatedAt),
        })
        .from(knowledgeDocuments)
        .where(where)
        .orderBy(orderBy(sortColumn), orderBy(knowledgeDocuments.id))
        .limit(limit),
  });
  if (page === null) return null;
  return {
    items: page.items.map(({ cursorValue, ...row }) => row),
    nextCursor:
      page.nextCursor === null
        ? null
        : defaultOrder
          ? page.nextCursor
          : encodeCursor([sort, direction, page.nextCursor]),
  };
}

export interface ListFaqDocumentsFilter extends PageOptions {
  baseId: string;
  folderId?: string | null;
  status?: KnowledgeDocumentRow['status'];
  q?: string;
  isRecommended?: boolean;
}

export async function listFaqDocuments(
  db: Database,
  filter: ListFaqDocumentsFilter,
): Promise<Page<KnowledgeDocumentRow> | null> {
  const filters: SQL[] = [
    eq(knowledgeDocuments.baseId, filter.baseId),
    eq(knowledgeDocuments.contentKind, 'faq'),
  ];
  if (filter.folderId !== undefined) {
    filters.push(
      filter.folderId === null
        ? isNull(knowledgeDocuments.folderId)
        : eq(knowledgeDocuments.folderId, filter.folderId),
    );
  }
  if (filter.status) filters.push(eq(knowledgeDocuments.status, filter.status));
  if (filter.q) {
    filters.push(sql`${knowledgeDocuments.title} ilike ${`%${escapeLike(filter.q)}%`}`);
  }
  if (filter.isRecommended !== undefined) {
    filters.push(sql`coalesce((
      select v.faq ->> 'isRecommended'
      from knowledge_document_versions v
      where v.document_id = ${knowledgeDocuments.id} and v.faq is not null
      order by v.version desc limit 1
    ), 'true') = ${String(filter.isRecommended)}`);
  }
  const page = await keysetPage(db, {
    table: knowledgeDocuments,
    cursor: filter.cursor,
    limit: pageLimit(filter),
    column: knowledgeDocuments.updatedAt,
    direction: 'desc',
    valueCursor: (row: { cursorValue: string }) => row.cursorValue,
    cursorKind: 'timestamp',
    where: filters,
    load: ({ where, limit }: { where: SQL | undefined; limit: number }) =>
      db
        .select({
          ...getTableColumns(knowledgeDocuments),
          cursorValue: cursorValueSql(knowledgeDocuments.updatedAt),
        })
        .from(knowledgeDocuments)
        .where(where)
        .orderBy(desc(knowledgeDocuments.updatedAt), desc(knowledgeDocuments.id))
        .limit(limit),
  });
  if (page === null) return null;
  return {
    items: page.items.map(({ cursorValue, ...row }) => row),
    nextCursor: page.nextCursor,
  };
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
  db: DbHandle,
  id: string,
  patch: DocumentPatch,
): Promise<KnowledgeDocumentRow | null> {
  const [row] = await db
    .update(knowledgeDocuments)
    .set({
      ...patch,
      ...(patch.title === undefined ? {} : { title: clampDocumentTitle(patch.title) }),
      updatedAt: new Date(),
    })
    .where(eq(knowledgeDocuments.id, id))
    .returning();
  return row ?? null;
}

export interface DocumentSummaryPatch {
  summaryStatus: KnowledgeDocumentRow['summaryStatus'];
  summaryVersionId: string | null;
  summary?: string | null | undefined;
  summaryGeneratedAt?: Date | null | undefined;
  summaryError?: string | null | undefined;
}

export async function setDocumentSummary(
  db: DbHandle,
  id: string,
  patch: DocumentSummaryPatch,
  expectedVersionId?: string,
): Promise<KnowledgeDocumentRow | null> {
  const [row] = await db
    .update(knowledgeDocuments)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      expectedVersionId === undefined
        ? eq(knowledgeDocuments.id, id)
        : and(
            eq(knowledgeDocuments.id, id),
            eq(knowledgeDocuments.currentVersionId, expectedVersionId),
          ),
    )
    .returning();
  return row ?? null;
}

export async function beginDocumentSummary(
  db: DbHandle,
  documentId: string,
  versionId: string,
  status: 'pending' | 'generating',
  expectedVersionId?: string,
): Promise<KnowledgeDocumentRow | null> {
  return setDocumentSummary(
    db,
    documentId,
    {
      summaryStatus: status,
      summaryVersionId: versionId,
      summary: null,
      summaryGeneratedAt: null,
      summaryError: null,
    },
    expectedVersionId,
  );
}

export async function failDocumentSummary(
  db: DbHandle,
  documentId: string,
  message: string,
  expectedVersionId?: string,
): Promise<void> {
  await db
    .update(knowledgeDocuments)
    .set({
      summaryStatus: 'failed',
      summaryVersionId: sql`coalesce(${knowledgeDocuments.summaryVersionId}, ${knowledgeDocuments.currentVersionId})`,
      summary: null,
      summaryGeneratedAt: null,
      summaryError: message,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        inArray(knowledgeDocuments.summaryStatus, ['pending', 'generating']),
        ...(expectedVersionId === undefined
          ? []
          : [eq(knowledgeDocuments.summaryVersionId, expectedVersionId)]),
      ),
    );
}

export async function settleProcessingDocument(db: Database, documentId: string): Promise<void> {
  await db
    .update(knowledgeDocuments)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.status, 'processing'),
        isNull(knowledgeDocuments.currentVersionId),
        isNull(knowledgeDocuments.disabledReason),
      ),
    );
  await db
    .update(knowledgeDocuments)
    .set({ status: 'ready', updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.status, 'processing'),
        isNotNull(knowledgeDocuments.currentVersionId),
        isNull(knowledgeDocuments.disabledReason),
      ),
    );
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

/** 外部来源失权/删除：文档置 disabled，不物理删、不参与检索。
 * 人工停用原因不被来源同步覆盖；归属只看 source_connection_id。
 */
export async function disableDocumentsBySource(
  db: Database,
  sourceId: string,
): Promise<KnowledgeDocumentRow[]> {
  return db.transaction(async (tx) => {
    const rows = await disableDocumentsBySourceTx(tx, sourceId);
    await markWikiStaleByDocumentsTx(
      tx,
      rows.map((row) => row.id),
    );
    return rows;
  });
}
