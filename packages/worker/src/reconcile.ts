import { DbError } from '@agentport/core';
import { type createDb, repo, schema } from '@agentport/db';
import { and, eq, lt } from 'drizzle-orm';
import { Effect, Schedule } from 'effect';
import type { Logger } from 'pino';
import { publishRun } from './runner-client.js';

const RECONCILE_EVERY_MS = 5 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;

export const LOST_RUN_ERROR = 'worker lost track of this run';

const EVAL_LOST_ERROR = 'eval run lost';
const EVAL_STALE_MS = 60 * 60 * 1000;

/** 收敛是幂等的 UPDATE；瞬时数据库故障重试三次比等下一轮五分钟划算。 */
const DB_RETRY = Schedule.min([Schedule.exponential('200 millis'), Schedule.recurs(3)]);

function withDb<A>(run: () => Promise<A>): Effect.Effect<A, DbError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new DbError(cause instanceof Error ? cause.message : String(cause), cause),
  }).pipe(Effect.retry(DB_RETRY));
}

/**
 * 评估跑批已移到 worker，但 API/worker 重启仍可能让 job 丢失：
 * 把超过 1 小时还停在 running 的 eval run 置为 failed。
 */
export async function reconcileOrphanedEvalRuns(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
): Promise<number> {
  const count = await Effect.runPromise(
    withDb(() =>
      repo.evalRepo.failStaleEvalRuns(db, EVAL_LOST_ERROR, new Date(Date.now() - EVAL_STALE_MS)),
    ),
  );
  if (count > 0) logger.warn({ count }, 'reconciled orphaned running eval runs');
  return count;
}

/**
 * worker 崩溃/重启后，DB 里会残留 running 的 run：把已超过超时上限的收敛成 failed，
 * 并补发 run_finished，否则前端会一直转圈。
 * shortcut: 阈值用全局 AGENT_TIMEOUT_MS，个别 agent 自定义更长超时时可能被提前收敛。
 */
export async function reconcileOrphanedRuns(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
  agentTimeoutMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - agentTimeoutMs - GRACE_MS);
  const rows = await Effect.runPromise(
    withDb(() =>
      db
        .update(schema.agentRuns)
        .set({ status: 'failed', error: LOST_RUN_ERROR, endedAt: new Date() })
        .where(and(eq(schema.agentRuns.status, 'running'), lt(schema.agentRuns.startedAt, cutoff)))
        .returning({ id: schema.agentRuns.id, conversationId: schema.agentRuns.conversationId }),
    ),
  );

  // 先落库再补发事件：前端漏掉事件也能从 DB 看到终态。
  await Effect.runPromise(
    Effect.forEach(
      rows,
      (row) =>
        Effect.promise(() =>
          publishRun(
            row.id,
            { type: 'run_finished', status: 'failed', error: LOST_RUN_ERROR },
            logger,
          ),
        ),
      { concurrency: 4, discard: true },
    ),
  );
  if (rows.length > 0) {
    for (const row of rows) {
      await repo.audit.writeAudit(db, logger, {
        actor: 'worker',
        action: 'agent.run.reconciled',
        target: row.id,
        status: 'error',
      });
    }
    logger.warn({ runs: rows.map((row) => row.id) }, 'reconciled orphaned running runs');
  }
  return rows.length;
}

/**
 * 启动时先跑一次，之后每 5 分钟一次；用 setInterval 而非 BullMQ，少一个队列和 worker。
 * 返回的 stop 会等在跑的 tick 结束：否则关闭进程时可能和正在写的事件撞车。
 */
export function startReconciler(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  agentTimeoutMs: number;
}): () => Promise<void> {
  let busy = false;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    if (busy) return;
    busy = true;
    inFlight = Promise.all([
      reconcileOrphanedRuns(input.db, input.logger, input.agentTimeoutMs),
      reconcileOrphanedEvalRuns(input.db, input.logger),
    ])
      .then(() => undefined)
      .catch((err: unknown) => {
        input.logger.error({ err }, 'reconcile failed');
      })
      .finally(() => {
        busy = false;
      });
  };
  tick();
  const timer = setInterval(tick, RECONCILE_EVERY_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}
