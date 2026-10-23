import { setTimeout as delay } from 'node:timers/promises';
import { RUN_STREAM_MAXLEN, runChannel, runStreamKey } from '@agentport/shared';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { closeProducer, publishRun, subscribeRun } from '../src/queue/producer.js';
import { infraReady, subscriberCount, testConfig, unique, waitFor } from './helpers.js';

const ready = await infraReady;

/** 直接走 producer，不经过 HTTP：一个 run 的推送不能因为其他观众关闭而中断。 */
describe.skipIf(!ready)('run subscribers', () => {
  afterAll(async () => {
    await closeProducer();
  });

  it('keeps pushing to the remaining subscriber after the other closes', async () => {
    const runId = unique('sse-run');
    const types: string[] = [];
    const first = await subscribeRun(runId, () => undefined);
    const second = await subscribeRun(runId, (event) => types.push(event.type));

    first.close();
    await delay(100);
    await publishRun(runId, { type: 'text_delta', text: 'still here' });

    expect(await waitFor(() => types.length > 0)).toBe(true);
    expect(types).toEqual(['text_delta']);

    second.close();
  });

  it('delivers each event once when publishes race the drain', async () => {
    const runId = unique('sse-run');
    const texts: string[] = [];
    const sub = await subscribeRun(runId, (event) => {
      if (event.type === 'text_delta') texts.push(event.text);
    });

    // 每次 publish 都会唤醒一次 drain；并发 XRANGE 返回同一批事件时不能重复回调。
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        publishRun(runId, { type: 'text_delta', text: `t${i}` }),
      ),
    );
    await delay(500);

    expect(texts).toHaveLength(50);
    expect(new Set(texts).size).toBe(50);
    sub.close();
  });

  it('announces retention before replaying a trimmed stream', async () => {
    const runId = unique('sse-run');
    const redis = new Redis(testConfig().REDIS_URL);
    let sub: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      const pipeline = redis.pipeline();
      for (let i = 0; i < RUN_STREAM_MAXLEN + 500; i += 1) {
        pipeline.xadd(
          runStreamKey(runId),
          'MAXLEN',
          '~',
          RUN_STREAM_MAXLEN,
          '*',
          'payload',
          JSON.stringify({ type: 'text_delta', text: `e${i}` }),
        );
      }
      await pipeline.exec();
      const info = (await redis.xinfo('STREAM', runStreamKey(runId))) as unknown[];
      const entriesAdded = Number(info[info.indexOf('entries-added') + 1]);
      const length = Number(info[info.indexOf('length') + 1]);
      expect(entriesAdded).toBeGreaterThan(length);

      const reasons: string[] = [];
      const types: string[] = [];
      const texts: string[] = [];
      sub = await subscribeRun(runId, (event) => {
        types.push(event.type);
        if (event.type === 'replay_truncated') reasons.push(event.reason);
        if (event.type === 'text_delta') texts.push(event.text);
      });

      expect(types[0]).toBe('replay_truncated');
      expect(reasons).toEqual(['retention']);
      expect(types.filter((type) => type === 'replay_truncated')).toHaveLength(1);
      expect(texts.at(-1)).toBe(`e${RUN_STREAM_MAXLEN + 499}`);
    } finally {
      sub?.close();
      await redis.del(runStreamKey(runId), runChannel(runId)).catch(() => undefined);
      await redis.quit();
    }
  });

  it('announces byte truncation without a text marker', async () => {
    const runId = unique('sse-run');
    const redis = new Redis(testConfig().REDIS_URL);
    let sub: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      // 三条 3MiB：从新往旧只能装下两条，第三条越过 8MiB 回放上限。
      const big = 'x'.repeat(3 * 1024 * 1024);
      for (let i = 0; i < 3; i += 1) {
        await redis.xadd(
          runStreamKey(runId),
          '*',
          'payload',
          JSON.stringify({ type: 'text_delta', text: big }),
        );
      }

      const types: string[] = [];
      const reasons: string[] = [];
      sub = await subscribeRun(runId, (event) => {
        types.push(event.type);
        if (event.type === 'replay_truncated') reasons.push(event.reason);
      });

      expect(reasons).toEqual(['bytes']);
      expect(types).toEqual(['replay_truncated', 'text_delta', 'text_delta']);
      expect(types.filter((type) => type === 'text_delta')).toHaveLength(2);
    } finally {
      sub?.close();
      await redis.del(runStreamKey(runId), runChannel(runId)).catch(() => undefined);
      await redis.quit();
    }
  });

  it('does not unsubscribe a live subscriber when a stale one closes', async () => {
    const runId = unique('sse-run');
    const channel = runChannel(runId);
    const types: string[] = [];
    const probe = new Redis(testConfig().REDIS_URL);

    try {
      const stale = await subscribeRun(runId, () => undefined);
      // 模拟进程内重建 producer（热重载 / 测试多次 buildApp）后旧订阅仍存活。
      await closeProducer();
      const live = await subscribeRun(runId, (event) => types.push(event.type));

      stale.close();
      await delay(100);
      expect(await subscriberCount(probe, channel)).toBe(1);

      await publishRun(runId, { type: 'text_delta', text: 'still here' });
      expect(await waitFor(() => types.length > 0)).toBe(true);

      live.close();
      expect(await waitFor(async () => (await subscriberCount(probe, channel)) === 0)).toBe(true);
    } finally {
      await probe.quit();
    }
  });
});
