import { runCancelKey, runEventsConnectionName, runStreamKey } from '@agentport/shared';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeProducer,
  publishRun,
  requestRunCancel,
  subscribeRun,
} from '../src/queue/producer.js';

const mockState = vi.hoisted(() => ({
  pipelines: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  execError: null as Error | null,
}));

vi.mock('ioredis', () => {
  const chain = (): Record<string, ReturnType<typeof vi.fn>> => {
    const pipe: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of ['xadd', 'expire', 'set', 'publish']) {
      pipe[name] = vi.fn(() => pipe);
    }
    pipe.exec = vi.fn(async () =>
      mockState.execError
        ? [
            [mockState.execError, null],
            [null, 1],
          ]
        : [
            [null, '1-0'],
            [null, 1],
          ],
    );
    mockState.pipelines.push(pipe);
    return pipe;
  };
  class Redis {
    on = vi.fn();
    xadd = vi.fn().mockResolvedValue('1-0');
    expire = vi.fn().mockResolvedValue(1);
    publish = vi.fn().mockResolvedValue(1);
    set = vi.fn().mockResolvedValue('OK');
    subscribe = vi.fn().mockResolvedValue(1);
    xrange = vi.fn().mockResolvedValue([]);
    xread = vi.fn(() => new Promise<never>(() => undefined));
    disconnect = vi.fn();
    quit = vi.fn().mockResolvedValue('OK');
    pipeline = vi.fn(() => chain());
  }
  return { Redis: vi.fn(Redis) };
});

// Distinct values catch a producer that copies the wire contract instead of consuming it.
vi.mock('@agentport/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@agentport/shared')>();
  return {
    ...shared,
    RUN_TRANSIENT_MAX_EVENTS: 7,
    RUN_TRANSIENT_MAX_BYTES: 8,
    RUN_PERSISTED_MAX_EVENTS: 9,
    RUN_PERSISTED_MAX_BYTES: 10,
    runStreamKey: (id: string) => `contract:${id}:events`,
    runCancelKey: (id: string) => `contract:${id}:cancel`,
  };
});

afterEach(async () => {
  await closeProducer();
  mockState.pipelines.length = 0;
  mockState.execError = null;
});

describe('producer shared stream contract', () => {
  it('publishes events through one pipeline instead of two round trips', async () => {
    await publishRun('run-1', { type: 'text_delta', text: 'hello' });
    const publisher = vi.mocked(Redis).mock.instances.at(-1);
    const pipe = mockState.pipelines.at(-1);
    expect(pipe?.xadd).toHaveBeenCalledWith(
      runStreamKey('run-1'),
      '*',
      'payload',
      JSON.stringify({ type: 'text_delta', text: 'hello' }),
    );
    expect(pipe?.expire).toHaveBeenCalledWith(runStreamKey('run-1'), 3600);
    expect(pipe?.exec).toHaveBeenCalledTimes(1);
    // 两条命令都进了同一个 pipeline，不再各自单独往返。
    expect(publisher?.xadd).not.toHaveBeenCalled();
    expect(publisher?.expire).not.toHaveBeenCalled();
    expect(publisher?.publish).not.toHaveBeenCalled();
  });

  it('rejects when a pipelined command fails', async () => {
    mockState.execError = new Error('xadd failed');
    await expect(publishRun('run-1', { type: 'text_delta', text: 'hello' })).rejects.toThrow(
      'xadd failed',
    );
  });

  it('follows the stream with a blocking XREAD from the last real id', async () => {
    await publishRun('run-1', { type: 'text_delta', text: 'hello' });
    const publisher = vi.mocked(Redis).mock.instances.at(-1);
    expect(publisher).toBeDefined();
    // 回放读到一条真实事件后，跟读必须从它的 ID 继续，而不是 `$`（会丢掉阻塞前到达的事件）。
    vi.mocked(Redis).mock.instances[0]?.xrange.mockResolvedValueOnce([
      ['42-0', ['payload', JSON.stringify({ type: 'text_delta', text: 'hello' })]],
    ]);
    const subscription = await subscribeRun('run-1', () => undefined, undefined);
    const subscriber = vi
      .mocked(Redis)
      .mock.calls.map((call, index) => ({ call, instance: vi.mocked(Redis).mock.instances[index] }))
      .find(({ call }) => call[1]?.connectionName === runEventsConnectionName('run-1'))?.instance;
    expect(subscriber).toBeDefined();
    // 初始回放从流头正序读（不在订阅连接上执行），第一条后剩 0 条即结束回放。
    expect(publisher.xrange).toHaveBeenCalledWith(
      runStreamKey('run-1'),
      '0-0',
      '+',
      'COUNT',
      expect.any(Number),
    );
    await vi.waitFor(() => {
      expect(subscriber?.xread).toHaveBeenCalledWith(
        'COUNT',
        expect.any(Number),
        'BLOCK',
        0,
        'STREAMS',
        runStreamKey('run-1'),
        '42-0',
      );
    });
    expect(subscriber?.subscribe).not.toHaveBeenCalled();

    subscription.close();
    expect(subscriber?.disconnect).toHaveBeenCalled();
  });

  it('batches the cancel flag and notification under the shared cancel key', async () => {
    expect(await requestRunCancel('run-1')).toBe(true);
    const pipe = mockState.pipelines.at(-1);
    // NX：重复取消不重复写审计，也不重复打扰 worker。
    expect(pipe?.set).toHaveBeenCalledWith(runCancelKey('run-1'), '1', 'EX', 3600, 'NX');
    expect(pipe?.publish).toHaveBeenCalledWith(runCancelKey('run-1'), '1');
    expect(pipe?.exec).toHaveBeenCalledTimes(1);
    // 取消不是事件流的一部分：不能写 xadd。
    expect(pipe?.xadd).not.toHaveBeenCalled();
  });

  it('keeps the Redis wire format and exports the worker budgets', async () => {
    const shared = await vi.importActual<typeof import('@agentport/shared')>('@agentport/shared');
    expect(shared.runStreamKey('run-1')).toBe('run:run-1:events');
    expect(shared.runCancelKey('run-1')).toBe('run:run-1:cancel');
    // 删除按 1000 条裁剪流头的上限，改由 worker 的事件预算约束写入量。
    expect('RUN_STREAM_MAXLEN' in shared).toBe(false);
    expect(shared.RUN_TRANSIENT_MAX_EVENTS).toBe(2_000);
    expect(shared.RUN_TRANSIENT_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(shared.RUN_PERSISTED_MAX_EVENTS).toBe(2_000);
    expect(shared.RUN_PERSISTED_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});
