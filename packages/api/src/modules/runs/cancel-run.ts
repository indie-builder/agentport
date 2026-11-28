import { type Database, repo } from '@agentport/db';
import { getQueue, publishRun, requestRunCancel } from '../../queue/producer.js';
export type CancelAgentRunResult = 'queued' | 'running' | null;
export async function cancelAgentRun(
  context: { db: Database },
  runId: string,
): Promise<CancelAgentRunResult> {
  const queued = await repo.runs.cancelQueuedRun(context.db, runId);
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
