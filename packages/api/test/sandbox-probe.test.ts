import { SANDBOX_PROBES_QUEUE, type Server } from '@agentport/shared';
import { type Job, Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import {
  type CommandWatch,
  startXreadGate,
  watchIsFinished,
  type XreadGate,
} from './queue-events-gate.js';

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
  let adminQueue: Queue<{ serverId: string }> | undefined;
  let cookie: string;
  const created: string[] = [];
  const workers: Worker[] = [];
  const gates: XreadGate[] = [];
  const watches: CommandWatch[] = [];
  const finishCallbacks: Array<() => void> = [];

  const startWorker = <T>(processor: (job: Job<T>) => Promise<unknown>): Worker<T> => {
    const worker = new Worker<T>(SANDBOX_PROBES_QUEUE, processor, { connection, concurrency: 1 });
    workers.push(worker);
    return worker;
  };

  beforeAll(async () => {
    // 上次运行留下的等待 job 会被新 consumer 先消费，清空后再断言。
    adminQueue = new Queue<{ serverId: string }>(SANDBOX_PROBES_QUEUE, { connection });
    await adminQueue.obliterate({ force: true });
    app = await startApp();
    cookie = await loginCookie(app);
  });

  // 测试超时也要释放 consumer：留在 test body 的 finally 不会在超时后执行，
  // 遗留 worker 会让后面“无 consumer”用例提前拿到结果；close(true) 不等未完成的 job。
  afterEach(async () => {
    const activeGates = gates.splice(0);
    for (const gate of activeGates) gate.release();
    for (const finish of finishCallbacks.splice(0)) finish();
    // 并行清理：任一资源关闭慢都不能挡住 worker 的强制关闭。
    await Promise.allSettled([
      ...activeGates.map((gate) => gate.close()),
      ...watches.splice(0).map((watch) => watch.close()),
      ...workers.splice(0).map((worker) => worker.close(true)),
    ]);
  });

  afterAll(async () => {
    await cleanup(app, { serverNames: created });
    await app.close();
    await adminQueue?.obliterate({ force: true });
    await adminQueue?.close();
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
    startWorker<{ serverId: string }>(async (job) => {
      seen.push(job.data);
      return {
        ok: true,
        tools: [{ name: 'echo' }],
        serverInfo: { name: 'x', version: '1' },
        durationMs: 7,
      };
    });

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
  });

  it('passes an optional runtime environment and returns its actual identity', async () => {
    const seen: unknown[] = [];
    const identity = {
      environmentId: 'env_1',
      environmentName: '默认环境',
      versionId: 'ver_1',
      imageId: 'sha256:1',
    };
    startWorker<{ serverId: string; runtimeEnvironmentId?: string }>(async (job) => {
      seen.push(job.data);
      return { ok: true, tools: [], durationMs: 3, runtimeEnvironment: identity };
    });

    const result = await testStdioInSandbox('srv_any', logger, {
      runtimeEnvironmentId: 'env_1',
      timeoutMs: 2_000,
    });

    expect(seen).toEqual([{ serverId: 'srv_any', runtimeEnvironmentId: 'env_1' }]);
    expect(result.runtimeEnvironment).toEqual(identity);
  });

  it('passes the body environment to the queue and returns that identity per request', async () => {
    const name = unique('probe');
    created.push(name);
    const server = await createStdio(name);

    const seen: unknown[] = [];
    startWorker<{ serverId: string; runtimeEnvironmentId?: string }>(async (job) => {
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
    });

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
    startWorker<{ serverId: string; runtimeEnvironmentId?: string }>(async (job) => {
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
    });

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

  /**
   * QueueEvents 连接 ready 不代表首个 XREAD 已开始；默认 $ 在执行时解析为流尾。
   * 门闩扣住首个 XREAD，等 job 完成并写入事件后再放行，稳定复现完成通知被跳过。
   */
  it('returns the worker result when the job finishes before the first event read starts', async () => {
    const gate = await startXreadGate(redisUrl);
    gates.push(gate);
    const watch = await watchIsFinished(redisUrl, SANDBOX_PROBES_QUEUE);
    watches.push(watch);

    let finishJob!: () => void;
    const jobFinished = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    finishCallbacks.push(() => finishJob());
    let workerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      workerStarted = resolve;
    });
    const worker = startWorker<{ serverId: string }>(async () => {
      workerStarted();
      await jobFinished;
      return { ok: true, tools: [{ name: 'echo' }], durationMs: 5 };
    });
    const jobCompleted = new Promise<void>((resolve) => {
      worker.once('completed', () => resolve());
    });

    const pending = testStdioInSandbox('srv_any', logger, {
      timeoutMs: 2_000,
      redisUrl: gate.url,
    });
    await Promise.all([gate.held, started, watch.isFinished]);
    finishJob();
    await jobCompleted;
    gate.release();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      tools: [{ name: 'echo' }],
    });
  });

  it('returns a readable timeout result when no worker is consuming', async () => {
    const result = await testStdioInSandbox('srv_any', logger, { timeoutMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain('超时');
    // Date.now() 有毫秒截断，定时器按 >=300ms 触发时实测可能落在 299。
    expect(result.durationMs).toBeGreaterThanOrEqual(299);
  });
});
