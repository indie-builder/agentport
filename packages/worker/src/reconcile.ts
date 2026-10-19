import { type createDb, newId, schema } from '@agentport/db';
import { and, eq, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { publishRun } from './runner-client.js';

const RECONCILE_EVERY_MS = 5 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;

export const LOST_RUN_ERROR = 'worker lost track of this run';

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
  const rows = await db
    .update(schema.agentRuns)
    .set({ status: 'failed', error: LOST_RUN_ERROR, endedAt: new Date() })
    .where(and(eq(schema.agentRuns.status, 'running'), lt(schema.agentRuns.startedAt, cutoff)))
    .returning({ id: schema.agentRuns.id, conversationId: schema.agentRuns.conversationId });

  for (const row of rows) {
    await publishRun(
      row.id,
      { type: 'run_finished', status: 'failed', error: LOST_RUN_ERROR },
      logger,
    );
  }
  if (rows.length > 0) {
    await db.insert(schema.auditLog).values(
      rows.map((row) => ({
        id: newId('audit'),
        actor: 'worker',
        action: 'agent.run.reconciled',
        target: row.id,
        status: 'error',
      })),
    );
    logger.warn({ runs: rows.map((row) => row.id) }, 'reconciled orphaned running runs');
  }
  return rows.length;
}

/** 启动时先跑一次，之后每 5 分钟一次；用 setInterval 而非 BullMQ，少一个队列和 worker。 */
export function startReconciler(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  agentTimeoutMs: number;
}): () => void {
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    void reconcileOrphanedRuns(input.db, input.logger, input.agentTimeoutMs)
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
  return () => clearInterval(timer);
}
