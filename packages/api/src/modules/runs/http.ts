import { fail, notFound } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { accessFilter } from '../../http/access.js';
import { attachmentResponse } from '../../http/attachment.js';
import type { HttpEnv } from '../../http/context.js';
import { parseRequest, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { runExportQuerySchema } from '../../http/native-schemas.js';
import { requireCursorPage } from '../../http/pagination.js';
import { authorizeRun, RUN_MISSING } from './access.js';
import { toRunDetail, toRunItem } from './events.js';

export function registerRunExportHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/runs/export',
    access({ kind: 'permission', permissionId: 'runs.export' }),
    async (c) => {
      const context = requestContext(c);
      const input = parseRequest(
        c,
        z.object({
          query: runExportQuerySchema,
        }),
      );
      const { agentId, status, trigger, since, limit } = input.query;
      const page = requireCursorPage(
        await repo.runs.listRuns(context.db, {
          ...(agentId === undefined ? {} : { agentId }),
          ...(status === undefined ? {} : { status }),
          ...(trigger === undefined ? {} : { trigger }),
          ...(since === undefined ? {} : { since: new Date(since) }),
          limit,
          access: accessFilter(context, 'runs.export'),
        }),
      );
      if (page.nextCursor !== null) {
        return fail('CONFLICT', `运行记录超过 ${limit} 条，请先按智能体或状态缩小范围后再导出`);
      }
      return attachmentResponse(
        JSON.stringify({
          format: 'agentport/runs@1',
          exportedAt: new Date().toISOString(),
          items: page.items.map(toRunItem),
        }),
        'runs.json',
        'application/json',
      );
    },
  );
  app.get(
    '/api/runs/:id/export',
    access({ kind: 'permission', permissionId: 'runs.export' }),
    async (c) => {
      const context = requestContext(c);
      const id = c.req.param('id');
      await authorizeRun(context, id, 'runs.export');
      const detail = await repo.runs.getRunDetail(context.db, id);
      if (!detail) notFound('run', RUN_MISSING);
      const body = JSON.stringify({
        format: 'agentport/run-trajectory@1',
        exportedAt: new Date().toISOString(),
        ...toRunDetail(detail),
      });
      return attachmentResponse(body, `run-${id}.json`, 'application/json');
    },
  );
}
