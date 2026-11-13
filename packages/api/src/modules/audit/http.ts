import { auditQuerySchema } from '@agentport/contract/audit';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { type HttpEnv, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { auditOptions, toItem } from './router.js';

export const auditExportQuerySchema = auditQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(1000).default(1000),
  format: z.enum(['json', 'ndjson']).default('json'),
  afterSeq: z.coerce.number().int().nonnegative().optional(),
});

export function registerAuditHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/audit/export',
    access({ kind: 'permission', permissionId: 'audit.read' }),
    async (c) => {
      const context = requestContext(c);

      const parsed = auditExportQuerySchema.safeParse(
        Object.fromEntries(new URL(context.request.url).searchParams),
      );
      if (!parsed.success)
        fail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'invalid request');
      const query = parsed.data;

      if (query.format === 'ndjson') {
        if (query.beforeId !== undefined)
          fail('INVALID_INPUT', 'NDJSON 导出不支持 beforeId 游标，请改用 afterSeq');
        const chain = await repo.audit.listAudit(context.db, {
          ...auditOptions({
            action: query.action,
            status: query.status,
            target: query.target,
            actor: query.actor,
            actorKind: query.actorKind,
            since: query.since,
            before: query.before,
            limit: query.limit,
          }),
          order: 'asc',
          ...(query.afterSeq === undefined ? {} : { afterSeq: query.afterSeq }),
        });
        const last = chain.at(-1);
        const lines = chain
          .map((row) =>
            JSON.stringify({
              ...toItem(row),
              chainSeq: row.chainSeq,
              prevHash: row.prevHash,
              hash: row.hash,
            }),
          )
          .join('\n');
        return new Response(lines.length > 0 ? `${lines}\n` : '', {
          status: 200,
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': 'attachment; filename="audit.ndjson"',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...(last ? { 'x-next-after-seq': String(last.chainSeq) } : {}),
          },
        });
      }

      const rows = await repo.audit.listAudit(context.db, {
        ...auditOptions(query),
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
