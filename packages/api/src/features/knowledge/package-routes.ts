import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { actorOf } from '../access.js';
import {
  exportKnowledgePackage,
  importKnowledgePackage,
  KNOWLEDGE_PACKAGE_MAX_BYTES,
} from './package.js';

const baseParams = z.object({ id: z.string().min(1) });

export function registerKnowledgePackageRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  // 知识包是二进制 ZIP；专家包导入可能已注册同一 content-type，此时复用它
  // （路由级 bodyLimit 优先于 parser 默认值）。
  if (!rawApp.hasContentTypeParser('application/zip')) {
    rawApp.addContentTypeParser(
      'application/zip',
      { parseAs: 'buffer', bodyLimit: KNOWLEDGE_PACKAGE_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
  }

  app.get(
    '/api/knowledge/bases/:id/export',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.export' } },
      schema: { params: baseParams },
    },
    async (request, reply) => {
      const pkg = await exportKnowledgePackage(app.db, app.config.KNOWLEDGE_DIR, request.params.id);
      if (!pkg) return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除；请刷新后重试');
      return reply
        .header('content-disposition', `attachment; filename="${pkg.filename}"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type('application/zip')
        .send(pkg.body);
    },
  );

  app.post(
    '/api/knowledge/bases/import',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.import' } },
      bodyLimit: KNOWLEDGE_PACKAGE_MAX_BYTES,
      schema: { body: z.instanceof(Buffer) },
    },
    async (request, reply) => {
      const result = await importKnowledgePackage(app.db, app.config.KNOWLEDGE_DIR, request.body);
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
        action: 'knowledge.base.imported',
        target: result.baseId,
        input: result.counts,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(201).send(result);
    },
  );
}
