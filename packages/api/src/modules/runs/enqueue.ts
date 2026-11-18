import { type Database, repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';

export async function failQueuedRunEnqueue(db: Database, runId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [failed] = await tx
      .update(schema.agentRuns)
      .set({
        status: 'failed',
        endedAt: new Date(),
        error: '消息入队失败，请重新发送。',
        errorKind: 'infra',
      })
      .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')))
      .returning({
        id: schema.agentRuns.id,
        agentId: schema.agentRuns.agentId,
        conversationId: schema.agentRuns.conversationId,
        initiatedBy: schema.agentRuns.initiatedBy,
        channelId: schema.agentRuns.channelId,
      });
    if (failed === undefined) return false;
    if (failed.channelId !== null) {
      await repo.runInstructions.requeueUndeliveredInstructionWakes(tx, {
        runId: failed.id,
        agentId: failed.agentId,
      });
    }
    if (failed.initiatedBy !== null) {
      await repo.integrations.enqueueWebhookEvent(tx, {
        eventType: 'run.failed',
        sourceId: `run:${failed.id}:failed`,
        ownerBusinessId: failed.initiatedBy,
        payload: JSON.stringify({
          runId: failed.id,
          agentId: failed.agentId,
          conversationId: failed.conversationId,
          status: 'failed',
          error: '消息入队失败，请重新发送。',
        }),
      });
    }
    return true;
  });
}
