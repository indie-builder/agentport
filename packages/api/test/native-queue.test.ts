import { NATIVE_PLUGINS_QUEUE, type NativePluginAction } from '@agentport/shared';
import { type Job, Queue, Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runNativePluginAction } from '../src/features/plugins/native.js';
import { infraReady } from './helpers.js';
import {
  type CommandWatch,
  startXreadGate,
  watchIsFinished,
  type XreadGate,
} from './queue-events-gate.js';

const ready = await infraReady;
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const connection = { url: redisUrl };
const logger = { warn: () => undefined };

// 不需要 Postgres/Redis：这条用真实 ioredis 连接被拒绝的端口，不走 mock。
it('fails within the budget with SERVICE_UNAVAILABLE when Redis refuses connections', async () => {
  const startedAt = Date.now();
  const refused = 'redis://127.0.0.1:1';
  const error = await runNativePluginAction(refused, logger, { action: 'list' }, 100).then(
    () => null,
    (err: unknown) => err as { code?: string; message?: string },
  );
  const elapsed = Date.now() - startedAt;
  expect(error?.code).toBe('SERVICE_UNAVAILABLE');
  expect(elapsed).toBeLessThanOrEqual(2000);
  expect(error?.message).not.toContain('127.0.0.1:1');
});

/**
 * 队列边界用真实 BullMQ + 假 consumer 覆盖：断言只投递受限动作、
 * 结果按 shared schema 校验、超时与队列不可用都收敛成可读错误。
 */
describe.skipIf(!ready)('native plugin queue client', () => {
  let adminQueue: Queue<NativePluginAction> | undefined;
  const workers: Worker[] = [];
  const gates: XreadGate[] = [];
  const watches: CommandWatch[] = [];
  const finishCallbacks: Array<() => void> = [];

  const startWorker = (processor: (job: Job<NativePluginAction>) => Promise<unknown>): Worker => {
    const worker = new Worker<NativePluginAction>(NATIVE_PLUGINS_QUEUE, processor, {
      connection,
      concurrency: 1,
    });
    workers.push(worker);
    return worker;
  };

  beforeAll(async () => {
    adminQueue = new Queue<NativePluginAction>(NATIVE_PLUGINS_QUEUE, { connection });
    await adminQueue.obliterate({ force: true });
  });

  // 测试超时也要释放 consumer：留在 test body 的 finally 不会在超时后执行，
  // 遗留 worker 会把后面“无 consumer”用例的 job 跑掉；close(true) 不等未完成的 job。
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
    await adminQueue?.obliterate({ force: true });
    await adminQueue?.close();
  });

  it('sends the action as the job payload and returns the worker output', async () => {
    const seen: NativePluginAction[] = [];
    startWorker(async (job) => {
      seen.push(job.data);
      return {
        ok: true,
        plugin: { pluginId: 'demo@repo', version: '1.0.0' },
        files: [{ path: '.claude-plugin/plugin.json', content: '{}', executable: false }],
      };
    });
    const output = await runNativePluginAction(redisUrl, logger, {
      action: 'install',
      marketplace: 'owner/repo',
      plugin: 'demo',
    });
    expect(seen).toEqual([{ action: 'install', marketplace: 'owner/repo', plugin: 'demo' }]);
    expect(output).toMatchObject({ ok: true, plugin: { pluginId: 'demo@repo' } });
  });

  it('rejects worker output that breaks the shared contract', async () => {
    startWorker(async () => ({ ok: true, files: [{ path: '../escape', content: '' }] }));
    await expect(
      runNativePluginAction(redisUrl, logger, { action: 'read', pluginId: 'demo@repo' }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' });
  });

  /**
   * QueueEvents 连接 ready 不代表首个 XREAD 已开始；默认 $ 在执行时解析为流尾。
   * 门闩扣住首个 XREAD，等 job 完成并写入事件后再放行，稳定复现完成通知被跳过。
   */
  it('returns the worker result when the job finishes before the first event read starts', async () => {
    const gate = await startXreadGate(redisUrl);
    gates.push(gate);
    const watch = await watchIsFinished(redisUrl, NATIVE_PLUGINS_QUEUE);
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
    const worker = startWorker(async () => {
      workerStarted();
      await jobFinished;
      return {
        ok: true,
        plugin: { pluginId: 'demo@repo', version: '1.0.0' },
        files: [],
      };
    });
    const jobCompleted = new Promise<void>((resolve) => {
      worker.once('completed', () => resolve());
    });

    const pending = runNativePluginAction(gate.url, logger, { action: 'list' }, 2_000);
    await Promise.all([gate.held, started, watch.isFinished]);
    finishJob();
    await jobCompleted;
    gate.release();

    await expect(pending).resolves.toMatchObject({
      ok: true,
      plugin: { pluginId: 'demo@repo' },
    });
  });

  it('fails fast with a readable error when no worker is consuming', async () => {
    await expect(
      runNativePluginAction(redisUrl, logger, { action: 'list' }, 300),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('超时'),
    });
  });
});
