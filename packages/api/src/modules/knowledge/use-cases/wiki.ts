import { AppError } from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { z } from 'zod';
import { createJob, enqueueKnowledgeJob, storeBlob } from '../service.js';
import { type KnowledgeDeps, type PageQuery, notFound, pageOptions } from './shared.js';

type WikiPageRow = typeof schema.knowledgeWikiPages.$inferSelect;

// ---- wiki -----------------------------------------------------------------

function toWikiPage(row: WikiPageRow) {
  return {
    id: row.id,
    baseId: row.baseId,
    slug: row.slug,
    title: row.title,
    parentId: row.parentId,
    position: row.position,
    status: row.status,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWikiVersion(row: typeof schema.knowledgeWikiVersions.$inferSelect) {
  return {
    id: row.id,
    pageId: row.pageId,
    version: row.version,
    markdown: row.markdown,
    sourceChunkIds: row.sourceChunkIds,
    model: row.model,
    generatedBy: row.generatedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

const WIKI_LINK_PATTERN = /\[\[([^[\]]+)\]\]/g;

interface WikiLinkToken {
  slug: string;
  anchor: string | null;
}

function parseWikiLinkToken(raw: string): WikiLinkToken | null {
  const target = raw.split('|')[0]?.trim() ?? '';
  if (target.length === 0) return null;
  const [slugPart, ...anchorParts] = target.split('#');
  const slug = (slugPart ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (slug.length === 0) return null;
  const anchor = anchorParts.join('#').trim();
  return { slug, anchor: anchor.length > 0 ? anchor : null };
}

interface MarkdownNode {
  type: string;
  value?: string | undefined;
  children?: MarkdownNode[] | undefined;
}

function extractWikiLinks(markdown: string): WikiLinkToken[] {
  const tree = fromMarkdown(markdown) as MarkdownNode;
  const links: WikiLinkToken[] = [];
  const seen = new Set<string>();
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return;
    if (node.type === 'text' && node.value) {
      for (const match of node.value.matchAll(WIKI_LINK_PATTERN)) {
        const token = parseWikiLinkToken(match[1] ?? '');
        if (!token) continue;
        const key = `${token.slug}#${token.anchor ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push(token);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return links;
}

const pageMarkdownRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  markdown: z.string().nullable(),
});

type PageMarkdownRow = z.infer<typeof pageMarkdownRowSchema>;

async function latestPageMarkdowns(db: Database, baseId: string): Promise<PageMarkdownRow[]> {
  const result = await db.execute<{ id: string; slug: string; markdown: string | null }>(sql`
    select p.id, p.slug, v.markdown
    from knowledge_wiki_pages p
    left join lateral (
      select wv.markdown
      from knowledge_wiki_versions wv
      where wv.page_id = p.id
      order by wv.version desc
      limit 1
    ) v on true
    where p.base_id = ${baseId}
    order by p.created_at, p.id
  `);
  return z.array(pageMarkdownRowSchema).parse(result);
}

async function latestWikiVersion(
  db: Database,
  pageId: string,
): Promise<typeof schema.knowledgeWikiVersions.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(schema.knowledgeWikiVersions)
    .where(eq(schema.knowledgeWikiVersions.pageId, pageId))
    .orderBy(desc(schema.knowledgeWikiVersions.version))
    .limit(1);
  return row ?? null;
}

type PreparedWikiIndex = {
  versionId: string;
  sizeBytes: number;
  input: {
    blobSha256: string;
    filename: string;
    mimeType: string;
    expectedCurrentVersionId: string | null;
  };
};

async function prepareWikiIndex(
  deps: KnowledgeDeps,
  page: WikiPageRow,
  versionId: string,
): Promise<PreparedWikiIndex | null> {
  const [version] = await deps.db
    .select()
    .from(schema.knowledgeWikiVersions)
    .where(
      and(
        eq(schema.knowledgeWikiVersions.id, versionId),
        eq(schema.knowledgeWikiVersions.pageId, page.id),
      ),
    )
    .limit(1);
  if (!version) return null;
  const data = Buffer.from(version.markdown, 'utf8');
  const sha = await storeBlob(deps.config.KNOWLEDGE_DIR, data);
  return {
    versionId: version.id,
    sizeBytes: data.length,
    input: {
      blobSha256: sha,
      filename: `${page.slug}.md`,
      mimeType: 'text/markdown',
      expectedCurrentVersionId: null,
    },
  };
}

async function publishWithWikiIndex(
  deps: KnowledgeDeps,
  page: WikiPageRow,
  prepared: PreparedWikiIndex,
): Promise<WikiPageRow | null> {
  const committed = await deps.db.transaction(async (tx) => {
    const updated = await repo.knowledge.publishWikiVersionTx(tx, page.id, prepared.versionId);
    if (!updated) return null;
    const [existing] = await tx
      .select()
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.baseId, page.baseId),
          eq(schema.knowledgeDocuments.contentKind, 'wiki'),
          sql`${schema.knowledgeDocuments.metadata} ->> 'wikiPageId' = ${page.id}`,
        ),
      )
      .limit(1);
    const metadata = {
      ...(existing?.metadata ?? {}),
      wikiPageId: page.id,
      wikiVersionId: prepared.versionId,
      originalFilename: prepared.input.filename,
    };
    const document = existing
      ? ((await repo.knowledge.updateDocument(tx, existing.id, {
          title: updated.title,
          metadata,
        })) ?? existing)
      : await repo.knowledge.createDocument(tx, {
          baseId: page.baseId,
          folderId: null,
          title: updated.title,
          sourceType: 'manual',
          sourceId: null,
          sourceUrl: null,
          sourcePath: null,
          mimeType: 'text/markdown',
          sizeBytes: prepared.sizeBytes,
          contentKind: 'wiki',
          metadata,
        });
    const job = await createJob(tx, {
      baseId: page.baseId,
      documentId: document.id,
      payload: {
        type: 'ingest',
        documentId: document.id,
        publish: 'automatic',
        input: {
          ...prepared.input,
          expectedCurrentVersionId: document.currentVersionId,
        },
        versionMetadata: { wikiPageId: page.id, wikiVersionId: prepared.versionId },
      },
    });
    return { page: updated, jobId: job.id };
  });
  if (!committed) return null;
  await enqueueKnowledgeJob({ id: committed.jobId }).catch((err: unknown) => {
    deps.log.warn({ err, jobId: committed.jobId }, 'Wiki 索引任务入队失败，等待对账补投');
  });
  return committed.page;
}

export async function listWikiPages(deps: KnowledgeDeps, id: string, query: PageQuery) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const page = await repo.knowledge.listWikiPages(deps.db, id, pageOptions(query));
  return { items: page.items.map(toWikiPage), nextCursor: page.nextCursor };
}

export async function createWikiPage(
  deps: KnowledgeDeps,
  id: string,
  body: {
    slug: string;
    title: string;
    parentId?: string | null | undefined;
    position?: number | undefined;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const row = await repo.knowledge.createWikiPage(deps.db, {
    baseId: base.id,
    slug: body.slug,
    title: body.title,
  });
  if (body.parentId !== undefined || body.position !== undefined) {
    try {
      const updated = await repo.knowledge.updateWikiPageStructure(deps.db, row.id, {
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        ...(body.position === undefined ? {} : { position: body.position }),
      });
      return toWikiPage(updated ?? row);
    } catch (err) {
      await deps.db
        .delete(schema.knowledgeWikiPages)
        .where(eq(schema.knowledgeWikiPages.id, row.id))
        .catch(() => undefined);
      throw err;
    }
  }
  return toWikiPage(row);
}

export async function getWikiPage(deps: KnowledgeDeps, pageId: string, query: PageQuery) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const versions = await repo.knowledge.listWikiVersions(deps.db, page.id, pageOptions(query));
  return {
    ...toWikiPage(page),
    versions: versions.items.map(toWikiVersion),
    nextCursor: versions.nextCursor,
  };
}

export async function updateWikiPage(
  deps: KnowledgeDeps,
  pageId: string,
  body: {
    title?: string | undefined;
    markdown?: string | undefined;
    parentId?: string | null | undefined;
    position?: number | undefined;
    expectedVersion?: string | null | undefined;
  },
) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const structure = {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
    ...(body.position === undefined ? {} : { position: body.position }),
  };
  const hasStructure = Object.keys(structure).length > 0;
  if (body.markdown !== undefined) {
    const previous = await latestWikiVersion(deps.db, page.id);
    await repo.knowledge.saveWikiDraft(deps.db, page.id, {
      markdown: body.markdown,
      sourceChunkIds: previous?.sourceChunkIds ?? [],
      model: 'manual',
      generatedBy: 'manual',
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
      ...(hasStructure ? { structure } : {}),
    });
  } else if (hasStructure) {
    await repo.knowledge.updateWikiPageStructure(deps.db, page.id, {
      ...structure,
      ...(body.expectedVersion === undefined ? {} : { expectedVersionId: body.expectedVersion }),
    });
  }
  const updated = await repo.knowledge.getWikiPage(deps.db, page.id);
  if (!updated) notFound('Wiki 页面');
  return toWikiPage(updated);
}

export async function generateWiki(
  deps: KnowledgeDeps,
  pageId: string,
  body: { instruction?: string | undefined; sourceDocumentIds?: string[] | undefined },
) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const job = await createJob(deps.db, {
    baseId: page.baseId,
    documentId: null,
    payload: {
      type: 'wiki_generate',
      baseId: page.baseId,
      pageId: page.id,
      ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
      ...(body.sourceDocumentIds === undefined
        ? {}
        : { sourceDocumentIds: body.sourceDocumentIds }),
    },
  });
  await enqueueKnowledgeJob(job);
  return { jobId: job.id };
}

export async function listWikiVersions(deps: KnowledgeDeps, pageId: string, query: PageQuery) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const versions = await repo.knowledge.listWikiVersions(deps.db, page.id, pageOptions(query));
  return { items: versions.items.map(toWikiVersion), nextCursor: versions.nextCursor };
}

export async function wikiLinks(deps: KnowledgeDeps, pageId: string) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const rows = await latestPageMarkdowns(deps.db, page.baseId);
  const bySlug = new Map(rows.map((row) => [row.slug.toLowerCase(), row.id]));
  const current = rows.find((row) => row.id === page.id);
  const outgoing = (current?.markdown ? extractWikiLinks(current.markdown) : []).map((link) => ({
    targetPageId: bySlug.get(link.slug) ?? null,
    anchor: link.anchor,
  }));
  const incoming = rows.flatMap((row) => {
    if (row.id === page.id || !row.markdown) return [];
    return extractWikiLinks(row.markdown).flatMap((link) =>
      bySlug.get(link.slug) === page.id ? [{ sourcePageId: row.id, anchor: link.anchor }] : [],
    );
  });
  return { outgoing, incoming };
}

export async function wikiDiff(
  deps: KnowledgeDeps,
  pageId: string,
  query: { fromVersionId: string; toVersionId: string },
) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const diff = await repo.knowledge.getWikiVersionDiff(
    deps.db,
    page.id,
    query.fromVersionId,
    query.toVersionId,
  );
  if (!diff) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  return diff;
}

export async function publishWiki(deps: KnowledgeDeps, pageId: string, versionId: string) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const prepared = await prepareWikiIndex(deps, page, versionId);
  if (!prepared) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  const updated = await publishWithWikiIndex(deps, page, prepared);
  if (!updated) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  return toWikiPage(updated);
}

export async function rollbackWiki(deps: KnowledgeDeps, pageId: string, versionId: string) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const [source] = await deps.db
    .select()
    .from(schema.knowledgeWikiVersions)
    .where(
      and(
        eq(schema.knowledgeWikiVersions.id, versionId),
        eq(schema.knowledgeWikiVersions.pageId, page.id),
      ),
    )
    .limit(1);
  if (!source) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  const draft = await repo.knowledge.saveWikiDraft(deps.db, page.id, {
    markdown: source.markdown,
    sourceChunkIds: source.sourceChunkIds,
    model: source.model,
    generatedBy: source.generatedBy,
  });
  if (!draft) notFound('Wiki 页面');
  const prepared = await prepareWikiIndex(deps, page, draft.id);
  if (!prepared) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  const published = await publishWithWikiIndex(deps, page, prepared);
  if (!published) notFound('Wiki 页面');
  return toWikiVersion(draft);
}
