import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { runCancelKey, runChannel, runStreamKey } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { publishRun } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  infraReady,
  inject,
  loginCookie,
  seedRun,
  startApp,
  subscriberCount,
  testConfig,
  unique,
  waitFor,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('sse terminal recovery', () => {
  let app: FastifyInstance;
  let cookie: string;
  let baseUrl: string;
  let redis: Redis;
  const agentSlugs: string[] = [];
  const runIds: string[] = [];
  const activeReaders = new Set<() => Promise<void>>();

  afterEach(async () => {
    await Promise.all([...activeReaders].map((abort) => abort()));
    activeReaders.clear();
  });

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    redis = new Redis(testConfig().REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    for (const runId of runIds) {
      await redis
        .del(runStreamKey(runId), runChannel(runId), runCancelKey(runId))
        .catch(() => undefined);
    }
    await cleanup(app, { agentSlugs, runIds });
    await redis.quit();
    await app.close();
  });

  const seed = async (status: 'running' | 'queued' = 'running'): Promise<string> => {
    const agent = await createAgent(app, cookie, {
      slug: unique('sse-recovery'),
      track: agentSlugs,
    });
    const { runId } = await seedRun(app, agent.json<{ id: string }>().id, {
      runId: unique('sse-recovery-run'),
    });
    runIds.push(runId);
    if (status !== 'running') {
      await app.pool.query('update agent_runs set status = $2 where id = $1', [runId, status]);
    }
    return runId;
  };

  const setTerminal = (runId: string): Promise<unknown> =>
    app.pool.query("update agent_runs set status = 'succeeded', ended_at = now() where id = $1", [
      runId,
    ]);

  const openSse = async (
    runId: string,
  ): Promise<{
    abort: () => Promise<void>;
    readUntilClosed: (timeoutMs: number) => Promise<{ text: string; closed: boolean }>;
  }> => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/chat/${runId}/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
    const initial = await reader.read();
    let buffered = initial.value ? decoder.decode(initial.value, { stream: true }) : '';

    const abort = async (): Promise<void> => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      activeReaders.delete(abort);
    };
    activeReaders.add(abort);
    return {
      abort,
      readUntilClosed: async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        let text = buffered;
        buffered = '';
        if (initial.done) return { text, closed: true };
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0) return { text, closed: false };
          const chunk = await Promise.race([reader.read(), delay(left).then(() => null)]);
          if (chunk === null) return { text, closed: false };
          if (chunk.done) return { text, closed: true };
          text += decoder.decode(chunk.value, { stream: true });
        }
      },
    };
  };

  it('delivers a database terminal when the stream never published one', async () => {
    const runId = await seed();
    const sse = await openSse(runId);
    const started = Date.now();

    // 不走 worker / 模型：只把终态写进数据库，事件流保持静默。
    await setTerminal(runId);
    const { text, closed } = await sse.readUntilClosed(5_000);

    expect(closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(text).toContain('"type":"replay_truncated"');
    expect(text).toContain('"reason":"terminal_missing"');
    expect(text.match(/"type":"run_finished"/g)).toHaveLength(1);
    expect(text.indexOf('replay_truncated')).toBeLessThan(text.indexOf('run_finished'));
  });

  it('finishes immediately when connecting to an already-terminal run with no stream', async () => {
    const runId = await seed();
    await setTerminal(runId);
    const sse = await openSse(runId);
    const { text, closed } = await sse.readUntilClosed(1_000);
    expect(closed).toBe(true);
    expect(text.match(/"type":"run_finished"/g)).toHaveLength(1);
    expect(text).not.toContain('replay_truncated');
  });

  it('keeps a queued run open past the first recheck', async () => {
    const runId = await seed('queued');
    const sse = await openSse(runId);

    const { text, closed } = await sse.readUntilClosed(2_500);
    expect(closed).toBe(false);
    expect(text).not.toContain('data:');
    await sse.abort();
  });

  it('ends an open stream with run_unavailable when the run row is deleted', async () => {
    const runId = await seed();
    const channel = runChannel(runId);
    const sse = await openSse(runId);
    expect(await waitFor(async () => (await subscriberCount(redis, channel)) === 1)).toBe(true);

    // 模拟保留期清理：只删本用例自己的 run 行。
    await app.pool.query('delete from agent_runs where id = $1', [runId]);
    const started = Date.now();
    const { text, closed } = await sse.readUntilClosed(5_000);

    expect(closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(text.match(/"type":"run_unavailable"/g)).toHaveLength(1);
    expect(text).toContain('运行记录已不存在，已停止接收。');
    expect(text).not.toContain('run_finished');
    expect(await waitFor(async () => (await subscriberCount(redis, channel)) === 0)).toBe(true);
  });

  it('returns a JSON 404 before opening SSE for an unknown run', async () => {
    const res = await fetch(`${baseUrl}/api/chat/${unique('sse-recovery-missing')}/events`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('does not add a recovery marker when the terminal event was published', async () => {
    const runId = await seed();
    const sse = await openSse(runId);

    await publishRun(runId, { type: 'run_finished', status: 'cancelled' });
    await setTerminal(runId);
    const { text, closed } = await sse.readUntilClosed(5_000);

    expect(closed).toBe(true);
    expect(text.match(/"type":"run_finished"/g)).toHaveLength(1);
    expect(text).not.toContain('replay_truncated');
  });

  it('stops the recheck when the client aborts', async () => {
    const runId = await seed();
    const channel = runChannel(runId);
    const sse = await openSse(runId);
    expect(await waitFor(async () => (await subscriberCount(redis, channel)) === 1)).toBe(true);

    await sse.abort();
    expect(await waitFor(async () => (await subscriberCount(redis, channel)) === 0)).toBe(true);
    await delay(2_200);
    expect(await subscriberCount(redis, channel)).toBe(0);

    const health = await inject(app, { method: 'GET', url: '/health/live' });
    expect(health.statusCode).toBe(200);
  });
});
