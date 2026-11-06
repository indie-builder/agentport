import { evalCaseExportQuerySchema } from '@agentport/contract/eval';
import { fail } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { evalRunExportSchema } from '@agentport/shared';
import { asc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { authorizeObject } from '../../http/access.js';
import { type HttpEnv, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { agentNotFound, toEvalRun } from './use-cases.js';

const EXPORT_CASE_LIMIT = 500;
const EXPORT_RESULT_LIMIT = 500;
const EXPORT_BYTE_LIMIT = 1024 * 1024;

function fileResponse(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function registerEvalHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/eval/cases/export',
    access({ kind: 'permission', permissionId: 'eval.read' }),
    async (c) => {
      const context = requestContext(c);

      const parsed = evalCaseExportQuerySchema.safeParse(
        Object.fromEntries(new URL(context.request.url).searchParams),
      );
      if (!parsed.success)
        fail('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'invalid request');
      const { agentId } = parsed.data;
      await authorizeObject(context, 'eval.read', { agentId }, agentNotFound);

      const cases = await context.db
        .select({
          name: schema.evalCases.name,
          prompt: schema.evalCases.prompt,
          expectation: schema.evalCases.expectation,
        })
        .from(schema.evalCases)
        .where(eq(schema.evalCases.agentId, agentId))
        .orderBy(asc(schema.evalCases.createdAt), asc(schema.evalCases.id))
        .limit(EXPORT_CASE_LIMIT + 1);
      if (cases.length > EXPORT_CASE_LIMIT) {
        fail('CONFLICT', `用例超过 ${EXPORT_CASE_LIMIT} 条，请拆分成多个数据集后导出`);
      }

      const body = JSON.stringify(
        { format: 'agentport/eval@1', exportedAt: new Date().toISOString(), cases },
        null,
        2,
      );
      if (Buffer.byteLength(body, 'utf8') > EXPORT_BYTE_LIMIT) {
        fail('CONFLICT', '导出内容超过 1 MiB，请拆分成多个数据集后导出');
      }
      return fileResponse(body, 'eval-cases.json');
    },
  );

  app.get(
    '/api/eval/runs/:id/export',
    access({ kind: 'permission', permissionId: 'eval.read' }),
    async (c) => {
      const context = requestContext(c);

      const id = c.req.param('id');
      const detail = await repo.evalRepo.getRunDetail(context.db, id, EXPORT_RESULT_LIMIT + 1);
      if (!detail) fail('NOT_FOUND', '评估运行不存在，可能已被清理；请刷新列表');
      await authorizeObject(
        context,
        'eval.read',
        { agentId: detail.evalRun.agentId },
        agentNotFound,
      );
      if (detail.evalRun.status === 'running') {
        fail('EVAL_RUN_IN_PROGRESS', '评估运行尚未结束，无法导出结果');
      }
      if (detail.results.length > EXPORT_RESULT_LIMIT) {
        fail('CONFLICT', `结果超过 ${EXPORT_RESULT_LIMIT} 条，请拆分为多次运行后再导出`);
      }

      const body = JSON.stringify(
        evalRunExportSchema.parse({
          format: 'agentport/eval-run@1',
          exportedAt: new Date().toISOString(),
          configurationPinned: false,
          evalRun: toEvalRun(detail.evalRun),
          results: detail.results,
        }),
        null,
        2,
      );
      if (Buffer.byteLength(body, 'utf8') > EXPORT_BYTE_LIMIT) {
        fail('CONFLICT', '导出内容超过 1 MiB，请拆分为多次运行后再导出');
      }
      return fileResponse(body, 'eval-result.json');
    },
  );
}
