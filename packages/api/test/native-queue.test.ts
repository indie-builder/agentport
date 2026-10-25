import { NATIVE_PLUGINS_QUEUE, type NativePluginAction } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNativePluginAction } from '../src/features/plugins/native.js';
import { infraReady } from './helpers.js';

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
  beforeAll(async () => {
    await new Queue(NATIVE_PLUGINS_QUEUE, { connection }).obliterate({ force: true });
  });

  afterAll(async () => {
    await new Queue(NATIVE_PLUGINS_QUEUE, { connection }).obliterate({ force: true });
  });

  it('sends the action as the job payload and returns the worker output', async () => {
    const seen: NativePluginAction[] = [];
    const worker = new Worker<NativePluginAction>(
      NATIVE_PLUGINS_QUEUE,
      async (job) => {
        seen.push(job.data);
        return {
          ok: true,
          plugin: { pluginId: 'demo@repo', version: '1.0.0' },
          files: [{ path: '.claude-plugin/plugin.json', content: '{}', executable: false }],
        };
      },
      { connection, concurrency: 1 },
    );
    try {
      const output = await runNativePluginAction(redisUrl, logger, {
        action: 'install',
        marketplace: 'owner/repo',
        plugin: 'demo',
      });
      expect(seen).toEqual([{ action: 'install', marketplace: 'owner/repo', plugin: 'demo' }]);
      expect(output).toMatchObject({ ok: true, plugin: { pluginId: 'demo@repo' } });
    } finally {
      await worker.close();
    }
  });

  it('rejects worker output that breaks the shared contract', async () => {
    const worker = new Worker(
      NATIVE_PLUGINS_QUEUE,
      async () => ({ ok: true, files: [{ path: '../escape', content: '' }] }),
      { connection, concurrency: 1 },
    );
    try {
      await expect(
        runNativePluginAction(redisUrl, logger, { action: 'read', pluginId: 'demo@repo' }),
      ).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' });
    } finally {
      await worker.close();
    }
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
