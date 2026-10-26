import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { KNOWLEDGE_JOBS_QUEUE, knowledgeEnqueueOptions } from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKnowledgeWorker } from '../src/knowledge/queue.js';

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
    const { baseId } = await seedJob();
    const page = await repo.knowledge.createWikiPage(db, {
      baseId,
      slug: 'auth',
      title: '认证',
    });
    const ids = await Promise.all([createWikiJob(baseId, page.id), createWikiJob(baseId, page.id)]);

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
              await server.instance._registeredTools.wiki_save_draft?.handler(
                { markdown: '# 草稿', sourceChunkIds: [] },
                {},
              );
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
      const failed = rows.find((row) => row?.status === 'failed');
      expect(failed?.error).toContain('模型没有保存任何草稿');
      const versions = await repo.knowledge.listWikiVersions(db, page.id);
      expect(versions.items).toHaveLength(1);
    } finally {
      await queue.close();
      await worker.close();
    }
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
