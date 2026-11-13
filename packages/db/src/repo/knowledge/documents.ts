import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import { knowledgeDocuments, knowledgeDocumentTags, knowledgeTags } from '../../schema.js';
import { paginate } from '../keyset.js';
import {
  type KnowledgeDocumentRow,
  type Page,
  type PageOptions,
  disableDocumentsBySourceTx,
  markWikiStaleByDocumentsTx,
  pageLimit,
  readableDocumentSql,
} from './shared.js';

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
  db: DbHandle,
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
  return paginate(rows, limit);
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
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, id))
    .returning();
  return row ?? null;
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
  return paginate(rows, limit);
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
