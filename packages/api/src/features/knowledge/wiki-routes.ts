import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { repo, schema } from '@agentport/db';
import {
  type KnowledgeIngestInputSnapshot,
  knowledgeWikiLinksResultSchema,
  knowledgeWikiVersionDiffSchema,
  slugSchema,
} from '@agentport/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { z } from 'zod';
import { isAppError, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { createJob, enqueueKnowledgeJob } from './service.js';

const baseParams = z.object({ id: z.string().min(1) });
const pageParams = z.object({ pageId: z.string().min(1) });

const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const pageCreateSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(300),
  parentId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
});

/** markdown 只存在于版本里：保存写入新草稿，不修改线上版本。 */
const pagePatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  markdown: z.string().min(1).optional(),
  parentId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
  /** 最新草稿版本的乐观锁；已变化则 409。 */
  expectedVersion: z.string().min(1).nullable().optional(),
});

const generateSchema = z.object({
  instruction: z.string().max(2_000).optional(),
  sourceDocumentIds: z.array(z.string().min(1)).max(50).optional(),
});

const rollbackSchema = z.object({ versionId: z.string().min(1) });
const publishSchema = z.object({ versionId: z.string().min(1) });
const diffQuery = z.object({
  fromVersionId: z.string().min(1),
  toVersionId: z.string().min(1),
});

type PageRow = typeof schema.knowledgeWikiPages.$inferSelect;

function toPage(row: PageRow) {
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

function toVersion(row: typeof schema.knowledgeWikiVersions.$inferSelect) {
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

/** 与 WeKnora 一致：`[[slug]]`、`[[slug|显示名]]`；额外支持 `#anchor`。 */
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

/**
 * 结构由真实 Markdown AST 解析（代码块内的 `[[...]]` 不算链接），
 * 只在 text 节点上识别 Wiki 链接语法；不用正则代替 Markdown 解析。
 */
function extractWikiLinks(markdown: string): WikiLinkToken[] {
  const tree = fromMarkdown(markdown) as MarkdownNode;
  const links: WikiLinkToken[] = [];
  const seen = new Set<string>();
  const visit = (node: MarkdownNode): void => {
    // code/inlineCode/html 里的文本不是可点击链接。
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

interface PageMarkdownRow {
  id: string;
  slug: string;
  markdown: string | null;
}

/** 每页最新版本（草稿优先于线上）的正文；管理端组织视图使用最新内容。 */
async function latestPageMarkdowns(
  app: FastifyInstance,
  baseId: string,
): Promise<PageMarkdownRow[]> {
  const result = await app.db.execute<{ id: string; slug: string; markdown: string | null }>(sql`
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
  return result.rows;
}

async function latestVersion(
  app: FastifyInstance,
  pageId: string,
): Promise<typeof schema.knowledgeWikiVersions.$inferSelect | null> {
  const [row] = await app.db
    .select()
    .from(schema.knowledgeWikiVersions)
    .where(eq(schema.knowledgeWikiVersions.pageId, pageId))
    .orderBy(desc(schema.knowledgeWikiVersions.version))
    .limit(1);
  return row ?? null;
}

/**
 * 每页一个内部索引文档（contentKind=wiki），发布/回退把线上正文交给既有 ingest。
 * 身份是 baseId + metadata.wikiPageId；版本 metadata 固定当前 wikiVersionId，
 * 检索只在索引版本追上线上指针时召回。
 *
 * 准备阶段只校验版本归属并写内容寻址 blob：不碰 document/job，文件失败时数据库零变更。
 * 索引指针未知，任务载荷在发布事务锁住页面后补齐。
 */
type PreparedWikiIndex = {
  versionId: string;
  sizeBytes: number;
  input: KnowledgeIngestInputSnapshot;
};

async function prepareWikiIndex(
  app: FastifyInstance,
  page: PageRow,
  versionId: string,
): Promise<PreparedWikiIndex | null> {
  const [version] = await app.db
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
  const sha = createHash('sha256').update(data).digest('hex');
  const blobPath = join(app.config.KNOWLEDGE_DIR, 'blobs', sha.slice(0, 2), sha);
  await mkdir(dirname(blobPath), { recursive: true });
  await writeFile(blobPath, data);
  return {
    versionId: version.id,
    sizeBytes: data.length,
    input: {
      blobSha256: sha,
      filename: `${page.slug}.md`,
      mimeType: 'text/markdown',
      // 发布事务锁页后按索引文档旧指针补齐。
      expectedCurrentVersionId: null,
    },
  };
}

/**
 * 一次事务完成切指针、索引文档 upsert 与任务创建：任何一步失败都整体回滚。
 * 内部索引文档的 contentHash 保持不可变的线上指纹，任务只消费 payload.input 的 blob。
 * 提交后才投递；投递失败留下的 queued 任务由既有 reconcile 补投。
 */
async function publishWithWikiIndex(
  app: FastifyInstance,
  page: PageRow,
  prepared: PreparedWikiIndex,
  log: FastifyInstance['log'],
): Promise<PageRow | null> {
  const committed = await app.db.transaction(async (tx) => {
    // 事务内先按统一锁序取来源/文档/Wiki page 锁并核来源；锁持有到提交。
    const updated = await repo.knowledge.publishWikiVersionTx(tx, page.id, prepared.versionId);
    if (!updated) return null;

    // page 行锁已持有，同页发布串行，查询后创建即可保持一页一索引。
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
  // 投递失败不影响已发布页面；queued job 由既有 reconcile 补投。
  await enqueueKnowledgeJob({ id: committed.jobId }).catch((err: unknown) => {
    log.warn({ err, jobId: committed.jobId }, 'Wiki 索引任务入队失败，等待对账补投');
  });
  return committed.page;
}

export function registerWikiRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  const pageOptions = (query: { cursor?: string | undefined; limit?: number | undefined }) => ({
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });

  app.get(
    '/api/knowledge/bases/:id/wiki-pages',
    { ...auth, schema: { params: baseParams, querystring: pageQuery } },
    async (request, reply) => {
      if (!(await repo.knowledge.getBase(app.db, request.params.id))) {
        return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      }
      const page = await repo.knowledge.listWikiPages(
        app.db,
        request.params.id,
        pageOptions(request.query),
      );
      return { items: page.items.map(toPage), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/api/knowledge/bases/:id/wiki-pages',
    { ...auth, schema: { params: baseParams, body: pageCreateSchema } },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      const row = await repo.knowledge.createWikiPage(app.db, {
        baseId: base.id,
        slug: request.body.slug,
        title: request.body.title,
      });
      if (request.body.parentId !== undefined || request.body.position !== undefined) {
        try {
          const updated = await repo.knowledge.updateWikiPageStructure(app.db, row.id, {
            ...(request.body.parentId === undefined ? {} : { parentId: request.body.parentId }),
            ...(request.body.position === undefined ? {} : { position: request.body.position }),
          });
          return reply.status(201).send(toPage(updated ?? row));
        } catch (err) {
          await app.db
            .delete(schema.knowledgeWikiPages)
            .where(eq(schema.knowledgeWikiPages.id, row.id))
            .catch(() => undefined);
          if (isAppError(err)) return reject(reply, err.code, err.message);
          throw err;
        }
      }
      return reply.status(201).send(toPage(row));
    },
  );

  app.get(
    '/api/knowledge/wiki-pages/:pageId',
    { ...auth, schema: { params: pageParams, querystring: pageQuery } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      const versions = await repo.knowledge.listWikiVersions(
        app.db,
        page.id,
        pageOptions(request.query),
      );
      return {
        ...toPage(page),
        versions: versions.items.map(toVersion),
        nextCursor: versions.nextCursor,
      };
    },
  );

  app.patch(
    '/api/knowledge/wiki-pages/:pageId',
    { ...auth, schema: { params: pageParams, body: pagePatchSchema } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      try {
        const structure = {
          ...(request.body.title === undefined ? {} : { title: request.body.title }),
          ...(request.body.parentId === undefined ? {} : { parentId: request.body.parentId }),
          ...(request.body.position === undefined ? {} : { position: request.body.position }),
        };
        const hasStructure = Object.keys(structure).length > 0;
        // 结构与正文同事务：saveWikiDraft 先核 expectedVersion，再写结构，最后追加草稿。
        if (request.body.markdown !== undefined) {
          const previous = await latestVersion(app, page.id);
          await repo.knowledge.saveWikiDraft(app.db, page.id, {
            markdown: request.body.markdown,
            sourceChunkIds: previous?.sourceChunkIds ?? [],
            model: 'manual',
            generatedBy: 'manual',
            ...(request.body.expectedVersion === undefined
              ? {}
              : { expectedVersion: request.body.expectedVersion }),
            ...(hasStructure ? { structure } : {}),
          });
        } else if (hasStructure) {
          await repo.knowledge.updateWikiPageStructure(app.db, page.id, {
            ...structure,
            ...(request.body.expectedVersion === undefined
              ? {}
              : { expectedVersionId: request.body.expectedVersion }),
          });
        }
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
      const updated = await repo.knowledge.getWikiPage(app.db, page.id);
      return updated ? toPage(updated) : reject(reply, 'NOT_FOUND', 'Wiki 页面不存在');
    },
  );

  app.post(
    '/api/knowledge/wiki-pages/:pageId/generate',
    { ...auth, schema: { params: pageParams, body: generateSchema } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      const job = await createJob(app.db, {
        baseId: page.baseId,
        documentId: null,
        payload: {
          type: 'wiki_generate',
          baseId: page.baseId,
          pageId: page.id,
          ...(request.body.instruction === undefined
            ? {}
            : { instruction: request.body.instruction }),
          ...(request.body.sourceDocumentIds === undefined
            ? {}
            : { sourceDocumentIds: request.body.sourceDocumentIds }),
        },
      });
      await enqueueKnowledgeJob(job);
      return reply.status(202).send({ jobId: job.id });
    },
  );

  // 草稿版本列表：sdk 与人工都只追加，人工从这里挑一版发布。
  app.get(
    '/api/knowledge/wiki-pages/:pageId/versions',
    { ...auth, schema: { params: pageParams, querystring: pageQuery } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      const versions = await repo.knowledge.listWikiVersions(
        app.db,
        page.id,
        pageOptions(request.query),
      );
      return { items: versions.items.map(toVersion), nextCursor: versions.nextCursor };
    },
  );

  app.get(
    '/api/knowledge/wiki-pages/:pageId/links',
    { ...auth, schema: { params: pageParams } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      const rows = await latestPageMarkdowns(app, page.baseId);
      const bySlug = new Map(rows.map((row) => [row.slug.toLowerCase(), row.id]));
      const current = rows.find((row) => row.id === page.id);
      const outgoing = (current?.markdown ? extractWikiLinks(current.markdown) : []).map(
        (link) => ({
          // 目标不存在时 targetPageId 为 null：管理端据此标坏链接，不丢弃。
          targetPageId: bySlug.get(link.slug) ?? null,
          anchor: link.anchor,
        }),
      );
      const incoming = rows.flatMap((row) => {
        if (row.id === page.id || !row.markdown) return [];
        return extractWikiLinks(row.markdown).flatMap((link) =>
          bySlug.get(link.slug) === page.id ? [{ sourcePageId: row.id, anchor: link.anchor }] : [],
        );
      });
      return knowledgeWikiLinksResultSchema.parse({ outgoing, incoming });
    },
  );

  app.get(
    '/api/knowledge/wiki-pages/:pageId/diff',
    { ...auth, schema: { params: pageParams, querystring: diffQuery } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      const diff = await repo.knowledge.getWikiVersionDiff(
        app.db,
        page.id,
        request.query.fromVersionId,
        request.query.toVersionId,
      );
      if (!diff) return reject(reply, 'NOT_FOUND', '版本不存在或不属于该页面');
      return knowledgeWikiVersionDiffSchema.parse(diff);
    },
  );

  app.post(
    '/api/knowledge/wiki-pages/:pageId/publish',
    { ...auth, schema: { params: pageParams, body: publishSchema } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      try {
        // 先写内容寻址 blob：文件失败时数据库零发布变更；事务内再切指针并建任务。
        const prepared = await prepareWikiIndex(app, page, request.body.versionId);
        if (!prepared) return reject(reply, 'NOT_FOUND', '版本不存在或不属于该页面');
        const updated = await publishWithWikiIndex(app, page, prepared, request.log);
        if (!updated) return reject(reply, 'NOT_FOUND', '版本不存在或不属于该页面');
        return toPage(updated);
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.post(
    '/api/knowledge/wiki-pages/:pageId/rollback',
    { ...auth, schema: { params: pageParams, body: rollbackSchema } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      try {
        // 回退 = 复制目标版本为新草稿再显式发布；来源失效由发布事务按同一规则拒绝。
        const [source] = await app.db
          .select()
          .from(schema.knowledgeWikiVersions)
          .where(
            and(
              eq(schema.knowledgeWikiVersions.id, request.body.versionId),
              eq(schema.knowledgeWikiVersions.pageId, page.id),
            ),
          )
          .limit(1);
        if (!source) return reject(reply, 'NOT_FOUND', '版本不存在或不属于该页面');
        const draft = await repo.knowledge.saveWikiDraft(app.db, page.id, {
          markdown: source.markdown,
          sourceChunkIds: source.sourceChunkIds,
          model: source.model,
          generatedBy: source.generatedBy,
        });
        if (!draft) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
        const prepared = await prepareWikiIndex(app, page, draft.id);
        if (!prepared) return reject(reply, 'NOT_FOUND', '版本不存在或不属于该页面');
        const published = await publishWithWikiIndex(app, page, prepared, request.log);
        if (!published) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
        return reply.status(201).send(toVersion(draft));
      } catch (err) {
        // 回退引用已失效的来源时拒绝，不把失效来源洗成有效发布。
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );
}
