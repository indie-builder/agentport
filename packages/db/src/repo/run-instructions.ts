import { isActiveRunStatus } from '@agentport/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, channelWakes, runInstructions } from '../schema.js';
import { markChannelWakeEnqueued } from './channel-wakes.js';

export type RunInstructionRow = typeof runInstructions.$inferSelect;

/** 唤醒重试会重复调用；唯一键保证同一 run 只追加一次同一条频道消息。 */
export async function createRunInstruction(
  db: Database,
  input: {
    runId: string;
    channelMessageId: string;
    body: string;
    createdBy: string;
    wake: { id: string; claimedAt: Date };
  },
): Promise<'enqueued' | 'run_ended' | 'claim_lost'> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.runId))
      .for('update');
    if (run === undefined || !isActiveRunStatus(run.status)) return 'run_ended';
    const claimed = await markChannelWakeEnqueued(tx, input.wake);
    if (!claimed) return 'claim_lost';
    await tx
      .insert(runInstructions)
      .values({
        id: newId('runInstruction'),
        runId: input.runId,
        channelMessageId: input.channelMessageId,
        body: input.body,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing();
    return 'enqueued';
  });
}

export async function requeueUndeliveredInstructionWakes(
  db: DbHandle,
  input: { runId: string; agentId: string },
): Promise<number> {
  const rows = await db
    .select({ channelMessageId: runInstructions.channelMessageId })
    .from(runInstructions)
    .where(and(eq(runInstructions.runId, input.runId), isNull(runInstructions.deliveredAt)));
  if (rows.length === 0) return 0;
  const updated = await db
    .update(channelWakes)
    .set({
      status: 'pending',
      claimedAt: null,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
      lastError: '运行已结束，追加指令未送达，已重新唤醒',
    })
    .where(
      and(
        eq(channelWakes.agentId, input.agentId),
        inArray(
          channelWakes.channelMessageId,
          rows.map((row) => row.channelMessageId),
        ),
        eq(channelWakes.status, 'enqueued'),
      ),
    )
    .returning({ id: channelWakes.id });
  return updated.length;
}

export async function resetInstructionDeliveryForRun(db: DbHandle, runId: string): Promise<void> {
  await db
    .update(runInstructions)
    .set({ deliveredAt: null })
    .where(eq(runInstructions.runId, runId));
}

export async function listPendingRunInstructions(
  db: Database,
  runId: string,
): Promise<Array<{ id: string; body: string }>> {
  return db
    .select({ id: runInstructions.id, body: runInstructions.body })
    .from(runInstructions)
    .where(and(eq(runInstructions.runId, runId), isNull(runInstructions.deliveredAt)))
    .orderBy(asc(runInstructions.createdAt), asc(runInstructions.id));
}

/** 只在首次送达时落时间；重复调用保持原值。 */
export async function markRunInstructionDelivered(db: Database, id: string): Promise<void> {
  await db
    .update(runInstructions)
    .set({ deliveredAt: new Date() })
    .where(and(eq(runInstructions.id, id), isNull(runInstructions.deliveredAt)));
}
