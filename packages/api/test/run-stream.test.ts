import { setTimeout as delay } from 'node:timers/promises';
import { runCancelKey, runStreamKey } from '@agentport/shared';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  closeRunnerClient,
  configureRunnerClient,
  publishRun as publishFromWorker,
} from '../../worker/src/runner-client.js';
import {
  closeProducer,
  publishRun,
  requestRunCancel,
  subscribeRun,
} from '../src/queue/producer.js';
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

  /**
   * 只统计客户端实际发出的读命令：spy 默认 call-through，真实读写仍走 Redis。
   * 按本次 run 的唯一键过滤，取每条命令的 COUNT；这是客户端调用计数，不是服务端 MONITOR。
   */
  const watchCounts = (command: 'xrange' | 'xread', runId: string) => {
    const key = runStreamKey(runId);
    const spy = vi.spyOn(Redis.prototype, command);
    return {
      get counts(): number[] {
        return spy.mock.calls
          .filter((args) => {
            const streams = args.indexOf('STREAMS');
            return (streams >= 0 ? args[streams + 1] : args[0]) === key;
          })
          .map((args) => {
            const index = args.indexOf('COUNT');
            return index >= 0 ? Number(args[index + 1]) : -1;
          });
      },
      stop: () => spy.mockRestore(),
    };
  };

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

  it('cancel sets only the cancel key and never writes the event stream', async () => {
    const runId = newRun();
    expect(await requestRunCancel(runId)).toBe(true);
    expect(await redis.exists(runCancelKey(runId))).toBe(1);
    expect(await eventCount(runId)).toBe(0);
    // 键已存在：重复取消不再发通知。
    expect(await requestRunCancel(runId)).toBe(false);
  });

  it.each([
    [
      'API producer',
      (runId: string, text: string) => publishRun(runId, { type: 'text_delta', text }),
    ],
    [
      'worker publisher',
      (runId: string, text: string) => {
        configureRunnerClient(testConfig().REDIS_URL);
        return publishFromWorker(runId, { type: 'text_delta', text }, logger);
      },
    ],
  ])('%s keeps all 1600 events and replays them in order', async (_label, publish) => {
    const runId = newRun();
    const total = 1_600;
    for (let i = 0; i < total; i += 1) await publish(runId, `e${i}`);
    // 旧实现按 MAXLEN ~ 1000 裁掉流头；新契约必须完整保留到预算上限。
    expect(await eventCount(runId)).toBe(total);

    const types: string[] = [];
    const texts: string[] = [];
    const subscription = await subscribeRun(runId, (event) => {
      types.push(event.type);
      if (event.type === 'text_delta') texts.push(event.text);
    });
    try {
      expect(types.filter((type) => type === 'replay_truncated')).toHaveLength(0);
      expect(texts).toEqual(Array.from({ length: total }, (_, i) => `e${i}`));
    } finally {
      subscription.close();
    }
  });

  it('replays 40 events in order with two-entry XRANGE pages', async () => {
    const runId = newRun();
    const total = 40;
    for (let i = 0; i < total; i += 1) {
      await publishRun(runId, { type: 'text_delta', text: `e${i}` });
    }

    const watched = watchCounts('xrange', runId);
    const texts: string[] = [];
    let subscription: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      subscription = await subscribeRun(runId, (event) => {
        if (event.type === 'text_delta') texts.push(event.text);
      });
      expect(texts).toEqual(Array.from({ length: total }, (_, i) => `e${i}`));
      expect(await waitFor(() => watched.counts.length >= 21)).toBe(true);
      await delay(200);
      // 40 条按 2 条一页：20 次读满 + 1 次空页确认到头（整除才有这一次）；逐条读是 41 次。
      expect(watched.counts).toEqual(Array.from({ length: 21 }, () => 2));
    } finally {
      subscription?.close();
      watched.stop();
    }
  });

  it('follows live events with bounded multi-event XREAD batches', async () => {
    const runId = newRun();
    const watched = watchCounts('xread', runId);
    const types: string[] = [];
    let subscription: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      subscription = await subscribeRun(runId, (event) => types.push(event.type));
      await publishRun(runId, { type: 'text_delta', text: 'live' });
      expect(await waitFor(() => types.length === 1)).toBe(true);
      expect(await waitFor(() => watched.counts.length > 0)).toBe(true);
      expect(watched.counts.every((count) => count === 2)).toBe(true);
    } finally {
      subscription?.close();
      watched.stop();
    }
  });

  it('replays all 9 escaped tool results beyond 8MiB, each page COUNT 2', async () => {
    const runId = newRun();
    // runner 默认单字段上限 1MiB。控制字符在 JSON 里转义成 \u00XX（6 字节），
    // 与普通字符各半，1MiB 字段序列化后约 3.5MiB，正好落在 worker 的 32MiB 落库额度内。
    const content = '\u0001a'.repeat((1024 * 1024) / 2);
    const payloads = Array.from({ length: 9 }, (_, i) =>
      JSON.stringify({ type: 'tool_result', toolUseId: `tool-${i}`, content }),
    );
    const payloadBytes = Buffer.byteLength(payloads[0] ?? '');
    const totalBytes = payloadBytes * payloads.length;
    // 合法输入：每条字段 1MiB，9 条序列化合计约 31.5MiB，都会写入流。
    expect(Buffer.byteLength(content)).toBe(1024 * 1024);
    expect(totalBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(totalBytes).toBeLessThan(32 * 1024 * 1024);

    const seed = redis.pipeline();
    for (const payload of payloads) seed.xadd(runStreamKey(runId), '*', 'payload', payload);
    await seed.exec();

    const watched = watchCounts('xrange', runId);
    const types: string[] = [];
    let deliveredBytes = 0;
    let subscription: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      subscription = await subscribeRun(runId, (event) => {
        types.push(event.type);
        deliveredBytes += Buffer.byteLength(JSON.stringify(event));
      });
      // 旧实现只回放最近 8MiB（约 2 条）并补 bytes 截断标记；新契约必须整条流回放。
      expect(types.filter((type) => type === 'replay_truncated')).toHaveLength(0);
      expect(types).toEqual(Array.from({ length: payloads.length }, () => 'tool_result'));
      expect(deliveredBytes).toBeGreaterThan(8 * 1024 * 1024);
      // 9 条按 2 条一页：4 页读满 + 1 页只剩 1 条，COUNT 始终为 2。
      expect(watched.counts).toEqual([2, 2, 2, 2, 2]);
    } finally {
      subscription?.close();
      watched.stop();
    }
  });

  it('delivers every event exactly once when events arrive during a gated callback', async () => {
    const runId = newRun();
    const seen: string[] = [];
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let enteredGate = false;
    let subscription: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      const subscribing = subscribeRun(runId, async (event) => {
        if (event.type !== 'text_delta') return;
        if (event.text === 'e0' && !enteredGate) {
          enteredGate = true;
          await gate;
        }
        seen.push(event.text);
      });

      await publishRun(runId, { type: 'text_delta', text: 'e0' });
      await publishRun(runId, { type: 'text_delta', text: 'e1' });
      expect(await waitFor(() => enteredGate)).toBe(true);

      // 回调被卡住期间继续写入：回放续页与跟读都必须只投递一次。
      await publishRun(runId, { type: 'text_delta', text: 'e2' });
      await publishRun(runId, { type: 'text_delta', text: 'e3' });
      releaseGate();

      subscription = await subscribing;
      expect(await waitFor(() => seen.length === 4)).toBe(true);
      await delay(100);
      expect(seen).toEqual(['e0', 'e1', 'e2', 'e3']);
    } finally {
      releaseGate();
      subscription?.close();
    }
  });

  it('stops replaying further pages when the signal aborts mid-page', async () => {
    const runId = newRun();
    for (let i = 0; i < 5; i += 1) {
      await publishRun(runId, { type: 'text_delta', text: `e${i}` });
    }

    const watched = watchCounts('xrange', runId);
    const controller = new AbortController();
    const seen: string[] = [];
    let subscription: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      subscription = await subscribeRun(
        runId,
        (event) => {
          if (event.type !== 'text_delta') return;
          seen.push(event.text);
          controller.abort();
        },
        controller.signal,
      );
      expect(seen).toEqual(['e0']);
      // 第一页取到 2 条；回调 abort 后不再请求下一页，也不启动跟读。
      expect(watched.counts).toEqual([2]);
    } finally {
      subscription?.close();
      watched.stop();
    }
  });

  it('surfaces per-command pipeline errors and still applies the paired command', async () => {
    const runId = newRun();
    // 同键先放 string：pipeline 内 XADD 返回 WRONGTYPE，EXPIRE 仍会执行。
    await redis.set(runStreamKey(runId), 'not-a-stream', 'EX', 60);
    await expect(publishRun(runId, { type: 'text_delta', text: 'x' })).rejects.toThrow(/WRONGTYPE/);
    expect(await redis.ttl(runStreamKey(runId))).toBeGreaterThan(3_000);
  });
});
