import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, repo } from '@agentport/db';
import {
  KNOWLEDGE_JOBS_QUEUE,
  knowledgeCancelKey,
  knowledgeEnqueueOptions,
} from '@agentport/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startKnowledgeWorker } from '../src/knowledge/queue.js';

const control = vi.hoisted(() => ({ captureCancelRead: false }));

vi.mock('../src/knowledge/ingestion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/knowledge/ingestion.js')>();
  return {
    ...actual,
    // 处理返回后队列才开始最后一次取消键读取；从这里挂起，才能稳定命中收尾竞态窗口。
    runKnowledgeJob: async () => {
      control.captureCancelRead = true;
    },
  };
});

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;
const redisUrl = process.env.REDIS_URL ?? '';
const prefix = `knowledge-queue-cancel-${randomUUID().slice(0, 8)}`;
const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as Parameters<typeof startKnowledgeWorker>[0]['logger'];

let knowledgeDir = '';

beforeAll(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-queue-cancel-'));
});

afterAll(async () => {
  const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, {
    connection: { url: redisUrl },
    prefix,
  });
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await rm(knowledgeDir, { recursive: true, force: true });
  await dbHandle.pool.end();
});

describe('knowledge queue cancellation during final read', () => {
  it('does not mark the job succeeded when abort lands while the final cancel-key read is pending', async () => {
    const job = await repo.knowledge.createJob(db, {
      type: 'cleanup',
      baseId: null,
      documentId: null,
      sourceId: null,
      payload: { type: 'cleanup' },
    });

    const redisPrototype = Redis.prototype as unknown as {
      get: (this: Redis, key: string) => Promise<string | null>;
    };
    const originalGet = redisPrototype.get;
    const held: Array<(value: null) => void> = [];
    let released = false;
    let enterRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      enterRead = resolve;
    });
    redisPrototype.get = function (key) {
      if (!released && control.captureCancelRead && key === knowledgeCancelKey(job.id)) {
        enterRead();
        return new Promise<null>((resolve) => held.push(resolve));
      }
      return originalGet.call(this, key);
    };

    const worker = await startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      parse: async () => ({ markdown: '', images: [], pageMap: [] }),
      chunkMarkdown: () => [],
      connectors: {},
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl },
      prefix,
    });
    try {
      await queue.add('knowledge', { jobId: job.id }, knowledgeEnqueueOptions(job.id));
      // 处理器已返回，队列停在最后一次取消键读取上；此时收尾还没决定终态。
      await readStarted;
      const closing = worker.close(); // 同步 abort 活跃任务
      released = true;
      for (const resolve of held) resolve(null);
      await closing;

      const finished = await repo.knowledge.getJob(db, job.id);
      // 关闭中断不是成功：退回 queued 等重启重试，不能被收尾写成 succeeded。
      expect(finished?.status).toBe('queued');
      expect(finished?.error).toBe('worker shutting down');
      expect(await (await queue.getJob(job.id))?.getState()).not.toBe('completed');
    } finally {
      released = true;
      for (const resolve of held) resolve(null);
      redisPrototype.get = originalGet;
      await queue.close();
      await worker.close();
    }
  });
});
