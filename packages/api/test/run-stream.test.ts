import { RUN_STREAM_MAXLEN, runCancelKey, runStreamKey } from '@agentport/shared';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeRunnerClient,
  configureRunnerClient,
  publishRun as publishFromWorker,
} from '../../worker/src/runner-client.js';
import { closeProducer, publishRun, subscribeRun } from '../src/queue/producer.js';
import { infraReady, testConfig, unique, waitFor } from './helpers.js';

const ready = await infraReady;
const logger = { warn: () => undefined, error: () => undefined } as unknown as Logger;

/**
 * 生产者与订阅者必须用同一套键：API 发、worker 写、前端订阅，任何一方漂移都会静默丢事件。
 * 让 API 与 worker 各写一条，再用 shared 的键读回。
 */
describe.skipIf(!ready)('run stream contract', () => {
  const redis = new Redis(testConfig().REDIS_URL);
  const runIds: string[] = [];

  afterAll(async () => {
    await Promise.all(runIds.map((runId) => redis.del(runStreamKey(runId), runCancelKey(runId))));
    await redis.quit();
    await closeProducer();
    await closeRunnerClient();
  });

  const newRun = (): string => {
    const runId = unique('contract-run');
    runIds.push(runId);
    return runId;
  };

  const eventCount = async (runId: string): Promise<number> => redis.xlen(runStreamKey(runId));

  it('API and worker publish to the same stream key', async () => {
    configureRunnerClient(testConfig().REDIS_URL);
    const runId = newRun();
    await publishRun(runId, { type: 'text_delta', text: 'from api' });
    await publishFromWorker(runId, { type: 'text_delta', text: 'from worker' }, logger);

    const entries = (await redis.xrange(runStreamKey(runId), '-', '+')) as Array<
      [string, string[]]
    >;
    const texts = entries.map(([, fields]) => {
      const payload = fields[fields.indexOf('payload') + 1] ?? '{}';
      return (JSON.parse(payload) as { text?: string }).text;
    });
    expect(texts).toEqual(['from api', 'from worker']);
  });

  it('publishes nothing on pub/sub; the stream read alone wakes subscribers', async () => {
    const runId = newRun();
    const types: string[] = [];
    const subscription = await subscribeRun(runId, (event) => types.push(event.type));
    try {
      await publishRun(runId, { type: 'text_delta', text: 'wake me' });
      expect(await waitFor(() => types.length === 1)).toBe(true);
      expect(await eventCount(runId)).toBe(1);
    } finally {
      subscription.close();
    }
  });

  it('cancel writes only the cancel key', async () => {
    const runId = newRun();
    await publishRun(runId, { type: 'cancel' });
    expect(await redis.exists(runCancelKey(runId))).toBe(1);
    expect(await eventCount(runId)).toBe(0);
  });

  it.each([
    ['API producer', (runId: string) => publishRun(runId, { type: 'text_delta', text: 't' })],
    [
      'worker publisher',
      (runId: string) => {
        configureRunnerClient(testConfig().REDIS_URL);
        return publishFromWorker(runId, { type: 'text_delta', text: 't' }, logger);
      },
    ],
  ])('%s trims the stream to RUN_STREAM_MAXLEN', async (_label, publish) => {
    const runId = newRun();
    for (let i = 0; i < RUN_STREAM_MAXLEN * 2; i += 1) await publish(runId);
    // MAXLEN ~ 只按整节点回收，允许超出节点粒度（默认 128）。
    expect(await eventCount(runId)).toBeLessThan(RUN_STREAM_MAXLEN + 128);
  });
});
