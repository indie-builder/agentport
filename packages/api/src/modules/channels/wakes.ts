import { copyChannelAttachmentsToConversation } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import { type AgentRunJob, errorText, runEnqueueOptions } from '@agentport/shared';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { AppError } from '../../http/errors.js';
import { publishChannelMessage } from '../../queue/producer.js';
import { failQueuedRunEnqueue } from '../runs/enqueue.js';

const channelRepo = repo.channels;
const channelWakeRepo = repo.channelWakes;

const WAKE_SWEEP_MS = 30_000;
const WAKE_MIN_AGE_MS = 5_000;
const WAKE_LEASE_MS = 120_000;
const WAKE_BATCH = 20;
const WAKE_MAX_ATTEMPTS = 5;

const WAKE_STOP_TIMEOUT_MS = 5_000;

const LANE_BUSY_NOTICE = '当前智能体正在处理上一轮消息，本条已保存；请等它结束后再 @ 继续。';
const WAKE_FAILED_NOTICE = '智能体启动失败，请重新 @ 该智能体。';
const AGENT_GONE_NOTICE = '该智能体已不在频道内，本条消息未执行。';
const BINDING_INACTIVE_NOTICE = '该智能体在频道内已断开，本条消息未执行。';
const AGENT_DISABLED_NOTICE = '该智能体已停用，本条消息未执行。';
const AGENT_BUDGET_EXCEEDED_NOTICE = '该智能体本月预算已用尽，本条消息未执行。';

type WakeContext = {
  db: Database;
  log: Logger;
  queue: Queue<AgentRunJob>;
  workspacesDir: string;
};

type WakeMessage = NonNullable<Awaited<ReturnType<typeof channelWakeRepo.getChannelWakeMessage>>>;

type WakeDispatchResult = { enqueued: number; skipped: number; retried: number; failed: number };
type WakeOutcome = keyof WakeDispatchResult;

function retryAt(attempts: number): Date {
  return new Date(Date.now() + Math.min(5_000 * 2 ** (attempts - 1), 300_000));
}

async function postNotice(
  context: WakeContext,
  target: { channelId: string; agentId: string },
  body: string,
): Promise<void> {
  try {
    const notice = await channelRepo.postSystemMessage(context.db, {
      channelId: target.channelId,
      agentId: target.agentId,
      body,
    });
    if (notice === null) return;
    try {
      await publishChannelMessage(target.channelId, repo.channels.toChannelMessage(notice));
    } catch (err) {
      context.log.warn(
        { err, channelId: target.channelId },
        'channel wake notice publish failed; SSE will recover from DB replay',
      );
    }
  } catch (err) {
    context.log.warn(
      { err, channelId: target.channelId, agentId: target.agentId },
      'channel wake notice failed',
    );
  }
}

async function skipWake(
  context: WakeContext,
  wake: repo.channelWakes.ChannelWakeRow,
  notice: string,
): Promise<'skipped'> {
  await postNotice(context, wake, notice);
  await channelWakeRepo.markChannelWakeSkipped(context.db, {
    id: wake.id,
    claimedAt: wake.claimedAt as Date,
  });
  return 'skipped';
}

async function handleEnqueueFailure(
  context: WakeContext,
  wake: repo.channelWakes.ChannelWakeRow,
  runId: string,
  err: unknown,
): Promise<WakeOutcome> {
  if (wake.attempts >= WAKE_MAX_ATTEMPTS) {
    try {
      await failQueuedRunEnqueue(context.db, runId);
    } catch (cleanupErr) {
      context.log.warn(
        { err: cleanupErr, runId, wakeId: wake.id },
        'channel wake queued run cleanup failed',
      );
    }
    await channelWakeRepo.markChannelWakeFailed(context.db, {
      id: wake.id,
      claimedAt: wake.claimedAt as Date,
      lastError: errorText(err),
    });
    await postNotice(context, wake, WAKE_FAILED_NOTICE);
    return 'failed';
  }
  await channelWakeRepo.markChannelWakeRetry(context.db, {
    id: wake.id,
    claimedAt: wake.claimedAt as Date,
    lastError: errorText(err),
    nextAttemptAt: retryAt(wake.attempts),
  });
  return 'retried';
}

async function copyMessageAttachments(
  context: WakeContext,
  wake: repo.channelWakes.ChannelWakeRow,
  message: WakeMessage,
  agentSlug: string,
  conversationId: string,
): Promise<void> {
  if (message.attachments.length === 0) return;
  await copyChannelAttachmentsToConversation({
    root: context.workspacesDir,
    channelId: wake.channelId,
    messageId: wake.channelMessageId,
    slug: agentSlug,
    conversationId,
    attachments: message.attachments,
  });
}

async function dispatchWake(
  context: WakeContext,
  wake: repo.channelWakes.ChannelWakeRow,
): Promise<WakeOutcome> {
  const message = await channelWakeRepo.getChannelWakeMessage(context.db, wake.channelMessageId);
  if (message === null || message.channelArchivedAt !== null || message.authorBusinessId === null) {
    await channelWakeRepo.markChannelWakeSkipped(context.db, {
      id: wake.id,
      claimedAt: wake.claimedAt as Date,
    });
    return 'skipped';
  }
  if (wake.attempts > WAKE_MAX_ATTEMPTS) {
    const run = await channelWakeRepo.findChannelRunByTrigger(context.db, {
      channelId: wake.channelId,
      channelMessageId: wake.channelMessageId,
      agentId: wake.agentId,
    });
    if (run !== null && run.status === 'queued') {
      try {
        await failQueuedRunEnqueue(context.db, run.id);
      } catch (err) {
        context.log.warn(
          { err, runId: run.id, wakeId: wake.id },
          'channel wake queued run cleanup failed',
        );
      }
    }
    await channelWakeRepo.markChannelWakeFailed(context.db, {
      id: wake.id,
      claimedAt: wake.claimedAt as Date,
      lastError: 'channel wake exceeded max attempts',
    });
    await postNotice(context, wake, WAKE_FAILED_NOTICE);
    return 'failed';
  }
  const agent = await repo.agents.getAgent(context.db, wake.agentId);
  if (!agent) return skipWake(context, wake, AGENT_GONE_NOTICE);
  const existing = await channelWakeRepo.findChannelRunByTrigger(context.db, {
    channelId: wake.channelId,
    channelMessageId: wake.channelMessageId,
    agentId: wake.agentId,
  });
  if (existing !== null) {
    if (existing.status === 'queued') {
      try {
        await copyMessageAttachments(context, wake, message, agent.slug, existing.conversationId);
      } catch (err) {
        return handleEnqueueFailure(context, wake, existing.id, err);
      }
      try {
        await context.queue.add(
          'run',
          {
            runId: existing.id,
            agentId: wake.agentId,
            conversationId: existing.conversationId,
            prompt: message.body,
          },
          runEnqueueOptions(existing.id),
        );
      } catch (err) {
        return handleEnqueueFailure(context, wake, existing.id, err);
      }
    }
    await channelWakeRepo.markChannelWakeEnqueued(context.db, {
      id: wake.id,
      claimedAt: wake.claimedAt as Date,
    });
    return 'enqueued';
  }
  const binding = await channelWakeRepo.getChannelWakeBindingStatus(context.db, {
    channelId: wake.channelId,
    agentId: wake.agentId,
  });
  if (binding === null) return skipWake(context, wake, AGENT_GONE_NOTICE);
  if (binding.status !== 'active') return skipWake(context, wake, BINDING_INACTIVE_NOTICE);
  const activeRun = await channelWakeRepo.findActiveChannelRunForAgent(context.db, {
    channelId: wake.channelId,
    agentId: wake.agentId,
  });
  if (activeRun !== null && message.attachments.length === 0) {
    const appended = await repo.runInstructions.createRunInstruction(context.db, {
      runId: activeRun.id,
      channelMessageId: wake.channelMessageId,
      body: message.body,
      createdBy: message.authorBusinessId,
      wake: { id: wake.id, claimedAt: wake.claimedAt as Date },
    });
    if (appended === 'enqueued') return 'enqueued';
    if (appended === 'claim_lost') return 'skipped';
  }
  let admitted: Awaited<ReturnType<typeof repo.chat.admitChatRun>>;
  try {
    const agentVersion = agent.publishedVersion;
    admitted = await repo.chat.admitChatRun(context.db, {
      agentId: wake.agentId,
      message: message.body,
      subject: { kind: 'user', businessId: message.authorBusinessId },
      ...(agentVersion === null ? {} : { agentVersion }),
      trigger: 'channel',
      channel: { channelId: wake.channelId, channelMessageId: wake.channelMessageId },
      ...(message.attachments.length === 0 ? {} : { attachments: message.attachments }),
    });
  } catch (err) {
    if (err instanceof AppError) {
      const notice =
        err.code === 'CONFLICT'
          ? LANE_BUSY_NOTICE
          : err.code === 'AGENT_DISABLED'
            ? AGENT_DISABLED_NOTICE
            : err.code === 'BUDGET_EXCEEDED'
              ? err.message
              : err.code === 'AGENT_BUDGET_EXCEEDED'
                ? AGENT_BUDGET_EXCEEDED_NOTICE
                : err.code === 'NOT_FOUND'
                  ? AGENT_GONE_NOTICE
                  : WAKE_FAILED_NOTICE;
      return skipWake(context, wake, notice);
    }
    await channelWakeRepo.markChannelWakeRetry(context.db, {
      id: wake.id,
      claimedAt: wake.claimedAt as Date,
      lastError: errorText(err),
      nextAttemptAt: retryAt(wake.attempts),
    });
    return 'retried';
  }
  try {
    await copyMessageAttachments(context, wake, message, agent.slug, admitted.conversationId);
  } catch (err) {
    return handleEnqueueFailure(context, wake, admitted.run.id, err);
  }
  try {
    await context.queue.add(
      'run',
      {
        runId: admitted.run.id,
        agentId: wake.agentId,
        conversationId: admitted.conversationId,
        prompt: message.body,
      },
      runEnqueueOptions(admitted.run.id),
    );
  } catch (err) {
    return handleEnqueueFailure(context, wake, admitted.run.id, err);
  }
  await channelWakeRepo.markChannelWakeEnqueued(context.db, {
    id: wake.id,
    claimedAt: wake.claimedAt as Date,
  });
  return 'enqueued';
}

export async function dispatchChannelWakes(input: {
  db: Database;
  log: Logger;
  queue: Queue<AgentRunJob>;
  workspacesDir: string;
  channelMessageId?: string;
  minAgeMs?: number;
  limit?: number;
}): Promise<WakeDispatchResult> {
  const result: WakeDispatchResult = { enqueued: 0, skipped: 0, retried: 0, failed: 0 };
  let claimed: repo.channelWakes.ChannelWakeRow[];
  try {
    claimed = await channelWakeRepo.claimChannelWakes(input.db, {
      limit: input.limit ?? WAKE_BATCH,
      minAgeMs: input.minAgeMs ?? 0,
      leaseMs: WAKE_LEASE_MS,
      ...(input.channelMessageId === undefined ? {} : { channelMessageId: input.channelMessageId }),
    });
  } catch (err) {
    input.log.error({ err }, 'channel wake claim failed');
    return result;
  }
  for (const wake of claimed) {
    try {
      result[await dispatchWake(input, wake)] += 1;
    } catch (err) {
      input.log.error({ err, wakeId: wake.id }, 'channel wake dispatch failed');
      try {
        await channelWakeRepo.markChannelWakeRetry(input.db, {
          id: wake.id,
          claimedAt: wake.claimedAt as Date,
          lastError: errorText(err),
          nextAttemptAt: retryAt(wake.attempts),
        });
        result.retried += 1;
      } catch (markErr) {
        input.log.error({ err: markErr, wakeId: wake.id }, 'channel wake retry mark failed');
      }
    }
  }
  return result;
}

export function startChannelWakeSweeper(input: {
  db: Database;
  log: Logger;
  queue: Queue<AgentRunJob>;
  workspacesDir: string;
}): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      try {
        const result = await dispatchChannelWakes({
          ...input,
          minAgeMs: WAKE_MIN_AGE_MS,
          limit: WAKE_BATCH,
        });
        if (
          result.enqueued !== 0 ||
          result.skipped !== 0 ||
          result.retried !== 0 ||
          result.failed !== 0
        ) {
          input.log.info(result, 'channel wake sweep');
        }
      } catch (err) {
        input.log.error({ err }, 'channel wake sweep failed');
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  void tick();
  const timer = setInterval(() => void tick(), WAKE_SWEEP_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (inFlight === null) return;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      inFlight,
      new Promise<void>((resolveStop) => {
        stopTimer = setTimeout(resolveStop, WAKE_STOP_TIMEOUT_MS);
        stopTimer.unref();
      }),
    ]);
    if (stopTimer !== undefined) clearTimeout(stopTimer);
  };
}
