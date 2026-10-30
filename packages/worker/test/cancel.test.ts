import { randomUUID } from 'node:crypto';
import type { ExecutionSettlement } from '@agentport/shared';
import { runCancelKey } from '@agentport/shared';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acquireSessionSandbox,
  closeRunnerClient,
  configureRunnerClient,
  isRetryable,
  runInSandbox,
} from '../src/runner-client.js';
import type { SessionSandboxLease } from '../src/sandbox/sessions.js';

async function probeRedis(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return false;
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

const redisUrl = process.env.REDIS_URL ?? '';
const ready = await probeRedis();

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quietLogger,
} as unknown as Parameters<typeof runInSandbox>[0]['logger'];

const task = {
  prompt: 'hi',
  model: 'test',
  maxTurns: 1,
  maxBudgetUsd: 1,
  userMessageUuid: '11111111-2222-4333-8444-555555555555',
};

function input(runId: string, lease: SessionSandboxLease) {
  return {
    runId,
    timeoutMs: 5_000,
    task,
    env: {},
    lease,
    logger: quietLogger,
  };
}

async function requestCancel(runId: string): Promise<void> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    await redis.set(runCancelKey(runId), '1', 'EX', 60);
    await redis.publish(runCancelKey(runId), '1');
  } finally {
    redis.disconnect();
  }
}

afterAll(async () => {
  await closeRunnerClient();
});

describe.skipIf(!ready)('runInSandbox task payload', () => {
  it('passes task and per-run environment to the lease unchanged', async () => {
    configureRunnerClient(redisUrl);
    let received: unknown;
    const outcome = await runInSandbox(
      input(`run-payload-${randomUUID()}`, {
        sandboxId: 'fake',
        start: async (options) => {
          received = options.task;
          options.onEvent({ type: 'run_finished', status: 'succeeded' });
          return {
            done: Promise.resolve({ state: 'stopped', code: 0, signal: null }),
            send() {},
            cancel: async () => ({ state: 'stopped', code: 0, signal: null }),
          };
        },
        release: async () => {
          throw new Error('completed run must retain its lease');
        },
      }),
    );
    expect(outcome.status).toBe('succeeded');
    expect(received).toEqual(task);
  });
});

describe.skipIf(!ready)('session acquire cancellation', () => {
  it('aborts a pending acquire when the user cancels through Redis', async () => {
    configureRunnerClient(redisUrl);
    const runId = `acquire-cancel-${randomUUID()}`;
    let started: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    let received: AbortSignal | undefined;
    let cleanedUp = false;
    const running = acquireSessionSandbox({
      runId,
      logger: quietLogger,
      signal: new AbortController().signal,
      spec: {
        agentId: 'a',
        conversationId: 'c',
        image: 'i',
        workspaceDir: '/w',
        outputsDir: '/o',
        inputsDir: '/i',
        memoryDir: '/m',
        sessionsDir: '/s',
      },
      manager: {
        acquire: (_spec, signal) => {
          received = signal;
          started();
          return new Promise<SessionSandboxLease>((_resolve, reject) => {
            const abort = (): void => {
              // provider 契约：abort 后先清理完容器再 reject，调用方要等收尾才返回 cancelled。
              cleanedUp = true;
              const err = new Error('acquire aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        },
      },
    });
    const rejected = expect(running).rejects.toMatchObject({ reason: 'cancelled' });
    await reached;
    await requestCancel(runId);
    await rejected;
    expect(received?.aborted).toBe(true);
    expect(cleanedUp).toBe(true);
  });
});

describe.skipIf(!ready)('runInSandbox cancellation', () => {
  it.each([false, true])(
    'waits for cancel ACK, preserves metadata and reports cleanup failure=%s',
    async (cleanupFails) => {
      configureRunnerClient(redisUrl);
      const runId = `run-cancel-${randomUUID()}`;
      let started: () => void = () => undefined;
      const starting = new Promise<void>((resolve) => {
        started = resolve;
      });
      let releases = 0;
      const running = runInSandbox(
        input(runId, {
          sandboxId: 'fake',
          start: async ({ onEvent }) => {
            let finish: (value: ExecutionSettlement) => void = () => undefined;
            const done = new Promise<ExecutionSettlement>((resolve) => {
              finish = resolve;
            });
            started();
            return {
              done,
              send() {},
              cancel: async () => {
                onEvent({
                  type: 'run_finished',
                  status: 'cancelled',
                  sessionId: 'sdk-cancel',
                  costUsd: 0.1,
                });
                const settlement: ExecutionSettlement = cleanupFails
                  ? { state: 'unconfirmed', error: 'cancel failed' }
                  : { state: 'stopped', code: 0, signal: null };
                finish(settlement);
                return settlement;
              },
            };
          },
          release: async ({ reuse }) => {
            expect(reuse).toBe(false);
            releases++;
            throw new Error('destroy failed');
          },
        }),
      );
      await starting;
      await requestCancel(runId);
      const outcome = await running;
      expect(outcome).toMatchObject({ status: 'cancelled', sessionId: 'sdk-cancel', costUsd: 0.1 });
      expect(isRetryable(outcome)).toBe(false);
      expect(releases).toBe(cleanupFails ? 1 : 0);
      expect(outcome.cleanupError).toBe(cleanupFails ? 'destroy failed' : undefined);
      expect(outcome.settlement.state).toBe(cleanupFails ? 'unconfirmed' : 'stopped');
    },
  );
});
