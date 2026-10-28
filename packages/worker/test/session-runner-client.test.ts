import { EventEmitter } from 'node:events';
import { RunFailure } from '@agentport/core';
import type { ChatEvent, ExecutionSettlement } from '@agentport/shared';
import { runCancelKey } from '@agentport/shared';
import type { Logger } from 'pino';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
afterAll(closeRunnerClient);
afterEach(async () => {
  vi.useRealTimers();
  await closeRunnerClient();
  redisMock.subscribe.mockReset().mockResolvedValue(undefined);
  redisMock.unsubscribe.mockReset().mockResolvedValue(undefined);
  redisMock.exists.mockReset().mockResolvedValue(0);
  redisMock.connections.length = 0;
});

function fixture(input: { timeout?: boolean; uncertain?: boolean; destroyFails?: boolean } = {}) {
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
  it('aborts a pending acquire when the 30 second create budget expires', async () => {
    let received: AbortSignal | undefined;
    const acquire = vi.fn((_spec, signal: AbortSignal) => {
      received = signal;
      return new Promise<SessionSandboxLease>(() => undefined);
    });
    vi.useFakeTimers();
    try {
      const running = acquireSessionSandbox({
        runId: 'acquire-timeout',
        spec,
        manager: { acquire },
        signal: new AbortController().signal,
        logger,
      });
      const rejected = expect(running).rejects.toMatchObject({
        reason: 'infra',
        message: expect.stringContaining('timed out'),
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(received?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
});
