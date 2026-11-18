import { type Database, repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import { getQueue, publishRun, requestRunCancel } from '../../queue/producer.js';
export type CancelAgentRunResult = 'queued' | 'running' | null;
export async function cancelAgentRun(
  context: { db: Database },
  runId: string,
): Promise<CancelAgentRunResult> {
  const queued = await context.db.transaction(async (tx) => {
    const [queued] = await tx
      .update(schema.agentRuns)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')))
      .returning({
        id: schema.agentRuns.id,
        initiatedBy: schema.agentRuns.initiatedBy,
        agentId: schema.agentRuns.agentId,
        conversationId: schema.agentRuns.conversationId,
        channelId: schema.agentRuns.channelId,
      });
    if (queued === undefined) return undefined;
    if (queued.channelId !== null) {
      await repo.runInstructions.requeueUndeliveredInstructionWakes(tx, {
        runId: queued.id,
        agentId: queued.agentId,
      });
    }
    if (queued.initiatedBy !== null) {
      await repo.integrations.enqueueWebhookEvent(tx, {
        eventType: 'run.failed',
        sourceId: `run:${runId}:cancelled`,
        ownerBusinessId: queued.initiatedBy,
        payload: JSON.stringify({
          runId: queued.id,
          agentId: queued.agentId,
          conversationId: queued.conversationId,
          status: 'cancelled',
          error: null,
        }),
      });
    }
    return queued;
  });
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
