import { jest } from 'bun:test';

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

export async function runOnlyPendingTimersAsync(): Promise<void> {
  jest.runOnlyPendingTimers();
  await flushMicrotasks();
}

export async function waitFor<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const timeout = options.timeout ?? 1000;
  const interval = options.interval ?? 10;
  const fake = jest.isFakeTimers();
  const started = performance.now();
  const maxIterations = Math.max(1, Math.ceil(timeout / interval));
  let iterations = 0;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      iterations += 1;
      const expired = fake ? iterations > maxIterations : performance.now() - started >= timeout;
      if (expired) throw error;
      if (fake) {
        jest.advanceTimersByTime(interval);
        await flushMicrotasks();
      } else {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
  }
}
