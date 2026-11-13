import { AppError } from '@agentport/core';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../../client.js';
import { newId } from '../../id.js';
import { knowledgeWikiPages, knowledgeWikiSources, knowledgeWikiVersions } from '../../schema.js';
import { paginate } from '../keyset.js';
import {
  type KnowledgeWikiPageRow,
  type KnowledgeWikiVersionRow,
  type Page,
  type PageOptions,
  lockWikiSourceScope,
  markWikiStaleByDocumentsTx,
  pageLimit,
  readableDocumentSql,
  usableSourceChunks,
} from './shared.js';

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
  return paginate(rows, limit);
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
async function latestWikiVersionId(db: DbHandle, pageId: string): Promise<string | null> {
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
 * 发布指定版本：只切指针，不复制内容。来源必须仍可检索，
 * 否则 409——草稿不能绕过来源撤权。
 */
export async function publishWikiVersionTx(
  tx: Transaction,
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
  return paginate(rows, limit);
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
async function markWikiStaleByDocumentTx(tx: Transaction, documentId: string): Promise<number> {
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
