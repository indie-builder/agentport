import { type Database, repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import { getQueue, publishRun, requestRunCancel } from '../../queue/producer.js';
export type CancelAgentRunResult = 'queued' | 'running' | null;
export async function cancelAgentRun(
  context: { db: Database },
  runId: string,
): Promise<CancelAgentRunResult> {
  const [queued] = await context.db
    .update(schema.agentRuns)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')))
    .returning({ id: schema.agentRuns.id });
  if (queued) {
    await publishRun(runId, { type: 'run_finished', status: 'cancelled' });
    await getQueue()
      .getJob(runId)
      .then((job) => job?.remove())
      .catch(() => undefined);
    return 'queued';
  }
  const run = await repo.chat.getRun(context.db, runId);
  if (run?.status !== 'running') return null;
  return (await requestRunCancel(runId)) ? 'running' : null;
}
