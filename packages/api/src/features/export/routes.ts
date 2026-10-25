import * as agentRepo from '@agentport/db/repo/agents.js';
import { idParams } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { buildAgentPackage, packAgentPackage } from '../agent-package.js';

export function registerExportRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  // 下载就是官方 `.claude/` 目录的 ZIP；正文与运行时渲染同源。
  app.get(
    '/api/export/agents/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const row = await agentRepo.getAgent(app.db, request.params.id);
      if (!row) return reject(reply, 'AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重试');

      const pkg = await buildAgentPackage(
        app.db,
        app.config.APP_SECRET_KEY,
        app.config.SELF_URL,
        row,
      );
      const body = packAgentPackage(pkg);
      return reply
        .header('content-disposition', `attachment; filename="${pkg.slug}.zip"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type('application/zip')
        .send(body);
    },
  );
}
