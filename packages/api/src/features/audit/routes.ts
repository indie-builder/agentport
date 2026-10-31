import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';

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

/** 两个读接口共用过滤映射；游标是否有效只在空页时补查，非空页由查询本身证明。 */
function auditOptions(query: Query): repo.audit.AuditQuery {
  const { action, status, target, limit, before, beforeId } = query;
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

  app.get(
    '/api/audit',
    {
      config: { access: { kind: 'permission', permissionId: 'audit.read' } },
      schema: { querystring: querySchema },
    },
    async (request, reply) => {
      const options = auditOptions(request.query);
      const rows = await repo.audit.listAudit(app.db, options);
      if (
        request.query.beforeId !== undefined &&
        rows.length === 0 &&
        !(await repo.audit.auditEntryExists(app.db, request.query.beforeId))
      ) {
        return reject(reply, 'INVALID_INPUT', '分页游标无效');
      }
      return { items: rows.map(toItem) };
    },
  );

  app.get(
    '/api/audit/export',
    {
      config: { access: { kind: 'permission', permissionId: 'audit.read' } },
      schema: { querystring: exportQuerySchema },
    },
    async (request, reply) => {
      const options = auditOptions(request.query);
      // 多取一条用于判断超限，绝不把截断后的结果当完整导出发出。
      const rows = await repo.audit.listAudit(app.db, {
        ...options,
        limit: request.query.limit + 1,
      });
      if (
        request.query.beforeId !== undefined &&
        rows.length === 0 &&
        !(await repo.audit.auditEntryExists(app.db, request.query.beforeId))
      ) {
        return reject(reply, 'INVALID_INPUT', '分页游标无效');
      }
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
