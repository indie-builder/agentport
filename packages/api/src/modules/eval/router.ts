import { evalContract } from '@agentport/contract/eval';
import { fail } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import { implement } from '@orpc/server';
import { eq } from 'drizzle-orm';
import { accessFilter, actorOf, authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { authorizeRun, RUN_MISSING } from '../runs/access.js';
import { agentNotFound, importEvalCases, startEvalRun, toEvalRun } from './use-cases.js';

const os = implement(evalContract).$context<RequestContext>();
const evalRepo = repo.evalRepo;

function toEvalCase(row: repo.evalRepo.EvalCase) {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    prompt: row.prompt,
    expectation: row.expectation,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

async function authorizeEvalAgent(
  context: RequestContext,
  agentId: string,
  permissionIds: ReadonlyArray<'eval.read' | 'eval.manage' | 'eval.execute' | 'agents.use'>,
): Promise<void> {
  for (const permissionId of permissionIds) {
    await authorizeObject(context, permissionId, { agentId }, agentNotFound);
  }
}

export const evalRouter = os.router({
  cases: {
    list: os.cases.list.handler(async ({ input, context }) => {
      const rows = await evalRepo.listCases(
        context.db,
        accessFilter(context, 'eval.read'),
        input.query.agentId,
      );
      return rows.map(toEvalCase);
    }),
    create: os.cases.create.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      await authorizeEvalAgent(context, input.body.agentId, ['eval.read', 'eval.manage']);
      const row = await evalRepo.createCase(context.db, newId('evalCase'), {
        ...input.body,
        createdBy: businessId,
      });
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'eval.case.created',
        target: row.id,
        input: { agentId: input.body.agentId, name: input.body.name },
        status: 'ok',
        requestId: context.requestId,
      });
      return toEvalCase(row);
    }),
    fromRun: os.cases.fromRun.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      await authorizeRun(context, input.body.runId, 'runs.read');
      const detail = await repo.runs.getRunDetail(context.db, input.body.runId);
      if (!detail) fail('RUN_NOT_FOUND', RUN_MISSING);
      const prompt = detail.steps.find((step) => step.kind === 'user')?.text;
      if (!prompt || !prompt.trim()) {
        fail('INVALID_INPUT', '该运行没有可用的用户输入，无法生成评估用例');
      }
      const expectation =
        [...detail.steps].reverse().find((step) => step.kind === 'assistant')?.text ?? '';
      const agentId = detail.run.agentId;
      await authorizeEvalAgent(context, agentId, ['eval.read', 'eval.manage']);
      const rawName = input.body.name ?? detail.conversation.title;
      const name = (rawName.trim() ? rawName.trim() : `运行 ${detail.run.id}`).slice(0, 128);
      const row = await evalRepo.createCase(context.db, newId('evalCase'), {
        agentId,
        name,
        prompt: prompt.slice(0, 20_000),
        expectation: expectation.slice(0, 5_000),
        createdBy: businessId,
      });
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'eval.case.created',
        target: row.id,
        input: { agentId, name, fromRun: detail.run.id },
        status: 'ok',
        requestId: context.requestId,
      });
      return toEvalCase(row);
    }),
    update: os.cases.update.handler(async ({ input, context }) => {
      const existing = await evalRepo.getCase(context.db, input.params.id);
      if (!existing) fail('NOT_FOUND', '用例不存在，可能已被删除；请刷新后重试');
      await authorizeEvalAgent(context, existing.agentId, ['eval.read', 'eval.manage']);
      const row = await evalRepo.updateCase(context.db, input.params.id, input.body);
      if (!row) fail('NOT_FOUND', '用例不存在，可能已被删除；请刷新后重试');
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'eval.case.updated',
        target: input.params.id,
        input: { fields: Object.keys(input.body) },
        status: 'ok',
        requestId: context.requestId,
      });
      return toEvalCase(row);
    }),
    remove: os.cases.remove.handler(async ({ input, context }) => {
      const existing = await evalRepo.getCase(context.db, input.params.id);
      if (!existing) fail('NOT_FOUND', '用例不存在，可能已被删除；请刷新后重试');
      await authorizeEvalAgent(context, existing.agentId, ['eval.read', 'eval.manage']);
      const deleted = await evalRepo.deleteCase(context.db, input.params.id);
      if (!deleted) fail('NOT_FOUND', '用例不存在，可能已被删除；请刷新后重试');
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'eval.case.deleted',
        target: input.params.id,
        status: 'ok',
        requestId: context.requestId,
      });
      return undefined;
    }),
    import: os.cases.import.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      await authorizeEvalAgent(context, input.body.agentId, ['eval.read', 'eval.manage']);
      const result = await importEvalCases(
        context.db,
        input.body.agentId,
        input.body.dataset,
        businessId,
      );
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'eval.cases.imported',
        target: input.body.agentId,
        input: { imported: result.imported, skipped: result.skipped },
        status: 'ok',
        requestId: context.requestId,
      });
      return result;
    }),
  },
  runs: {
    list: os.runs.list.handler(async ({ input, context }) => {
      const page = await evalRepo.listRuns(context.db, {
        ...(input.query.agentId === undefined ? {} : { agentId: input.query.agentId }),
        ...(input.query.cursor === undefined ? {} : { cursor: input.query.cursor }),
        limit: input.query.limit,
        access: accessFilter(context, 'eval.read'),
      });
      if (!page) fail('INVALID_INPUT', '分页游标不存在或不属于当前筛选条件');
      return { items: page.items.map(toEvalRun), nextCursor: page.nextCursor };
    }),
    create: os.runs.create.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      await authorizeEvalAgent(context, input.body.agentId, [
        'eval.read',
        'eval.execute',
        'agents.use',
      ]);
      const created = await startEvalRun(context.db, input.body.agentId, businessId);
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'eval.run.requested',
        target: created.evalRunId,
        input: { agentId: input.body.agentId },
        status: 'ok',
        requestId: context.requestId,
      });
      return created;
    }),
    cancel: os.runs.cancel.handler(async ({ input, context }) => {
      const [run] = await context.db
        .select({ id: schema.evalRuns.id, agentId: schema.evalRuns.agentId })
        .from(schema.evalRuns)
        .where(eq(schema.evalRuns.id, input.params.id))
        .limit(1);
      if (!run) fail('NOT_FOUND', '评估运行不存在，可能已被清理；请刷新列表');
      await authorizeEvalAgent(context, run.agentId, ['eval.read', 'eval.manage']);
      if (await evalRepo.cancelEvalRun(context.db, input.params.id)) {
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'eval.run.cancelled',
          target: input.params.id,
          status: 'ok',
          requestId: context.requestId,
        });
      }
      return { ok: true as const };
    }),
    compare: os.runs.compare.handler(async ({ input, context }) => {
      const { id } = input.params;
      const { head } = input.query;
      if (id === head) fail('INVALID_INPUT', '不能把评估运行与自身对比');
      const comparison = await evalRepo.getComparison(context.db, id, head);
      if (!comparison) fail('NOT_FOUND', '评估运行不存在，可能已被清理；请刷新列表');
      if (comparison.baseRun.agentId !== comparison.headRun.agentId) {
        fail('INVALID_INPUT', '只能对比同一智能体的评估运行');
      }
      await authorizeEvalAgent(context, comparison.baseRun.agentId, ['eval.read']);
      const running = [comparison.baseRun, comparison.headRun].find(
        (run) => run.status === 'running',
      );
      if (running) fail('EVAL_RUN_IN_PROGRESS', '评估运行尚未结束，无法对比');
      return {
        baseRun: toEvalRun(comparison.baseRun),
        headRun: toEvalRun(comparison.headRun),
        rows: comparison.rows,
      };
    }),
    detail: os.runs.detail.handler(async ({ input, context }) => {
      const detail = await evalRepo.getRunDetail(context.db, input.params.id);
      if (!detail) fail('NOT_FOUND', '评估运行不存在，可能已被清理；请刷新列表');
      await authorizeEvalAgent(context, detail.evalRun.agentId, ['eval.read']);
      return { ...detail, evalRun: toEvalRun(detail.evalRun) };
    }),
  },
});
