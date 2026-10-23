import { repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getQueue, publishRun } from '../../queue/producer.js';

/**
 * 把 run 推进到 cancelled 并发对应信号；只有真正发生状态迁移才返回 true。
 * queued → cancelled 用 CAS 与 worker claim 竞争，赢的一方负责终态事件。
 */
export async function cancelAgentRun(app: FastifyInstance, runId: string): Promise<boolean> {
  const [queued] = await app.db
    .update(schema.agentRuns)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')))
    .returning({ id: schema.agentRuns.id });

  if (queued) {
    await publishRun(runId, { type: 'run_finished', status: 'cancelled' });
    // 已取消的 waiting job 不会自己消失，残留会永久占用一个等待位。
    await getQueue()
      .getJob(runId)
      .then((job) => job?.remove())
      .catch(() => undefined);
    return true;
  }

  // CAS 失败：worker 可能已领取（running），也可能已终态；后者返回 false。
  const cancelled = await repo.chat.cancelRun(app.db, runId);
  if (!cancelled) return false;
  await publishRun(runId, { type: 'cancel' });
  return true;
}
