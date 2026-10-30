import { EventEmitter } from 'node:events';
import { RunFailure } from '@agentport/core';
import type { ChatEvent, ExecutionSettlement } from '@agentport/shared';
import { runCancelKey } from '@agentport/shared';
import type { Logger } from 'pino';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxCleanupError } from '../src/sandbox/provider.js';
import type { SessionSandboxLease } from '../src/sandbox/sessions.js';

const redisMock = vi.hoisted(() => ({
  subscribe: vi.fn(async (_channel: string): Promise<void> => undefined),
  unsubscribe: vi.fn(async (_channel: string): Promise<void> => undefined),
  exists: vi.fn(async (_channel: string): Promise<number> => 0),
  connections: [] as EventEmitter[],
}));
vi.mock('ioredis', () => ({
  Redis: class extends EventEmitter {
    constructor() {
      super();
      redisMock.connections.push(this);
    }
    subscribe = redisMock.subscribe;
    unsubscribe = redisMock.unsubscribe;
    exists = redisMock.exists;
    async quit() {}
    pipeline() {
      return {
        xadd() {
          return this;
        },
        expire() {
          return this;
        },
        async exec() {
          return [];
        },
      };
    }
  },
}));
const { acquireSessionSandbox, closeRunnerClient, runInSandbox, isRetryable } = await import(
  '../src/runner-client.js'
);
const logger = { info() {}, warn() {}, debug() {}, error() {} } as unknown as Logger;
const stopped: ExecutionSettlement = { state: 'stopped', code: 0, signal: null };
const task = {
  prompt: 'hi',
  model: 'test',
  maxTurns: 1,
  maxBudgetUsd: 1,
  userMessageUuid: '11111111-2222-4333-8444-555555555555',
};
/** 真 provider 的清理失败类型：带 sandbox id 与原始 cause。 */
function cleanupFailure(
  sandboxId: string,
  cause = new Error('docker rm failed'),
): SandboxCleanupError {
  return new SandboxCleanupError(sandboxId, `sandbox ${sandboxId} cleanup failed`, cause);
}

afterAll(closeRunnerClient);
afterEach(async () => {
  vi.useRealTimers();
  await closeRunnerClient();
  redisMock.subscribe.mockReset().mockResolvedValue(undefined);
  redisMock.unsubscribe.mockReset().mockResolvedValue(undefined);
  redisMock.exists.mockReset().mockResolvedValue(0);
  redisMock.connections.length = 0;
});

function fixture(
  input: {
    timeout?: boolean;
    uncertain?: boolean;
    destroyFails?: boolean;
    releaseError?: Error;
  } = {},
) {
  let event: (value: ChatEvent) => void = () => undefined;
  let finish: (value: ExecutionSettlement) => void = () => undefined;
  const done = new Promise<ExecutionSettlement>((resolve) => {
    finish = resolve;
  });
  const cancel = vi.fn(async () => {
    event({
      type: 'run_finished',
      status: 'cancelled',
      sessionId: 'sdk-after-cancel',
      costUsd: 0.25,
    });
    const result: ExecutionSettlement = input.uncertain
      ? { state: 'unconfirmed', error: 'runner still alive' }
      : stopped;
    finish(result);
    return result;
  });
  const release = vi.fn(async () => {
    if (input.releaseError !== undefined) throw input.releaseError;
    if (input.destroyFails) throw new Error('destroy failed');
  });
  const lease: SessionSandboxLease = {
    sandboxId: 'session-container',
    release,
    start: vi.fn(async (options) => {
      event = options.onEvent;
      if (!input.timeout)
        queueMicrotask(() => {
          event({ type: 'assistant_text', text: 'complete' });
          event({ type: 'run_finished', status: 'succeeded', sessionId: 'sdk-session' });
          finish(input.uncertain ? { state: 'unconfirmed', error: 'runner still alive' } : stopped);
        });
      return { done, send() {}, cancel };
    }),
  };
  return { lease, release, cancel };
}

describe('subscription preparation cancellation', () => {
  const spec = {
    agentId: 'a',
    conversationId: 'c',
    image: 'i',
    workspaceDir: '/w',
    outputsDir: '/o',
    inputsDir: '/i',
    memoryDir: '/m',
    sessionsDir: '/s',
  };
  for (const entry of ['acquire', 'execution'] as const) {
    for (const pending of ['subscribe', 'exists'] as const) {
      for (const stop of ['shutdown', 'budget'] as const) {
        it(`${entry}: ${stop} interrupts pending ${pending} and removes its listener`, async () => {
          vi.useFakeTimers();
          redisMock[pending].mockImplementationOnce(() => new Promise(() => undefined));
          // Unsubscribe must not make shutdown depend on the same disconnected Redis.
          redisMock.unsubscribe.mockImplementationOnce(() => new Promise(() => undefined));
          const { lease } = fixture();
          const acquire = vi.fn(async () => lease);
          const closing = new AbortController();
          let result: unknown;
          const running =
            entry === 'acquire'
              ? acquireSessionSandbox({
                  runId: 'pending-preparation',
                  spec,
                  manager: { acquire },
                  signal: closing.signal,
                  logger,
                })
              : runInSandbox({
                  runId: 'pending-preparation',
                  task,
                  lease,
                  env: {},
                  timeoutMs: 1000,
                  signal: closing.signal,
                  logger,
                });
          void running.then(
            (value) => {
              result = value;
            },
            (error: unknown) => {
              result = error;
            },
          );
          await vi.advanceTimersByTimeAsync(0);
          expect(redisMock[pending]).toHaveBeenCalled();
          if (stop === 'shutdown') closing.abort();
          await vi.advanceTimersByTimeAsync(stop === 'budget' ? 30_000 : 1);
          expect(result).toBeDefined();
          if (entry === 'acquire') {
            expect(result).toMatchObject({
              reason: stop === 'shutdown' ? 'cancelled' : 'infra',
              message: expect.any(String),
            });
          } else {
            expect(result).toMatchObject({
              status: stop === 'shutdown' ? 'cancelled' : 'failed',
              failure: { reason: stop === 'shutdown' ? 'cancelled' : 'infra' },
            });
          }
          expect(acquire).not.toHaveBeenCalled();
          expect(lease.start).not.toHaveBeenCalled();
          expect(
            redisMock.connections.every((connection) => connection.listenerCount('message') === 0),
          ).toBe(true);
          expect(redisMock.unsubscribe).toHaveBeenCalledWith(runCancelKey('pending-preparation'));
        });
      }
    }
    for (const cancellation of ['exists', 'callback', 'signal'] as const) {
      it(`${entry}: ${cancellation} already cancelled never starts a side effect`, async () => {
        const { lease, release } = fixture();
        const acquire = vi.fn(async () => lease);
        const closing = new AbortController();
        if (cancellation === 'exists') redisMock.exists.mockResolvedValueOnce(1);
        if (cancellation === 'callback')
          redisMock.subscribe.mockImplementationOnce(async (channel) => {
            for (const connection of redisMock.connections)
              connection.emit('message', channel, '1');
          });
        if (cancellation === 'signal') closing.abort();
        if (entry === 'acquire') {
          await expect(
            acquireSessionSandbox({
              runId: 'already-cancelled',
              spec,
              manager: { acquire },
              signal: closing.signal,
              logger,
            }),
          ).rejects.toMatchObject({ reason: 'cancelled' });
        } else {
          const outcome = await runInSandbox({
            runId: 'already-cancelled',
            task,
            lease,
            env: {},
            timeoutMs: 1000,
            signal: closing.signal,
            logger,
          });
          expect(outcome).toMatchObject({ status: 'cancelled', settlement: { state: 'stopped' } });
          expect(release).not.toHaveBeenCalled();
        }
        expect(acquire).not.toHaveBeenCalled();
        expect(lease.start).not.toHaveBeenCalled();
      });
    }
  }

  it.each(['subscribe', 'exists'] as const)(
    'ignores late %s rejection after shutdown',
    async (pending) => {
      let rejectPending: (error: Error) => void = () => undefined;
      redisMock[pending].mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPending = reject;
          }),
      );
      const { lease } = fixture();
      const closing = new AbortController();
      const running = runInSandbox({
        runId: 'late-reject',
        task,
        lease,
        env: {},
        timeoutMs: 1000,
        logger,
        signal: closing.signal,
      });
      await vi.waitFor(() => expect(redisMock[pending]).toHaveBeenCalled());
      closing.abort();
      expect((await running).status).toBe('cancelled');
      rejectPending(new Error('late Redis failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(lease.start).not.toHaveBeenCalled();
      if (pending === 'subscribe') expect(redisMock.exists).not.toHaveBeenCalled();
      expect(
        redisMock.connections.every((connection) => connection.listenerCount('message') === 0),
      ).toBe(true);
    },
  );

  it('does not continue to EXISTS when a cancelled subscription resolves late', async () => {
    let resolveSubscribe: () => void = () => undefined;
    redisMock.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve;
        }),
    );
    const { lease } = fixture();
    const closing = new AbortController();
    const running = runInSandbox({
      runId: 'late-subscribe',
      task,
      lease,
      env: {},
      timeoutMs: 1000,
      logger,
      signal: closing.signal,
    });
    await vi.waitFor(() => expect(redisMock.subscribe).toHaveBeenCalled());
    closing.abort();
    await running;
    resolveSubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(redisMock.exists).not.toHaveBeenCalled();
    expect(lease.start).not.toHaveBeenCalled();
  });

  it('keeps the other run listener when one subscription is interrupted', async () => {
    redisMock.subscribe.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = fixture();
    const active = fixture({ timeout: true });
    const closing = new AbortController();
    const first = runInSandbox({
      runId: 'first',
      task,
      lease: pending.lease,
      env: {},
      timeoutMs: 1000,
      logger,
      signal: closing.signal,
    });
    const second = runInSandbox({
      runId: 'second',
      task,
      lease: active.lease,
      env: {},
      timeoutMs: 1000,
      logger,
    });
    await vi.waitFor(() => expect(active.lease.start).toHaveBeenCalled());
    closing.abort();
    await first;
    const subscriber = redisMock.connections[0];
    expect(subscriber?.listenerCount('message')).toBe(1);
    subscriber?.emit('message', runCancelKey('second'), '1');
    expect((await second).status).toBe('cancelled');
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(pending.lease.start).not.toHaveBeenCalled();
    expect(subscriber?.listenerCount('message')).toBe(0);
  });

  it('keeps metadata received while waiting for start ACK during cancellation', async () => {
    const { lease } = fixture();
    lease.start = vi.fn(async ({ onEvent }) => {
      onEvent({
        type: 'run_finished',
        status: 'cancelled',
        sessionId: 'sdk-during-start',
        costUsd: 0.2,
        inputTokens: 10,
        outputTokens: 2,
      });
      return new Promise(() => undefined);
    });
    const closing = new AbortController();
    const running = runInSandbox({
      runId: 'start-metadata',
      task,
      lease,
      env: {},
      timeoutMs: 1000,
      logger,
      signal: closing.signal,
    });
    await vi.waitFor(() => expect(lease.start).toHaveBeenCalled());
    closing.abort();
    expect(await running).toMatchObject({
      status: 'cancelled',
      sessionId: 'sdk-during-start',
      costUsd: 0.2,
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it('keeps one startup budget across subscription and start ACK', async () => {
    vi.useFakeTimers();
    redisMock.subscribe.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 20_000)),
    );
    const { lease } = fixture();
    lease.start = vi.fn(() => new Promise(() => undefined));
    let outcome: unknown;
    void runInSandbox({
      runId: 'single-budget',
      task,
      lease,
      env: {},
      timeoutMs: 1000,
      logger,
    }).then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toMatchObject({ status: 'failed', failure: { reason: 'infra' } });
  });

  it('preserves a non-Error RunFailure message at the acquire boundary', async () => {
    const failure = new RunFailure('infra', 'supervisor ready failed: socket closed');
    await expect(
      acquireSessionSandbox({
        runId: 'failure-message',
        spec,
        manager: {
          acquire: async () => {
            throw failure;
          },
        },
        signal: new AbortController().signal,
        logger,
      }),
    ).rejects.toBe(failure);
  });
});

describe('session acquire cancellation and budget', () => {
  const spec = {
    agentId: 'a',
    conversationId: 'c',
    image: 'i',
    workspaceDir: '/w',
    outputsDir: '/o',
    inputsDir: '/i',
    memoryDir: '/m',
    sessionsDir: '/s',
  };
  it('keeps waiting after the 30 second budget until the aborted create settles', async () => {
    let received: AbortSignal | undefined;
    let rejectAcquire: (error: Error) => void = () => undefined;
    const acquire = vi.fn((_spec, signal: AbortSignal) => {
      received = signal;
      return new Promise<SessionSandboxLease>((_resolve, reject) => {
        rejectAcquire = reject;
      });
    });
    vi.useFakeTimers();
    try {
      const cleanup = cleanupFailure('late-container');
      let settled = false;
      const running = acquireSessionSandbox({
        runId: 'acquire-timeout',
        spec,
        manager: { acquire },
        signal: new AbortController().signal,
        logger,
      }).finally(() => {
        settled = true;
      });
      const rejected = expect(running).rejects.toMatchObject({
        reason: 'infra',
        message: expect.stringContaining('timed out'),
        // 清理失败的真实类型保留在 cause 里，调用方仍能拿到容器 id。
        cause: cleanup,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(received?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      // provider 仍在清理：预算到点后必须等它真正收尾，不能先返回。
      expect(settled).toBe(false);
      rejectAcquire(cleanup);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a cancelled create to clean up before rejecting', async () => {
    const closing = new AbortController();
    let received: AbortSignal | undefined;
    let rejectAcquire: (error: Error) => void = () => undefined;
    const acquire = vi.fn((_spec, signal: AbortSignal) => {
      received = signal;
      return new Promise<SessionSandboxLease>((_resolve, reject) => {
        rejectAcquire = reject;
      });
    });
    let settled = false;
    const running = acquireSessionSandbox({
      runId: 'acquire-cancel-cleanup',
      spec,
      manager: { acquire },
      signal: closing.signal,
      logger,
    }).finally(() => {
      settled = true;
    });
    const rejected = expect(running).rejects.toMatchObject({ reason: 'cancelled' });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    closing.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(received?.aborted).toBe(true);
    expect(settled).toBe(false);
    rejectAcquire(cleanupFailure('cancelled-container'));
    await rejected;
  });

  it('releases a lease that arrives after cancellation instead of leaking it', async () => {
    const closing = new AbortController();
    const release = vi.fn(async () => undefined);
    let resolveAcquire: (lease: SessionSandboxLease) => void = () => undefined;
    const acquire = vi.fn(
      (_spec, _signal: AbortSignal) =>
        new Promise<SessionSandboxLease>((resolve) => {
          resolveAcquire = resolve;
        }),
    );
    let settled = false;
    const running = acquireSessionSandbox({
      runId: 'late-lease',
      spec,
      manager: { acquire },
      signal: closing.signal,
      logger,
    }).finally(() => {
      settled = true;
    });
    const rejected = expect(running).rejects.toMatchObject({ reason: 'cancelled' });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    closing.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    resolveAcquire({
      sandboxId: 'late-lease',
      release,
      start: vi.fn(),
    } as unknown as SessionSandboxLease);
    await rejected;
    expect(release).toHaveBeenCalledWith({ reuse: false });
  });

  it('keeps the sandbox id when releasing a late cancelled lease fails with a plain error', async () => {
    const closing = new AbortController();
    const releaseError = new Error('docker rm failed');
    const release = vi.fn(async () => {
      throw releaseError;
    });
    let resolveAcquire: (lease: SessionSandboxLease) => void = () => undefined;
    const acquire = vi.fn(
      (_spec, _signal: AbortSignal) =>
        new Promise<SessionSandboxLease>((resolve) => {
          resolveAcquire = resolve;
        }),
    );
    const running = acquireSessionSandbox({
      runId: 'late-lease-release-fails',
      spec,
      manager: { acquire },
      signal: closing.signal,
      logger,
    }).catch((err: unknown) => err);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    closing.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveAcquire({
      sandboxId: 'late-lease-release-fails',
      release,
      start: vi.fn(),
    } as unknown as SessionSandboxLease);
    const error = await running;
    expect(error).toBeInstanceOf(RunFailure);
    const failure = error as RunFailure;
    expect(failure.reason).toBe('cancelled');
    expect(failure.cause).toBeInstanceOf(SandboxCleanupError);
    const cleanup = failure.cause as SandboxCleanupError;
    expect(cleanup.sandboxId).toBe('late-lease-release-fails');
    expect(cleanup.cause).toBe(releaseError);
  });

  it('keeps the sandbox id when releasing a late timed-out lease fails with a plain error', async () => {
    vi.useFakeTimers();
    try {
      const releaseError = new Error('docker rm failed');
      const release = vi.fn(async () => {
        throw releaseError;
      });
      let resolveAcquire: (lease: SessionSandboxLease) => void = () => undefined;
      const acquire = vi.fn(
        (_spec, _signal: AbortSignal) =>
          new Promise<SessionSandboxLease>((resolve) => {
            resolveAcquire = resolve;
          }),
      );
      const running = acquireSessionSandbox({
        runId: 'late-timeout-release-fails',
        spec,
        manager: { acquire },
        signal: new AbortController().signal,
        logger,
      }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(0);
      expect(acquire).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      resolveAcquire({
        sandboxId: 'late-timeout-release-fails',
        release,
        start: vi.fn(),
      } as unknown as SessionSandboxLease);
      const error = await running;
      expect(error).toBeInstanceOf(RunFailure);
      const failure = error as RunFailure;
      expect(failure.reason).toBe('infra');
      expect(failure.message).toContain('timed out');
      expect(failure.cause).toBeInstanceOf(SandboxCleanupError);
      const cleanup = failure.cause as SandboxCleanupError;
      expect(cleanup.sandboxId).toBe('late-timeout-release-fails');
      expect(cleanup.cause).toBe(releaseError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an ordinary acquire failure as retryable infra and keeps its cause', async () => {
    const failure = new Error('image pull failed');
    const acquire = vi.fn(async () => {
      throw failure;
    });
    const error = await acquireSessionSandbox({
      runId: 'ordinary-infra',
      spec,
      manager: { acquire },
      signal: new AbortController().signal,
      logger,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RunFailure);
    const runFailure = error as RunFailure;
    expect(runFailure).toMatchObject({ reason: 'infra', message: 'image pull failed' });
    expect(runFailure.cause).toBe(failure);
    expect(
      isRetryable({
        status: 'failed',
        sandboxId: '',
        settlement: { state: 'stopped', code: 0, signal: null },
        failure: runFailure,
        events: [],
      }),
    ).toBe(true);
  });

  it('passes the run id to the acquire implementation', async () => {
    const { lease } = fixture();
    const acquire = vi.fn(async () => lease);
    await acquireSessionSandbox({
      runId: 'run-with-id',
      spec,
      manager: { acquire },
      signal: new AbortController().signal,
      logger,
    });
    expect(acquire).toHaveBeenCalledWith(spec, expect.any(AbortSignal), 'run-with-id');
  });

  it('passes shutdown cancellation to an acquire that is still pending', async () => {
    const closing = new AbortController();
    let received: AbortSignal | undefined;
    const acquire = vi.fn((_spec, signal: AbortSignal) => {
      received = signal;
      return new Promise<SessionSandboxLease>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    });
    const running = acquireSessionSandbox({
      runId: 'acquire-shutdown',
      spec,
      manager: { acquire },
      signal: closing.signal,
      logger,
    });
    const rejected = expect(running).rejects.toMatchObject({ reason: 'cancelled' });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    closing.abort();
    await rejected;
    expect(received?.aborted).toBe(true);
  });
});

describe('session runner client', () => {
  it('returns a completed run without releasing the lease before publication', async () => {
    const { lease, release } = fixture();
    const outcome = await runInSandbox({
      runId: 'complete',
      task,
      timeoutMs: 1000,
      env: { RUN_TOKEN: 'new' },
      lease,
      logger,
    });
    expect(outcome).toMatchObject({
      status: 'succeeded',
      settlement: stopped,
      sessionId: 'sdk-session',
    });
    expect(lease.start).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'complete', task, env: { RUN_TOKEN: 'new' } }),
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('keeps metadata emitted during graceful cancellation', async () => {
    const { lease, cancel, release } = fixture({ timeout: true });
    const signal = new AbortController();
    const running = runInSandbox({
      runId: 'cancel',
      task,
      timeoutMs: 1000,
      env: {},
      lease,
      logger,
      signal: signal.signal,
    });
    await vi.waitFor(() => expect(lease.start).toHaveBeenCalled());
    signal.abort();
    const outcome = await running;
    expect(outcome).toMatchObject({
      status: 'cancelled',
      sessionId: 'sdk-after-cancel',
      costUsd: 0.25,
      settlement: stopped,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it('destroys an abnormal runner exit even when run_finished arrived first', async () => {
    const { lease, release } = fixture();
    lease.start = async ({ onEvent }) => {
      onEvent({ type: 'run_finished', status: 'succeeded', sessionId: 'sdk-before-crash' });
      return {
        done: Promise.resolve({ state: 'stopped', code: 137, signal: 'SIGKILL' }),
        send() {},
        cancel: async () => stopped,
      };
    };
    const outcome = await runInSandbox({
      runId: 'abnormal',
      task,
      timeoutMs: 1000,
      env: {},
      lease,
      logger,
    });
    expect(outcome).toMatchObject({ status: 'failed', sessionId: 'sdk-before-crash' });
    expect(release).toHaveBeenCalledWith({ reuse: false });
    expect(isRetryable(outcome)).toBe(false);
  });

  it('cancels while waiting for runner start ACK and destroys before returning', async () => {
    const { lease, release } = fixture();
    let startReached: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      startReached = resolve;
    });
    lease.start = async () => {
      startReached();
      return new Promise(() => undefined);
    };
    const signal = new AbortController();
    const running = runInSandbox({
      runId: 'pending-start',
      task,
      timeoutMs: 1000,
      env: {},
      lease,
      logger,
      signal: signal.signal,
    });
    await started;
    signal.abort();
    const outcome = await running;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.settlement.state).toBe('stopped');
    expect(release).toHaveBeenCalledWith({ reuse: false });
  });

  it('destroys an unconfirmed execution before reporting stopped', async () => {
    const { lease, release } = fixture({ uncertain: true });
    const outcome = await runInSandbox({
      runId: 'uncertain',
      task,
      timeoutMs: 1000,
      env: {},
      lease,
      logger,
    });
    expect(release).toHaveBeenCalledWith({ reuse: false });
    expect(outcome.settlement.state).toBe('stopped');
  });

  it('keeps complete messages and blocks publication when destroy cannot confirm stop', async () => {
    const { lease, release } = fixture({ uncertain: true, destroyFails: true });
    const outcome = await runInSandbox({
      runId: 'destroy-failed',
      task,
      timeoutMs: 1000,
      env: {},
      lease,
      logger,
    });
    expect(release).toHaveBeenCalledWith({ reuse: false });
    expect(outcome.settlement).toMatchObject({ state: 'unconfirmed' });
    expect(outcome.cleanupError).toBe('destroy failed');
    expect(outcome.events).toEqual([
      expect.objectContaining({ type: 'assistant_text', text: 'complete' }),
    ]);
    expect(isRetryable(outcome)).toBe(false);
  });

  it('keeps a typed cleanup failure in the run failure cause chain', async () => {
    const cleanup = cleanupFailure('session-container');
    const { lease, release } = fixture({ releaseError: cleanup });
    lease.start = async () => ({
      done: Promise.resolve({ state: 'unconfirmed', error: 'runner still alive' }),
      send() {},
      cancel: async () => stopped,
    });
    const outcome = await runInSandbox({
      runId: 'cleanup-typed',
      task,
      timeoutMs: 1000,
      env: {},
      lease,
      logger,
    });
    expect(release).toHaveBeenCalledWith({ reuse: false });
    expect(outcome.settlement.state).toBe('unconfirmed');
    expect(outcome.cleanupError).toBe(cleanup.message);
    // 容器 id 在 cause 链里，index 才能继续按 id 清理。
    expect(outcome.failure?.cause).toBe(cleanup);
    expect(outcome.failure?.cause).toMatchObject({ sandboxId: 'session-container' });
    expect(isRetryable(outcome)).toBe(false);
  });
});
