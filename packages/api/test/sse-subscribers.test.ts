import { setTimeout as delay } from 'node:timers/promises';
import { runStreamKey } from '@agentport/shared';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { closeProducer, publishRun, subscribeRun } from '../src/queue/producer.js';
import { eventFollowerCount, infraReady, testConfig, unique, waitFor } from './helpers.js';

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

  it('delivers each event once during live follow', async () => {
    const runId = unique('sse-run');
    const texts: string[] = [];
    const sub = await subscribeRun(runId, (event) => {
      if (event.type === 'text_delta') texts.push(event.text);
    });

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        publishRun(runId, { type: 'text_delta', text: `t${i}` }),
      ),
    );
    await waitFor(() => texts.length === 50);
    await delay(200);

    expect(texts).toHaveLength(50);
    expect(new Set(texts).size).toBe(50);
    sub.close();
  });

  it('replays a long stream from its first event without trimming', async () => {
    const runId = unique('sse-run');
    const redis = new Redis(testConfig().REDIS_URL);
    const total = 1_600;
    let sub: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      const pipeline = redis.pipeline();
      for (let i = 0; i < total; i += 1) {
        pipeline.xadd(
          runStreamKey(runId),
          '*',
          'payload',
          JSON.stringify({ type: 'text_delta', text: `e${i}` }),
        );
      }
      await pipeline.exec();
      expect(await redis.xlen(runStreamKey(runId))).toBe(total);

      const types: string[] = [];
      const texts: string[] = [];
      sub = await subscribeRun(runId, (event) => {
        types.push(event.type);
        if (event.type === 'text_delta') texts.push(event.text);
      });

      expect(types.filter((type) => type === 'replay_truncated')).toHaveLength(0);
      expect(texts[0]).toBe('e0');
      expect(texts.at(-1)).toBe(`e${total - 1}`);
      expect(texts).toHaveLength(total);
    } finally {
      sub?.close();
      await redis.del(runStreamKey(runId)).catch(() => undefined);
      await redis.quit();
    }
  });

  it('replays events beyond the old 8MiB cap instead of dropping the older ones', async () => {
    const runId = unique('sse-run');
    const redis = new Redis(testConfig().REDIS_URL);
    let sub: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      // 三条 3MiB，合计 9MiB：旧实现从新往旧只能装下两条并补 bytes 标记。
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
      sub = await subscribeRun(runId, (event) => {
        types.push(event.type);
      });

      expect(types).toEqual(['text_delta', 'text_delta', 'text_delta']);
    } finally {
      sub?.close();
      await redis.del(runStreamKey(runId)).catch(() => undefined);
      await redis.quit();
    }
  });

  it('does not disconnect a live subscriber when a stale one closes', async () => {
    const runId = unique('sse-run');
    const types: string[] = [];
    const probe = new Redis(testConfig().REDIS_URL);

    try {
      const stale = await subscribeRun(runId, () => undefined);
      // 模拟进程内重建 producer（热重载 / 测试多次 buildApp）后旧订阅仍存活。
      await closeProducer();
      const live = await subscribeRun(runId, (event) => types.push(event.type));

      stale.close();
      await delay(100);
      await publishRun(runId, { type: 'text_delta', text: 'still here' });
      expect(await waitFor(() => types.length > 0)).toBe(true);

      live.close();
      expect(await waitFor(async () => (await eventFollowerCount(probe, runId)) === 0)).toBe(true);
    } finally {
      await probe.quit();
    }
  });

  it('follows events added while the blocking read is between calls', async () => {
    const runId = unique('sse-run');
    const probe = new Redis(testConfig().REDIS_URL);
    const types: string[] = [];
    const sub = await subscribeRun(runId, (event) => types.push(event.type));
    try {
      expect(await waitFor(async () => (await eventFollowerCount(probe, runId)) === 1)).toBe(true);

      // 先写再等：BLOCK 从最后真实 ID 继续，不会因为订阅已建立就漏掉。
      await publishRun(runId, { type: 'text_delta', text: 'a' });
      await publishRun(runId, { type: 'text_delta', text: 'b' });
      expect(await waitFor(() => types.length === 2)).toBe(true);
    } finally {
      sub.close();
      await probe.quit();
    }
  });

  it('resumes from the last seen id after the follower connection drops', async () => {
    const runId = unique('sse-run');
    const probe = new Redis(testConfig().REDIS_URL);
    const texts: string[] = [];
    const sub = await subscribeRun(runId, (event) => {
      if (event.type === 'text_delta') texts.push(event.text);
    });
    try {
      await publishRun(runId, { type: 'text_delta', text: 'before' });
      expect(await waitFor(() => texts.includes('before'))).toBe(true);

      // 模拟网络闪断：服务端断开阻塞中的跟随连接，客户端会带着同一个 lastId 重订阅。
      expect(await waitFor(async () => (await eventFollowerCount(probe, runId)) === 1)).toBe(true);
      const list = await probe.client('LIST');
      const line = list.split('\n').find((entry) => entry.includes(`name=run-events:${runId}`));
      const clientId = line?.match(/\bid=(\d+)/)?.[1];
      expect(clientId).toBeDefined();
      await probe.client('KILL', 'ID', clientId as string);

      await publishRun(runId, { type: 'text_delta', text: 'after' });
      expect(await waitFor(() => texts.includes('after'))).toBe(true);
      // 不重放已确认的事件，也不丢断线期间写入的事件。
      expect(texts).toEqual(['before', 'after']);
    } finally {
      sub.close();
      await probe.quit();
    }
  });

  it('applies callback backpressure instead of buffering pending events', async () => {
    const runId = unique('sse-run');
    const seen: string[] = [];
    let active = 0;
    let overlap = false;
    const sub = await subscribeRun(runId, async (event) => {
      active += 1;
      if (active > 1) overlap = true;
      await delay(20);
      if (event.type === 'text_delta') seen.push(event.text);
      active -= 1;
    });
    try {
      await publishRun(runId, { type: 'text_delta', text: 'a' });
      await publishRun(runId, { type: 'text_delta', text: 'b' });
      expect(await waitFor(() => seen.length === 2)).toBe(true);
      expect(seen).toEqual(['a', 'b']);
      expect(overlap).toBe(false);
    } finally {
      sub.close();
    }
  });

  it('closeProducer interrupts a blocked follower promptly', async () => {
    const runId = unique('sse-run');
    const probe = new Redis(testConfig().REDIS_URL);
    await subscribeRun(runId, () => undefined);
    await waitFor(async () => (await eventFollowerCount(probe, runId)) === 1);
    const started = Date.now();
    await closeProducer();
    expect(Date.now() - started).toBeLessThan(2_000);
    await probe.quit();
  });
});
