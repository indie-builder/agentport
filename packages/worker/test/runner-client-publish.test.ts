import { randomUUID } from 'node:crypto';
import { runStreamKey } from '@agentport/shared';
import { RedisClient } from 'bun';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { closeRunnerClient, configureRunnerClient, publishRun } from '../src/runner-client.js';

async function probeRedis(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return false;
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

const redisUrl = process.env.REDIS_URL ?? '';
const ready = await probeRedis();
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

afterAll(async () => {
  await closeRunnerClient();
});

describe.skipIf(!ready)('publishRun', () => {
  it('writes the event and its TTL in one pipeline', async () => {
    configureRunnerClient(redisUrl);
    const runId = `run-publish-${randomUUID()}`;
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const send = spyOn(RedisClient.prototype, 'send');
    const expire = spyOn(RedisClient.prototype, 'expire');
    try {
      await publishRun(runId, { type: 'run_started', runId, conversationId: 'c1' }, logger);

      expect(send).toHaveBeenCalledTimes(1);
      expect(expire).toHaveBeenCalledTimes(1);
      expect(await redis.xlen(runStreamKey(runId))).toBe(1);
      const ttl = await redis.ttl(runStreamKey(runId));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3600);
    } finally {
      send.mockRestore();
      expire.mockRestore();
      await redis.del(runStreamKey(runId));
      redis.disconnect();
    }
  });

  it('keeps every accepted event beyond the old 1000-entry cap', async () => {
    configureRunnerClient(redisUrl);
    const runId = `run-publish-${randomUUID()}`;
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      for (let index = 0; index < 1_200; index += 1) {
        await publishRun(runId, { type: 'text_delta', text: String(index) }, logger);
      }
      // 展示额度由 worker 自己控制；发布端不能再按 MAXLEN 裁掉已接受的事件。
      expect(await redis.xlen(runStreamKey(runId))).toBe(1_200);
    } finally {
      await redis.del(runStreamKey(runId));
      redis.disconnect();
    }
  });

  it('rejects when a pipelined command fails instead of dropping the error', async () => {
    configureRunnerClient(redisUrl);
    const runId = `run-publish-${randomUUID()}`;
    const key = runStreamKey(runId);
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      // 字符串键上 XADD 会失败，EXPIRE 仍会成功：逐命令检查才能看到第一条错误。
      await redis.set(key, 'not-a-stream');
      await expect(
        publishRun(runId, { type: 'run_started', runId, conversationId: 'c1' }, logger),
      ).rejects.toThrow(/WRONGTYPE/);
    } finally {
      await redis.del(key);
      redis.disconnect();
    }
  });
});
