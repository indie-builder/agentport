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
    provider: h.step('sandbox provider'),
    steps: [h.step('maintenance worker'), h.step('sandbox probe')],
    finalSteps: [h.step('eval queue'), h.step('model proxy')],
    pool: h.step('postgres pool'),
    waits: { shutdownMs: 1_000, closeMs: 1_000, poolMs: 1_000 },
    ...overrides,
  };
}

function expectRemainingClosed(h: Harness): void {
  // 任一资源失败后，后续步骤仍按原顺序执行到底。
  const order = ['maintenance worker', 'sandbox probe', 'eval queue', 'model proxy'];
  for (const label of order) expect(h.calls).toContain(label);
  expect(h.calls).toContain('sandbox provider');
  expect(h.calls.indexOf('maintenance worker')).toBeLessThan(h.calls.indexOf('sandbox probe'));
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
        provider: h.step('sandbox provider', async () => {
          throw failure;
        }),
      }),
    );

    expect(code).toBe(1);
    expect(h.errors).toEqual([{ label: 'sandbox provider', err: failure }]);
    expect(h.calls).toContain('sandbox probe');
    // provider 失败已聚合，后续 final close 仍执行到底。
    expectRemainingClosed(h);
  });

  it('waits for a provider that outlives the close deadline before resolving', async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const run = runShutdown(
      options(h, {
        provider: h.step('sandbox provider', () => held),
        waits: { shutdownMs: 5, closeMs: 5, poolMs: 5 },
      }),
    ).finally(() => {
      settled = true;
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    // 运行中的容器还在 stop：关停不能在 provider 收尾前返回 exit 0。
    expect(settled).toBe(false);
    expect(h.calls).not.toContain('postgres pool');

    release();
    await expect(run).resolves.toBe(0);
    expect(h.calls).toContain('eval queue');
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

  it('destroys the provider after the run grace even when another close hangs', async () => {
    const h = harness();
    const code = await runShutdown(
      options(h, {
        workers: [h.step('main worker', () => new Promise(() => {})), h.step('eval worker')],
        steps: [h.step('maintenance worker', () => new Promise(() => {}))],
        waits: { shutdownMs: 5, closeMs: 5, poolMs: 5 },
      }),
    );

    expect(code).toBe(0);
    // 知识任务这类关闭可以挂很久，沙盒强杀不能排在它们后面等排空。
    expect(h.calls).toContain('sandbox provider');
    // 仍有后台任务时提前关池会打断它正在跑的查询，直接退出交给进程回收连接。
    expect(h.calls).not.toContain('postgres pool');
  });

  it('stops waiting at the deadline and still closes later resources', async () => {
    const h = harness();
    const code = await runShutdown(
      options(h, {
        workers: [h.step('main worker', () => new Promise(() => {})), h.step('eval worker')],
        waits: { shutdownMs: 5, closeMs: 5, poolMs: 5 },
      }),
    );

    expect(code).toBe(0);
    expectRemainingClosed(h);
    // run 未在宽限期内结束，池留给进程回收，不能提前打断在跑的查询。
    expect(h.calls).not.toContain('postgres pool');
  });

  it('does not leak an unhandled rejection when a worker rejects after the shutdown wait', async () => {
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
          waits: { shutdownMs: 5, closeMs: 5, poolMs: 5 },
        }),
      );
      // 让首轮等待超时后的 rejection 全部落地，再断言没有漏成 unhandled。
      await new Promise((resolveWait) => setTimeout(resolveWait, 60));

      expect(code).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
