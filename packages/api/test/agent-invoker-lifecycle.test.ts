import { repo } from '@agentport/db';
import { RUN_CANCEL_PAYLOAD, runCancelKey, runStreamKey } from '@agentport/shared';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInvoker } from '../src/features/servers/agent-invoker.js';
import { buildAgentServer } from '../src/features/servers/agent-tools.js';
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

// 有真实消费者时 job 会被领走，超时/取消边界就测不到了。
const ready = (await infraReady) && (await queueIdle);

interface OwnAgent {
  id: string;
  slug: string;
}

interface RunRow {
  id: string;
  status: string;
  error: string | null;
  error_kind: string | null;
  ended_at: Date | null;
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected promise to reject');
}

/** 所有挂起都有界；测试自身的 20s 超时不算可读的失败原因。 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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

describe.skipIf(!ready)('agent invoker lifecycle', () => {
  let app: FastifyInstance;
  let cookie: string;
  let redis: Redis;
  const agentIds: string[] = [];
  const agentSlugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    redis = new Redis(testConfig().REDIS_URL);
  });

  afterAll(async () => {
    // 断言失败也要清干净：按本文件的 agent 反查所有 run，含旧实现泄漏的 queued run。
    const discovered =
      agentIds.length === 0
        ? []
        : (
            await app.pool.query<{ id: string }>(
              'select id from agent_runs where agent_id = any($1::text[])',
              [agentIds],
            )
          ).rows.map((row) => row.id);
    for (const runId of discovered) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
      await redis.del(runCancelKey(runId), runStreamKey(runId)).catch(() => undefined);
    }
    await cleanup(app, { agentSlugs, runIds: discovered });
    await redis.quit().catch(() => undefined);
    await app.close();
  });

  const newAgent = async (prefix: string): Promise<OwnAgent> => {
    const slug = unique(prefix);
    const res = await createAgent(app, cookie, { slug, track: agentSlugs });
    const agent = res.json<{ id: string }>();
    agentIds.push(agent.id);
    return { id: agent.id, slug };
  };

  const runsOf = async (agentId: string): Promise<RunRow[]> =>
    (
      await app.pool.query<RunRow>(
        'select id, status, error, error_kind, ended_at from agent_runs where agent_id = $1 order by created_at desc',
        [agentId],
      )
    ).rows;

  it('rejects non-positive and non-finite timeouts before writing a conversation or run', async () => {
    const agent = await newAgent('timeout-invalid');
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await rejectionOf(
        createInvoker(app).invoke({ slug: agent.slug, prompt: 'bad timeout', timeoutMs }),
      );
      expect(err.code).toBe('INVALID_INPUT');
    }
    expect(await runsOf(agent.id)).toHaveLength(0);
    const conversations = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from conversations where agent_id = $1',
      [agent.id],
    );
    expect(conversations.rows[0]?.count).toBe(0);
  });

  it('advertises the positive timeout constraint in the MCP tool schema', async () => {
    const server = buildAgentServer([{ slug: 'lifecycle-demo', name: 'Demo', description: '' }], {
      invoke: async () => 'unused',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'lifecycle-test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((candidate) => candidate.name === 'run_lifecycle-demo');
      expect(tool?.inputSchema).toMatchObject({
        properties: { timeoutMs: { type: 'number', exclusiveMinimum: 0 } },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('turns a rejected enqueue into a fixed error and an infra-failed run without leaking secrets', async () => {
    const agent = await newAgent('enqueue-fail');
    const queue = getQueue();
    const spy = vi
      .spyOn(queue, 'add')
      .mockRejectedValueOnce(new Error('redis://:hunter2-secret@127.0.0.1:6379 refused'));
    let err: { code?: string; message: string };
    try {
      err = await rejectionOf(
        withDeadline(
          createInvoker(app).invoke({ slug: agent.slug, prompt: 'queue is down' }),
          5_000,
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.message).toBe('运行入队失败，请稍后重试');
    expect(err.message).not.toContain('hunter2-secret');
    expect(err.message).not.toContain('redis://');

    const runs = await runsOf(agent.id);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (!run) throw new Error('run was not created');
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('infra');
    expect(run.error).toBe('消息入队失败，请重新发送。');
    expect(run.ended_at).not.toBeNull();
    expect(await queue.getJob(run.id)).toBeUndefined();
  });

  it.each([
    { claimed: 'running' as const, terminal: false },
    { claimed: 'succeeded' as const, terminal: true },
  ])(
    'does not overwrite a $claimed run when add rejects after the worker moved it',
    async ({ claimed, terminal }) => {
      const agent = await newAgent(`enqueue-${claimed}`);
      const queue = getQueue();
      const spy = vi.spyOn(queue, 'add').mockImplementationOnce(async (_name, data) => {
        // 模拟 worker 在 add 返回前就领取/完成：失败收口只能动仍为 queued 的 run。
        await repo.chat.updateRun(app.db, data.runId, {
          status: claimed,
          startedAt: new Date(),
          ...(terminal ? { endedAt: new Date() } : {}),
        });
        throw new Error('redis://:secret@127.0.0.1:6379 refused');
      });
      let err: { code?: string; message: string };
      try {
        err = await rejectionOf(
          withDeadline(createInvoker(app).invoke({ slug: agent.slug, prompt: 'race' }), 5_000),
        );
      } finally {
        spy.mockRestore();
      }
      expect(err.code).toBe('SERVICE_UNAVAILABLE');

      const runs = await runsOf(agent.id);
      expect(runs).toHaveLength(1);
      const run = runs[0];
      if (!run) throw new Error('run was not created');
      expect(run.status).toBe(claimed);
      expect(run.error).toBeNull();
      expect(run.error_kind).toBeNull();
      expect(run.ended_at === null).toBe(!terminal);
      expect(await queue.getJob(run.id)).toBeUndefined();
    },
  );

  it('cancels a still-queued run when the deadline expires and removes its job', {
    timeout: 15_000,
  }, async () => {
    const agent = await newAgent('timeout-queued');
    const pending = createInvoker(app).invoke({
      slug: agent.slug,
      prompt: 'short deadline',
      timeoutMs: 50,
    });
    pending.catch(() => undefined);

    const runId = await waitFor(async () => (await runsOf(agent.id)).length > 0);
    expect(runId).toBe(true);
    const err = await rejectionOf(withDeadline(pending, 5_000));
    expect(err.code).toBe('UPSTREAM_FAILED');
    expect(err.message).toMatch(/timed out/);

    const runs = await runsOf(agent.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('cancelled');
    expect(await getQueue().getJob(runs[0]?.id ?? '')).toBeUndefined();
    const active = await app.pool.query<{ count: number }>(
      "select count(*)::int as count from agent_runs where agent_id = $1 and status in ('queued', 'running')",
      [agent.id],
    );
    expect(active.rows[0]?.count).toBe(0);
  });

  it('signals a running run on deadline expiry without taking over its job', {
    timeout: 15_000,
  }, async () => {
    const agent = await newAgent('timeout-running');
    const pending = createInvoker(app).invoke({
      slug: agent.slug,
      prompt: 'claim then timeout',
      timeoutMs: 200,
    });
    pending.catch(() => undefined);

    const claimed = await waitFor(async () => {
      const runId = (await runsOf(agent.id))[0]?.id;
      return runId !== undefined && (await getQueue().getJob(runId)) !== undefined;
    });
    expect(claimed).toBe(true);
    const run = (await runsOf(agent.id))[0];
    if (!run) throw new Error('run was not created');

    const subscriber = new Redis(testConfig().REDIS_URL);
    try {
      const channel = runCancelKey(run.id);
      await subscriber.subscribe(channel);
      let received: string | undefined;
      const signalled = new Promise<void>((resolve) => {
        subscriber.on('message', (incoming, message) => {
          if (incoming !== channel) return;
          received = message;
          resolve();
        });
      });

      const moved = await app.pool.query(
        "update agent_runs set status = 'running', started_at = now() where id = $1 and status = 'queued' returning id",
        [run.id],
      );
      expect(moved.rows).toHaveLength(1);

      const err = await rejectionOf(withDeadline(pending, 5_000));
      expect(err.code).toBe('UPSTREAM_FAILED');
      expect(err.message).toMatch(/timed out/);
      expect(await settledWithin(signalled, 5_000)).toBe(true);
      expect(received).toBe(RUN_CANCEL_PAYLOAD);
      // 订阅连接处于 pub/sub 模式，读键必须用独立连接。
      expect(await redis.get(channel)).toBe(RUN_CANCEL_PAYLOAD);
      expect((await runsOf(agent.id))[0]?.status).toBe('cancelled');
      // running 的 job 由 worker 负责清理，取消只撤销 run。
      expect(await getQueue().getJob(run.id)).toBeDefined();
    } finally {
      await subscriber.quit().catch(() => undefined);
    }
  });
});
