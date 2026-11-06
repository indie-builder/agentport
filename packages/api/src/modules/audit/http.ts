import { auditQuerySchema } from '@agentport/contract/audit';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { type AppContext, type HttpEnv, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';

const exportQuerySchema = auditQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(1000).default(1000),
});

type Row = Awaited<ReturnType<typeof repo.audit.listAudit>>[number];

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

export function registerAuditHttp(app: Hono<HttpEnv>, _deps: AppContext): void {
  app.get(
    '/api/audit/export',
    access({ kind: 'permission', permissionId: 'audit.read' }),
    async (c) => {
      const context = requestContext(c);

      const parsed = exportQuerySchema.safeParse(
        Object.fromEntries(new URL(context.request.url).searchParams),
      );
      if (!parsed.success)
        fail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'invalid request');
      const query = parsed.data;

      const options: repo.audit.AuditQuery = {
        ...(query.action ? { action: query.action } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.target ? { target: query.target } : {}),
        ...(query.before === undefined ? {} : { before: new Date(query.before) }),
        ...(query.beforeId === undefined ? {} : { beforeId: query.beforeId }),
      };
      const rows = await repo.audit.listAudit(context.db, {
        ...options,
        limit: query.limit + 1,
      });
      if (
        query.beforeId !== undefined &&
        rows.length === 0 &&
        !(await repo.audit.auditEntryExists(context.db, query.beforeId))
      ) {
        fail('INVALID_INPUT', '分页游标无效');
      }
      if (rows.length > query.limit) {
        fail('CONFLICT', `审计记录超过 ${query.limit} 条，请先按目标或动作缩小范围后再导出`);
      }
      const body = JSON.stringify({
        format: 'agentport/audit@1',
        exportedAt: new Date().toISOString(),
        items: rows.map(toItem),
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="audit.json"',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    },
  );
}
