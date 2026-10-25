import {
  RUN_STREAM_MAXLEN,
  runCancelKey,
  runEventsConnectionName,
  runStreamKey,
} from '@agentport/shared';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeProducer, publishRun, subscribeRun } from '../src/queue/producer.js';

vi.mock('ioredis', () => {
  class Redis {
    on = vi.fn();
    xadd = vi.fn().mockResolvedValue('1-0');
    expire = vi.fn().mockResolvedValue(1);
    publish = vi.fn().mockResolvedValue(1);
    set = vi.fn().mockResolvedValue('OK');
    subscribe = vi.fn().mockResolvedValue(1);
    xrevrange = vi.fn().mockResolvedValue([]);
    xinfo = vi.fn().mockResolvedValue(['length', 1, 'entries-added', 1]);
    // BLOCK 0 且没有新事件：订阅停在阻塞读取上，直到 close() 打断连接。
    xread = vi.fn(() => new Promise<never>(() => undefined));
    disconnect = vi.fn();
    quit = vi.fn().mockResolvedValue('OK');
  }
  return { Redis: vi.fn(Redis) };
});

// Distinct values catch a producer that copies the wire contract instead of consuming it.
vi.mock('@agentport/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@agentport/shared')>();
  return {
    ...shared,
    RUN_STREAM_MAXLEN: 17,
    runStreamKey: (id: string) => `contract:${id}:events`,
    runCancelKey: (id: string) => `contract:${id}:cancel`,
  };
});

afterEach(closeProducer);

describe('producer shared stream contract', () => {
  it('publishes events to the stream without any separate wake channel', async () => {
    await publishRun('run-1', { type: 'text_delta', text: 'hello' });
    const publisher = vi.mocked(Redis).mock.instances.at(-1);
    expect(publisher?.xadd).toHaveBeenCalledWith(
      runStreamKey('run-1'),
      'MAXLEN',
      '~',
      RUN_STREAM_MAXLEN,
      '*',
      'payload',
      JSON.stringify({ type: 'text_delta', text: 'hello' }),
    );
    expect(publisher?.expire).toHaveBeenCalledWith(runStreamKey('run-1'), 3600);
    expect(publisher?.publish).not.toHaveBeenCalled();
  });

  it('follows the stream with a blocking XREAD from the last real id', async () => {
    await publishRun('run-1', { type: 'text_delta', text: 'hello' });
    const publisher = vi.mocked(Redis).mock.instances.at(-1);
    expect(publisher).toBeDefined();
    // 回放读到一条真实事件后，跟读必须从它的 ID 继续，而不是 `$`（会丢掉阻塞前到达的事件）。
    vi.mocked(Redis).mock.instances[0]?.xrevrange.mockResolvedValueOnce([
      ['42-0', ['payload', JSON.stringify({ type: 'text_delta', text: 'hello' })]],
    ]);
    const subscription = await subscribeRun('run-1', () => undefined, undefined);
    const subscriber = vi
      .mocked(Redis)
      .mock.calls.map((call, index) => ({ call, instance: vi.mocked(Redis).mock.instances[index] }))
      .find(({ call }) => call[1]?.connectionName === runEventsConnectionName('run-1'))?.instance;
    expect(subscriber).toBeDefined();
    // 初始回放走共享普通连接（不在订阅连接上执行 XRANGE）。
    expect(publisher.xrevrange).toHaveBeenCalledWith(
      runStreamKey('run-1'),
      '+',
      '-',
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

  it('uses the shared cancel key for the persistent flag and notification', async () => {
    await publishRun('run-1', { type: 'cancel' });
    const publisher = vi.mocked(Redis).mock.instances.at(-1);
    expect(publisher?.set).toHaveBeenCalledWith(runCancelKey('run-1'), '1', 'EX', 3600);
    expect(publisher?.publish).toHaveBeenCalledWith(runCancelKey('run-1'), '1');
  });

  it('keeps the existing Redis wire format byte-identical', async () => {
    const shared = await vi.importActual<typeof import('@agentport/shared')>('@agentport/shared');
    expect(shared.runStreamKey('run-1')).toBe('run:run-1:events');
    expect(shared.runCancelKey('run-1')).toBe('run:run-1:cancel');
    expect(shared.RUN_STREAM_MAXLEN).toBe(1000);
  });
});
