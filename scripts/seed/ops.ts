import {
  agentSchedules,
  budgetLimits,
  evalCases,
  evalRuns,
  newId,
  repo,
  type Transaction,
} from '@agentport/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { DemoCatalog, SeedContext } from './types.js';

const EVAL_CASES = [
  {
    name: '演示·预算超支问答',
    prompt: '产品分析师本月预算还剩多少？请给出结论和依据。',
    expectation: '引用预算页面数据，说明已用额度、剩余额度与告警阈值。',
  },
  {
    name: '演示·退款政策答复',
    prompt: '客户购买 30 天后申请退款，按政策应如何处理？',
    expectation: '说明退款期限、例外条件与需要人工确认的情形。',
  },
  {
    name: '演示·升级工单摘要',
    prompt: '把最近三条升级工单归纳成一段客服交接摘要。',
    expectation: '按工单逐条列出问题、当前状态与下一步动作。',
  },
];

export async function seedOps(ctx: SeedContext, catalog: DemoCatalog): Promise<void> {
  if (!catalog.agents) throw new Error('seedOps: catalog.agents 缺失');
  const analyst = catalog.agents.analyst;
  if (!analyst) throw new Error('seedOps: catalog.agents.analyst 缺失');
  const succeededRun = catalog.runs?.succeeded;
  const failedRun = catalog.runs?.failed;

  const { db, businessId, log } = ctx;

  await repo.notifications.createNotification(db, {
    businessId,
    kind: 'budget_alert',
    title: '演示·月度预算告警',
    body: '演示数据：预算告警通知形态示例，实际额度请查看治理页预算。',
    link: '/governance?tab=budgets',
    sourceId: `demo:budget-alert:${analyst.id}`,
  });
  if (failedRun) {
    await repo.notifications.createNotification(db, {
      businessId,
      kind: 'run_failed',
      title: '演示·一次运行失败',
      body: '演示·最近一次运行以失败结束，点击查看失败详情。',
      link: `/runs/${failedRun.runId}`,
      sourceId: `demo:run-failed:${failedRun.runId}`,
    });
  }
  await repo.notifications.createNotification(db, {
    businessId,
    kind: 'policy_violation',
    title: '演示·内容策略命中违规事件',
    body: '演示·内容策略记录了一条待复核的违规事件。',
    link: '/security?tab=violations',
    sourceId: 'demo:policy-violation',
  });
  await repo.notifications.createNotification(db, {
    businessId,
    kind: 'ops_alert',
    title: '演示·队列等待超过阈值',
    body: '演示·队列最早等待时长超过告警阈值，请查看告警设置。',
    link: '/governance?tab=alerts',
    sourceId: 'demo:ops-alert',
  });

  const scheduleName = '演示·每日运营简报';
  const [existingSchedule] = await db
    .select({ id: agentSchedules.id })
    .from(agentSchedules)
    .where(and(eq(agentSchedules.agentId, analyst.id), eq(agentSchedules.name, scheduleName)))
    .limit(1);
  if (!existingSchedule) {
    await repo.ops.createSchedule(db, {
      agentId: analyst.id,
      name: scheduleName,
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      missedPolicy: 'skip',
      prompt: '请汇总昨天的运营关键指标、异常告警与待跟进事项，生成一份中文运营简报。',
      enabled: false,
      createdBy: businessId,
      executeAsBusinessId: businessId,
    });
  }

  const cases = await Promise.all(
    EVAL_CASES.map(async (item) => {
      const [existing] = await db
        .select()
        .from(evalCases)
        .where(and(eq(evalCases.agentId, analyst.id), eq(evalCases.name, item.name)))
        .limit(1);
      if (existing) return existing;
      return repo.evalRepo.createCase(db, newId('evalCase'), {
        agentId: analyst.id,
        name: item.name,
        prompt: item.prompt,
        expectation: item.expectation,
        judgeMode: 'contains',
        createdBy: businessId,
      });
    }),
  );

  const [completedRun] = await db
    .select({ id: evalRuns.id })
    .from(evalRuns)
    .where(and(eq(evalRuns.agentId, analyst.id), isNotNull(evalRuns.finishedAt)))
    .limit(1);
  if (!completedRun) {
    const evalRunId = newId('evalRun');
    await db.transaction(async (tx: Transaction) => {
      await repo.evalRepo.createEvalRun(tx, {
        id: evalRunId,
        agentId: analyst.id,
        total: EVAL_CASES.length,
        createdBy: businessId,
        caseSnapshot: cases.map(({ id, name, prompt, expectation, judgeMode }) => ({
          id,
          name,
          prompt,
          expectation,
          judgeMode,
        })),
      });
      for (const [index, evalCase] of cases.entries()) {
        await repo.evalRepo.addResult(tx, {
          id: newId('evalResult'),
          evalRunId,
          caseId: evalCase.id,
          caseSnapshot: {
            id: evalCase.id,
            name: evalCase.name,
            prompt: evalCase.prompt,
            expectation: evalCase.expectation,
            judgeMode: evalCase.judgeMode,
          },
          runId: null,
          passed: index < 2,
          output: index < 2 ? '演示·符合预期。' : '演示·未覆盖例外条件，判定不通过。',
        });
      }
      await repo.evalRepo.finishEvalRun(tx, evalRunId, { status: 'succeeded', passed: 2 });
    });
  }

  await db
    .insert(budgetLimits)
    .values({
      id: newId('budgetLimit'),
      scopeKind: 'agent',
      scopeId: analyst.id,
      metric: 'cost_usd_month',
      limitValue: '50',
      alertRatio: '0.800',
    })
    .onConflictDoNothing();

  const logger = { warn: (_obj: object, message: string) => log(message) };
  await repo.audit.writeAudit(db, logger, {
    actor: businessId,
    actorKind: 'user',
    action: 'agent.created',
    target: analyst.id,
    input: { slug: analyst.slug, name: analyst.name },
    status: 'ok',
    dedupeKey: `demo:audit:agent-create:${analyst.id}`,
  });
  await repo.audit.writeAudit(db, logger, {
    actor: businessId,
    actorKind: 'user',
    action: 'budget.upsert',
    target: analyst.id,
    input: { scopeKind: 'agent', metric: 'cost_usd_month', limitValue: 50, alertRatio: 0.8 },
    status: 'ok',
    dedupeKey: `demo:audit:budget-update:${analyst.id}`,
  });
  const shareTarget = succeededRun?.conversationId ?? failedRun?.conversationId;
  if (shareTarget) {
    await repo.audit.writeAudit(db, logger, {
      actor: businessId,
      actorKind: 'user',
      action: 'share.created',
      target: shareTarget,
      input: { conversationId: shareTarget },
      status: 'ok',
      dedupeKey: 'demo:audit:share-create',
    });
  }
}
