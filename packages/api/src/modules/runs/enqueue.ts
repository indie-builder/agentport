import { type Database, repo, schema } from '@agentport/db';
import { buildRunWebhookEvent } from '@agentport/shared';
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
        trigger: schema.agentRuns.trigger,
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
        ...buildRunWebhookEvent({ status: 'failed', error: '消息入队失败，请重新发送。' }, failed),
        ownerBusinessId: failed.initiatedBy,
      });
    }
    if (failed.trigger === 'review') await repo.memoryReviews.deleteByRunId(tx, runId);
    return true;
  });
}
