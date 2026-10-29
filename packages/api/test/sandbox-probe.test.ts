import { SANDBOX_PROBES_QUEUE, type Server } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testStdioInSandbox } from '../src/features/servers/sandbox-probe.js';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

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

      // 结果落到连接健康度，列表刷新后仍能看到；没有环境身份的结果记为 null。
      const row = await app.pool.query(
        'select last_test_ok, last_tool_count, last_test_runtime_environment from servers where id = $1',
        [server.id],
      );
      expect(row.rows[0]).toMatchObject({
        last_test_ok: true,
        last_tool_count: 1,
        last_test_runtime_environment: null,
      });
    } finally {
      await probeWorker.close();
    }
  });

  it('passes an optional runtime environment and returns its actual identity', async () => {
    const seen: unknown[] = [];
    const identity = {
      environmentId: 'env_1',
      environmentName: '默认环境',
      versionId: 'ver_1',
      imageId: 'sha256:1',
    };
    const probeWorker = new Worker<{ serverId: string; runtimeEnvironmentId?: string }>(
      SANDBOX_PROBES_QUEUE,
      async (job) => {
        seen.push(job.data);
        return { ok: true, tools: [], durationMs: 3, runtimeEnvironment: identity };
      },
      { connection, concurrency: 1 },
    );
    try {
      const result = await testStdioInSandbox('srv_any', logger, {
        runtimeEnvironmentId: 'env_1',
        timeoutMs: 2_000,
      });

      expect(seen).toEqual([{ serverId: 'srv_any', runtimeEnvironmentId: 'env_1' }]);
      expect(result.runtimeEnvironment).toEqual(identity);
    } finally {
      await probeWorker.close();
    }
  });

  it('passes the body environment to the queue and returns that identity per request', async () => {
    const name = unique('probe');
    created.push(name);
    const server = await createStdio(name);

    const seen: unknown[] = [];
    const probeWorker = new Worker<{ serverId: string; runtimeEnvironmentId?: string }>(
      SANDBOX_PROBES_QUEUE,
      async (job) => {
        seen.push(job.data);
        const id = job.data.runtimeEnvironmentId ?? 'default';
        return {
          ok: true,
          tools: [],
          durationMs: 1,
          runtimeEnvironment: {
            environmentId: id,
            environmentName: `环境 ${id}`,
            versionId: `version-${id}`,
            imageId: `sha256:${id}`,
          },
        };
      },
      { connection, concurrency: 1 },
    );
    try {
      const first = await inject(app, {
        method: 'POST',
        url: `/api/servers/${server.id}/test`,
        headers: { cookie },
        payload: { runtimeEnvironmentId: 'rte_first' },
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ runtimeEnvironment: { environmentId: 'rte_first' } });

      // 换环境再测：上一次的成功不能被当成当前环境的结果复用。
      const second = await inject(app, {
        method: 'POST',
        url: `/api/servers/${server.id}/test`,
        headers: { cookie },
        payload: { runtimeEnvironmentId: 'rte_second' },
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({ runtimeEnvironment: { environmentId: 'rte_second' } });

      expect(seen).toEqual([
        { serverId: server.id, runtimeEnvironmentId: 'rte_first' },
        { serverId: server.id, runtimeEnvironmentId: 'rte_second' },
      ]);
    } finally {
      await probeWorker.close();
    }
  });

  it('persists the last test environment so a success never carries over to another environment', async () => {
    const name = unique('probe-persist');
    created.push(name);
    const server = await createStdio(name);

    const identity = (id: string) => ({
      environmentId: id,
      environmentName: `环境 ${id}`,
      versionId: `version-${id}`,
      imageId: `sha256:${id}`,
    });
    const probeWorker = new Worker<{ serverId: string; runtimeEnvironmentId?: string }>(
      SANDBOX_PROBES_QUEUE,
      async (job) => {
        const id = job.data.runtimeEnvironmentId ?? 'default';
        // B 故意失败：证明失败结果会覆盖 A 的成功，而不是把 A 的可用性当成当前环境可用。
        if (id === 'rte_b') {
          return {
            ok: false,
            tools: [],
            error: 'connect failed',
            durationMs: 1,
            runtimeEnvironment: identity(id),
          };
        }
        return {
          ok: true,
          tools: [{ name: 'echo' }],
          durationMs: 1,
          runtimeEnvironment: identity(id),
        };
      },
      { connection, concurrency: 1 },
    );

    const test = (environmentId: string) =>
      inject(app, {
        method: 'POST',
        url: `/api/servers/${server.id}/test`,
        headers: { cookie },
        payload: { runtimeEnvironmentId: environmentId },
      });
    const readBack = async (): Promise<Server> => {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/servers/${server.id}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Server>();
    };

    try {
      expect((await test('rte_a')).statusCode).toBe(200);
      expect(await readBack()).toMatchObject({
        lastTestOk: true,
        lastToolCount: 1,
        lastTestRuntimeEnvironment: identity('rte_a'),
      });

      expect((await test('rte_b')).statusCode).toBe(200);
      expect(await readBack()).toMatchObject({
        lastTestOk: false,
        lastToolCount: null,
        lastTestRuntimeEnvironment: identity('rte_b'),
      });

      expect((await test('rte_a')).statusCode).toBe(200);
      expect(await readBack()).toMatchObject({
        lastTestOk: true,
        lastTestRuntimeEnvironment: identity('rte_a'),
      });
    } finally {
      await probeWorker.close();
    }
  });

  it('rejects a runtime environment on HTTP connections instead of pretending it applied', async () => {
    const name = unique('probe-http');
    created.push(name);
    const createdServer = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name, kind: 'http', url: 'https://example.com/mcp' },
    });
    expect(createdServer.statusCode, createdServer.body).toBe(201);
    const server = createdServer.json<Server>();

    const res = await inject(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/test`,
      headers: { cookie },
      payload: { runtimeEnvironmentId: 'rte_http' },
    });
    expectProblem(res, 'INVALID_INPUT');
  });

  it('returns a readable timeout result when no worker is consuming', async () => {
    const result = await testStdioInSandbox('srv_any', logger, { timeoutMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain('超时');
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
  });
});
