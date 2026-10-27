import { fail } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import {
  type EvalDatasetImportResult,
  evalCaseFieldsSchema,
  evalComparisonSchema,
  evalDatasetSchema,
  evalRunDetailSchema,
  evalRunExportSchema,
  evalRunListQuerySchema,
  evalRunPageSchema,
  idParams,
  RUN_QUEUE_MAX_WAITING,
} from '@agentport/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { evalRunRateLimit } from '../../plugins/security.js';
import { getEvalQueue, getQueue } from '../../queue/producer.js';
import { typed } from '../../types.js';

const evalRepo = repo.evalRepo;
const chatRepo = repo.chat;

/** 库里是 Date、wire 上是 ISO 字符串；列表和详情都要走这一层，否则 response schema 会 500。 */
function toEvalRun(row: repo.evalRepo.EvalRunSummary) {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status,
    total: row.total,
    passed: row.passed,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
  };
}

const createCaseSchema = evalCaseFieldsSchema.extend({ agentId: z.string().min(1) });

// partial() 会把 expectation 的默认值补回来，那样 PATCH 省略该字段就等于清空；先去掉默认值。
const patchCaseSchema = createCaseSchema
  .omit({ agentId: true })
  .partial()
  .extend({ expectation: evalCaseFieldsSchema.shape.expectation.removeDefault().optional() });

const exportQuery = z.object({ agentId: z.string().min(1) });

const importBodySchema = z.object({
  agentId: z.string().min(1),
  dataset: evalDatasetSchema,
});

/** 单次导出上限：再大就分文件，不做静默截断。 */
const EXPORT_CASE_LIMIT = 500;
const EXPORT_RESULT_LIMIT = 500;
const EXPORT_BYTE_LIMIT = 1024 * 1024;

const agentNotFound = '智能体不存在，可能已被删除；请刷新后重新选择';

const listQuery = z.object({ agentId: z.string().min(1).optional() });

export function registerEvalRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get('/api/eval/cases', { ...auth, schema: { querystring: listQuery } }, async (request) =>
    evalRepo.listCases(app.db, request.query.agentId),
  );

  app.post(
    '/api/eval/cases',
    { ...auth, schema: { body: createCaseSchema } },
    async (request, reply) => {
      const input = request.body;
      if (!(await chatRepo.agentExists(app.db, input.agentId))) {
        return reject(reply, 'AGENT_NOT_FOUND', agentNotFound);
      }
      const row = await evalRepo.createCase(app.db, newId('evalCase'), input);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.case.created',
        target: row.id,
        input: { agentId: input.agentId, name: input.name },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(201).send(row);
    },
  );

  app.patch(
    '/api/eval/cases/:id',
    { ...auth, schema: { params: idParams, body: patchCaseSchema } },
    async (request, reply) => {
      const row = await evalRepo.updateCase(app.db, request.params.id, request.body);
      if (!row) return reject(reply, 'NOT_FOUND', '用例不存在，可能已被删除；请刷新后重试');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.case.updated',
        target: request.params.id,
        input: { fields: Object.keys(request.body) },
        status: 'ok',
        requestId: request.id,
      });
      return row;
    },
  );

  app.delete(
    '/api/eval/cases/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const deleted = await evalRepo.deleteCase(app.db, request.params.id);
      if (!deleted) return reject(reply, 'NOT_FOUND', '用例不存在，可能已被删除；请刷新后重试');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.case.deleted',
        target: request.params.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // 静态路径比 /cases/:id 优先匹配；导出不读 id/agentId/createdAt。
  app.get(
    '/api/eval/cases/export',
    { ...auth, schema: { querystring: exportQuery } },
    async (request, reply) => {
      const { agentId } = request.query;
      if (!(await chatRepo.agentExists(app.db, agentId))) {
        return reject(reply, 'AGENT_NOT_FOUND', agentNotFound);
      }

      const cases = await app.db
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
        return reject(
          reply,
          'CONFLICT',
          `用例超过 ${EXPORT_CASE_LIMIT} 条，请拆分成多个数据集后导出`,
        );
      }

      const body = JSON.stringify(
        { format: 'agentport/eval@1', exportedAt: new Date().toISOString(), cases },
        null,
        2,
      );
      if (Buffer.byteLength(body, 'utf8') > EXPORT_BYTE_LIMIT) {
        return reject(reply, 'CONFLICT', '导出内容超过 1 MiB，请拆分成多个数据集后导出');
      }

      return reply
        .header('content-disposition', 'attachment; filename="eval-cases.json"')
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type('application/json')
        .send(body);
    },
  );

  app.post(
    '/api/eval/cases/import',
    { ...auth, schema: { body: importBodySchema } },
    async (request, reply) => {
      const { agentId, dataset } = request.body;
      const warnings: string[] = [];

      const result = await app.db.transaction(async (tx): Promise<EvalDatasetImportResult> => {
        // 锁住智能体行：同一目标的并发导入串行执行，重复名称检查才不会两边都通过。
        const [agent] = await tx
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(eq(schema.agents.id, agentId))
          .for('update');
        if (!agent) fail('AGENT_NOT_FOUND', agentNotFound);

        const existing = await tx
          .select({ name: schema.evalCases.name })
          .from(schema.evalCases)
          .where(
            and(
              eq(schema.evalCases.agentId, agentId),
              inArray(
                schema.evalCases.name,
                dataset.cases.map((evalCase) => evalCase.name),
              ),
            ),
          );
        const taken = new Set(existing.map((row) => row.name));

        const rows: Array<typeof schema.evalCases.$inferInsert> = [];
        let skipped = 0;
        for (const evalCase of dataset.cases) {
          if (taken.has(evalCase.name)) {
            skipped += 1;
            warnings.push(`用例「${evalCase.name}」已存在，已跳过`);
            continue;
          }
          taken.add(evalCase.name);
          rows.push({ id: newId('evalCase'), agentId, ...evalCase });
        }
        if (rows.length > 0) await tx.insert(schema.evalCases).values(rows);

        return { imported: rows.length, skipped, warnings };
      });

      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.cases.imported',
        target: agentId,
        input: { imported: result.imported, skipped: result.skipped },
        status: 'ok',
        requestId: request.id,
      });

      return reply.status(201).send(result);
    },
  );

  app.post(
    '/api/eval/runs',
    {
      ...auth,
      ...evalRunRateLimit,
      schema: { body: z.object({ agentId: z.string().min(1) }) },
    },
    async (request, reply) => {
      const { agentId } = request.body;

      const [agent] = await app.db
        .select({ id: schema.agents.id, timeoutMs: schema.agents.timeoutMs })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .limit(1);
      if (!agent) {
        return reject(reply, 'AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');
      }

      const [waitingRuns, waitingEvals] = await Promise.all([
        getQueue().getWaitingCount(),
        getEvalQueue().getWaitingCount(),
      ]);
      if (waitingRuns > RUN_QUEUE_MAX_WAITING || waitingEvals > RUN_QUEUE_MAX_WAITING) {
        return reject(reply, 'SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
      }

      let evalRun: typeof schema.evalRuns.$inferSelect | undefined;
      try {
        evalRun = await app.db.transaction(async (tx) => {
          // 同一 agent 的提交跨 API 进程串行；Redis 入队不持有数据库锁。
          const [lockedAgent] = await tx
            .select({ id: schema.agents.id })
            .from(schema.agents)
            .where(eq(schema.agents.id, agentId))
            .for('update');
          if (!lockedAgent) fail('AGENT_NOT_FOUND', agentNotFound);
          const cases = await tx
            .select({
              id: schema.evalCases.id,
              name: schema.evalCases.name,
              prompt: schema.evalCases.prompt,
              expectation: schema.evalCases.expectation,
            })
            .from(schema.evalCases)
            .where(eq(schema.evalCases.agentId, agentId))
            .orderBy(asc(schema.evalCases.createdAt), asc(schema.evalCases.id));
          if (cases.length === 0) fail('INVALID_INPUT', '该智能体还没有用例');
          const [running] = await tx
            .select({ id: schema.evalRuns.id })
            .from(schema.evalRuns)
            .where(and(eq(schema.evalRuns.agentId, agentId), eq(schema.evalRuns.status, 'running')))
            .limit(1);
          if (running) return undefined;
          const [created] = await tx
            .insert(schema.evalRuns)
            .values({ id: newId('evalRun'), agentId, total: cases.length, caseSnapshot: cases })
            .returning();
          return created;
        });
      } catch (err) {
        if (!isPgCode(err, '23505')) throw err;
      }
      if (!evalRun) {
        return reject(reply, 'EVAL_RUN_IN_PROGRESS', '该智能体已有正在运行的评估');
      }

      // 执行搬到 worker：API 重启不再让跑批停在 running。
      try {
        await getEvalQueue().add(
          'eval-run',
          { evalRunId: evalRun.id },
          { jobId: evalRun.id, removeOnComplete: 100, removeOnFail: 200 },
        );
      } catch {
        // 只收口仍由本次调用持有的 run；worker 已认领或已终态时不得覆盖。
        try {
          const [failed] = await app.db
            .update(schema.evalRuns)
            .set({
              status: 'failed',
              error: '评估入队失败，请稍后重试',
              finishedAt: new Date(),
            })
            .where(
              and(
                eq(schema.evalRuns.id, evalRun.id),
                eq(schema.evalRuns.status, 'running'),
                isNull(schema.evalRuns.claimedAt),
              ),
            )
            .returning({ id: schema.evalRuns.id });
          if (failed) {
            await getEvalQueue()
              .getJob(evalRun.id)
              .then((job) => job?.remove())
              .catch(() => undefined);
          }
        } catch {
          // 清理失败时没有可安全回显的细节，仍然返回固定的入队失败。
        }
        // cause 会被日志序列化，不能附带可能包含凭证的队列错误。
        fail('SERVICE_UNAVAILABLE', '评估入队失败，请稍后重试');
      }

      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.run.requested',
        target: evalRun.id,
        input: { agentId, total: evalRun.total },
        status: 'ok',
        requestId: request.id,
      });

      return reply.status(202).send({ evalRunId: evalRun.id });
    },
  );

  app.post(
    '/api/eval/runs/:id/cancel',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const { id } = request.params;
      // 存在性校验只需要主键；不用共享 getEvalRun，避免读取 case_snapshot 等大字段。
      const [run] = await app.db
        .select({ id: schema.evalRuns.id })
        .from(schema.evalRuns)
        .where(eq(schema.evalRuns.id, id))
        .limit(1);
      if (!run) return reject(reply, 'NOT_FOUND', '评估运行不存在，可能已被清理；请刷新列表');
      // 已收口的跑批重复取消是无操作；只有真正完成转换的一方写审计。
      if (await evalRepo.cancelEvalRun(app.db, id)) {
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'eval.run.cancelled',
          target: id,
          status: 'ok',
          requestId: request.id,
        });
      }
      return reply.status(202).send({ ok: true });
    },
  );

  app.get(
    '/api/eval/runs',
    {
      ...auth,
      schema: { querystring: evalRunListQuerySchema, response: { 200: evalRunPageSchema } },
    },
    async (request, reply) => {
      const page = await evalRepo.listRuns(app.db, {
        ...(request.query.agentId === undefined ? {} : { agentId: request.query.agentId }),
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        limit: request.query.limit,
      });
      if (!page) return reject(reply, 'INVALID_INPUT', '分页游标不存在或不属于当前筛选条件');
      return { items: page.items.map(toEvalRun), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/api/eval/runs/:id/compare',
    {
      ...auth,
      schema: {
        params: idParams,
        querystring: z.object({ head: z.string().min(1) }),
        response: { 200: evalComparisonSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { head } = request.query;
      if (id === head) return reject(reply, 'INVALID_INPUT', '不能把评估运行与自身对比');
      const comparison = await evalRepo.getComparison(app.db, id, head);
      if (!comparison)
        return reject(reply, 'NOT_FOUND', '评估运行不存在，可能已被清理；请刷新列表');
      if (comparison.baseRun.agentId !== comparison.headRun.agentId) {
        return reject(reply, 'INVALID_INPUT', '只能对比同一智能体的评估运行');
      }
      const running = [comparison.baseRun, comparison.headRun].find(
        (run) => run.status === 'running',
      );
      if (running) {
        return reject(reply, 'EVAL_RUN_IN_PROGRESS', '评估运行尚未结束，无法对比');
      }
      return {
        baseRun: toEvalRun(comparison.baseRun),
        headRun: toEvalRun(comparison.headRun),
        rows: comparison.rows,
      };
    },
  );

  app.get(
    '/api/eval/runs/:id/export',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      // 多取一条用于判断「超过上限」，绝不把截断后的结果当完整导出发出。
      const detail = await evalRepo.getRunDetail(
        app.db,
        request.params.id,
        EXPORT_RESULT_LIMIT + 1,
      );
      if (!detail) return reject(reply, 'NOT_FOUND', '评估运行不存在，可能已被清理；请刷新列表');
      if (detail.evalRun.status === 'running') {
        return reject(reply, 'EVAL_RUN_IN_PROGRESS', '评估运行尚未结束，无法导出结果');
      }
      if (detail.results.length > EXPORT_RESULT_LIMIT) {
        return reject(
          reply,
          'CONFLICT',
          `结果超过 ${EXPORT_RESULT_LIMIT} 条，请拆分为多次运行后再导出`,
        );
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
        return reject(reply, 'CONFLICT', '导出内容超过 1 MiB，请拆分为多次运行后再导出');
      }

      return reply
        .header('content-disposition', 'attachment; filename="eval-result.json"')
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type('application/json')
        .send(body);
    },
  );

  app.get(
    '/api/eval/runs/:id',
    { ...auth, schema: { params: idParams, response: { 200: evalRunDetailSchema } } },
    async (request, reply) => {
      const detail = await evalRepo.getRunDetail(app.db, request.params.id);
      if (!detail) return reject(reply, 'NOT_FOUND', '评估运行不存在，可能已被清理；请刷新列表');
      return { ...detail, evalRun: toEvalRun(detail.evalRun) };
    },
  );
}
