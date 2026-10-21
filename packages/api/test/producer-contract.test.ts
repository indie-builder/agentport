import { RUN_STREAM_MAXLEN, runCancelKey, runChannel, runStreamKey } from '@agentport/shared';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeProducer, publishRun, subscribeRun } from '../src/queue/producer.js';

vi.mock('ioredis', () => {
  class Redis {
    status = 'ready';
    on = vi.fn();
    off = vi.fn();
    xadd = vi.fn().mockResolvedValue('1-0');
    expire = vi.fn().mockResolvedValue(1);
    publish = vi.fn().mockResolvedValue(1);
    set = vi.fn().mockResolvedValue('OK');
    subscribe = vi.fn().mockResolvedValue(1);
    xrange = vi.fn().mockResolvedValue([]);
    quit = vi.fn().mockResolvedValue('OK');
    duplicate = vi.fn(() => this);
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
    runChannel: (id: string) => `contract:${id}:wake`,
    runCancelKey: (id: string) => `contract:${id}:cancel`,
  };
});

afterEach(closeProducer);

describe('producer shared stream contract', () => {
  it('uses the shared stream key, wake channel, and maxlen for publishing and subscribing', async () => {
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
    expect(publisher?.publish).toHaveBeenCalledWith(runChannel('run-1'), '1');

    const subscription = await subscribeRun('run-1', () => undefined);
    const subscriber = vi.mocked(Redis).mock.instances.at(-1);
    expect(subscriber?.subscribe).toHaveBeenCalledWith(runChannel('run-1'));
    expect(subscriber?.xrange).toHaveBeenCalledWith(runStreamKey('run-1'), '-', '+');
    subscription.close();
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
    expect(shared.runChannel('run-1')).toBe('run:run-1:events:wake');
    expect(shared.runCancelKey('run-1')).toBe('run:run-1:cancel');
    expect(shared.RUN_STREAM_MAXLEN).toBe(1000);
  });
});
