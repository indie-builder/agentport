import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import {
  KNOWLEDGE_JOBS_QUEUE,
  knowledgeCancelKey,
  knowledgeEnqueueOptions,
} from '@agentport/shared';
import { Queue, QueueEvents } from 'bullmq';
import { RedisClient } from 'bun';
import { KnowledgeParseError } from '../src/knowledge/parsing.js';
import { bunRedisConnection } from './fixtures/bun-redis.js';

const control = { run: async () => {} };
const ingestionActual = await import('../src/knowledge/ingestion.js');
mock.module('../src/knowledge/ingestion.js', () => ({
  ...ingestionActual,
  runKnowledgeJob: () => control.run(),
}));
const { startKnowledgeWorker } = await import('../src/knowledge/queue.js');

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
  const redis = bunRedisConnection(redisUrl);
  const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, { connection: redis.connection, prefix });
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await redis.close();
  await rm(knowledgeDir, { recursive: true, force: true });
  await dbHandle.client.close();
});

describe('knowledge queue cancellation across attempts', () => {
  it('preserves cancellation through retry and close, then settles before dispatch on the next claim', async () => {
    for (const mode of ['retry', 'close'] as const) {
      const serverId = newId('server');
      const profileId = newId('knowledgeModelProfile');
      await db
        .insert(schema.servers)
        .values({ id: serverId, name: serverId, kind: 'knowledge', config: {} });
      await db.insert(schema.knowledgeModelProfiles).values({
        id: profileId,
        kind: 'embedding',
        name: profileId,
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
        dimensions: 1024,
      });
      const base = await repo.knowledge.createBase(db, {
        slug: `cancel-${randomUUID().slice(0, 8)}`,
        name: mode,
        description: '',
        serverId,
        embeddingProfileId: profileId,
        rerankProfileId: null,
        settings: { chunkTokens: 400, chunkOverlap: 40, wikiAutoUpdate: false },
      });
      const { source } = await repo.knowledge.createSource(db, {
        baseId: base.id,
        type: 'feed',
        name: mode,
        config: {},
        secretsEncrypted: null,
        syncCron: null,
        ranges: [
          {
            kind: 'feed',
            externalId: 'https://example.com/feed',
            ref: null,
            paths: [],
            enabled: true,
          },
        ],
      });
      const pair = await repo.knowledge.createSyncJob(db, source.id);
      if (pair.status !== 'created') throw new Error(pair.status);
      const { job } = pair;
      const redis = new RedisClient(redisUrl);
      const connection = bunRedisConnection(redisUrl);
      const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, { connection: connection.connection, prefix });
      const events = new QueueEvents(KNOWLEDGE_JOBS_QUEUE, {
        connection: connection.connection,
        prefix,
      });
      events.on('error', () => undefined);
      await events.waitUntilReady();
      const options = { db, logger: quiet, redisUrl, prefix, knowledgeDir, decrypt: () => ({}) };
      const redisPrototype = RedisClient.prototype as unknown as {
        get: (this: RedisClient, key: string) => Promise<string | null>;
      };
      const originalGet = redisPrototype.get;
      const gate = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delayed = Promise.withResolvers<void>();
      const held: Array<(value: null) => void> = [];
      let capturing = false;
      let released = false;
      let calls = 0;
      events.on('delayed', ({ jobId }) => {
        if (jobId === job.id) delayed.resolve();
      });
      control.run = async () => {
        calls += 1;
        capturing = true;
        if (mode === 'retry') {
          gate.resolve();
          await release.promise;
          throw new KnowledgeParseError('parser_unavailable', 'gated failure');
        }
      };
      redisPrototype.get = function (key) {
        if (!released && capturing && key === knowledgeCancelKey(job.id)) {
          if (mode === 'retry') return Promise.resolve(null);
          gate.resolve();
          return new Promise<null>((resolve) => held.push(resolve));
        }
        return originalGet.call(this, key);
      };
      let worker = await startKnowledgeWorker(options);
      try {
        const queued = await queue.add(
          'knowledge',
          { jobId: job.id },
          {
            ...knowledgeEnqueueOptions(job.id),
            backoff: { type: 'fixed', delay: 60_000 },
          },
        );
        await Promise.race([gate.promise, queued.waitUntilFinished(events, 10_000)]);
        expect(calls).toBe(1);
        await redis.set(knowledgeCancelKey(job.id), '1', 'EX', 60);
        if (mode === 'close') {
          const closing = worker.close();
          for (const resolve of held) resolve(null);
          await closing;
        } else {
          release.resolve();
        }
        await delayed.promise;
        released = true;
        redisPrototype.get = originalGet;
        expect(await repo.knowledge.getJob(db, job.id)).toMatchObject({
          status: 'queued',
          attempts: 1,
        });
        expect(await redis.get(knowledgeCancelKey(job.id))).toBe('1');
        expect(await repo.knowledge.getSource(db, source.id)).toMatchObject({
          cursor: {},
          lastSyncStatus: null,
        });
        expect((await repo.knowledge.listSyncRuns(db, source.id)).items[0]?.status).toBe('running');
        if (mode === 'close') worker = await startKnowledgeWorker(options);
        await queued.promote();
        await queued.waitUntilFinished(events, 10_000);
        expect(calls).toBe(1);
        expect(await repo.knowledge.getJob(db, job.id)).toMatchObject({
          status: 'cancelled',
          attempts: 2,
        });
        expect((await repo.knowledge.listSyncRuns(db, source.id)).items[0]).toMatchObject({
          status: 'cancelled',
          error: 'cancelled',
        });
        expect(await repo.knowledge.getSource(db, source.id)).toMatchObject({
          cursor: {},
          lastSyncStatus: 'cancelled',
          lastError: 'cancelled',
        });
        expect(await redis.get(knowledgeCancelKey(job.id))).toBeNull();
      } finally {
        released = true;
        release.resolve();
        for (const resolve of held) resolve(null);
        redisPrototype.get = originalGet;
        await worker.close();
        await queue.close();
        await events.close();
        await connection.close();
        redis.close();
      }
    }
  });
});
