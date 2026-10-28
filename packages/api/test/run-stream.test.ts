import { setTimeout as delay } from 'node:timers/promises';
import { RUN_STREAM_MAXLEN, runCancelKey, runStreamKey } from '@agentport/shared';
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
  const watchCounts = (command: 'xrevrange' | 'xread', runId: string) => {
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

  it('replays 40 events in order with a bounded number of XREVRANGE pages', async () => {
    const runId = newRun();
    const total = 40;
    for (let i = 0; i < total; i += 1) {
      await publishRun(runId, { type: 'text_delta', text: `e${i}` });
    }

    const watched = watchCounts('xrevrange', runId);
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

  it('caps escaped tool_result replay at 8MiB with two-entry pages', async () => {
    const runId = newRun();
    // runner 默认单字段上限 1MiB。控制字符在 JSON 里转义成 \u00XX（6 字节），
    // 与普通字符各半，1MiB 字段序列化后约 3.5MiB，正好落在 worker 的 8MiB 行预算内。
    const content = '\u0001a'.repeat((1024 * 1024) / 2);
    const payloads = Array.from({ length: 9 }, (_, i) =>
      JSON.stringify({ type: 'tool_result', toolUseId: `tool-${i}`, content }),
    );
    const payloadBytes = Buffer.byteLength(payloads[0] ?? '');
    const totalBytes = payloadBytes * payloads.length;
    // 合法输入：每条字段 1MiB，9 条序列化合计不足 worker 的 32MiB 落库额度，都会写入流。
    expect(Buffer.byteLength(content)).toBe(1024 * 1024);
    expect(totalBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(totalBytes).toBeLessThan(32 * 1024 * 1024);

    const seed = redis.pipeline();
    for (const payload of payloads) seed.xadd(runStreamKey(runId), '*', 'payload', payload);
    await seed.exec();

    const watched = watchCounts('xrevrange', runId);
    const types: string[] = [];
    let deliveredBytes = 0;
    let subscription: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      subscription = await subscribeRun(runId, (event) => {
        types.push(event.type);
        deliveredBytes += Buffer.byteLength(JSON.stringify(event));
      });
      // 每页 2 条 × 约 3.5MiB：两页共 4 条约 14MiB，累计到第 3 条已越过 8MiB 回放上限。
      expect(types).toEqual(['replay_truncated', 'tool_result', 'tool_result']);
      expect(deliveredBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(await waitFor(() => watched.counts.length >= 2)).toBe(true);
      await delay(200);
      // 旧实现单页 COUNT 16 一次拉完 9 条约 33MB；现在每页只取 2 条。
      expect(watched.counts).toEqual([2, 2]);
      expect(watched.counts.length * (watched.counts[0] ?? 0) * payloadBytes).toBeLessThan(
        24 * 1024 * 1024,
      );
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
