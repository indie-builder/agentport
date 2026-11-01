import { repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getQueue, publishRun, requestRunCancel } from '../../queue/producer.js';

/**
 * 请求取消一个 run；结果说明本次真正执行了哪条路径。
 *
 * - queued：用 CAS 和 worker claim 竞争，赢下的一方直接写终态并发布 run_finished。
 * - running：容器和已写文件由 worker 收尾，这里只发取消信号。
 *   提前写终态会让 worker 的 updateRun（status='running'）落空，成果快照也会丢。
 * - null：已终态，或取消信号已存在，本次没有产生新的取消。
 */
export type CancelAgentRunResult = 'queued' | 'running' | null;

export async function cancelAgentRun(
  app: FastifyInstance,
  runId: string,
): Promise<CancelAgentRunResult> {
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
    return 'queued';
  }

  // CAS 失败：worker 可能已领取（running），也可能已终态；后者不再发信号。
  const run = await repo.chat.getRun(app.db, runId);
  if (run?.status !== 'running') return null;
  // 发布失败必须抛出：静默返回成功会让界面显示「正在停止」而容器继续跑。
  return (await requestRunCancel(runId)) ? 'running' : null;
}
