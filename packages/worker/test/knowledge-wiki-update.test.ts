import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChunkDraft,
  type KnowledgeDeps,
  runIngest,
  type WikiUpdateInput,
} from '../src/knowledge/ingestion.js';

/**
 * 摄取成功后的 Wiki 联动：真实 DB + 真实 HTTP embedding fixture；
 * 只有队列边界用假回调，避免测试自己开第二个 Redis singleton。
 */
const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as KnowledgeDeps['logger'];

const chunkStub = (markdown: string): ChunkDraft[] =>
  markdown
    .split(/\n{2,}/)
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content) => ({
      kind: 'text' as const,
      heading: null,
      content,
      pageFrom: null,
      pageTo: null,
    }));

let fixture: Server;
let fixtureUrl = '';
let embeddingStatus = 200;
let knowledgeDir = '';
const baseIds: string[] = [];

beforeAll(async () => {
  fixture = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (req.url !== '/embeddings') {
        res.writeHead(404).end();
        return;
      }
      if (embeddingStatus !== 200) {
        res.writeHead(embeddingStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
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
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await dbHandle.pool.end();
});

beforeEach(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-wiki-update-'));
  embeddingStatus = 200;
});
afterEach(async () => {
  if (baseIds.length > 0) {
    // delete cascade 掉 wiki 页/版本/来源、job、文档与 chunk。
    await dbHandle.pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
    baseIds.length = 0;
  }
  await rm(knowledgeDir, { recursive: true, force: true });
});

const suffix = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Fixture {
  baseId: string;
  deps: KnowledgeDeps;
  notified: WikiUpdateInput[];
}

async function makeBase(settings: { wikiAutoUpdate: boolean }): Promise<Fixture> {
  const id = suffix();
  const serverId = newId('server');
  await db
    .insert(schema.servers)
    .values({ id: serverId, name: `kb-wiki-update-${id}`, kind: 'knowledge', config: {} });
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-wiki-update-${id}`,
    endpointUrl: fixtureUrl,
    model: 'test',
    dimensions: 1024,
    enabled: true,
  });
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-wiki-update-${id}`,
    name: `kb wiki update ${id}`,
    description: '',
    serverId,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: { chunkTokens: 400, chunkOverlap: 40, ...settings },
  });
  const notified: WikiUpdateInput[] = [];
  baseIds.push(base.id);
  return {
    baseId: base.id,
    notified,
    deps: {
      db,
      logger: quiet,
      knowledgeDir,
      parse: async ({ data }) => ({ markdown: data.toString('utf8'), images: [], pageMap: [] }),
      chunkMarkdown: chunkStub,
      connectors: {},
      decrypt: () => ({ apiKey: 'test-key' }),
      onWikiUpdate: async (input) => {
        notified.push(input);
      },
    },
  };
}

async function writeBlob(data: Buffer): Promise<string> {
  const sha = createHash('sha256').update(data).digest('hex');
  await mkdir(join(knowledgeDir, 'blobs', sha.slice(0, 2)), { recursive: true });
  await writeFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), data);
  return sha;
}

/** 已就绪文档：当前版本 + 一个可引用 chunk。 */
async function seedReadyDocument(
  baseId: string,
  markdown = '# 认证\n\n旧内容：令牌有效期 30 天。',
): Promise<{ documentId: string; versionId: string; chunkId: string }> {
  const documentId = newId('knowledgeDocument');
  await db.insert(schema.knowledgeDocuments).values({
    id: documentId,
    baseId,
    title: 'auth.md',
    sourceType: 'upload',
    mimeType: 'text/markdown',
    status: 'processing',
  });
  const base = await repo.knowledge.getBase(db, baseId);
  const version = await repo.knowledge.createVersion(db, {
    documentId,
    blobSha256: await writeBlob(Buffer.from(markdown, 'utf8')),
    markdownSha256: createHash('sha256').update(markdown).digest('hex'),
    originalFilename: 'auth.md',
    mimeType: 'text/markdown',
    sizeBytes: markdown.length,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: base?.embeddingProfileId ?? '',
  });
  await repo.knowledge.setCurrentVersion(db, documentId, version.id);
  const chunks = await repo.knowledge.insertChunks(db, {
    baseId,
    documentId,
    versionId: version.id,
    folderId: null,
    chunks: [
      {
        ordinal: 0,
        kind: 'text',
        heading: null,
        content: markdown,
        searchText: markdown,
        embedding: null,
        pageFrom: null,
        pageTo: null,
        tokenCount: 10,
      },
    ],
  });
  const chunk = chunks[0];
  if (!chunk) throw new Error('chunk missing');
  return { documentId, versionId: version.id, chunkId: chunk.id };
}

/** 手动发布一页，并把页面来源指向给定 chunk（页面因此与文档关联）。 */
async function publishLinkedPage(
  baseId: string,
  source: { documentId: string; versionId: string; chunkId: string },
  title = '认证',
): Promise<{ pageId: string; versionId: string }> {
  const page = await repo.knowledge.createWikiPage(db, {
    baseId,
    slug: `page-${suffix()}`,
    title,
  });
  const version = await repo.knowledge.saveWikiVersion(db, page.id, {
    markdown: `# ${title}\n\n人工发布的内容。`,
    sourceChunkIds: [source.chunkId],
    model: 'manual',
    generatedBy: 'manual',
  });
  if (!version) throw new Error('wiki version missing');
  await repo.knowledge.publishWikiVersion(db, page.id, version.id);
  return { pageId: page.id, versionId: version.id };
}

/** 新内容作为下一次 ingest：写 blob、更新 contentHash、建并认领 job。 */
async function startIngest(
  documentId: string,
  body: string,
): Promise<{
  jobId: string;
  document: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getJob>>>;
}> {
  const data = Buffer.from(body, 'utf8');
  const sha = await writeBlob(data);
  const document = await repo.knowledge.getDocument(db, documentId);
  if (!document) throw new Error('document missing');
  await repo.knowledge.updateDocument(db, documentId, { contentHash: sha });
  const job = await repo.knowledge.createJob(db, {
    type: 'ingest',
    baseId: document.baseId,
    documentId,
    sourceId: null,
    payload: { type: 'ingest', documentId },
  });
  const claimed = await repo.knowledge.claimJob(db, job.id);
  if (!claimed) throw new Error('job not claimed');
  return { jobId: job.id, document: claimed };
}

async function wikiJobs(baseId: string) {
  return db
    .select()
    .from(schema.knowledgeJobs)
    .where(
      and(eq(schema.knowledgeJobs.baseId, baseId), eq(schema.knowledgeJobs.type, 'wiki_generate')),
    );
}

describe('ingestion → wiki linkage', () => {
  it('marks linked pages stale and enqueues a draft job after a successful version switch', async () => {
    const fixtureBase = await makeBase({ wikiAutoUpdate: true });
    const seeded = await seedReadyDocument(fixtureBase.baseId);
    const page = await publishLinkedPage(fixtureBase.baseId, seeded);
    const { jobId, document } = await startIngest(
      seeded.documentId,
      '# 认证\n\n新内容：令牌有效期改为 7 天。',
    );

    await runIngest(fixtureBase.deps, document, new AbortController().signal);

    const after = await repo.knowledge.getWikiPage(db, page.pageId);
    // 已发布内容与页面指针不动，只提示需要复核。
    expect(after?.status).toBe('stale');
    expect(after?.currentVersionId).toBe(page.versionId);

    expect(fixtureBase.notified).toHaveLength(1);
    expect(fixtureBase.notified[0]?.baseId).toBe(fixtureBase.baseId);
    expect(fixtureBase.notified[0]?.jobIds).toHaveLength(1);
    const jobs = await wikiJobs(fixtureBase.baseId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(fixtureBase.notified[0]?.jobIds[0]);
    expect(jobs[0]?.payload).toMatchObject({
      type: 'wiki_generate',
      baseId: fixtureBase.baseId,
      pageId: page.pageId,
    });
    // 新版本已切换，旧 chunk 仍保留历史引用。
    const updated = await repo.knowledge.getDocument(db, seeded.documentId);
    expect(updated?.currentVersionId).not.toBe(seeded.versionId);
    expect(await repo.knowledge.listChunks(db, seeded.versionId)).toMatchObject({
      items: [{ id: seeded.chunkId }],
    });
    expect(jobId).toBeTruthy();
  });

  it('keeps wiki untouched when the new version fails', async () => {
    const fixtureBase = await makeBase({ wikiAutoUpdate: true });
    const seeded = await seedReadyDocument(fixtureBase.baseId);
    const page = await publishLinkedPage(fixtureBase.baseId, seeded);
    embeddingStatus = 500;
    const { document } = await startIngest(seeded.documentId, '# 认证\n\n失败的新内容。');

    await expect(
      runIngest(fixtureBase.deps, document, new AbortController().signal),
    ).rejects.toThrow();

    const after = await repo.knowledge.getWikiPage(db, page.pageId);
    expect(after?.status).toBe('published');
    expect(after?.currentVersionId).toBe(page.versionId);
    expect(fixtureBase.notified).toHaveLength(0);
    expect(await wikiJobs(fixtureBase.baseId)).toHaveLength(0);
  });

  it('keeps wiki untouched when the job is cancelled', async () => {
    const fixtureBase = await makeBase({ wikiAutoUpdate: true });
    const seeded = await seedReadyDocument(fixtureBase.baseId);
    const page = await publishLinkedPage(fixtureBase.baseId, seeded);
    const { document } = await startIngest(seeded.documentId, '# 认证\n\n被取消的新内容。');
    const controller = new AbortController();
    controller.abort();

    await expect(runIngest(fixtureBase.deps, document, controller.signal)).rejects.toThrow(
      'cancelled',
    );

    expect((await repo.knowledge.getWikiPage(db, page.pageId))?.status).toBe('published');
    expect(fixtureBase.notified).toHaveLength(0);
    expect(await wikiJobs(fixtureBase.baseId)).toHaveLength(0);
  });

  it('only marks stale when wikiAutoUpdate is off', async () => {
    const fixtureBase = await makeBase({ wikiAutoUpdate: false });
    const seeded = await seedReadyDocument(fixtureBase.baseId);
    const page = await publishLinkedPage(fixtureBase.baseId, seeded);
    const { document } = await startIngest(seeded.documentId, '# 认证\n\n新内容。');

    await runIngest(fixtureBase.deps, document, new AbortController().signal);

    expect((await repo.knowledge.getWikiPage(db, page.pageId))?.status).toBe('stale');
    expect(fixtureBase.notified).toHaveLength(0);
    expect(await wikiJobs(fixtureBase.baseId)).toHaveLength(0);
  });

  it('does not fake auto-update when no queue callback is wired', async () => {
    const fixtureBase = await makeBase({ wikiAutoUpdate: true });
    delete fixtureBase.deps.onWikiUpdate;
    const seeded = await seedReadyDocument(fixtureBase.baseId);
    const page = await publishLinkedPage(fixtureBase.baseId, seeded);
    const { document } = await startIngest(seeded.documentId, '# 认证\n\n新内容。');

    await runIngest(fixtureBase.deps, document, new AbortController().signal);

    expect((await repo.knowledge.getWikiPage(db, page.pageId))?.status).toBe('stale');
    expect(await wikiJobs(fixtureBase.baseId)).toHaveLength(0);
  });

  it('creates one overview page for the first document and reuses it afterwards', async () => {
    const fixtureBase = await makeBase({ wikiAutoUpdate: true });
    const first = await startIngestForNewDocument(fixtureBase.baseId, '# 一\n\n第一篇。');
    await runIngest(fixtureBase.deps, first, new AbortController().signal);

    const pagesAfterFirst = await repo.knowledge.listWikiPages(db, fixtureBase.baseId);
    expect(pagesAfterFirst.items).toHaveLength(1);
    expect(pagesAfterFirst.items[0]?.slug).toBe('overview');
    const overviewId = pagesAfterFirst.items[0]?.id;
    // 上一轮索引任务已结束，才允许为同一页再投一次草稿任务。
    await db
      .update(schema.knowledgeJobs)
      .set({ status: 'succeeded', endedAt: new Date() })
      .where(eq(schema.knowledgeJobs.baseId, fixtureBase.baseId));

    const second = await startIngestForNewDocument(fixtureBase.baseId, '# 二\n\n第二篇。');
    await runIngest(fixtureBase.deps, second, new AbortController().signal);

    const pagesAfterSecond = await repo.knowledge.listWikiPages(db, fixtureBase.baseId);
    expect(pagesAfterSecond.items).toHaveLength(1);
    expect(fixtureBase.notified).toHaveLength(2);
    const jobs = await wikiJobs(fixtureBase.baseId);
    expect(jobs.map((job) => job.payload.pageId)).toEqual([overviewId, overviewId]);
  });

  it('dedupes per page across multiple linked pages and skips pages with a pending job', async () => {
    const fixtureBase = await makeBase({ wikiAutoUpdate: true });
    const seeded = await seedReadyDocument(fixtureBase.baseId);
    const firstPage = await publishLinkedPage(fixtureBase.baseId, seeded, '认证');
    // 第二个页面同样引用该文档（不同 chunk 行）：只应各收到一个任务。
    await db.insert(schema.knowledgeWikiSources).values({
      pageId: (
        await repo.knowledge.createWikiPage(db, {
          baseId: fixtureBase.baseId,
          slug: `second-${suffix()}`,
          title: '令牌',
        })
      ).id,
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      chunkId: null,
    });

    const first = await startIngest(seeded.documentId, '# 认证\n\n第一次更新。');
    await runIngest(fixtureBase.deps, first.document, new AbortController().signal);
    expect(fixtureBase.notified[0]?.jobIds).toHaveLength(2);

    // 任务仍在 queued：再次摄取同一文档不得给同一页再塞一个任务。
    const second = await startIngest(seeded.documentId, '# 认证\n\n第二次更新。');
    await runIngest(fixtureBase.deps, second.document, new AbortController().signal);

    const jobs = await wikiJobs(fixtureBase.baseId);
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((job) => job.payload.pageId === firstPage.pageId)).toHaveLength(1);
  });
});

/** 全新文档（无当前版本）走第一次摄取。 */
async function startIngestForNewDocument(
  baseId: string,
  body: string,
): Promise<NonNullable<Awaited<ReturnType<typeof repo.knowledge.getJob>>>> {
  const data = Buffer.from(body, 'utf8');
  const sha = await writeBlob(data);
  const document = await repo.knowledge.createDocument(db, {
    baseId,
    folderId: null,
    title: 'doc.md',
    sourceType: 'upload',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'text/markdown',
    sizeBytes: data.length,
    metadata: { originalFilename: 'doc.md' },
  });
  await repo.knowledge.updateDocument(db, document.id, { contentHash: sha });
  const job = await repo.knowledge.createJob(db, {
    type: 'ingest',
    baseId,
    documentId: document.id,
    sourceId: null,
    payload: { type: 'ingest', documentId: document.id },
  });
  const claimed = await repo.knowledge.claimJob(db, job.id);
  if (!claimed) throw new Error('job not claimed');
  return claimed;
}
