import { setTimeout as delay } from 'node:timers/promises';
import { runChannel } from '@agentport/shared';
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
