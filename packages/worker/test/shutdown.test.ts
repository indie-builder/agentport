import { describe, expect, it } from 'vitest';
import { runShutdown, type ShutdownOptions, type ShutdownStep } from '../src/shutdown.js';

interface Harness {
  calls: string[];
  errors: Array<{ label: string; err: unknown }>;
  step: (label: string, close?: () => Promise<unknown>) => ShutdownStep;
}

function harness(): Harness {
  const calls: string[] = [];
  const errors: Array<{ label: string; err: unknown }> = [];
  const step = (label: string, close: () => Promise<unknown> = async () => {}) => ({
    label,
    close: async () => {
      calls.push(label);
      return close();
    },
  });
  return { calls, errors, step };
}

function options(h: Harness, overrides: Partial<ShutdownOptions> = {}): ShutdownOptions {
  return {
    abort: () => {
      h.calls.push('abort');
    },
    logError: (label, err) => {
      h.errors.push({ label, err });
    },
    workers: [h.step('main worker'), h.step('eval worker')],
    steps: [h.step('maintenance worker'), h.step('sandbox provider')],
    finalSteps: [h.step('eval queue'), h.step('model proxy')],
    pool: h.step('postgres pool'),
    waits: { shutdownMs: 1_000, poolMs: 1_000 },
    ...overrides,
  };
}

function expectRemainingClosed(h: Harness): void {
  // 任一资源失败后，后续步骤仍按原顺序执行到底。
  const order = ['maintenance worker', 'sandbox provider', 'eval queue', 'model proxy'];
  for (const label of order) expect(h.calls).toContain(label);
  expect(h.calls).toContain('postgres pool');
  expect(h.calls.indexOf('maintenance worker')).toBeLessThan(h.calls.indexOf('sandbox provider'));
  expect(h.calls.indexOf('eval queue')).toBeLessThan(h.calls.indexOf('model proxy'));
}

describe('runShutdown', () => {
  it('records a main worker rejection and keeps closing, exiting 1', async () => {
    const h = harness();
    const failure = new Error('main worker close failed');
    const code = await runShutdown(
      options(h, {
        workers: [
          h.step('main worker', async () => {
            throw failure;
          }),
          h.step('eval worker'),
        ],
      }),
    );

    expect(code).toBe(1);
    expect(h.errors).toEqual([{ label: 'main worker', err: failure }]);
    expect(h.calls).toContain('eval worker');
    expectRemainingClosed(h);
  });

  it('records an eval worker rejection and keeps closing, exiting 1', async () => {
    const h = harness();
    const failure = new Error('eval worker close failed');
    const code = await runShutdown(
      options(h, {
        workers: [
          h.step('main worker'),
          h.step('eval worker', async () => {
            throw failure;
          }),
        ],
      }),
    );

    expect(code).toBe(1);
    expect(h.errors).toEqual([{ label: 'eval worker', err: failure }]);
    expect(h.calls).toContain('main worker');
    expectRemainingClosed(h);
  });

  it('records a provider rejection but closes the remaining resources, exiting 1', async () => {
    const h = harness();
    const failure = new Error('provider close failed');
    const code = await runShutdown(
      options(h, {
        steps: [
          h.step('maintenance worker'),
          h.step('sandbox provider', async () => {
            throw failure;
          }),
          h.step('sandbox probe'),
        ],
      }),
    );

    expect(code).toBe(1);
    expect(h.errors).toEqual([{ label: 'sandbox provider', err: failure }]);
    expect(h.calls).toContain('sandbox probe');
    expect(h.calls).toContain('postgres pool');
  });

  it('records a pool rejection instead of rejecting, exiting 1', async () => {
    const h = harness();
    const failure = new Error('pool end failed');
    const code = await runShutdown(
      options(h, {
        pool: h.step('postgres pool', async () => {
          throw failure;
        }),
      }),
    );

    expect(code).toBe(1);
    expect(h.errors).toEqual([{ label: 'postgres pool', err: failure }]);
    expect(h.calls).toContain('model proxy');
  });

  it('exits 0 when every resource closes', async () => {
    const h = harness();
    const code = await runShutdown(options(h));

    expect(code).toBe(0);
    expect(h.errors).toEqual([]);
    expect(h.calls[0]).toBe('abort');
    expect(h.calls).toContain('postgres pool');
  });

  it('stops waiting at the deadline and still closes later resources', async () => {
    const h = harness();
    const code = await runShutdown(
      options(h, {
        workers: [h.step('main worker', () => new Promise(() => {})), h.step('eval worker')],
        waits: { shutdownMs: 5, poolMs: 5 },
      }),
    );

    expect(code).toBe(0);
    expectRemainingClosed(h);
  });

  it('records a worker rejecting after the shutdown wait without an unhandled rejection', async () => {
    const h = harness();
    const failure = new Error('late main worker failure');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const code = await runShutdown(
        options(h, {
          workers: [
            h.step(
              'main worker',
              () => new Promise((_, reject) => setTimeout(() => reject(failure), 40)),
            ),
            h.step('eval worker'),
          ],
          // 首轮等待先超时；第二轮仍捕获迟到的 rejection。
          waits: { shutdownMs: 5, poolMs: 500 },
        }),
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));

      expect(code).toBe(1);
      expect(h.errors).toEqual([{ label: 'main worker', err: failure }]);
      expect(unhandled).toEqual([]);
      expect(h.calls).toContain('postgres pool');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
