import { AppError, diffLines } from '@agentport/core';
import { and, desc, eq, exists, inArray, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../../client.js';
import { newId } from '../../id.js';
import { knowledgeWikiPages, knowledgeWikiSources, knowledgeWikiVersions } from '../../schema.js';
import { cursorValueSql, keysetPage } from '../pagination.js';
import {
  type KnowledgeWikiPageRow,
  type KnowledgeWikiVersionRow,
  lockWikiSourceScope,
  markWikiStaleByDocumentsTx,
  type Page,
  type PageOptions,
  pageLimit,
  readableDocumentSql,
  usableSourceChunks,
} from './shared.js';

export async function createWikiPage(
  db: Database,
  input: {
    baseId: string;
    slug: string;
    title: string;
    parentId?: string | null | undefined;
    position?: number | undefined;
  },
): Promise<KnowledgeWikiPageRow> {
  const create = async (handle: DbHandle): Promise<KnowledgeWikiPageRow> => {
    const [row] = await handle
      .insert(knowledgeWikiPages)
      .values({
        id: newId('knowledgeWikiPage'),
        baseId: input.baseId,
        slug: input.slug,
        title: input.title,
      })
      .returning();
    if (!row) throw new Error('knowledge wiki page insert returned no row');
    return row;
  };
  if (input.parentId === undefined && input.position === undefined) {
    return create(db);
  }
  return db.transaction(async (tx) => {
    const row = await create(tx);
    return applyWikiStructureTx(tx, row, {
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.position === undefined ? {} : { position: input.position }),
    });
  });
}

export async function listWikiSourcesByPageIds(
  db: DbHandle,
  pageIds: string[],
): Promise<Array<typeof knowledgeWikiSources.$inferSelect>> {
  if (pageIds.length === 0) return [];
  return db
    .select()
    .from(knowledgeWikiSources)
    .where(inArray(knowledgeWikiSources.pageId, pageIds));
}

export async function getWikiPage(db: DbHandle, id: string): Promise<KnowledgeWikiPageRow | null> {
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
): Promise<Page<KnowledgeWikiPageRow> | null> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeWikiPages.baseId, baseId)];
  return keysetPage(db, {
    table: knowledgeWikiPages,
    cursor: options.cursor,
    limit,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select()
        .from(knowledgeWikiPages)
        .where(where)
        .orderBy(desc(knowledgeWikiPages.createdAt), desc(knowledgeWikiPages.id))
        .limit(limit),
  });
}

export interface SaveWikiVersionInput {
  markdown: string;
  sourceChunkIds: string[];
  model: string;
  generatedBy: KnowledgeWikiVersionRow['generatedBy'];
  expectedVersion?: string | null;
  structure?: {
    title?: string;
    slug?: string;
    parentId?: string | null;
    position?: number;
  };
  sources?: Array<{ documentId: string | null; versionId: string | null; chunkId: string | null }>;
}
async function latestWikiVersionId(db: DbHandle, pageId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: knowledgeWikiVersions.id })
    .from(knowledgeWikiVersions)
    .where(eq(knowledgeWikiVersions.pageId, pageId))
    .orderBy(desc(knowledgeWikiVersions.version))
    .limit(1);
  return row?.id ?? null;
}

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

export async function publishWikiVersionTx(
  tx: Transaction,
  pageId: string,
  versionId: string,
): Promise<KnowledgeWikiPageRow | null> {
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

export async function listWikiVersions(
  db: Database,
  pageId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeWikiVersionRow> | null> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeWikiVersions.pageId, pageId)];
  return keysetPage(db, {
    table: knowledgeWikiVersions,
    cursor: options.cursor,
    limit,
    column: knowledgeWikiVersions.version,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select()
        .from(knowledgeWikiVersions)
        .where(where)
        .orderBy(desc(knowledgeWikiVersions.version), desc(knowledgeWikiVersions.id))
        .limit(limit),
  });
}

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
): Promise<Page<ReadableWikiPage> | null> {
  const currentVersion = db
    .select({ id: knowledgeWikiVersions.id })
    .from(knowledgeWikiVersions)
    .where(
      and(
        eq(knowledgeWikiVersions.id, knowledgeWikiPages.currentVersionId),
        eq(knowledgeWikiVersions.pageId, knowledgeWikiPages.id),
      ),
    );
  const page = await keysetPage(db, {
    table: knowledgeWikiPages,
    cursor: options.cursor,
    limit: pageLimit(options),
    column: knowledgeWikiPages.updatedAt,
    valueCursor: (row: { cursorValue: string }) => row.cursorValue,
    cursorKind: 'timestamp',
    where: [readableWikiPageSql('knowledge_wiki_pages', baseId), exists(currentVersion)],
    load: ({ where, limit }: { where: SQL | undefined; limit: number }) =>
      db
        .select({
          id: knowledgeWikiPages.id,
          page: knowledgeWikiPages,
          version: knowledgeWikiVersions,
          cursorValue: cursorValueSql(knowledgeWikiPages.updatedAt),
        })
        .from(knowledgeWikiPages)
        .innerJoin(
          knowledgeWikiVersions,
          and(
            eq(knowledgeWikiVersions.id, knowledgeWikiPages.currentVersionId),
            eq(knowledgeWikiVersions.pageId, knowledgeWikiPages.id),
          ),
        )
        .where(where)
        .orderBy(desc(knowledgeWikiPages.updatedAt), desc(knowledgeWikiPages.id))
        .limit(limit),
  });
  if (page === null) return null;
  return {
    items: page.items.map(({ page, version }) => ({ page, version })),
    nextCursor: page.nextCursor,
  };
}

export interface WikiPageStructurePatch {
  title?: string;
  slug?: string;
  parentId?: string | null;
  position?: number;
  expectedVersionId?: string | null;
}

async function applyWikiStructureTx(
  tx: Transaction,
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
    if (cycle.length > 0) {
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
  const { added: addedLines, removed: removedLines } = diffLines(from.markdown, to.markdown);
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
async function markWikiStaleByDocumentTx(tx: Transaction, documentId: string): Promise<number> {
  return markWikiStaleByDocumentsTx(tx, [documentId]);
}

export async function markWikiStaleByDocument(db: Database, documentId: string): Promise<number> {
  return db.transaction((tx) => markWikiStaleByDocumentTx(tx, documentId));
}
