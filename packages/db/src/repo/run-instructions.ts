import { fail, providerRouteDestination } from '@agentport/core';
import { isActiveRunStatus } from '@agentport/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, channelWakes, runInstructions } from '../schema.js';
import { markChannelWakeEnqueued } from './channel-wakes.js';
import { getModelProvider } from './model-providers.js';
import {
  consumePolicyApproval,
  getApprovedPolicyApprovalForConversation,
  getApprovedPolicyApprovalForRun,
  linkPolicyApprovalToRun,
} from './security.js';

export type RunInstructionRow = typeof runInstructions.$inferSelect;

export async function createRunInstruction(
  db: Database,
  input: {
    runId: string;
    channelMessageId: string;
    body: string;
    createdBy: string;
    fallbackDestination: string;
    consumePolicyApprovalId?: string;
    wake: { id: string; claimedAt: Date };
  },
): Promise<'enqueued' | 'run_ended' | 'claim_lost'> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        status: agentRuns.status,
        conversationId: agentRuns.conversationId,
        providerId: agentRuns.providerId,
        servedProviderId: agentRuns.servedProviderId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.runId))
      .for('update');
    if (run === undefined || !isActiveRunStatus(run.status)) return 'run_ended';
    const claimed = await markChannelWakeEnqueued(tx, input.wake);
    if (!claimed) return 'claim_lost';
    if (input.consumePolicyApprovalId !== undefined) {
      const lockedRoute = await getApprovedPolicyApprovalForConversation(tx, run.conversationId);
      let destination = lockedRoute?.destination ?? null;
      if (destination === null) {
        if (run.servedProviderId === null && run.providerId !== null) {
          fail('CONTENT_BLOCKED', '运行尚未开始使用模型供应商，请稍后重试');
        }
        const provider =
          run.servedProviderId === null ? null : await getModelProvider(tx, run.servedProviderId);
        if (run.servedProviderId !== null && provider === null) {
          fail('CONTENT_BLOCKED', '追加指令审批的目标与当前运行不一致');
        }
        destination =
          provider === null ? input.fallbackDestination : providerRouteDestination(provider);
      }
      const approvedRoute = await getApprovedPolicyApprovalForRun(tx, input.runId);
      if (approvedRoute !== null && approvedRoute.destination !== destination) {
        fail('CONTENT_BLOCKED', '追加指令审批的目标与当前运行不一致');
      }
      const consumed = await consumePolicyApproval(tx, input.consumePolicyApprovalId, destination);
      if (consumed === null || consumed.runId !== input.runId) {
        fail('CONTENT_APPROVAL_REQUIRED', '审批已失效，请重新发起');
      }
      await linkPolicyApprovalToRun(tx, input.consumePolicyApprovalId, input.runId);
    }
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

export async function markRunInstructionDelivered(db: Database, id: string): Promise<void> {
  await db
    .update(runInstructions)
    .set({ deliveredAt: new Date() })
    .where(and(eq(runInstructions.id, id), isNull(runInstructions.deliveredAt)));
}
