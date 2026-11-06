import {
  RUN_PERSISTED_MAX_BYTES,
  RUN_PERSISTED_MAX_EVENTS,
  RUN_TRANSIENT_MAX_BYTES,
  RUN_TRANSIENT_MAX_EVENTS,
  runCancelKey,
  runEventsConnectionName,
  runStreamKey,
} from '@agentport/shared';
import { RedisClient } from 'bun';
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { closeProducer, publishRun, requestRunCancel, subscribeRun } from '../src/queue/producer.js';
import { infraReady, testConfig, unique, waitFor } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('producer shared stream contract', () => {
  const redis = new RedisClient(testConfig().REDIS_URL);
  const keys: string[] = [];

  afterEach(async () => {
    if (keys.length > 0) await redis.del(...keys.splice(0));
    await closeProducer();
  });

  afterAll(() => {
    redis.close();
  });

  const runKey = (): { runId: string; key: string } => {
    const runId = unique('contract-run');
    const key = runStreamKey(runId);
    keys.push(key, runCancelKey(runId));
    return { runId, key };
  };

  it('publishes events with XADD and expiry instead of two separated round trips', async () => {
    const { runId, key } = runKey();
    const spy = spyOn(RedisClient.prototype, 'send');
    await publishRun(runId, { type: 'text_delta', text: 'hello' });
    const calls = [...spy.mock.calls];
    spy.mockRestore();

    const xadd = calls.filter(([command]) => command === 'XADD');
    expect(xadd).toEqual([
      ['XADD', [key, '*', 'payload', JSON.stringify({ type: 'text_delta', text: 'hello' })]],
    ]);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });

  it('rejects when the XADD command fails', async () => {
    const { runId } = runKey();
    const spy = spyOn(RedisClient.prototype, 'send').mockRejectedValueOnce(new Error('xadd failed'));
    try {
      await expect(publishRun(runId, { type: 'text_delta', text: 'hello' })).rejects.toThrow(
        'xadd failed',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('follows the stream with a blocking XREAD from the last real id', async () => {
    const { runId, key } = runKey();
    await publishRun(runId, { type: 'text_delta', text: 'hello' });
    const [[id]] = await redis.xrange(key, '-', '+');
    if (id === undefined) throw new Error('event was not published');

    const spy = spyOn(RedisClient.prototype, 'send');
    const seen: string[] = [];
    const subscription = await subscribeRun(runId, (event) => seen.push(event.type));
    await waitFor(() => seen.length === 1);
    await waitFor(() =>
      spy.mock.calls.some(
        ([command, args]) => command === 'XREAD' && args.includes(key) && args.includes(id),
      ),
    );
    const calls = [...spy.mock.calls];
    spy.mockRestore();

    const xrange = calls.find(([command]) => command === 'XRANGE');
    expect(xrange?.[1]).toEqual([key, '0-0', '+', 'COUNT', '2']);
    const xread = calls.find(([command]) => command === 'XREAD');
    expect(xread?.[1]).toEqual(['COUNT', '2', 'BLOCK', '0', 'STREAMS', key, id]);
    expect(calls.some(([command]) => command === 'SUBSCRIBE')).toBe(false);
    expect(
      calls.some(
        ([command, args]) =>
          command === 'CLIENT' && args[1] === runEventsConnectionName(runId),
      ),
    ).toBe(true);

    const closeSpy = spyOn(RedisClient.prototype, 'close');
    subscription.close();
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it('batches the cancel flag and notification under the shared cancel key', async () => {
    const { runId, key } = runKey();
    const sendSpy = spyOn(RedisClient.prototype, 'send');
    const publishSpy = spyOn(RedisClient.prototype, 'publish');
    try {
      expect(await requestRunCancel(runId)).toBe(true);
      expect(sendSpy.mock.calls).toContainEqual([
        'SET',
        [runCancelKey(runId), '1', 'EX', '3600', 'NX'],
      ]);
      expect(publishSpy).toHaveBeenCalledWith(runCancelKey(runId), '1');
      expect(sendSpy.mock.calls.some(([command]) => command === 'XADD')).toBe(false);
    } finally {
      sendSpy.mockRestore();
      publishSpy.mockRestore();
    }
    expect(runCancelKey(runId)).toBe(`run:${runId}:cancel`);
    expect(key).toBe(`run:${runId}:events`);
  });

  it('keeps the Redis wire format and exports the worker budgets', () => {
    expect(runStreamKey('run-1')).toBe('run:run-1:events');
    expect(runCancelKey('run-1')).toBe('run:run-1:cancel');
    expect(RUN_TRANSIENT_MAX_EVENTS).toBe(2_000);
    expect(RUN_TRANSIENT_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(RUN_PERSISTED_MAX_EVENTS).toBe(2_000);
    expect(RUN_PERSISTED_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});
