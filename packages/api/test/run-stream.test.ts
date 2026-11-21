import { afterAll, describe, expect, it } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runCancelKey, runStreamKey } from '@agentport/shared';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';
import {
  closeRunnerClient,
  configureRunnerClient,
  publishRun as publishFromWorker,
} from '../../worker/src/runner-client.js';
import {
  closeProducer,
  configureQueueProducer,
  publishRun,
  requestRunCancel,
  subscribeRun,
} from '../src/queue/producer.js';
import { infraReady, testConfig, unique, waitFor } from './helpers.js';

const ready = await infraReady;
configureQueueProducer(testConfig().REDIS_URL);
const logger = { warn: () => undefined, error: () => undefined } as unknown as Logger;

describe.skipIf(!ready)('run stream contract', () => {
  const redis = new RedisClient(testConfig().REDIS_URL);
  const runIds: string[] = [];

  afterAll(async () => {
    await Promise.all(runIds.map((runId) => redis.del(runStreamKey(runId), runCancelKey(runId))));
    redis.close();
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

  it('cancel sets only the cancel key and never writes the event stream', async () => {
    const runId = newRun();
    expect(await requestRunCancel(runId)).toBe(true);
    expect(await redis.exists(runCancelKey(runId))).toBe(true);
    expect(await eventCount(runId)).toBe(0);
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

  it('replays all 9 escaped tool results beyond 8MiB', async () => {
    const runId = newRun();
    const content = '\u0001a'.repeat((1024 * 1024) / 2);
    const payloads = Array.from({ length: 9 }, (_, i) =>
      JSON.stringify({ type: 'tool_result', toolUseId: `tool-${i}`, content }),
    );
    const payloadBytes = Buffer.byteLength(payloads[0] ?? '');
    const totalBytes = payloadBytes * payloads.length;
    expect(Buffer.byteLength(content)).toBe(1024 * 1024);
    expect(totalBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(totalBytes).toBeLessThan(32 * 1024 * 1024);

    await Promise.all(
      payloads.map((payload) => redis.xadd(runStreamKey(runId), '*', 'payload', payload)),
    );

    const types: string[] = [];
    let deliveredBytes = 0;
    let subscription: Awaited<ReturnType<typeof subscribeRun>> | undefined;
    try {
      subscription = await subscribeRun(runId, (event) => {
        types.push(event.type);
        deliveredBytes += Buffer.byteLength(JSON.stringify(event));
      });
      expect(types.filter((type) => type === 'replay_truncated')).toHaveLength(0);
      expect(types).toEqual(Array.from({ length: payloads.length }, () => 'tool_result'));
      expect(deliveredBytes).toBeGreaterThan(8 * 1024 * 1024);
    } finally {
      subscription?.close();
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
    } finally {
      subscription?.close();
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
