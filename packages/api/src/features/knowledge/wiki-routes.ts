import { repo, schema } from '@agentport/db';
import { slugSchema } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
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
});

/** markdown 只存在于版本里：人工编辑写入新版本，不覆盖历史。 */
const pagePatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  markdown: z.string().min(1).optional(),
  /** 打开编辑时的 currentVersionId；已变化则 409，避免静默覆盖别人的发布。 */
  expectedVersion: z.string().min(1).nullable().optional(),
});

const generateSchema = z.object({
  instruction: z.string().max(2_000).optional(),
  sourceDocumentIds: z.array(z.string().min(1)).max(50).optional(),
});

const rollbackSchema = z.object({ versionId: z.string().min(1) });
const publishSchema = z.object({ versionId: z.string().min(1) });

type PageRow = typeof schema.knowledgeWikiPages.$inferSelect;

function toPage(row: PageRow) {
  return {
    id: row.id,
    baseId: row.baseId,
    slug: row.slug,
    title: row.title,
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
      if (request.body.title !== undefined) {
        await app.db
          .update(schema.knowledgeWikiPages)
          .set({ title: request.body.title, updatedAt: new Date() })
          .where(eq(schema.knowledgeWikiPages.id, page.id));
      }
      if (request.body.markdown !== undefined) {
        const previous = page.currentVersionId
          ? await app.db
              .select({ sourceChunkIds: schema.knowledgeWikiVersions.sourceChunkIds })
              .from(schema.knowledgeWikiVersions)
              .where(eq(schema.knowledgeWikiVersions.id, page.currentVersionId))
              .limit(1)
          : [];
        try {
          await repo.knowledge.saveWikiVersion(app.db, page.id, {
            markdown: request.body.markdown,
            sourceChunkIds: previous[0]?.sourceChunkIds ?? [],
            model: 'manual',
            generatedBy: 'manual',
            ...(request.body.expectedVersion === undefined
              ? {}
              : { expectedVersion: request.body.expectedVersion }),
          });
        } catch (err) {
          if (isAppError(err)) return reject(reply, err.code, err.message);
          throw err;
        }
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

  // 草稿版本列表：sdk 只追加不发布，人工从这里挑一版上线。
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

  app.post(
    '/api/knowledge/wiki-pages/:pageId/publish',
    { ...auth, schema: { params: pageParams, body: publishSchema } },
    async (request, reply) => {
      const page = await repo.knowledge.getWikiPage(app.db, request.params.pageId);
      if (!page) return reject(reply, 'NOT_FOUND', 'Wiki 页面不存在，可能已被删除');
      try {
        // 只切指针：版本必须属于该页；来源已撤权时 409，不静默发布失效引用。
        const updated = await repo.knowledge.publishWikiVersion(
          app.db,
          page.id,
          request.body.versionId,
        );
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
      const version = await repo.knowledge.rollbackWikiPage(
        app.db,
        page.id,
        request.body.versionId,
      );
      if (!version) return reject(reply, 'NOT_FOUND', '版本不存在或不属于该页面');
      return reply.status(201).send(toVersion(version));
    },
  );
}
