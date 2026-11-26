import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Hono } from 'hono';
import { attachmentResponse } from '../../http/attachment.js';
import { type HttpEnv, requestContext } from '../../http/context.js';
import { INVALID_REQUEST_FALLBACK_MESSAGE } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { auditExportQuerySchema } from '../../http/native-schemas.js';
import { invalidCursor, requireCursorPage } from '../../http/pagination.js';
import { auditOptions, toItem } from './router.js';

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
        fail('INVALID_INPUT', parsed.error.issues[0]?.message ?? INVALID_REQUEST_FALLBACK_MESSAGE);
      const query = parsed.data;

      if (query.format === 'ndjson') {
        if (query.cursor !== undefined)
          fail('INVALID_INPUT', 'NDJSON 导出不支持 cursor 游标，请改用 afterSeq', {
            path: '/cursor',
          });
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
        if (chain === null) invalidCursor();
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
        const response = attachmentResponse(
          lines.length > 0 ? `${lines}\n` : '',
          'audit.ndjson',
          'application/x-ndjson; charset=utf-8',
        );
        if (last) response.headers.set('x-next-after-seq', String(last.chainSeq));
        return response;
      }

      const page = requireCursorPage(
        await repo.audit.listAuditPage(context.db, auditOptions(query)),
      );
      if (page.nextCursor !== null) {
        fail('CONFLICT', `审计记录超过 ${query.limit} 条，请先按目标或动作缩小范围后再导出`);
      }
      const body = JSON.stringify({
        format: 'agentport/audit@1',
        exportedAt: new Date().toISOString(),
        items: page.items.map(toItem),
      });
      return attachmentResponse(body, 'audit.json', 'application/json; charset=utf-8');
    },
  );
}
