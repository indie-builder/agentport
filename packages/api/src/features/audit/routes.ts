import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reject } from '../../plugins/errors.js';
import { type TypedApp, typed } from '../../types.js';

const querySchema = z.object({
  action: z.string().trim().max(100).optional(),
  status: z.enum(['ok', 'error', 'denied']).optional(),
  target: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.iso.datetime().optional(),
  beforeId: z.string().trim().min(1).max(200).optional(),
});

const exportQuerySchema = querySchema.extend({
  limit: z.coerce.number().int().positive().max(1000).default(1000),
});

type Row = Awaited<ReturnType<typeof repo.audit.listAudit>>[number];

/** wire 上只有库里已有的列；输入只以 digest 存在，原文不会出现在这里。 */
function toItem(row: Row) {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    status: row.status,
    durationMs: row.durationMs,
    requestId: row.requestId,
    inputDigest: row.inputDigest,
    createdAt: row.createdAt.toISOString(),
  };
}

type Query = z.infer<typeof querySchema>;

/** 两个读接口共用过滤映射；未知游标返回 null，由 handler 统一拒绝。 */
async function auditOptions(app: TypedApp, query: Query): Promise<repo.audit.AuditQuery | null> {
  const { action, status, target, limit, before, beforeId } = query;
  if (beforeId !== undefined && !(await repo.audit.auditEntryExists(app.db, beforeId))) return null;
  return {
    ...(action ? { action } : {}),
    ...(status ? { status } : {}),
    ...(target ? { target } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(before === undefined ? {} : { before: new Date(before) }),
    ...(beforeId === undefined ? {} : { beforeId }),
  };
}

export function registerAuditRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/audit',
    { ...auth, schema: { querystring: querySchema } },
    async (request, reply) => {
      const options = await auditOptions(app, request.query);
      if (!options) return reject(reply, 'INVALID_INPUT', '分页游标无效');
      const rows = await repo.audit.listAudit(app.db, options);
      return { items: rows.map(toItem) };
    },
  );

  app.get(
    '/api/audit/export',
    { ...auth, schema: { querystring: exportQuerySchema } },
    async (request, reply) => {
      const options = await auditOptions(app, request.query);
      if (!options) return reject(reply, 'INVALID_INPUT', '分页游标无效');
      // 多取一条用于判断超限，绝不把截断后的结果当完整导出发出。
      const rows = await repo.audit.listAudit(app.db, {
        ...options,
        limit: request.query.limit + 1,
      });
      if (rows.length > request.query.limit) {
        return reject(
          reply,
          'CONFLICT',
          `审计记录超过 ${request.query.limit} 条，请先按目标或动作缩小范围后再导出`,
        );
      }
      const body = JSON.stringify({
        format: 'agentport/audit@1',
        exportedAt: new Date().toISOString(),
        items: rows.map(toItem),
      });
      return reply
        .header('content-disposition', 'attachment; filename="audit.json"')
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type('application/json')
        .send(body);
    },
  );
}
