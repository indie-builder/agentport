import { CancelledError, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runQuery } from '../src/lib/queries.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run query cancellation', () => {
  it('forwards query cancellation to the in-flight run request', async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });

    // 真实网络边界：queryFn -> api.run -> fetch。记录的是 fetch 实际收到的信号。
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined;
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted();
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pending = client.query({ ...runQuery('run-a'), staleTime: 0 });
    await ready;

    expect(signal).toBeDefined();
    await client.cancelQueries({ queryKey: ['run', 'run-a'], exact: true });
    await cancelled;

    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });
});
