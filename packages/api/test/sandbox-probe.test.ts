import { SANDBOX_PROBES_QUEUE, type Server } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStdioInSandbox } from '../src/features/servers/sandbox-probe.js';
import { cleanup, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:55540';
const connection = { url: redisUrl };
const logger = { warn: () => undefined };

/**
 * 端到端只覆盖到队列边界：用真实 BullMQ + 隔离 Redis 起一个假 consumer，
 * 断言 API 只投递 serverId、按 job 返回值回响应。
 * 容器内真正的 stdio 试连由 worker/sandbox 各自的测试覆盖。
 */
describe.skipIf(!ready)('sandbox probe queue', () => {
  let app: FastifyInstance;
  let cookie: string;
  const created: string[] = [];

  beforeAll(async () => {
    // 上次运行留下的等待 job 会被新 consumer 先消费，清空后再断言。
    await new Queue(SANDBOX_PROBES_QUEUE, { connection }).obliterate({ force: true });
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { serverNames: created });
    await app.close();
    await new Queue(SANDBOX_PROBES_QUEUE, { connection }).obliterate({ force: true });
  });

  const createStdio = async (name: string): Promise<Server> => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name, kind: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 't' } },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Server>();
  };

  it('enqueues only the server id and returns the worker result', async () => {
    const name = unique('probe');
    created.push(name);
    const server = await createStdio(name);

    const seen: unknown[] = [];
    const probeWorker = new Worker<{ serverId: string }>(
      SANDBOX_PROBES_QUEUE,
      async (job) => {
        seen.push(job.data);
        return {
          ok: true,
          tools: [{ name: 'echo' }],
          serverInfo: { name: 'x', version: '1' },
          durationMs: 7,
        };
      },
      { connection, concurrency: 1 },
    );
    try {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/servers/${server.id}/test`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      // 队列里只有 serverId：密钥与配置由 worker 从库里读，不经 Redis。
      expect(seen).toEqual([{ serverId: server.id }]);
      expect(res.json()).toEqual({
        ok: true,
        tools: [{ name: 'echo' }],
        serverInfo: { name: 'x', version: '1' },
        durationMs: 7,
      });

      // 结果落到连接健康度，列表刷新后仍能看到。
      const row = await app.pool.query(
        'select last_test_ok, last_tool_count from servers where id = $1',
        [server.id],
      );
      expect(row.rows[0]).toMatchObject({ last_test_ok: true, last_tool_count: 1 });
    } finally {
      await probeWorker.close();
    }
  });

  it('returns a readable timeout result when no worker is consuming', async () => {
    const result = await testStdioInSandbox('srv_any', logger, 300);

    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain('超时');
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
  });
});
