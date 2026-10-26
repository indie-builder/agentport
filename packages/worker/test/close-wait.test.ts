import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitClose } from '../src/close-wait.js';

describe('waitClose', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports true when closing settles before the deadline and clears the deadline timer', async () => {
    vi.useFakeTimers();
    await expect(waitClose(Promise.resolve(), 1_000)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports true when closing rejects before the deadline and clears the deadline timer', async () => {
    vi.useFakeTimers();
    await expect(waitClose(Promise.reject(new Error('close failed')), 1_000)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports false on timeout without cancelling the pending work', async () => {
    vi.useFakeTimers();
    let finished = false;
    const pending = new Promise<void>((resolve) => {
      setTimeout(() => {
        finished = true;
        resolve();
      }, 30);
    });

    const waiting = waitClose(pending, 5);
    await vi.advanceTimersByTimeAsync(5);
    await expect(waiting).resolves.toBe(false);
    expect(finished).toBe(false);
    // 只剩后台任务自己的计时器：waitClose 的截止计时器已到点且未拦截后续释放。
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
