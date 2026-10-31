import * as agentRepo from '@agentport/db/repo/agents.js';
import { idParams } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { authorizeObject } from '../access.js';
import { buildAgentPackage, packAgentPackage } from '../agent-package.js';

const AGENT_MISSING = '智能体不存在，可能已被删除；请刷新后重试';

export function registerExportRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  // 下载就是官方 `.claude/` 目录的 ZIP；正文与运行时渲染同源。
  app.get(
    '/api/export/agents/:id',
    {
      config: { access: { kind: 'permission', permissionId: 'agents.export' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const row = await agentRepo.getAgent(app.db, request.params.id);
      if (!row) return reject(reply, 'AGENT_NOT_FOUND', AGENT_MISSING);

      // 导出配置、规则、样式与完整定义文件；运行时 agent-memory 目录不在专家包内，
      // 原生记忆由 GET /api/agents/:id/memory/download 单独交付。缺任一读取叶都拒绝，不能静默裁剪后发出。
      const resource = { agentId: row.id };
      for (const permissionId of [
        'agents.export',
        'agents.files.read',
        'agents.config.read',
        'agents.rules.read',
        'agents.styles.read',
        'agents.memory.read',
      ] as const) {
        await authorizeObject(app, request, permissionId, resource, AGENT_MISSING);
      }

      const pkg = await buildAgentPackage(
        app.db,
        app.config.APP_SECRET_KEY,
        app.config.SELF_URL,
        row,
      );
      const body = packAgentPackage(pkg);
      return (
        reply
          .header('content-disposition', `attachment; filename="${pkg.slug}.zip"`)
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          // ZIP 里没有插件代码：用响应头把提示带给调用方，页面 toast 直接展示。
          .header('x-package-warnings', encodeURIComponent(JSON.stringify(pkg.warnings)))
          .type('application/zip')
          .send(body)
      );
    },
  );
}
