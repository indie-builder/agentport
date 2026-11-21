import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  RUN_PERSISTED_MAX_BYTES,
  RUN_PERSISTED_MAX_EVENTS,
  RUN_TRANSIENT_MAX_BYTES,
  RUN_TRANSIENT_MAX_EVENTS,
  runCancelKey,
  runStreamKey,
} from '@agentport/shared';
import { RedisClient } from 'bun';
import { closeProducer, configureQueueProducer, publishRun } from '../src/queue/producer.js';
import { infraReady, testConfig, unique } from './helpers.js';

const ready = await infraReady;
configureQueueProducer(testConfig().REDIS_URL);

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

  const runKey = (): string => {
    const runId = unique('contract-run');
    keys.push(runStreamKey(runId), runCancelKey(runId));
    return runId;
  };

  it('rejects when the XADD command fails', async () => {
    const runId = runKey();
    const spy = spyOn(RedisClient.prototype, 'send').mockRejectedValueOnce(
      new Error('xadd failed'),
    );
    try {
      await expect(publishRun(runId, { type: 'text_delta', text: 'hello' })).rejects.toThrow(
        'xadd failed',
      );
    } finally {
      spy.mockRestore();
    }
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
