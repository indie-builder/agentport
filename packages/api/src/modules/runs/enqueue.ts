import { fail } from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import { buildRunWebhookEvent, isActiveJobState, runEnqueueOptions } from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { getQueue } from '../../queue/producer.js';

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
        ...buildRunWebhookEvent({ status: 'failed', error: '消息入队失败，请重新发送。' }, failed),
        ownerBusinessId: failed.initiatedBy,
      });
    }
    return true;
  });
}

export async function enqueueRunJob(
  deps: { db: Database; log: Logger; requestId: string },
  job: { runId: string; agentId: string; conversationId: string; prompt: string },
): Promise<void> {
  const markEnqueueFailed = async (runId: string) => {
    try {
      await failQueuedRunEnqueue(deps.db, runId);
    } catch {
      deps.log.warn({ runId }, 'chat enqueue failure cleanup failed');
    }
  };
  const recoverEnqueuedRun = async () => {
    await repo.chat.requeueInfraFailedRun(deps.db, job.runId);
  };
  const queue = getQueue();
  let existing: Awaited<ReturnType<typeof queue.getJob>>;
  try {
    existing = await queue.getJob(job.runId);
  } catch {
    await markEnqueueFailed(job.runId);
    fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
  }
  if (existing != null) {
    let state: Awaited<ReturnType<typeof existing.getState>>;
    try {
      state = await existing.getState();
    } catch {
      await markEnqueueFailed(job.runId);
      fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
    }
    if (isActiveJobState(state)) return recoverEnqueuedRun();
    if (state === 'completed' || state === 'failed') {
      try {
        await existing.remove();
      } catch {
        let current: Awaited<ReturnType<typeof queue.getJob>>;
        try {
          current = await queue.getJob(job.runId);
        } catch {
          await markEnqueueFailed(job.runId);
          fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
        }
        if (current != null) {
          let currentState: Awaited<ReturnType<typeof current.getState>>;
          try {
            currentState = await current.getState();
          } catch {
            await markEnqueueFailed(job.runId);
            fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
          }
          if (isActiveJobState(currentState)) return recoverEnqueuedRun();
          await markEnqueueFailed(job.runId);
          fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
        }
      }
    }
  }
  try {
    await queue.add(
      'run',
      {
        runId: job.runId,
        agentId: job.agentId,
        conversationId: job.conversationId,
        prompt: job.prompt,
        requestId: deps.requestId,
      },
      runEnqueueOptions(job.runId),
    );
  } catch {
    const active = async (): Promise<boolean> => {
      const queued = await queue.getJob(job.runId);
      return queued != null && isActiveJobState(await queued.getState());
    };
    const raced = await active().catch(() => null);
    if (raced === null) {
      await markEnqueueFailed(job.runId);
      fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
    }
    if (!raced) {
      await markEnqueueFailed(job.runId);
      if (!(await active().catch(() => false))) {
        fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
      }
    }
  }
  await recoverEnqueuedRun();
}
