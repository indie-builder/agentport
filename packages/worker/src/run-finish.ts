import { type createDb, repo, schema } from '@agentport/db';
import type { ChatEvent } from '@agentport/shared';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { publishChannelEventSafely } from './channel-events.js';
import { publishRun } from './runner-client.js';

export type RunFinishedEvent = Extract<ChatEvent, { type: 'run_finished' }>;

type Db = ReturnType<typeof createDb>['db'];

/** 终态写入时可一并保存的运行读数；省略的列保持原值。 */
export interface RunFinishValues {
  sandboxId?: string;
  latencyMs?: number | null;
  costUsd?: string | null;
  turns?: number | null;
  sessionId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  error?: string | null;
  errorKind?: 'cancelled' | 'timeout' | 'sandbox' | 'agent' | 'infra' | null;
}
/**
 * 落终态、发布、审计只在 CAS 胜出时发生一次。index 与 reconcile 共用这一段，
 * 避免两处写出不同的状态/事件组合。
 */
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
    });
  if (row === undefined) return false;
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
  await publishRun(input.runId, input.event, input.logger);
  await repo.audit.writeAudit(input.db, input.logger, {
    actor: 'worker',
    action: input.audit.action,
    target: input.runId,
    status: input.audit.status,
    ...(input.audit.dedupeKey === undefined ? {} : { dedupeKey: input.audit.dedupeKey }),
    ...(input.audit.durationMs === undefined ? {} : { durationMs: input.audit.durationMs }),
  });
  return true;
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
