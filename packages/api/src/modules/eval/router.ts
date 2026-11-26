import { evalContract } from '@agentport/contract/eval';
import { AGENT_SELECTION_MISSING_MESSAGE, fail, notFound } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import { implement } from '@orpc/server';
import { eq } from 'drizzle-orm';
import { accessFilter, actorOf, authorizeObject, requireUser } from '../../http/access.js';
import { writeCrossUserAudit } from '../../http/audit.js';
import type { RequestContext } from '../../http/context.js';
import { EVAL_RUN_MISSING_MESSAGE } from '../../http/errors.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { authorizeRun, authorizeRunFeedback, RUN_MISSING } from '../runs/access.js';

const EVAL_CASE_MISSING = '用例不存在，可能已被删除；请刷新后重试';

import { importEvalCases, startEvalRun, toEvalRun } from './use-cases.js';

const os = implement(evalContract).$context<RequestContext>();
const evalRepo = repo.evalRepo;

function toEvalCase(row: repo.evalRepo.EvalCase) {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    prompt: row.prompt,
    expectation: row.expectation,
    judgeMode: row.judgeMode,
    expectedTools: row.expectedTools,
    forbiddenTools: row.forbiddenTools,
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
    await authorizeObject(context, permissionId, { agentId }, AGENT_SELECTION_MISSING_MESSAGE);
  }
}

export const evalRouter = os.router({
  cases: {
    list: os.cases.list.handler(async ({ input, context }) => {
      const page = requireCursorPage(
        await evalRepo.listCases(context.db, accessFilter(context, 'eval.read'), {
          ...(input.query.agentId === undefined ? {} : { agentId: input.query.agentId }),
          ...cursorOption(input.query.cursor),
          limit: input.query.limit,
        }),
      );
      return { items: page.items.map(toEvalCase), nextCursor: page.nextCursor };
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
      const run = await repo.chat.getRun(context.db, input.body.runId);
      if (!run) notFound('run', RUN_MISSING);
      if (run.channelId === null) {
        await authorizeRun(context, run.id, 'runs.read');
      } else {
        const { channelRole } = await authorizeRunFeedback(context, run.id, 'runs.read');
        if (channelRole === 'viewer') fail('FORBIDDEN', '当前频道角色无权转评测用例');
      }
      const detail = await repo.runs.getRunDetail(context.db, run.id);
      if (!detail) notFound('run', RUN_MISSING);
      const prompt = detail.steps.find((step) => step.kind === 'user')?.text;
      if (!prompt?.trim()) {
        fail('INVALID_INPUT', '该运行没有可用的用户输入，无法生成评估用例');
      }
      const lastAnswer = [...detail.steps]
        .reverse()
        .find((step) => step.kind === 'assistant')?.text;
      if (lastAnswer !== undefined && input.body.expectation.trim() === lastAnswer.trim()) {
        fail('INVALID_INPUT', '期望答案不能直接使用原回答，请人工填写正确答案');
      }
      const feedbackId = input.body.feedbackId;
      if (feedbackId !== undefined) {
        const feedback = await repo.runFeedback.getRunFeedback(context.db, feedbackId);
        if (!feedback || feedback.runId !== run.id) fail('INVALID_INPUT', '反馈不属于该运行');
        if (feedback.decision !== 'rejected') fail('INVALID_INPUT', '只有退回的样本可以转评测用例');
        if (feedback.evalCaseId !== null) fail('CONFLICT', '该反馈已转为评测用例');
      }
      const agentId = detail.run.agentId;
      await authorizeEvalAgent(context, agentId, ['eval.read', 'eval.manage']);
      const rawName = input.body.name ?? detail.conversation.title;
      const name = (rawName.trim() ? rawName.trim() : `运行 ${detail.run.id}`).slice(0, 128);
      const row = await context.db.transaction(async (tx) => {
        const created = await evalRepo.createCase(tx, newId('evalCase'), {
          agentId,
          name,
          prompt: prompt.slice(0, 20_000),
          expectation: input.body.expectation,
          judgeMode: input.body.judgeMode,
          sourceRunId: detail.run.id,
          createdBy: businessId,
        });
        if (feedbackId !== undefined) {
          const linked = await repo.runFeedback.setRunFeedbackEvalCase(tx, feedbackId, created.id);
          if (linked === null) fail('CONFLICT', '该反馈已转为评测用例');
        }
        return created;
      });
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'eval.case.created',
        target: row.id,
        input: { agentId, name, fromRun: detail.run.id, fromFeedback: feedbackId ?? null },
        status: 'ok',
        requestId: context.requestId,
      });
      return toEvalCase(row);
    }),
    sampleCandidates: os.cases.sampleCandidates.handler(async ({ input, context }) => {
      await authorizeEvalAgent(context, input.query.agentId, ['eval.read']);
      const businessId = requireUser(context).businessId;
      const access = accessFilter(context, 'runs.read');
      const rows = await evalRepo.sampleProductionRuns(context.db, {
        agentId: input.query.agentId,
        limit: input.query.limit,
        access,
      });
      if (access.scopes.includes('platform')) {
        for (const row of rows) {
          if (row.initiatedBy !== null && row.initiatedBy !== businessId) {
            await writeCrossUserAudit(context.db, context.log, {
              actor: businessId,
              permissionId: 'runs.read',
              subjectBusinessId: row.initiatedBy,
              target: row.runId,
              requestId: context.requestId,
            });
          }
        }
      }
      return rows.map((row) => ({
        runId: row.runId,
        conversationId: row.conversationId,
        title: row.title,
        prompt: row.prompt,
        endedAt: row.endedAt.toISOString(),
      }));
    }),
    update: os.cases.update.handler(async ({ input, context }) => {
      const existing = await evalRepo.getCase(context.db, input.params.id);
      if (!existing) fail('NOT_FOUND', EVAL_CASE_MISSING);
      await authorizeEvalAgent(context, existing.agentId, ['eval.read', 'eval.manage']);
      const row = await evalRepo.updateCase(context.db, input.params.id, input.body);
      if (!row) fail('NOT_FOUND', EVAL_CASE_MISSING);
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
      if (!existing) fail('NOT_FOUND', EVAL_CASE_MISSING);
      await authorizeEvalAgent(context, existing.agentId, ['eval.read', 'eval.manage']);
      const deleted = await evalRepo.deleteCase(context.db, input.params.id);
      if (!deleted) fail('NOT_FOUND', EVAL_CASE_MISSING);
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
      const page = requireCursorPage(
        await evalRepo.listRuns(context.db, {
          ...(input.query.agentId === undefined ? {} : { agentId: input.query.agentId }),
          ...cursorOption(input.query.cursor),
          limit: input.query.limit,
          access: accessFilter(context, 'eval.read'),
        }),
      );

      return { items: page.items.map(toEvalRun), nextCursor: page.nextCursor };
    }),
    create: os.runs.create.handler(async ({ input, context }) => {
      const businessId = requireUser(context).businessId;
      await authorizeEvalAgent(context, input.body.agentId, [
        'eval.read',
        'eval.execute',
        'agents.use',
      ]);
      const created = await startEvalRun(
        context.db,
        input.body.agentId,
        businessId,
        input.body.target,
      );
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'eval.run.requested',
        target: created.evalRunId,
        input: { agentId: input.body.agentId, target: input.body.target },
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
      if (!run) fail('NOT_FOUND', EVAL_RUN_MISSING_MESSAGE);
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
      if (!comparison) fail('NOT_FOUND', EVAL_RUN_MISSING_MESSAGE);
      await authorizeEvalAgent(context, comparison.baseRun.agentId, ['eval.read']);
      await authorizeEvalAgent(context, comparison.headRun.agentId, ['eval.read']);
      if (comparison.baseRun.agentId !== comparison.headRun.agentId) {
        fail('INVALID_INPUT', '只能对比同一智能体的评估运行');
      }
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
      if (!detail) fail('NOT_FOUND', EVAL_RUN_MISSING_MESSAGE);
      await authorizeEvalAgent(context, detail.evalRun.agentId, ['eval.read']);
      return { ...detail, evalRun: toEvalRun(detail.evalRun) };
    }),
  },
});
