import { repo } from '@agentport/db';
import { RUN_CANCEL_PAYLOAD, runCancelKey, runStreamKey } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvoker } from '../src/features/servers/agent-invoker.js';
import { getQueue } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  infraReady,
  loginCookie,
  queueIdle,
  startApp,
  testConfig,
  unique,
  waitFor,
} from './helpers.js';

// 队列里有真实消费者时 job 会被 worker 抢走，取消语义就测不到了。
const ready = (await infraReady) && (await queueIdle);

/** 所有挂起都有界；vitest 的 20s 兜底不算可读的失败原因。 */
async function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!ready)('platform agent tools: abort signals reach the worker', () => {
  let app: FastifyInstance;
  let cookie: string;
  let redis: Redis;
  const createdAgents: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    redis = new Redis(testConfig().REDIS_URL);
  });

  afterAll(async () => {
    // 先清队列里本次留下的 job，再删库行；Redis 键只碰本文件创建的 run。
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
      await redis.del(runCancelKey(runId), runStreamKey(runId)).catch(() => undefined);
    }
    await cleanup(app, { agentSlugs: createdAgents, runIds });
    await redis.quit().catch(() => undefined);
    await app.close();
  });

  const ownRun = async (agentId: string): Promise<string | undefined> => {
    const rows = await app.pool.query<{ id: string }>(
      'select id from agent_runs where agent_id = $1 order by created_at desc limit 1',
      [agentId],
    );
    return rows.rows[0]?.id;
  };

  const statusOf = async (runId: string): Promise<string | undefined> => {
    const rows = await app.pool.query<{ status: string }>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    return rows.rows[0]?.status;
  };

  /** 等到本次 agent 的 run 建好并真实入队；返回 runId。 */
  const awaitQueuedJob = async (agentId: string): Promise<string> => {
    const found = await waitFor(async () => {
      const id = await ownRun(agentId);
      if (id === undefined) return false;
      if (!runIds.includes(id)) runIds.push(id);
      return (await getQueue().getJob(id)) !== undefined;
    });
    expect(found).toBe(true);
    const runId = runIds.at(-1);
    if (runId === undefined) throw new Error('run was never enqueued');
    return runId;
  };

  // timeoutMs 让旧实现（不响应 signal）在 8s 内以 timeout 失败，而不是挂到 vitest 超时。
  it('publishes the cancel signal and keeps the job when a claimed run is aborted', {
    timeout: 15_000,
  }, async () => {
    const slug = unique('signal-running');
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<{
      id: string;
    }>();
    const controller = new AbortController();
    const pending = createInvoker(app).invoke({
      slug,
      prompt: 'cancel a claimed run',
      timeoutMs: 8_000,
      signal: controller.signal,
    });
    pending.catch(() => undefined);

    const runId = await awaitQueuedJob(agent.id);
    // 模拟 worker 已领取：真实路径会启动沙盒与模型，这里只推进状态。
    await repo.chat.updateRun(app.db, runId, { status: 'running', startedAt: new Date() });

    const channel = runCancelKey(runId);
    let received: string | undefined;
    const signalled = new Promise<void>((resolve) => {
      redis.on('message', (incoming, message) => {
        if (incoming !== channel) return;
        received = message;
        resolve();
      });
    });
    // 先等 SUBSCRIBE ack 再 abort，否则早到的 cancel 会被 pub/sub 丢掉。
    await redis.subscribe(channel);

    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(await settledWithin(signalled, 5_000)).toBe(true);
    expect(received).toBe(RUN_CANCEL_PAYLOAD);
    expect(await redis.get(channel)).toBe(RUN_CANCEL_PAYLOAD);
    expect(await statusOf(runId)).toBe('cancelled');
    // running 已被领取，清 job 是 worker 的职责；取消只应撤销 run。
    expect(await getQueue().getJob(runId)).toBeDefined();
  });

  it('removes the waiting job and publishes the terminal event for a queued run', {
    timeout: 15_000,
  }, async () => {
    const slug = unique('signal-queued');
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<{
      id: string;
    }>();
    const controller = new AbortController();
    const pending = createInvoker(app).invoke({
      slug,
      prompt: 'cancel a queued run',
      timeoutMs: 8_000,
      signal: controller.signal,
    });
    pending.catch(() => undefined);

    const runId = await awaitQueuedJob(agent.id);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);

    expect(await waitFor(async () => (await getQueue().getJob(runId)) === undefined, 5_000)).toBe(
      true,
    );
    expect(await statusOf(runId)).toBe('cancelled');

    const streamKey = runStreamKey(runId);
    const terminal = await waitFor(async () => {
      const entries = (await redis.xrange(streamKey, '-', '+')) as Array<[string, string[]]>;
      return entries.some(([, fields]) => {
        const payload = fields[fields.indexOf('payload') + 1];
        return payload?.includes('"run_finished"') === true && payload.includes('"cancelled"');
      });
    }, 5_000);
    expect(terminal).toBe(true);
  });
});
