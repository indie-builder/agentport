import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { KNOWLEDGE_JOBS_QUEUE, knowledgeEnqueueOptions } from '@agentport/shared';
import { Queue, QueueEvents } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startKnowledgeWorker } from '../src/knowledge/queue.js';
import { type KnowledgeQueueLike, reconcileKnowledgeJobs } from '../src/knowledge/reconcile.js';
import { createIsolatedDatabase } from './isolated-db.js';

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;
const redisUrl = process.env.REDIS_URL ?? '';
// 独立键前缀：测试 worker 绝不消费同机真实知识队列。
const prefix = `knowledge-queue-test-${randomUUID().slice(0, 8)}`;
const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as Parameters<typeof startKnowledgeWorker>[0]['logger'];

let knowledgeDir = '';

beforeAll(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-queue-'));
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

async function seedJob(): Promise<{ jobId: string; documentId: string; baseId: string }> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const serverId = newId('server');
  await db.insert(schema.servers).values({
    id: serverId,
    name: `kb-queue-${id}`,
    kind: 'knowledge',
    config: { knowledgeBaseId: id },
  });
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-q-${id}`,
    endpointUrl: 'http://127.0.0.1:1',
    model: 'test',
    dimensions: 1024,
    enabled: true,
  });
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-q-${id}`,
    name: 'queue',
    description: '',
    serverId,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: { chunkTokens: 400, chunkOverlap: 40, wikiAutoUpdate: false },
  });
  const documentId = newId('knowledgeDocument');
  await db.insert(schema.knowledgeDocuments).values({
    id: documentId,
    baseId: base.id,
    title: 'doc.md',
    sourceType: 'upload',
    mimeType: 'text/markdown',
    status: 'pending',
  });
  const job = await repo.knowledge.createJob(db, {
    type: 'ingest',
    baseId: base.id,
    documentId,
    sourceId: null,
    payload: { type: 'ingest', documentId },
  });
  return { jobId: job.id, documentId, baseId: base.id };
}

describe('knowledge job claim', () => {
  it('lets exactly one of concurrent claims win', async () => {
    const { jobId } = await seedJob();
    const results = await Promise.all([
      repo.knowledge.claimJob(db, jobId),
      repo.knowledge.claimJob(db, jobId),
      repo.knowledge.claimJob(db, jobId),
    ]);
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    const job = await repo.knowledge.getJob(db, jobId);
    expect(job?.status).toBe('running');
    expect(job?.attempts).toBe(1);
  });

  it('does not let claimJob resurrect a cancelled job', async () => {
    const { jobId } = await seedJob();
    await repo.knowledge.requestCancel(db, jobId);
    expect(await repo.knowledge.claimJob(db, jobId)).toBeNull();
  });
});

describe('knowledge worker queue', () => {
  it('runs an enqueued job end to end on the separate queue', async () => {
    // 用真实 HTTP 上游替代 embedding 服务；解析通过注入 deps 走桩，队列/认领/收尾全走真实路径。
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(raw) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: parsed.input.map((_, index) => ({
              index,
              embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? index + 1 : 0)),
            })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture bind failed');

    const { jobId, documentId } = await seedJob();
    const document = await repo.knowledge.getDocument(db, documentId);
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(knowledgeDir, 'blobs'), { recursive: true });
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('hello world', 'utf8');
    const sha = createHash('sha256').update(body).digest('hex');
    await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), body);
    await repo.knowledge.updateDocument(db, documentId, { contentHash: sha });
    if (!document) throw new Error('document missing');
    const base = await repo.knowledge.getBase(db, document.baseId);
    await db
      .update(schema.knowledgeModelProfiles)
      .set({ endpointUrl: `http://127.0.0.1:${address.port}` })
      .where(eq(schema.knowledgeModelProfiles.id, base?.embeddingProfileId ?? ''));

    const worker = await startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      parse: async ({ data }) => ({
        markdown: data.toString('utf8'),
        images: [],
        pageMap: [],
      }),
      chunkMarkdown: (markdown) => [
        { kind: 'text', heading: null, content: markdown, pageFrom: null, pageTo: null },
      ],
      connectors: {},
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl },
      prefix,
    });
    try {
      await queue.add('knowledge', { jobId }, knowledgeEnqueueOptions(jobId));
      const deadline = Date.now() + 15_000;
      let job = await repo.knowledge.getJob(db, jobId);
      while (job?.status !== 'succeeded' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = await repo.knowledge.getJob(db, jobId);
      }
      expect(job?.status).toBe('succeeded');
      const updated = await repo.knowledge.getDocument(db, documentId);
      expect(updated?.status).toBe('ready');
    } finally {
      await queue.close();
      await worker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('retries a transient embedding failure through BullMQ and keeps the old version until the rebuild succeeds', async () => {
    // 第一次 embedding 请求返回 503，重试后恢复；只替换上游，队列/认领/重试全走真实路径。
    let failNextEmbedding = false;
    let embeddingCalls = 0;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        embeddingCalls += 1;
        if (failNextEmbedding) {
          failNextEmbedding = false;
          // 留出可观测的 running 窗口，避免状态采样漏掉首次尝试。
          setTimeout(() => {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'temporarily down' }));
          }, 150);
          return;
        }
        const parsed = JSON.parse(raw) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: parsed.input.map((_, index) => ({
              index,
              embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? index + 1 : 0)),
            })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture bind failed');

    const { jobId: ingestJobId, documentId, baseId } = await seedJob();
    const base = await repo.knowledge.getBase(db, baseId);
    if (!base?.embeddingProfileId) throw new Error('base missing');
    await db
      .update(schema.knowledgeModelProfiles)
      .set({ endpointUrl: `http://127.0.0.1:${address.port}` })
      .where(eq(schema.knowledgeModelProfiles.id, base.embeddingProfileId));

    const { createHash } = await import('node:crypto');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const body = Buffer.from('retry me', 'utf8');
    const sha = createHash('sha256').update(body).digest('hex');
    await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), body);
    await repo.knowledge.updateDocument(db, documentId, { contentHash: sha });

    const worker = await startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      parse: async ({ data }) => ({ markdown: data.toString('utf8'), images: [], pageMap: [] }),
      chunkMarkdown: (markdown) => [
        { kind: 'text', heading: null, content: markdown, pageFrom: null, pageTo: null },
      ],
      connectors: {},
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, { connection: { url: redisUrl }, prefix });
    const events = new QueueEvents(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix,
    });
    events.on('error', () => undefined);
    await events.waitUntilReady();
    const waitForStatus = async (id: string, terminal: string[]) => {
      const deadline = Date.now() + 15_000;
      let row = await repo.knowledge.getJob(db, id);
      while (!terminal.includes(row?.status ?? '') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        row = await repo.knowledge.getJob(db, id);
      }
      return row;
    };
    try {
      // 先落一个真实旧版本，重建失败时它必须仍是 currentVersion。
      await queue.add('knowledge', { jobId: ingestJobId }, knowledgeEnqueueOptions(ingestJobId));
      expect((await waitForStatus(ingestJobId, ['succeeded', 'failed']))?.status).toBe('succeeded');
      const oldVersionId = (await repo.knowledge.getDocument(db, documentId))?.currentVersionId;
      expect(oldVersionId).toBeTruthy();
      embeddingCalls = 0;

      const reindex = await repo.knowledge.createJob(db, {
        type: 'reindex',
        baseId,
        documentId,
        sourceId: null,
        payload: { type: 'reindex', baseId, documentIds: [documentId] },
      });
      let active = 0;
      let delayed = 0;
      let failed = 0;
      let completed = 0;
      // DB 终态先写，processor finally 删 key 后 BullMQ 才发 completed；入队前就等这个事件。
      let resolveCompleted!: () => void;
      const completedEvent = new Promise<void>((resolve) => {
        resolveCompleted = resolve;
      });
      events.on('active', ({ jobId }) => {
        if (jobId === reindex.id) active += 1;
      });
      // BullMQ 6 对还有剩余 attempts 的失败发 delayed（排入退避重试），不发 failed。
      events.on('delayed', ({ jobId }) => {
        if (jobId === reindex.id) delayed += 1;
      });
      events.on('failed', ({ jobId }) => {
        if (jobId === reindex.id) failed += 1;
      });
      events.on('completed', ({ jobId }) => {
        if (jobId === reindex.id) {
          completed += 1;
          resolveCompleted();
        }
      });

      failNextEmbedding = true;
      await queue.add('knowledge', { jobId: reindex.id }, knowledgeEnqueueOptions(reindex.id));
      const statuses = ['queued'];
      let last = 'queued';
      let oldVersionHeldDuringRetry = false;
      let retryState = '';
      let retryReason = '';
      const deadline = Date.now() + 25_000;
      let row = await repo.knowledge.getJob(db, reindex.id);
      while (row?.status !== 'succeeded' && row?.status !== 'failed' && Date.now() < deadline) {
        if (row && row.status !== last) {
          statuses.push(row.status);
          last = row.status;
        }
        if (row?.status === 'queued' && row.attempts >= 1) {
          const during = await repo.knowledge.getDocument(db, documentId);
          oldVersionHeldDuringRetry = during?.currentVersionId === oldVersionId;
          const queueJob = await queue.getJob(reindex.id);
          const state = (await queueJob?.getState()) ?? '';
          // 重试生效前队列还是 active，退避期间才是 delayed；只保留观察到的退避态。
          if (state === 'delayed') retryState = state;
          if (retryReason === '') retryReason = queueJob?.failedReason ?? '';
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        row = await repo.knowledge.getJob(db, reindex.id);
      }
      if (row && row.status !== last) statuses.push(row.status);
      // DB 已是 succeeded 时事件可能还没到；等它落地再断言原计数。
      if (row?.status === 'succeeded') await completedEvent;

      // BullMQ 真实重投：两次 active、一次推迟重试、一次完成，DB 认领两次并最终成功。
      expect(row?.status).toBe('succeeded');
      expect(row?.attempts).toBeGreaterThanOrEqual(2);
      expect(active).toBe(2);
      expect(delayed).toBe(1);
      expect(failed).toBe(0);
      expect(completed).toBe(1);
      expect(retryState).toBe('delayed');
      expect(retryReason).toContain('HTTP 503');
      expect(statuses).toContain('running');
      // queued 出现两次：入队初始态与第一次失败后的重试态。
      expect(statuses.filter((status) => status === 'queued')).toHaveLength(2);
      expect(statuses.at(-1)).toBe('succeeded');
      expect(oldVersionHeldDuringRetry).toBe(true);
      // 一次 503 + 一次成功，没有把可重试错误吞成永久失败。
      expect(embeddingCalls).toBe(2);

      const current = await repo.knowledge.getDocument(db, documentId);
      expect(current?.status).toBe('ready');
      expect(current?.currentVersionId).toBeTruthy();
      expect(current?.currentVersionId).not.toBe(oldVersionId);
      expect(await repo.knowledge.getVersion(db, oldVersionId ?? '')).not.toBeNull();
      const chunks = await repo.knowledge.listChunks(db, current?.currentVersionId ?? '');
      expect(chunks.items.length).toBeGreaterThan(0);
      expect(chunks.items.every((chunk) => chunk.embedding?.length === 1024)).toBe(true);
    } finally {
      await queue.close();
      await events.close();
      await worker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('keeps a sync run running across a retryable embedding failure and only succeeds with the cursor', async () => {
    // 首次 embedding 返回 503；重试等待期间 run 不能提前落 failed/cancelled，成功时才推进游标。
    let failNextEmbedding = false;
    let embeddingCalls = 0;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        embeddingCalls += 1;
        if (failNextEmbedding) {
          failNextEmbedding = false;
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'temporarily down' }));
          return;
        }
        const parsed = JSON.parse(raw) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: parsed.input.map((_, index) => ({
              index,
              embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? index + 1 : 0)),
            })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture bind failed');

    const { baseId } = await seedJob();
    const base = await repo.knowledge.getBase(db, baseId);
    if (!base?.embeddingProfileId) throw new Error('base missing');
    await db
      .update(schema.knowledgeModelProfiles)
      .set({ endpointUrl: `http://127.0.0.1:${address.port}` })
      .where(eq(schema.knowledgeModelProfiles.id, base.embeddingProfileId));

    const source = await repo.knowledge.createSource(db, {
      baseId,
      type: 'feed',
      name: 'sync-retry-feed',
      config: { syncDeletions: false },
      secretsEncrypted: null,
      syncCron: null,
    });
    await repo.knowledge.replaceRanges(db, source.id, [
      { kind: 'feed', externalId: 'https://example.com/feed', ref: null, paths: [], enabled: true },
    ]);
    const run = await repo.knowledge.createSyncRun(db, source.id, {});
    const job = await repo.knowledge.createJob(db, {
      type: 'sync',
      baseId,
      documentId: null,
      sourceId: source.id,
      payload: { type: 'sync', sourceId: source.id, syncRunId: run.id },
    });

    const connector = {
      async *sync({
        onCheckpoint,
      }: {
        onCheckpoint: (
          cursor: Record<string, unknown>,
          checkpoint: { complete: boolean },
        ) => Promise<void>;
      }) {
        // 只有完整枚举后的成功收尾才允许推进游标；失败重试仍从旧游标重读。
        await onCheckpoint({ page: 1 }, { complete: true });
        yield {
          sourceId: 'feed-item-1',
          sourceUrl: 'https://example.com/1',
          sourcePath: null,
          title: 'item.md',
          mimeType: 'text/markdown',
          revision: 'r1',
          content: { markdown: '# synced item' },
        };
      },
    };

    const worker = await startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      parse: async ({ data }) => ({ markdown: data.toString('utf8'), images: [], pageMap: [] }),
      chunkMarkdown: (markdown) => [
        { kind: 'text', heading: null, content: markdown, pageFrom: null, pageTo: null },
      ],
      connectors: { feed: connector },
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, { connection: { url: redisUrl }, prefix });
    const events = new QueueEvents(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix,
    });
    events.on('error', () => undefined);
    await events.waitUntilReady();
    try {
      const retryScheduled = new Promise<boolean>((resolve) => {
        events.on('delayed', ({ jobId }) => {
          if (jobId === job.id) resolve(true);
        });
      });
      failNextEmbedding = true;
      await queue.add('knowledge', { jobId: job.id }, knowledgeEnqueueOptions(job.id));

      const delayed = await Promise.race([
        retryScheduled,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000).unref()),
      ]);
      expect(delayed).toBe(true);
      const queueJob = await queue.getJob(job.id);
      expect(await queueJob?.getState()).toBe('delayed');
      expect(queueJob?.failedReason).toContain('HTTP 503');

      // 重试等待期间：sync run 仍 running、未结束，来源游标还没有推进。
      const during = (await repo.knowledge.listSyncRuns(db, source.id)).items.find(
        (item) => item.id === run.id,
      );
      expect(during?.status).toBe('running');
      expect(during?.endedAt).toBeNull();
      expect(during?.error).toBeNull();
      expect((await repo.knowledge.getSource(db, source.id))?.cursor).toEqual({});

      const deadline = Date.now() + 20_000;
      let final = await repo.knowledge.getJob(db, job.id);
      while (final?.status !== 'succeeded' && final?.status !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        final = await repo.knowledge.getJob(db, job.id);
      }
      expect(final?.status).toBe('succeeded');
      expect(final?.attempts).toBeGreaterThanOrEqual(2);
      expect(embeddingCalls).toBe(2);

      const finished = (await repo.knowledge.listSyncRuns(db, source.id)).items.find(
        (item) => item.id === run.id,
      );
      expect(finished?.status).toBe('succeeded');
      expect(finished?.endedAt).toBeInstanceOf(Date);
      expect(finished?.error).toBeNull();
      expect(finished?.cursorAfter).toEqual({ page: 1 });
      expect(finished?.stats).toMatchObject({ listed: 1, failed: 0 });
      expect(finished?.stats.created + finished?.stats.updated).toBe(1);

      const synced = await repo.knowledge.getSource(db, source.id);
      expect(synced?.cursor).toEqual({ page: 1 });
      expect(synced?.lastSyncStatus).toBe('succeeded');
      const documents = await repo.knowledge.listDocuments(db, { baseId });
      expect(documents.items.find((document) => document.title === 'item.md')?.status).toBe(
        'ready',
      );
    } finally {
      await queue.close();
      await events.close();
      await worker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('fails an auth error without burning retries', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad key' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture bind failed');

    const { jobId, documentId } = await seedJob();
    const base = await repo.knowledge.getBase(
      db,
      (await repo.knowledge.getDocument(db, documentId))?.baseId ?? '',
    );
    await db
      .update(schema.knowledgeModelProfiles)
      .set({ endpointUrl: `http://127.0.0.1:${address.port}` })
      .where(eq(schema.knowledgeModelProfiles.id, base?.embeddingProfileId ?? ''));
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('hello world', 'utf8');
    const sha = createHash('sha256').update(body).digest('hex');
    await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), body);
    await repo.knowledge.updateDocument(db, documentId, { contentHash: sha });

    const worker = await startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      parse: async ({ data }) => ({ markdown: data.toString('utf8'), images: [], pageMap: [] }),
      chunkMarkdown: (markdown) => [
        { kind: 'text', heading: null, content: markdown, pageFrom: null, pageTo: null },
      ],
      connectors: {},
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl },
      prefix,
    });
    try {
      await queue.add('knowledge', { jobId }, knowledgeEnqueueOptions(jobId));
      const deadline = Date.now() + 15_000;
      let job = await repo.knowledge.getJob(db, jobId);
      while (job?.status !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = await repo.knowledge.getJob(db, jobId);
      }
      expect(job?.status).toBe('failed');
      expect(job?.error).toContain('auth');
      // auth 不重试：重试计数停在 1，而不是跑到 attempts=3。
      expect(job?.attempts).toBe(1);
    } finally {
      await queue.close();
      await worker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails only the unparseable job when Docling is unset and keeps consuming', async () => {
    const seedPdf = async () => {
      const seeded = await seedJob();
      const body = Buffer.from(`%PDF-1.7 ${seeded.documentId}`, 'utf8');
      const { createHash } = await import('node:crypto');
      const { mkdir, writeFile } = await import('node:fs/promises');
      const sha = createHash('sha256').update(body).digest('hex');
      await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
      await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), body);
      await repo.knowledge.updateDocument(db, seeded.documentId, {
        contentHash: sha,
        mimeType: 'application/pdf',
        metadata: { originalFilename: 'report.pdf' },
      });
      return seeded;
    };
    // 不注入 parse：走真实适配器；DOCLING_URL 为空时 PDF 明确失败，不是假成功。
    const worker = await startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      parser: { url: undefined, key: undefined },
      chunkMarkdown: (markdown) => [
        { kind: 'text', heading: null, content: markdown, pageFrom: null, pageTo: null },
      ],
      connectors: {},
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, { connection: { url: redisUrl }, prefix });
    const waitFor = async (id: string, statuses: string[]) => {
      const deadline = Date.now() + 15_000;
      let job = await repo.knowledge.getJob(db, id);
      while (!statuses.includes(job?.status ?? '') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = await repo.knowledge.getJob(db, id);
      }
      return job;
    };
    try {
      const first = await seedPdf();
      await queue.add(
        'knowledge',
        { jobId: first.jobId },
        { ...knowledgeEnqueueOptions(first.jobId), attempts: 1 },
      );
      const failed = await waitFor(first.jobId, ['failed', 'succeeded']);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toContain('Docling');

      // worker 仍在消费：第二个任务同样明确失败，而不是进程挂掉后永远 queued。
      const second = await seedPdf();
      await queue.add(
        'knowledge',
        { jobId: second.jobId },
        { ...knowledgeEnqueueOptions(second.jobId), attempts: 1 },
      );
      const alsoFailed = await waitFor(second.jobId, ['failed', 'succeeded']);
      expect(alsoFailed?.status).toBe('failed');
      expect(alsoFailed?.error).toContain('Docling');
    } finally {
      await queue.close();
      await worker.close();
    }
  });

  it('owns the wiki job terminal state and requires a saved draft', async () => {
    const { baseId, documentId } = await seedJob();
    const base = await repo.knowledge.getBase(db, baseId);
    if (!base?.embeddingProfileId) throw new Error('base missing');
    const version = await repo.knowledge.createVersion(db, {
      documentId,
      blobSha256: 'a'.repeat(64),
      markdownSha256: 'b'.repeat(64),
      originalFilename: 'doc.md',
      mimeType: 'text/markdown',
      sizeBytes: 16,
      sourceRevision: null,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: base.embeddingProfileId,
    });
    await repo.knowledge.setCurrentVersion(db, documentId, version.id);
    const [sourceChunk] = await repo.knowledge.insertChunks(db, {
      baseId,
      documentId,
      versionId: version.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          kind: 'text',
          heading: null,
          content: '# 来源',
          searchText: '# 来源',
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 2,
        },
      ],
    });
    if (!sourceChunk) throw new Error('chunk missing');
    const page = await repo.knowledge.createWikiPage(db, {
      baseId,
      slug: 'auth',
      title: '认证',
    });
    const ids = await Promise.all([createWikiJob(baseId, page.id), createWikiJob(baseId, page.id)]);
    let saveResult: { isError?: boolean; content?: Array<{ text: string }> } | undefined;

    const worker = await startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      wikiModel: 'wiki-test-model',
      connectors: {},
      // 第一个任务保存草稿；第二个 SDK 报成功却不保存。
      queryFn: (() => {
        let call = 0;
        return (params) => {
          const index = call++;
          async function* run() {
            const server = params.options.mcpServers?.knowledge as unknown as {
              instance: {
                _registeredTools: Record<
                  string,
                  { handler: (args: unknown, extra: unknown) => Promise<unknown> }
                >;
              };
            };
            if (index === 0) {
              saveResult = (await server.instance._registeredTools.wiki_save_draft?.handler(
                { markdown: '# 草稿', sourceChunkIds: [sourceChunk.id] },
                {},
              )) as typeof saveResult;
            }
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: '',
            } as never;
          }
          return run();
        };
      })(),
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl },
      prefix,
    });
    try {
      for (const jobId of ids) {
        await queue.add('knowledge', { jobId }, knowledgeEnqueueOptions(jobId));
      }
      const deadline = Date.now() + 15_000;
      let rows = await Promise.all(ids.map((id) => repo.knowledge.getJob(db, id)));
      while (rows.some((row) => row?.status === 'queued' || row?.status === 'running')) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        rows = await Promise.all(ids.map((id) => repo.knowledge.getJob(db, id)));
      }
      expect(rows.map((row) => row?.status).sort()).toEqual(['failed', 'succeeded']);
      // 成功分支必须真的通过 save tool 落库，空来源的旧写法现在会被拒绝。
      expect(saveResult?.isError).toBeFalsy();
      expect(saveResult?.content?.[0]?.text).toContain('"saved":true');
      const failed = rows.find((row) => row?.status === 'failed');
      expect(failed?.error).toContain('模型没有保存任何草稿');
      const versions = await repo.knowledge.listWikiVersions(db, page.id);
      expect(versions.items).toHaveLength(1);
    } finally {
      await queue.close();
      await worker.close();
    }
  });
  it('aborts active jobs on close and leaves them retryable', async () => {
    // 永不响应的 embedding 上游：只有 abort 才能结束这个请求。
    let arrived!: () => void;
    const requestInFlight = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let upstreamClosed!: () => void;
    const upstreamClose = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = { requestClosed: false, responseClosed: false, responseEnded: false };
    const hanging = createServer((req, res) => {
      req.resume();
      arrived();
      req.once('close', () => {
        upstream.requestClosed = true;
      });
      res.once('close', () => {
        upstream.responseClosed = true;
        upstream.responseEnded = res.writableEnded;
        upstreamClosed();
      });
    });
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const address = hanging.address();
    if (address === null || typeof address === 'string') throw new Error('fixture bind failed');

    const { jobId, documentId } = await seedJob();
    const base = await repo.knowledge.getBase(
      db,
      (await repo.knowledge.getDocument(db, documentId))?.baseId ?? '',
    );
    await db
      .update(schema.knowledgeModelProfiles)
      .set({ endpointUrl: `http://127.0.0.1:${address.port}` })
      .where(eq(schema.knowledgeModelProfiles.id, base?.embeddingProfileId ?? ''));

    const { writeFile, mkdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('shutdown job', 'utf8');
    const sha = createHash('sha256').update(body).digest('hex');
    await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
    await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), body);
    await repo.knowledge.updateDocument(db, documentId, { contentHash: sha });

    const worker = await startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      parse: async ({ data }) => ({ markdown: data.toString('utf8'), images: [], pageMap: [] }),
      chunkMarkdown: (markdown) => [
        { kind: 'text', heading: null, content: markdown, pageFrom: null, pageTo: null },
      ],
      connectors: {},
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl },
      prefix,
    });
    try {
      await queue.add('knowledge', { jobId }, knowledgeEnqueueOptions(jobId));
      const deadline = Date.now() + 10_000;
      let row = await repo.knowledge.getJob(db, jobId);
      while (row?.status !== 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        row = await repo.knowledge.getJob(db, jobId);
      }
      expect(row?.status).toBe('running');
      // DB 认领发生在发请求之前；必须等真实上游请求挂起，close 才是在中断执行中的任务。
      const inFlight = await Promise.race([
        requestInFlight.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000).unref()),
      ]);
      expect(inFlight).toBe(true);

      const startedAt = Date.now();
      const closing = worker.close();
      const outcome = await Promise.race([
        closing.then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
      ]);
      if (outcome === 'timeout') {
        // 失败路径清理：断开挂起的上游，让当前实现也能结束，不把 hook 拖到超时。
        hanging.closeAllConnections();
        await closing;
      }
      expect(outcome).toBe('closed');
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // abort 必须真正断开在途的上游请求，而不是让它继续挂着。
      const upstreamOutcome = await Promise.race([
        upstreamClose.then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000).unref()),
      ]);
      expect(upstreamOutcome).toBe('closed');
      expect(upstream).toEqual({ requestClosed: true, responseClosed: true, responseEnded: false });

      // SIGTERM 中断不是用户取消：任务回到 queued，等重启后重试，而不是标记成功/取消。
      expect((await repo.knowledge.getJob(db, jobId))?.status).toBe('queued');
      const retryState = await (await queue.getJob(jobId))?.getState();
      expect(['delayed', 'waiting']).toContain(retryState);

      // close 之后不再领取新任务。
      const next = await seedJob();
      await queue.add('knowledge', { jobId: next.jobId }, knowledgeEnqueueOptions(next.jobId));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await repo.knowledge.getJob(db, next.jobId))?.status).toBe('queued');
    } finally {
      hanging.closeAllConnections();
      await worker.close();
      await queue.close();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
});

// 对账扫描整表，必须独占随机库，不能碰共享库中其他套件的 queued/running 行。
describe('knowledge redelivery after a stalled job', () => {
  const redeliveryPrefix = `knowledge-redelivery-${randomUUID().slice(0, 8)}`;
  let isolated: Awaited<ReturnType<typeof createIsolatedDatabase>> = null;
  let dbHandle!: ReturnType<typeof createDb>;
  let db!: ReturnType<typeof createDb>['db'];
  let queue!: Queue<{ jobId: string }>;
  let worker: Awaited<ReturnType<typeof startKnowledgeWorker>> | undefined;

  const startWorker = () =>
    startKnowledgeWorker({
      db,
      logger: quiet,
      redisUrl,
      prefix: redeliveryPrefix,
      knowledgeDir,
      decrypt: () => ({}),
      connectors: {},
    });

  const queueLike = (): KnowledgeQueueLike => ({
    getJob: (id) =>
      queue.getJob(id) as unknown as Promise<{ getState: () => Promise<string> } | undefined>,
    remove: (id) => queue.remove(id),
    add: (_name, data, opts) => queue.add('knowledge', data, opts),
  });

  const waitForState = async (
    id: string,
    states: string[],
    timeoutMs = 10_000,
  ): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      last = (await (await queue.getJob(id))?.getState()) ?? '';
      if (states.includes(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return last;
  };

  const waitForRow = async (id: string, statuses: string[]) => {
    const deadline = Date.now() + 10_000;
    let row = await repo.knowledge.getJob(db, id);
    while (!statuses.includes(row?.status ?? '') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = await repo.knowledge.getJob(db, id);
    }
    return row;
  };

  beforeAll(async () => {
    // 库只在套件真正执行时创建：被 -t 过滤掉时不会留下空库。
    isolated = await createIsolatedDatabase('worker_knowledge_redelivery');
    if (!isolated) return;
    dbHandle = createDb(isolated.url);
    db = dbHandle.db;
    queue = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl },
      prefix: redeliveryPrefix,
    });
  });

  beforeEach(async (ctx) => {
    // 建库失败时整套跳过，而不是让队列/连接在用例里报空。
    if (!isolated) ctx.skip('PostgreSQL unavailable');
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await worker?.close();
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    if (dbHandle) await dbHandle.pool.end();
    await isolated?.close();
  });

  it('defers a redelivered running job instead of marking it completed, then reconcile and restart finish it', async () => {
    const job = await repo.knowledge.createJob(db, {
      type: 'cleanup',
      baseId: null,
      documentId: null,
      sourceId: null,
      payload: { type: 'cleanup' },
    });
    // 模拟已认领后崩溃的 worker：行停在 running，BullMQ 随后把同一个 job 重投。
    const claimed = await repo.knowledge.claimJob(db, job.id);
    expect(claimed).toMatchObject({ status: 'running', attempts: 1 });

    worker = await startWorker();
    await queue.add('knowledge', { jobId: job.id }, knowledgeEnqueueOptions(job.id));

    // 认领返回空但行仍是 running：必须延后重投，不能被记 completed。
    expect(await waitForState(job.id, ['delayed', 'completed', 'failed'])).toBe('delayed');
    expect((await repo.knowledge.getJob(db, job.id))?.status).toBe('running');
    const pending = await queue.getJob(job.id);
    expect(pending?.attemptsMade).toBe(0);

    // delayed job 不占 active，关闭不必等它。
    const closeStarted = Date.now();
    await worker.close();
    worker = undefined;
    expect(Date.now() - closeStarted).toBeLessThan(5_000);

    // 既有对账把超过宽限的 running 行退回 queued，delayed job 仍在队列里。
    await db
      .update(schema.knowledgeJobs)
      .set({ startedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.knowledgeJobs.id, job.id));
    const reconciled = await reconcileKnowledgeJobs(db, quiet, queueLike());
    expect(reconciled.requeued).toBeGreaterThanOrEqual(1);
    expect((await repo.knowledge.getJob(db, job.id))?.status).toBe('queued');

    worker = await startWorker();
    await (await queue.getJob(job.id))?.promote();
    const finished = await waitForRow(job.id, ['succeeded', 'failed']);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.attempts).toBe(2);
    expect(finished?.endedAt).toBeInstanceOf(Date);
  });

  it('still skips cancelled or missing rows without delaying them', async () => {
    const cancelled = await repo.knowledge.createJob(db, {
      type: 'cleanup',
      baseId: null,
      documentId: null,
      sourceId: null,
      payload: { type: 'cleanup' },
    });
    await repo.knowledge.requestCancel(db, cancelled.id);
    const missing = newId('knowledgeJob');

    worker = await startWorker();
    await queue.add('knowledge', { jobId: cancelled.id }, knowledgeEnqueueOptions(cancelled.id));
    await queue.add('knowledge', { jobId: missing }, knowledgeEnqueueOptions(missing));

    expect(await waitForState(cancelled.id, ['completed', 'failed', 'delayed'])).toBe('completed');
    expect(await waitForState(missing, ['completed', 'failed', 'delayed'])).toBe('completed');
    expect((await repo.knowledge.getJob(db, cancelled.id))?.status).toBe('cancelled');
    expect(await repo.knowledge.getJob(db, missing)).toBeNull();
  });
});

async function createWikiJob(baseId: string, pageId: string): Promise<string> {
  const job = await repo.knowledge.createJob(db, {
    type: 'wiki_generate',
    baseId,
    documentId: null,
    sourceId: null,
    payload: { type: 'wiki_generate', baseId, pageId },
  });
  return job.id;
}
