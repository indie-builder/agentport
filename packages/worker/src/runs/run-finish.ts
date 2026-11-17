import { type createDb, repo, schema } from '@agentport/db';
import {
  type ChatEvent,
  type RunErrorKind,
  type TerminalRunStatus,
  utcMonthStart,
} from '@agentport/shared';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { publishChannelEventSafely } from '../channels/channel-events.js';
import { clearRunCancel, publishRun } from '../runner-client.js';

export type RunFinishedEvent = Extract<ChatEvent, { type: 'run_finished' }>;

const CHANNEL_FINISH_NOTICE: Record<Exclude<RunFinishedEvent['status'], 'succeeded'>, string> = {
  failed: '运行失败，打开运行详情查看原因。',
  timeout: '运行超时，未完成回复，打开运行详情查看原因。',
  cancelled: '运行已停止，打开运行详情查看状态。',
};

type Db = ReturnType<typeof createDb>['db'];

/** 终态写入时可一并保存的运行读数；省略的列保持原值。 */
interface RunFinishValues {
  sandboxId?: string;
  latencyMs?: number | null;
  costUsd?: string | null;
  turns?: number | null;
  sessionId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  error?: string | null;
  errorKind?: RunErrorKind | null;
}

interface RunTerminalRow {
  id: string;
  agentId: string;
  channelId: string | null;
  scheduleId: string | null;
  initiatedBy: string | null;
  trigger: typeof schema.agentRuns.$inferSelect.trigger;
  costUsd: string | null;
}

async function notifyRunTerminal(
  input: { db: Db; status: TerminalRunStatus; error?: string | null | undefined },
  row: RunTerminalRow,
): Promise<void> {
  if (input.status === 'failed' || input.status === 'timeout') {
    const body =
      input.status === 'timeout'
        ? '运行超时，请打开运行详情查看原因'
        : input.error
          ? `运行失败：${input.error}`
          : '运行失败，请打开运行详情查看原因';
    const scheduleId = row.trigger === 'schedule' ? row.scheduleId : null;
    let scheduleRecipient: string | null = null;
    if (scheduleId !== null) {
      const schedule = await repo.ops.getSchedule(input.db, scheduleId);
      scheduleRecipient = schedule?.createdBy ?? row.initiatedBy;
      if (scheduleRecipient !== null) {
        await repo.notifications.createNotification(input.db, {
          businessId: scheduleRecipient,
          kind: 'schedule_failed',
          title: '定时任务运行失败',
          body,
          link: '/schedules',
          sourceId: `schedule-failed:${scheduleId}:${row.id}`,
        });
      }
    }
    if (row.initiatedBy !== null && row.initiatedBy !== scheduleRecipient) {
      await repo.notifications.createNotification(input.db, {
        businessId: row.initiatedBy,
        kind: 'run_failed',
        title: input.status === 'timeout' ? '运行超时' : '运行失败',
        body,
        link: row.channelId === null ? `/runs/${row.id}` : `/channels/${row.channelId}`,
        sourceId: `run-failed:${row.id}`,
      });
    }
  }
  if (row.costUsd === null) return;
  const agent = await repo.agents.getAgent(input.db, row.agentId);
  if (agent === null || agent.monthlyBudgetUsd === null) return;
  const now = new Date();
  const limit = Number(agent.monthlyBudgetUsd);
  const ratio = Number(agent.budgetAlertRatio);
  const spent = await repo.agents.sumAgentSpendSince(input.db, row.agentId, utcMonthStart(now));
  const tier = spent >= limit ? 'exceeded' : spent >= limit * ratio ? 'alert' : null;
  if (tier === null) return;
  await repo.notifications.createNotification(input.db, {
    businessId: agent.ownerBusinessId,
    kind: 'budget_alert',
    title: tier === 'exceeded' ? '智能体预算已超支' : '智能体预算告警',
    body:
      tier === 'exceeded'
        ? `本月已使用 $${spent.toFixed(2)}，超过 $${limit.toFixed(2)} 月度预算`
        : `本月已使用 $${spent.toFixed(2)}，达到 $${limit.toFixed(2)} 月度预算的 ${Math.round(ratio * 100)}%`,
    link: `/agents/${row.agentId}`,
    sourceId: `budget:${row.agentId}:${now.toISOString().slice(0, 7)}:${tier}`,
  });
}

export async function notifyRunOutcome(input: {
  db: Db;
  logger: Logger;
  runId: string;
  status: TerminalRunStatus;
  error?: string | null | undefined;
}): Promise<void> {
  const [row] = await input.db
    .select({
      id: schema.agentRuns.id,
      channelId: schema.agentRuns.channelId,
      agentId: schema.agentRuns.agentId,
      initiatedBy: schema.agentRuns.initiatedBy,
      scheduleId: schema.agentRuns.scheduleId,
      trigger: schema.agentRuns.trigger,
      costUsd: schema.agentRuns.costUsd,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, input.runId))
    .limit(1);
  if (row === undefined) return;
  await notifyRunTerminal({ db: input.db, status: input.status, error: input.error }, row).catch(
    (err: unknown) => {
      input.logger.warn({ err, runId: input.runId }, 'run terminal notification failed');
    },
  );
}

export async function finalizeRun(input: {
  db: Db;
  logger: Logger;
  runId: string;
  event: RunFinishedEvent;
  /** 默认从 queued 认领的 running；queued 只用于排队孤儿。 */
  fromStatus?: 'queued' | 'running';
  /** running 终态的并发条件：pendingFinish 必须存在（接管）或不存在（真孤儿）。 */
  pending?: 'required' | 'absent';
  /** queued 收敛沿用入队时间条件，避免把探测期间重新入队的重试提前收敛。 */
  queuedBefore?: Date;
  values?: RunFinishValues;
  audit: { action: string; status: 'ok' | 'error'; dedupeKey?: string; durationMs?: number };
}): Promise<boolean> {
  const pendingCondition =
    input.fromStatus === 'queued'
      ? undefined
      : input.pending === 'required'
        ? isNotNull(schema.agentRuns.pendingFinish)
        : input.pending === 'absent'
          ? isNull(schema.agentRuns.pendingFinish)
          : undefined;
  const [row] = await input.db
    .update(schema.agentRuns)
    .set({
      status: input.event.status,
      endedAt: new Date(),
      // 接管 pendingFinish 时保留交接时保存的 error/errorKind（比 wire 分类更精确）。
      ...input.values,
      ...(input.pending === 'required' ? { pendingFinish: null } : {}),
    })
    .where(
      and(
        eq(schema.agentRuns.id, input.runId),
        eq(schema.agentRuns.status, input.fromStatus ?? 'running'),
        ...(pendingCondition === undefined ? [] : [pendingCondition]),
        ...(input.queuedBefore === undefined
          ? []
          : [lt(schema.agentRuns.createdAt, input.queuedBefore)]),
      ),
    )
    .returning({
      id: schema.agentRuns.id,
      channelId: schema.agentRuns.channelId,
      agentId: schema.agentRuns.agentId,
      initiatedBy: schema.agentRuns.initiatedBy,
      scheduleId: schema.agentRuns.scheduleId,
      trigger: schema.agentRuns.trigger,
      costUsd: schema.agentRuns.costUsd,
    });
  if (row === undefined) return false;
  await notifyRunTerminal({ db: input.db, status: input.event.status }, row).catch(
    (err: unknown) => {
      input.logger.warn({ err, runId: row.id }, 'run terminal notification failed');
    },
  );
  await clearRunCancel(input.runId, input.logger).catch((err: unknown) => {
    input.logger.warn({ err, runId: input.runId }, 'clear run cancel failed');
  });
  if (row.channelId !== null && input.event.status !== 'succeeded') {
    let notice: typeof schema.channelMessages.$inferSelect | null = null;
    try {
      notice = await repo.channels.postSystemMessage(input.db, {
        channelId: row.channelId,
        agentId: row.agentId,
        runId: row.id,
        allowArchived: true,
        body: CHANNEL_FINISH_NOTICE[input.event.status],
      });
    } catch (err) {
      input.logger.warn({ err, runId: row.id }, 'channel finish notice failed');
    }
    if (notice !== null) {
      await publishChannelEventSafely(
        row.channelId,
        {
          type: 'message.created',
          channelId: row.channelId,
          seq: notice.seq,
          message: repo.channels.toChannelMessage(notice),
        },
        input.logger,
        { runId: row.id },
      );
    }
  }
  // 频道终态只在 CAS 胜出后发一次；失败只记日志，不回滚也不触发重试。
  if (row.channelId !== null) {
    await publishChannelEventSafely(
      row.channelId,
      {
        type: 'run.finished',
        channelId: row.channelId,
        runId: row.id,
        agentId: row.agentId,
        status: input.event.status,
      },
      input.logger,
      { runId: row.id },
    );
  }
  await publishRunFinished(input);
  return true;
}

export async function publishRunFinished(input: {
  db: Db;
  logger: Logger;
  runId: string;
  event: RunFinishedEvent;
  audit: { action: string; status: 'ok' | 'error'; dedupeKey?: string; durationMs?: number };
}): Promise<void> {
  await publishRun(input.runId, input.event, input.logger);
  await repo.audit.writeAudit(input.db, input.logger, {
    actor: 'worker',
    actorKind: 'service',
    action: input.audit.action,
    target: input.runId,
    status: input.audit.status,
    ...(input.audit.dedupeKey === undefined ? {} : { dedupeKey: input.audit.dedupeKey }),
    ...(input.audit.durationMs === undefined ? {} : { durationMs: input.audit.durationMs }),
  });
}

/**
 * 停稳未确认时只交接终态：状态保持 running、endedAt 仍为 NULL，业务占用继续有效。
 * 等 reconcile 确认容器已销毁后再落终态并发布这一条原事件。
 */
export async function handOffPendingFinish(input: {
  db: Db;
  logger: Logger;
  runId: string;
  event: RunFinishedEvent;
  values?: RunFinishValues;
}): Promise<boolean> {
  const [row] = await input.db
    .update(schema.agentRuns)
    .set({ ...input.values, endedAt: null, pendingFinish: input.event })
    .where(and(eq(schema.agentRuns.id, input.runId), eq(schema.agentRuns.status, 'running')))
    .returning({ id: schema.agentRuns.id });
  if (row === undefined) {
    input.logger.warn({ runId: input.runId }, 'run no longer running, pending finish not saved');
    return false;
  }
  return true;
}
