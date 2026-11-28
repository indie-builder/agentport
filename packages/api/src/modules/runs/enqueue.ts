import { fail } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import { isActiveJobState, runEnqueueOptions } from '@agentport/shared';
import type { Logger } from 'pino';
import { getQueue } from '../../queue/producer.js';

export function failRunEnqueue(cause?: unknown): never {
  return fail(
    'SERVICE_UNAVAILABLE',
    '运行入队失败，请稍后重试',
    cause === undefined ? {} : { cause },
  );
}

async function failQueuedRunEnqueue(db: Database, runId: string): Promise<boolean> {
  return (
    (await repo.runs.failUnstartedRun(
      db,
      runId,
      { error: '消息入队失败，请重新发送。', errorKind: 'infra', includeNeverStarted: false },
      async (tx, row) => {
        if (row.channelId !== null) {
          await repo.runInstructions.requeueUndeliveredInstructionWakes(tx, {
            runId: row.id,
            agentId: row.agentId,
          });
        }
      },
    )) !== undefined
  );
}

export async function cleanupQueuedRunEnqueue(
  db: Database,
  log: Logger,
  runId: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await failQueuedRunEnqueue(db, runId);
  } catch (err) {
    log.warn({ err, runId, ...extra }, message);
    return false;
  }
}

export async function enqueueRunOrRollback(
  deps: { db: Database; log: Logger },
  payload: Parameters<ReturnType<typeof getQueue>['add']>[1],
  options?: {
    cleanupMessage?: string;
    removeJobOnFailure?: boolean;
    errorMessage?: string;
    onEnqueueError?: (err: unknown) => void;
    onRolledBack?: (err: unknown) => Promise<void>;
  },
): Promise<void> {
  const queue = getQueue();
  try {
    await queue.add('run', payload, runEnqueueOptions(payload.runId));
  } catch (err) {
    options?.onEnqueueError?.(err);
    const failed = await cleanupQueuedRunEnqueue(
      deps.db,
      deps.log,
      payload.runId,
      options?.cleanupMessage ?? 'run enqueue failure cleanup failed',
    );
    if (failed) {
      if (options?.removeJobOnFailure) {
        await queue
          .getJob(payload.runId)
          .then((job) => job?.remove())
          .catch(() => undefined);
      }
      await options?.onRolledBack?.(err);
    }
    if (options?.errorMessage !== undefined) {
      fail('SERVICE_UNAVAILABLE', options.errorMessage, { cause: err });
    }
    failRunEnqueue(err);
  }
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
    failRunEnqueue();
  }
  if (existing != null) {
    let state: Awaited<ReturnType<typeof existing.getState>>;
    try {
      state = await existing.getState();
    } catch {
      await markEnqueueFailed(job.runId);
      failRunEnqueue();
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
          failRunEnqueue();
        }
        if (current != null) {
          let currentState: Awaited<ReturnType<typeof current.getState>>;
          try {
            currentState = await current.getState();
          } catch {
            await markEnqueueFailed(job.runId);
            failRunEnqueue();
          }
          if (isActiveJobState(currentState)) return recoverEnqueuedRun();
          await markEnqueueFailed(job.runId);
          failRunEnqueue();
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
      failRunEnqueue();
    }
    if (!raced) {
      await markEnqueueFailed(job.runId);
      if (!(await active().catch(() => false))) {
        failRunEnqueue();
      }
    }
  }
  await recoverEnqueuedRun();
}
