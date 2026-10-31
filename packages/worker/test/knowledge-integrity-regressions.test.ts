import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchKnowledge } from '../../api/src/features/knowledge/retrieval.js';
import { knowledgeConnectors } from '../src/knowledge/connector-adapter.js';
import {
  type ChunkDraft,
  KnowledgeCancelled,
  type KnowledgeConnector,
  type KnowledgeDeps,
  runIngest,
  runReindex,
  runSourceProbe,
  runSync,
} from '../src/knowledge/ingestion.js';
import { createParsingAdapter } from '../src/knowledge/parsing-adapter.js';
import { SourceAuthError } from '../src/knowledge/sources.js';
import { createIsolatedDatabase } from './isolated-db.js';

// 回归套件写入知识库文档、版本与 chunk：独享随机库，避免与其它文件互相收敛。
const isolated = await createIsolatedDatabase('worker_knowledge_integrity');
const ready = isolated !== null;
if (isolated) process.env.DATABASE_URL = isolated.url;
let dbHandle: ReturnType<typeof createDb> | undefined;
let db: ReturnType<typeof createDb>['db'];
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

// 本地 fixture：embedding 协议与 feed/全文两个 HTTP 页面都走真实网络。
let fixture: Server;
let fixtureUrl = '';
let articleFails = false;

beforeAll(async () => {
  if (isolated) {
    dbHandle = createDb(isolated.url);
    db = dbHandle.db;
  }
  fixture = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fixture').pathname;
      if (path === '/embeddings') {
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
        return;
      }
      if (path === '/feed') {
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        res.end(
          `<rss version="2.0"><channel><title>Integrity Feed</title><item>` +
            `<guid>post-1</guid><title>Post One</title>` +
            `<link>${fixtureUrl}/article</link>` +
            `<description>summary only</description>` +
            `</item></channel></rss>`,
        );
        return;
      }
      if (path === '/article') {
        if (articleFails) {
          res.writeHead(503).end('temporarily unavailable');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><article><p>full article body alpha</p></article></body></html>');
        return;
      }
      if (path.startsWith('/docling/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          readFileSync(
            new URL('./fixtures/knowledge-parsing/docling-success.json', import.meta.url),
            'utf8',
          ),
        );
        return;
      }
      res.writeHead(404).end('missing');
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await dbHandle?.pool.end();
  await isolated?.close();
});

let knowledgeDir = '';
beforeEach(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-integrity-'));
  articleFails = false;
});
afterEach(async () => {
  await rm(knowledgeDir, { recursive: true, force: true });
});

const suffix = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Fixture {
  baseId: string;
  profileId: string;
  deps: KnowledgeDeps;
}

async function makeBase(): Promise<Fixture> {
  const id = suffix();
  const serverId = newId('server');
  await db.insert(schema.servers).values({
    id: serverId,
    name: `kb-integrity-${id}`,
    kind: 'knowledge',
    config: { knowledgeBaseId: `pending-${id}` },
  });
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-${id}`,
    endpointUrl: fixtureUrl,
    model: 'test-embed',
    dimensions: 1024,
    // 不加密：检索入口按 APP_SECRET_KEY 解密，空值才走真实关键词/向量路径。
    secretsEncrypted: null,
    enabled: true,
  });
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-integrity-${id}`,
    name: `kb integrity ${id}`,
    description: '',
    serverId,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: {
      chunkTokens: 400,
      chunkOverlap: 40,
      wikiAutoUpdate: false,
      imageProcessing: {
        enabled: false,
        model: null,
        ocrEnabled: true,
        captionEnabled: true,
        descriptionLanguage: 'zh-CN',
        customInstructions: '',
        imageVectorEnabled: false,
        imageVectorMinScore: 0.3,
      },
    },
  });
  return {
    baseId: base.id,
    profileId,
    deps: {
      db,
      logger: quiet,
      knowledgeDir,
      parse: async ({ data }) => ({ markdown: data.toString('utf8'), images: [], pageMap: [] }),
      chunkMarkdown: chunkStub,
      connectors: {},
      decrypt: () => ({ apiKey: '{{SECRET_TEST_API_KEY}}' }),
    },
  };
}

async function makeSource(
  fixtureBase: Fixture,
  connector: KnowledgeConnector,
  type: 'feed' | 'gitlab' = 'gitlab',
): Promise<{ sourceId: string }> {
  fixtureBase.deps.connectors = { ...fixtureBase.deps.connectors, [type]: connector };
  const source = await repo.knowledge.createSource(db, {
    baseId: fixtureBase.baseId,
    type,
    name: type,
    config: {},
    secretsEncrypted: null,
    syncCron: null,
  });
  await repo.knowledge.replaceRanges(db, source.id, [
    {
      kind: type === 'feed' ? 'feed' : 'gitlab_project',
      externalId: type === 'feed' ? `${fixtureUrl}/feed` : 'group/proj',
      ref: null,
      paths: [],
      enabled: true,
    },
  ]);
  return { sourceId: source.id };
}

async function startSync(
  fixtureBase: Fixture,
  sourceId: string,
): Promise<{ jobId: string; syncRunId: string }> {
  const run = await repo.knowledge.createSyncRun(db, sourceId, {});
  const job = await repo.knowledge.createJob(db, {
    type: 'sync',
    baseId: fixtureBase.baseId,
    documentId: null,
    sourceId,
    payload: { type: 'sync', sourceId, syncRunId: run.id },
  });
  await repo.knowledge.claimJob(db, job.id);
  return { jobId: job.id, syncRunId: run.id };
}

async function runSyncJob(fixtureBase: Fixture, sourceId: string): Promise<{ syncRunId: string }> {
  const { jobId, syncRunId } = await startSync(fixtureBase, sourceId);
  const job = await repo.knowledge.getJob(db, jobId);
  if (!job) throw new Error('sync job missing');
  await runSync(fixtureBase.deps, job, new AbortController().signal);
  return { syncRunId };
}

async function runReindexJob(
  fixtureBase: Fixture,
  payload: { documentIds?: string[]; confirmOverwriteManualChunks?: boolean } = {},
): Promise<void> {
  const job = await repo.knowledge.createJob(db, {
    type: 'reindex',
    baseId: fixtureBase.baseId,
    documentId: payload.documentIds?.[0] ?? null,
    sourceId: null,
    payload: { type: 'reindex', baseId: fixtureBase.baseId, ...payload },
  });
  await repo.knowledge.claimJob(db, job.id);
  const claimed = await repo.knowledge.getJob(db, job.id);
  if (!claimed) throw new Error('reindex job missing');
  await runReindex(fixtureBase.deps, claimed, new AbortController().signal);
}

async function documentsOfBase(fixtureBase: Fixture) {
  return db
    .select()
    .from(schema.knowledgeDocuments)
    .where(eq(schema.knowledgeDocuments.baseId, fixtureBase.baseId));
}

async function currentChunks(documentId: string) {
  const document = await repo.knowledge.getDocument(db, documentId);
  if (!document?.currentVersionId) throw new Error('document has no current version');
  return (await repo.knowledge.listChunks(db, document.currentVersionId)).items;
}

/** 按 worker 的寻址规则写原件，再把 hash 记到文档上，模拟 API 已完成上传。 */
async function writeBlob(content: Buffer): Promise<string> {
  const sha = createHash('sha256').update(content).digest('hex');
  const target = join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return sha;
}

async function seedManualDocument(
  fixtureBase: Fixture,
  title: string,
  content: string,
  options: { mimeType?: string; filename?: string } = {},
): Promise<typeof schema.knowledgeDocuments.$inferSelect> {
  const data = Buffer.from(content, 'utf8');
  const sha = await writeBlob(data);
  const document = await repo.knowledge.createDocument(db, {
    baseId: fixtureBase.baseId,
    folderId: null,
    title,
    sourceType: 'manual',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: options.mimeType ?? 'text/markdown',
    sizeBytes: data.length,
    metadata: { originalFilename: options.filename ?? `${title}.md` },
  });
  await repo.knowledge.updateDocument(db, document.id, { contentHash: sha });
  return document;
}

async function seedFaqDocument(
  fixtureBase: Fixture,
  faq: {
    question: string;
    similarQuestions: string[];
    negativeQuestions: string[];
    answers: string[];
    answerStrategy: 'all' | 'random';
    isRecommended: boolean;
  },
): Promise<{ documentId: string; versionId: string; jobId: string }> {
  const document = await repo.knowledge.createDocument(db, {
    baseId: fixtureBase.baseId,
    folderId: null,
    title: faq.question,
    sourceType: 'manual',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'application/json',
    sizeBytes: 0,
    contentKind: 'faq',
    metadata: { originalFilename: `${faq.question}.faq.json` },
  });
  const faqJson = Buffer.from(JSON.stringify(faq, null, 2), 'utf8');
  const blob = await writeBlob(faqJson);
  const versionId = newId('knowledgeVersion');
  const originalFilename = `${faq.question}.faq.json`;
  // 与 API 草稿流程一致：版本关联本任务的不可变输入快照，发布时由 repo 核对。
  const job = await repo.knowledge.createJob(db, {
    type: 'ingest',
    baseId: fixtureBase.baseId,
    documentId: document.id,
    sourceId: null,
    payload: {
      type: 'ingest',
      documentId: document.id,
      publish: 'draft',
      versionId,
      input: {
        blobSha256: blob,
        filename: originalFilename,
        mimeType: 'application/json',
        expectedCurrentVersionId: null,
      },
    },
  });
  await repo.knowledge.createVersion(db, {
    id: versionId,
    documentId: document.id,
    blobSha256: blob,
    markdownSha256: createHash('sha256').update(faq.question).digest('hex'),
    originalFilename,
    mimeType: 'application/json',
    sizeBytes: faqJson.length,
    sourceRevision: null,
    origin: 'faq',
    parentVersionId: null,
    metadata: { publication: 'draft', indexingJobId: job.id },
    faq,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: fixtureBase.profileId,
  });
  return { documentId: document.id, versionId, jobId: job.id };
}

/** 运行已落的 FAQ 摄取任务，不改任务终态；发布前由调用方按需 finishJob。 */
async function indexSeededFaq(fixtureBase: Fixture, seeded: { jobId: string }): Promise<void> {
  await repo.knowledge.claimJob(db, seeded.jobId);
  const claimed = await repo.knowledge.getJob(db, seeded.jobId);
  if (!claimed) throw new Error('seeded faq job missing');
  await runIngest(fixtureBase.deps, claimed, new AbortController().signal);
}

async function runIngestJob(
  fixtureBase: Fixture,
  documentId: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const job = await repo.knowledge.createJob(db, {
    type: 'ingest',
    baseId: fixtureBase.baseId,
    documentId,
    sourceId: null,
    payload: { type: 'ingest', documentId, ...payload },
  });
  await repo.knowledge.claimJob(db, job.id);
  const claimed = await repo.knowledge.getJob(db, job.id);
  if (!claimed) throw new Error('ingest job missing');
  await runIngest(fixtureBase.deps, claimed, new AbortController().signal);
  return job.id;
}

async function searchHits(fixtureBase: Fixture, q: string) {
  return searchKnowledge(
    db,
    fixtureBase.baseId,
    { q, folders: [], tags: [], limit: 10, rerank: false },
    { secretKey: process.env.APP_SECRET_KEY ?? '' },
  );
}

function item(
  content: string,
  sourceId = 'item-1',
): {
  sourceId: string;
  sourceUrl: string | null;
  sourcePath: string | null;
  title: string;
  mimeType: string;
  revision: string;
  content: { markdown: string };
} {
  return {
    sourceId,
    sourceUrl: 'https://example.com/item-1',
    sourcePath: null,
    title: 'item-1',
    mimeType: 'text/markdown',
    revision: 'r1',
    content: { markdown: content },
  };
}

describe.skipIf(!ready)('knowledge integrity regressions', () => {
  it('A: a revoked document stays disabled and unsearchable across a whole-base reindex', async () => {
    const fixtureBase = await makeBase();
    let failure: Error | null = null;
    const connector: KnowledgeConnector = {
      async *sync() {
        if (failure) throw failure;
        yield item('# Alpha\n\nalpha unique searchable marker');
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await runSyncJob(fixtureBase, sourceId);

    const [active] = await documentsOfBase(fixtureBase);
    if (!active) throw new Error('synced document missing');
    expect(active.status).toBe('ready');
    const baseline = await searchKnowledge(
      db,
      fixtureBase.baseId,
      { q: 'alpha', folders: [], tags: [], limit: 10, rerank: false },
      { secretKey: process.env.APP_SECRET_KEY ?? '' },
    );
    expect(baseline.hits.map((hit) => hit.documentId)).toContain(active.id);

    // 来源失权：runSync 撤权并把旧文档置 disabled。
    failure = new SourceAuthError('HTTP 401 from https://example.com');
    await expect(runSyncJob(fixtureBase, sourceId)).rejects.toBeInstanceOf(SourceAuthError);
    const revoked = await repo.knowledge.getDocument(db, active.id);
    expect(revoked?.status).toBe('disabled');

    // 整库 full rebuild 不能把已撤权文档重新发布成 ready。
    await runReindexJob(fixtureBase);

    const after = await repo.knowledge.getDocument(db, active.id);
    expect(after?.status).toBe('disabled');
    const searched = await searchKnowledge(
      db,
      fixtureBase.baseId,
      { q: 'alpha', folders: [], tags: [], limit: 10, rerank: false },
      { secretKey: process.env.APP_SECRET_KEY ?? '' },
    );
    expect(searched.hits.map((hit) => hit.documentId)).not.toContain(active.id);
  });

  it('B: an external content update does not silently overwrite a user-edited chunk', async () => {
    const fixtureBase = await makeBase();
    let content = '# Alpha\n\nalpha paragraph one\n\nbeta paragraph two';
    const connector: KnowledgeConnector = {
      async *sync() {
        yield item(content);
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await runSyncJob(fixtureBase, sourceId);

    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('synced document missing');
    const chunks = await currentChunks(document.id);
    const editable = chunks.find((chunk) => chunk.content === 'alpha paragraph one');
    if (!editable) throw new Error('expected chunk missing');
    await repo.knowledge.patchChunk(db, editable.id, {
      content: 'manual alpha paragraph one',
      searchText: 'manual alpha paragraph one',
      editedByUser: true,
    });

    // 外部源只新增后续段落，没有触碰人工修订的那一段。
    content = '# Alpha\n\nalpha paragraph one\n\nbeta paragraph two\n\ngamma paragraph three';
    const second = await runSyncJob(fixtureBase, sourceId);

    const after = await currentChunks(document.id);
    const preserved = after.find((chunk) => chunk.content === 'manual alpha paragraph one');
    expect(preserved?.editedByUser).toBe(true);
    // 冲突要逐项可见，而不是静默跳过。
    const items = await repo.knowledge.listSyncItems(db, second.syncRunId, { status: 'skipped' });
    expect(items.items).toEqual([
      expect.objectContaining({ code: 'manual_edit_conflict', documentId: document.id }),
    ]);
  });

  it('B: a whole-base full rebuild does not silently overwrite a user-edited chunk', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      async *sync() {
        yield item('# Alpha\n\nalpha paragraph one\n\nbeta paragraph two');
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await runSyncJob(fixtureBase, sourceId);

    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('synced document missing');
    const chunks = await currentChunks(document.id);
    const editable = chunks.find((chunk) => chunk.content === 'alpha paragraph one');
    if (!editable) throw new Error('expected chunk missing');
    await repo.knowledge.patchChunk(db, editable.id, {
      content: 'manual alpha paragraph one',
      searchText: 'manual alpha paragraph one',
      editedByUser: true,
    });

    await runReindexJob(fixtureBase);

    const after = await currentChunks(document.id);
    const preserved = after.find((chunk) => chunk.content === 'manual alpha paragraph one');
    expect(preserved?.editedByUser).toBe(true);
  });

  it('C: a temporary full-text fetch failure keeps the existing full text instead of the feed summary', async () => {
    const fixtureBase = await makeBase();
    fixtureBase.deps.connectors = { feed: knowledgeConnectors.feed };
    fixtureBase.deps.allowLoopback = true;
    const { sourceId } = await makeSource(fixtureBase, knowledgeConnectors.feed, 'feed');

    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('feed document missing');
    const before = await currentChunks(document.id);
    expect(before.map((chunk) => chunk.content).join('\n')).toContain('full article body alpha');
    const fullVersion = await repo.knowledge.getVersion(db, document.currentVersionId ?? '');
    expect(fullVersion?.metadata.contentCompleteness).toBe('full');

    // 全文页暂时不可用：连接器会回退到 feed 摘要；已有全文不能被摘要替换。
    articleFails = true;
    await runSyncJob(fixtureBase, sourceId);

    const after = await currentChunks(document.id);
    const text = after.map((chunk) => chunk.content).join('\n');
    expect(text).toContain('full article body alpha');
    expect(text).not.toContain('summary only');
    const unchanged = await repo.knowledge.getDocument(db, document.id);
    expect(unchanged?.currentVersionId).toBe(document.currentVersionId);
  });

  it('D: a successful re-sync re-proves access and re-attaches the actual range', async () => {
    const fixtureBase = await makeBase();
    let failure: Error | null = null;
    const connector: KnowledgeConnector = {
      async *sync() {
        if (failure) throw failure;
        yield item('# Alpha\n\nalpha membership marker');
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('synced document missing');
    const [range] = await repo.knowledge.listRanges(db, sourceId);

    failure = new SourceAuthError('HTTP 401 from https://example.com');
    await expect(runSyncJob(fixtureBase, sourceId)).rejects.toBeInstanceOf(SourceAuthError);
    expect((await repo.knowledge.getDocument(db, document.id))?.status).toBe('disabled');

    failure = null;
    // 修好凭证后由管理员重新启用来源，下一次成功同步才重新证明权限。
    await repo.knowledge.updateSource(db, sourceId, { status: 'active' });
    await runSyncJob(fixtureBase, sourceId);
    const revived = await repo.knowledge.getDocument(db, document.id);
    expect(revived?.status).toBe('ready');
    expect(revived?.disabledReason).toBeNull();
    expect(revived?.sourceConnectionId).toBe(sourceId);
    const memberships = await db
      .select()
      .from(schema.knowledgeDocumentSourceRanges)
      .where(eq(schema.knowledgeDocumentSourceRanges.documentId, document.id));
    expect(memberships.map((row) => row.rangeId)).toEqual([range?.id]);
  });

  it('W1: a config change after the read snapshot aborts before membership or publish', async () => {
    const fixtureBase = await makeBase();
    let changeConfig: (() => Promise<void>) | null = null;
    const connector: KnowledgeConnector = {
      async *sync({ onCheckpoint }) {
        // 连接器读到旧 config 后、返回条目前，管理员改了来源配置。
        await changeConfig?.();
        yield item('# Alpha\n\nalpha must not publish');
        await onCheckpoint({}, { complete: true });
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    changeConfig = async () => {
      await repo.knowledge.updateSource(db, sourceId, { config: { syncDeletions: false } });
    };

    await expect(runSyncJob(fixtureBase, sourceId)).rejects.toThrow('来源配置已变化');

    const [document] = await documentsOfBase(fixtureBase);
    expect(document?.currentVersionId).toBeNull();
    expect(document?.status).toBe('pending');
    expect(await repo.knowledge.listVersions(db, document?.id ?? '')).toMatchObject({
      items: [],
    });
    expect((await repo.knowledge.getSource(db, sourceId))?.cursor).toEqual({});
  });

  it('E: a manually disabled document is never revived by a sync', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      async *sync() {
        yield item('# Alpha\n\nalpha unchanged');
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('synced document missing');
    await repo.knowledge.updateDocument(db, document.id, {
      status: 'disabled',
      disabledReason: 'manual',
    });

    await runSyncJob(fixtureBase, sourceId);
    const after = await repo.knowledge.getDocument(db, document.id);
    expect(after?.status).toBe('disabled');
    expect(after?.disabledReason).toBe('manual');
  });

  it('G: a confirmed full rebuild is allowed to replace manually edited chunks', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      async *sync() {
        yield item('# Alpha\n\nalpha paragraph one\n\nbeta paragraph two');
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('synced document missing');
    const chunks = await currentChunks(document.id);
    const editable = chunks.find((chunk) => chunk.content === 'alpha paragraph one');
    if (!editable) throw new Error('expected chunk missing');
    await repo.knowledge.patchChunk(db, editable.id, {
      content: 'manual alpha paragraph one',
      searchText: 'manual alpha paragraph one',
      editedByUser: true,
    });

    await runReindexJob(fixtureBase, { confirmOverwriteManualChunks: true });

    const after = await currentChunks(document.id);
    expect(after.some((chunk) => chunk.content === 'manual alpha paragraph one')).toBe(false);
    expect(after.some((chunk) => chunk.content === 'alpha paragraph one')).toBe(true);
  });

  it('H: first summary is marked, later full text upgrades it, and full never downgrades', async () => {
    const fixtureBase = await makeBase();
    fixtureBase.deps.connectors = { feed: knowledgeConnectors.feed };
    fixtureBase.deps.allowLoopback = true;
    const { sourceId } = await makeSource(fixtureBase, knowledgeConnectors.feed, 'feed');

    articleFails = true;
    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('feed document missing');
    const summaryVersion = await repo.knowledge.getVersion(db, document.currentVersionId ?? '');
    expect(summaryVersion?.metadata.contentCompleteness).toBe('summary');
    expect((await currentChunks(document.id)).map((chunk) => chunk.content).join('\n')).toContain(
      'summary only',
    );

    articleFails = false;
    await runSyncJob(fixtureBase, sourceId);
    const upgraded = await repo.knowledge.getDocument(db, document.id);
    expect(upgraded?.currentVersionId).not.toBe(document.currentVersionId);
    const fullVersion = await repo.knowledge.getVersion(db, upgraded?.currentVersionId ?? '');
    expect(fullVersion?.metadata.contentCompleteness).toBe('full');

    articleFails = true;
    await runSyncJob(fixtureBase, sourceId);
    expect((await repo.knowledge.getDocument(db, document.id))?.currentVersionId).toBe(
      upgraded?.currentVersionId,
    );
  });

  it('H2: a same-hash summary cannot downgrade full before a later summary arrives', async () => {
    const fixtureBase = await makeBase();
    let next: { content: string; completeness: 'full' | 'summary' } = {
      content: 'full text alpha marker',
      completeness: 'full',
    };
    const connector: KnowledgeConnector = {
      async *sync() {
        yield {
          sourceId: 'feed:item-1',
          sourceUrl: 'https://example.com/item-1',
          sourcePath: null,
          title: 'item',
          mimeType: 'text/markdown',
          revision: 'r1',
          content: { markdown: next.content },
          completeness: next.completeness,
        };
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector, 'feed');

    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document?.currentVersionId) throw new Error('full version missing');
    const fullVersionId = document.currentVersionId;
    const fullHash = document.contentHash;
    expect(document.metadata.contentCompleteness).toBe('full');

    // 摘要恰好等于全文：同 hash 分支也只能更新标题/路径，不能把 full 改为 summary。
    next = { content: 'full text alpha marker', completeness: 'summary' };
    await runSyncJob(fixtureBase, sourceId);
    const afterSummary = await repo.knowledge.getDocument(db, document.id);
    expect(afterSummary?.currentVersionId).toBe(fullVersionId);
    expect(afterSummary?.contentHash).toBe(fullHash);
    expect(afterSummary?.metadata.contentCompleteness).toBe('full');
    expect((await repo.knowledge.getVersion(db, fullVersionId))?.metadata.contentCompleteness).toBe(
      'full',
    );

    // 下一轮摘要内容不同：仍被上面保住的 full 标记挡住，不能覆盖线上全文。
    next = { content: 'new summary marker', completeness: 'summary' };
    await runSyncJob(fixtureBase, sourceId);
    const afterLater = await repo.knowledge.getDocument(db, document.id);
    expect(afterLater?.currentVersionId).toBe(fullVersionId);
    expect(afterLater?.metadata.contentCompleteness).toBe('full');
    const chunks = (await repo.knowledge.listChunks(db, fullVersionId)).items;
    expect(chunks.map((chunk) => chunk.content)).toContain('full text alpha marker');
    expect(chunks.some((chunk) => chunk.content.includes('new summary marker'))).toBe(false);
  });

  it('I: FAQ ingest builds leaf roles and answers as context without publishing the draft', async () => {
    const fixtureBase = await makeBase();
    const faq = {
      question: '如何认证？',
      similarQuestions: ['认证方式'],
      negativeQuestions: ['如何退款？'],
      answers: ['使用 token'],
      answerStrategy: 'all' as const,
      isRecommended: true,
    };
    const seeded = await seedFaqDocument(fixtureBase, faq);
    const { documentId, versionId } = seeded;
    await indexSeededFaq(fixtureBase, seeded);

    // 保存草稿不改变线上指针。
    expect((await repo.knowledge.getDocument(db, documentId))?.currentVersionId).toBeNull();
    const chunks = (await repo.knowledge.listChunks(db, versionId)).items;
    const parent = chunks.find((chunk) => chunk.indexRole === 'parent');
    expect(parent?.content).toContain('使用 token');
    expect(chunks.find((chunk) => chunk.content === '如何认证？')?.metadata).toMatchObject({
      questionKind: 'standard',
      matchedQuestion: '如何认证？',
    });
    expect(chunks.find((chunk) => chunk.content === '认证方式')?.metadata).toMatchObject({
      questionKind: 'similar',
      matchedQuestion: '认证方式',
    });
    // 反例只供检索归一化排除，绝不生成任何正向索引块。
    expect(chunks.find((chunk) => chunk.content === '如何退款？')).toBeUndefined();
    expect(chunks.find((chunk) => chunk.content === '认证方式')?.embedding).not.toBeNull();
    expect(chunks.filter((chunk) => chunk.indexRole === 'leaf')).toHaveLength(2);
    // 摄取只按 job 指定的原始版本建块，不就地改写版本的 faq 数据。
    expect((await repo.knowledge.getVersion(db, versionId))?.faq).toEqual(faq);

    await repo.knowledge.finishJob(db, seeded.jobId, { status: 'succeeded' });
    await repo.knowledge.setCurrentVersion(db, documentId, versionId);
    const hit = await searchKnowledge(
      db,
      fixtureBase.baseId,
      { q: '认证', folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
      { secretKey: process.env.APP_SECRET_KEY ?? '' },
    );
    expect(hit.hits.map((entry) => entry.documentId)).toContain(documentId);
    const negative = await searchKnowledge(
      db,
      fixtureBase.baseId,
      { q: '如何退款？', folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
      { secretKey: process.env.APP_SECRET_KEY ?? '' },
    );
    expect(negative.hits).toHaveLength(0);
  });

  it('W3: a full reindex rebuilds FAQ from its published snapshot instead of plain JSON', async () => {
    const fixtureBase = await makeBase();
    const faq = {
      question: '如何认证？',
      similarQuestions: ['认证方式'],
      negativeQuestions: ['如何退款？'],
      answers: ['使用 token', '联系管理员'],
      answerStrategy: 'all' as const,
      isRecommended: true,
    };
    const seeded = await seedFaqDocument(fixtureBase, faq);
    const { documentId, versionId } = seeded;
    await indexSeededFaq(fixtureBase, seeded);
    await repo.knowledge.finishJob(db, seeded.jobId, { status: 'succeeded' });
    const published = await repo.knowledge.setCurrentVersion(db, documentId, versionId);
    expect(published?.currentVersionId).toBe(versionId);

    await runReindexJob(fixtureBase, { documentIds: [documentId] });

    const rebuiltDocument = await repo.knowledge.getDocument(db, documentId);
    expect(rebuiltDocument?.status).toBe('ready');
    expect(rebuiltDocument?.currentVersionId).not.toBe(versionId);
    const rebuilt = await repo.knowledge.getVersion(db, rebuiltDocument?.currentVersionId ?? '');
    // 完整 FAQ 语义必须跟着新版本，不能退化成 faq=null 的普通 JSON 正文。
    expect(rebuilt?.faq).toEqual(faq);
    const versions = await repo.knowledge.listVersions(db, documentId);
    expect(versions.items.map((row) => row.id)).toContain(versionId);
    expect(versions.items).toHaveLength(2);

    const chunks = (await repo.knowledge.listChunks(db, rebuilt?.id ?? '')).items;
    expect(chunks.filter((chunk) => chunk.indexRole === 'leaf')).toHaveLength(2);
    expect(chunks.find((chunk) => chunk.indexRole === 'parent')?.content).toContain('联系管理员');
    expect(chunks.find((chunk) => chunk.content === '如何退款？')).toBeUndefined();
    const positive = await searchKnowledge(
      db,
      fixtureBase.baseId,
      { q: '认证', folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
      { secretKey: process.env.APP_SECRET_KEY ?? '' },
    );
    expect(positive.hits.map((hit) => hit.documentId)).toContain(documentId);
    expect(positive.hits.every((hit) => hit.versionId === rebuilt?.id)).toBe(true);
    const negative = await searchKnowledge(
      db,
      fixtureBase.baseId,
      { q: '如何退款？', folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
      { secretKey: process.env.APP_SECRET_KEY ?? '' },
    );
    expect(negative.hits).toHaveLength(0);
    expect(
      (await repo.knowledge.getReadableDocument(db, fixtureBase.baseId, documentId))
        ?.currentVersionId,
    ).toBe(rebuilt?.id);

    // 人工编辑未确认时保留当前版本；确认后才允许再次重建。
    const editedChunk = chunks.find((chunk) => chunk.indexRole === 'leaf');
    if (!editedChunk) throw new Error('faq leaf missing');
    await db
      .update(schema.knowledgeChunks)
      .set({ editedByUser: true })
      .where(eq(schema.knowledgeChunks.id, editedChunk.id));
    await runReindexJob(fixtureBase, { documentIds: [documentId] });
    expect((await repo.knowledge.getDocument(db, documentId))?.currentVersionId).toBe(rebuilt?.id);
    expect((await repo.knowledge.listVersions(db, documentId)).items).toHaveLength(2);
    await runReindexJob(fixtureBase, {
      documentIds: [documentId],
      confirmOverwriteManualChunks: true,
    });
    expect((await repo.knowledge.getDocument(db, documentId))?.currentVersionId).not.toBe(
      rebuilt?.id,
    );

    // 只有未发布草稿的 FAQ 不会被重建自动推上线。
    const draftOnly = await seedFaqDocument(fixtureBase, { ...faq, question: '只有草稿？' });
    await runReindexJob(fixtureBase, { documentIds: [draftOnly.documentId] });
    expect(
      (await repo.knowledge.getDocument(db, draftOnly.documentId))?.currentVersionId,
    ).toBeNull();
    expect((await repo.knowledge.listVersions(db, draftOnly.documentId)).items).toHaveLength(1);
  });

  it('W7: an abort during FAQ chunk replacement cannot return success', async () => {
    const fixtureBase = await makeBase();
    const faq = {
      question: '如何认证？',
      similarQuestions: [],
      negativeQuestions: ['如何退款？'],
      answers: ['使用 token'],
      answerStrategy: 'all' as const,
      isRecommended: true,
    };
    const seeded = await seedFaqDocument(fixtureBase, faq);
    const { documentId, versionId } = seeded;
    await repo.knowledge.claimJob(db, seeded.jobId);
    const claimed = await repo.knowledge.getJob(db, seeded.jobId);
    if (!claimed) throw new Error('ingest job missing');

    // 取消落在 replaceChunks 事务提交之后、摄取返回之前：必须抛取消而不是正常返回。
    type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
    const controller = new AbortController();
    const depsForCall: KnowledgeDeps = {
      ...fixtureBase.deps,
      db: new Proxy(fixtureBase.deps.db, {
        get(target, prop) {
          if (prop !== 'transaction') return Reflect.get(target, prop, target);
          return (fn: (tx: Tx) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              const result = await fn(tx);
              controller.abort();
              return result;
            });
        },
      }) as KnowledgeDeps['db'],
    };

    await expect(runIngest(depsForCall, claimed, controller.signal)).rejects.toBeInstanceOf(
      KnowledgeCancelled,
    );
    expect(controller.signal.aborted).toBe(true);
    const document = await repo.knowledge.getDocument(db, documentId);
    expect(document?.currentVersionId).toBeNull();
    expect(document?.status).toBe('pending');
    expect((await repo.knowledge.listChunks(db, versionId)).items.length).toBeGreaterThan(0);
  });

  it('J: structural chunks keep a real locator and multiple leaves share one parent', async () => {
    const fixtureBase = await makeBase();
    const adapter = createParsingAdapter();
    fixtureBase.deps.chunkMarkdown = adapter.chunkMarkdown;
    const connector: KnowledgeConnector = {
      async *sync() {
        // 两段都超过 400 字符块预算，才会在同一标题下生成多个 leaf 与一个 parent。
        yield item(`# Alpha\n\nfirst ${'a'.repeat(450)}\n\nsecond ${'b'.repeat(450)}`);
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document) throw new Error('synced document missing');
    const chunks = await currentChunks(document.id);
    const parent = chunks.find((chunk) => chunk.indexRole === 'parent');
    const leaves = chunks.filter((chunk) => chunk.indexRole === 'leaf');
    expect(parent).toBeDefined();
    expect(leaves.length).toBeGreaterThan(1);
    expect(leaves.every((chunk) => chunk.parentOrdinal === parent?.ordinal)).toBe(true);
    expect([...new Set(leaves.map((chunk) => chunk.locator?.lineFrom))]).toEqual([3, 5]);
    expect(leaves.every((chunk) => typeof chunk.locator?.startOffset === 'number')).toBe(true);
  });

  it('K: source probe checks remote access only and never imports or advances the cursor', async () => {
    const fixtureBase = await makeBase();
    let probeFails = false;
    const connector: KnowledgeConnector = {
      async probe() {
        if (probeFails) throw new Error('HTTP 401 from remote');
      },
      async *sync() {
        yield item('# Alpha\n\nprobe must not import this');
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    const job = await repo.knowledge.createJob(db, {
      type: 'source_probe',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId,
      payload: { type: 'source_probe', sourceId },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('probe job missing');

    const ok = await runSourceProbe(fixtureBase.deps, claimed, new AbortController().signal);
    expect(ok.ok).toBe(true);
    expect(ok.checks).toHaveLength(1);
    expect(await documentsOfBase(fixtureBase)).toHaveLength(0);
    expect((await repo.knowledge.getSource(db, sourceId))?.cursor).toEqual({});

    probeFails = true;
    const failed = await runSourceProbe(fixtureBase.deps, claimed, new AbortController().signal);
    expect(failed.ok).toBe(false);
    expect(failed.checks[0]).toMatchObject({ ok: false, code: 'probe_failed' });
  });

  it('L: a non-retryable unsupported item is skipped without failing the whole sync', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      async *sync({ onCheckpoint }) {
        yield {
          sourceId: 'bad-item',
          sourceUrl: null,
          sourcePath: null,
          title: 'archive.zip',
          mimeType: 'application/zip',
          revision: 'bad-item',
          content: { markdown: '' },
          failure: {
            code: 'unsupported_type',
            message: 'unsupported file type .zip',
            retryable: false,
          },
        };
        await onCheckpoint({ version: 1 }, { complete: true });
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await repo.knowledge.updateSource(db, sourceId, { config: { syncDeletions: true } });
    const [range] = await repo.knowledge.listRanges(db, sourceId);
    const existing = await repo.knowledge.createDocument(db, {
      baseId: fixtureBase.baseId,
      folderId: null,
      title: 'old',
      sourceType: 'gitlab',
      sourceId: 'old-item',
      sourceConnectionId: sourceId,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: 0,
      metadata: {},
    });
    await repo.knowledge.updateDocument(db, existing.id, { status: 'ready' });
    const snapshot = await repo.knowledge.getSourceReadSnapshot(db, sourceId);
    if (range && snapshot) {
      await repo.knowledge.setDocumentSourceRanges(db, existing.id, [range.id], snapshot.snapshot, {
        title: existing.title,
        sourceUrl: existing.sourceUrl,
        sourcePath: existing.sourcePath,
        mimeType: existing.mimeType,
        sizeBytes: existing.sizeBytes,
        metadata: existing.metadata,
      });
      // 测试前置的 ready 状态没有真实 current 版本，授权入口会按无版本置 processing；
      // 这里恢复成 ready 以验证同步不会因不支持项改动旧文档。
      await repo.knowledge.updateDocument(db, existing.id, { status: 'ready' });
    }

    const { syncRunId } = await runSyncJob(fixtureBase, sourceId);

    // 单项不支持不阻断游标推进；但本轮不完整，不能据此推导删除。
    expect((await repo.knowledge.getSource(db, sourceId))?.cursor).toEqual({ version: 1 });
    expect((await repo.knowledge.getDocument(db, existing.id))?.status).toBe('ready');
    const items = await repo.knowledge.listSyncItems(db, syncRunId);
    expect(items.items).toEqual([
      expect.objectContaining({ status: 'skipped', code: 'unsupported_type' }),
    ]);
  });

  it('R: a FAQ job indexes the version named by the payload, never the latest one', async () => {
    const fixtureBase = await makeBase();
    const document = await repo.knowledge.createDocument(db, {
      baseId: fixtureBase.baseId,
      folderId: null,
      title: 'faq-versioned',
      sourceType: 'manual',
      sourceId: null,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'application/json',
      sizeBytes: 0,
      contentKind: 'faq',
      metadata: {},
    });
    const versionOf = (question: string) =>
      repo.knowledge.createVersion(db, {
        documentId: document.id,
        blobSha256: `blob-${question}`,
        markdownSha256: `markdown-${question}`,
        originalFilename: 'faq.json',
        mimeType: 'application/json',
        sizeBytes: 0,
        sourceRevision: null,
        origin: 'faq',
        parentVersionId: null,
        metadata: { publication: 'draft' },
        faq: {
          question,
          similarQuestions: [],
          negativeQuestions: [],
          answers: [`${question}的答案`],
        },
        parseStatus: 'parsed',
        pageMap: [],
        images: [],
        embeddingProfileId: fixtureBase.profileId,
      });
    const first = await versionOf('第一问');
    const second = await versionOf('第二问');

    await runIngestJob(fixtureBase, document.id, { publish: 'draft', versionId: first.id });

    const firstChunks = (await repo.knowledge.listChunks(db, first.id)).items;
    expect(firstChunks.map((chunk) => chunk.content)).toContain('第一问');
    expect(firstChunks.some((chunk) => chunk.content.includes('第二问'))).toBe(false);
    expect((await repo.knowledge.listChunks(db, second.id)).items).toHaveLength(0);
  });

  it('M: a manual draft stays off the published pointer until an explicit publish', async () => {
    const fixtureBase = await makeBase();
    const document = await seedManualDocument(
      fixtureBase,
      'notes',
      '# Note\n\npublished alpha marker',
    );
    await runIngestJob(fixtureBase, document.id);
    const published = await repo.knowledge.getDocument(db, document.id);
    if (!published?.currentVersionId) throw new Error('first ingest did not publish');

    // 保存新草稿：API 把新正文 blob 放进 job 输入快照，worker 不再读线上 contentHash。
    const draftSha = await writeBlob(Buffer.from('# Note\n\ndraft beta marker', 'utf8'));
    await runIngestJob(fixtureBase, document.id, {
      publish: 'draft',
      input: {
        blobSha256: draftSha,
        filename: 'notes.md',
        mimeType: 'text/markdown',
        expectedCurrentVersionId: published.currentVersionId,
      },
    });

    const afterDraft = await repo.knowledge.getDocument(db, document.id);
    expect(afterDraft?.currentVersionId).toBe(published.currentVersionId);
    expect(afterDraft?.contentHash).toBe(published.contentHash);
    expect(afterDraft?.status).toBe('ready');
    const versions = await repo.knowledge.listVersions(db, document.id);
    const draft = versions.items.find((row) => row.metadata.publication === 'draft');
    expect(draft).toBeDefined();
    expect(draft?.id).not.toBe(published.currentVersionId);
    const draftChunks = (await repo.knowledge.listChunks(db, draft?.id ?? '')).items;
    expect(draftChunks.some((chunk) => chunk.content.includes('draft beta marker'))).toBe(true);
    // 线上仍是旧版：新草稿在显式发布前不可检索（向量 fixture 会命中旧版，故按版本与正文断言）。
    const betaHits = await searchHits(fixtureBase, 'beta');
    expect(betaHits.hits.every((hit) => hit.versionId === published.currentVersionId)).toBe(true);
    expect(betaHits.hits.some((hit) => hit.quote.includes('beta'))).toBe(false);
    expect((await searchHits(fixtureBase, 'alpha')).hits.map((hit) => hit.documentId)).toContain(
      document.id,
    );
    // 未确认的整库/单文档重建不能把草稿 contentHash 直接推上线。
    await runReindexJob(fixtureBase, { documentIds: [document.id] });
    const afterRebuild = await repo.knowledge.getDocument(db, document.id);
    expect(afterRebuild?.currentVersionId).toBe(published.currentVersionId);
    expect((await repo.knowledge.listVersions(db, document.id)).items).toHaveLength(
      versions.items.length,
    );

    // 首次保存即草稿：没有发布版时文档保持 pending，仍不可检索。
    const fresh = await seedManualDocument(fixtureBase, 'fresh', '# Fresh\n\nonly draft gamma');
    const freshBlob = (await repo.knowledge.getDocument(db, fresh.id))?.contentHash;
    if (!freshBlob) throw new Error('fresh blob missing');
    const freshJobId = await runIngestJob(fixtureBase, fresh.id, {
      publish: 'draft',
      input: {
        blobSha256: freshBlob,
        filename: 'fresh.md',
        mimeType: 'text/markdown',
        expectedCurrentVersionId: null,
      },
    });
    const freshAfter = await repo.knowledge.getDocument(db, fresh.id);
    expect(freshAfter?.currentVersionId).toBeNull();
    expect(freshAfter?.status).toBe('pending');
    const gammaHits = await searchHits(fixtureBase, 'gamma');
    expect(gammaHits.hits.every((hit) => hit.documentId !== fresh.id)).toBe(true);

    const freshVersions = await repo.knowledge.listVersions(db, fresh.id);
    const freshDraft = freshVersions.items[0];
    if (!freshDraft) throw new Error('draft version missing');
    // 显式发布只接受本版本自己的成功索引任务。
    await repo.knowledge.finishJob(db, freshJobId, { status: 'succeeded' });
    await repo.knowledge.activateDocumentVersion(db, {
      documentId: fresh.id,
      versionId: freshDraft.id,
      expectedVersionId: null,
    });
    // 与 API publish 一致：显式发布同时把文档从 pending 置为 ready。
    await repo.knowledge.updateDocument(db, fresh.id, { status: 'ready', disabledReason: null });
    expect((await searchHits(fixtureBase, 'gamma')).hits.map((hit) => hit.documentId)).toContain(
      fresh.id,
    );
  });

  it('S: consecutive input snapshots each build their own draft and a retry reuses its snapshot', async () => {
    const fixtureBase = await makeBase();
    const document = await seedManualDocument(
      fixtureBase,
      'snapshot-notes',
      '# Note\n\npublished alpha marker',
    );
    await runIngestJob(fixtureBase, document.id);
    const published = await repo.knowledge.getDocument(db, document.id);
    if (!published?.currentVersionId) throw new Error('initial publish missing');
    const publishedHash = published.contentHash;

    const inputFor = async (content: string) => ({
      publish: 'draft',
      input: {
        blobSha256: await writeBlob(Buffer.from(content, 'utf8')),
        filename: 'snapshot-notes.md',
        mimeType: 'text/markdown',
        expectedCurrentVersionId: published.currentVersionId,
      },
    });
    const drafts = async () => {
      const versions = (await repo.knowledge.listVersions(db, document.id, { limit: 50 })).items;
      return Promise.all(
        versions
          .filter((row) => row.metadata.publication === 'draft')
          .map(async (row) => ({
            version: row,
            content: (await repo.knowledge.listChunks(db, row.id)).items
              .map((chunk) => chunk.content)
              .join('\n'),
          })),
      );
    };

    await runIngestJob(fixtureBase, document.id, await inputFor('# Note\n\nsnapshot bravo marker'));
    let saved = await drafts();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toContain('snapshot bravo marker');
    expect(saved[0]?.content).not.toContain('published alpha marker');
    expect(saved[0]?.version.parentVersionId).toBe(published.currentVersionId);
    // 草稿不覆盖线上指针，也不覆盖已发布 contentHash。
    expect((await repo.knowledge.getDocument(db, document.id))?.contentHash).toBe(publishedHash);
    expect((await repo.knowledge.getDocument(db, document.id))?.currentVersionId).toBe(
      published.currentVersionId,
    );

    await runIngestJob(
      fixtureBase,
      document.id,
      await inputFor('# Note\n\nsnapshot charlie marker'),
    );
    saved = await drafts();
    expect(saved).toHaveLength(2);
    expect(saved.some((entry) => entry.content.includes('snapshot bravo marker'))).toBe(true);
    expect(saved.some((entry) => entry.content.includes('snapshot charlie marker'))).toBe(true);

    // 同一 job 快照重试仍按 charlie 建版本，不会回落到线上 alpha。
    await runIngestJob(
      fixtureBase,
      document.id,
      await inputFor('# Note\n\nsnapshot charlie marker'),
    );
    saved = await drafts();
    expect(saved).toHaveLength(3);
    expect(saved.filter((entry) => entry.content.includes('snapshot charlie marker'))).toHaveLength(
      2,
    );
    expect(saved.some((entry) => entry.content.includes('published alpha marker'))).toBe(false);
    expect((await repo.knowledge.getDocument(db, document.id))?.contentHash).toBe(publishedHash);
  });

  it('T: a failing ingest cannot revive a document disabled mid-flight', async () => {
    const fixtureBase = await makeBase();
    const document = await seedManualDocument(
      fixtureBase,
      'revoked-mid-flight',
      '# Note\n\npublished alpha marker',
    );
    await runIngestJob(fixtureBase, document.id);
    const published = await repo.knowledge.getDocument(db, document.id);
    if (!published?.currentVersionId) throw new Error('initial publish missing');

    const sha = await writeBlob(Buffer.from('# Note\n\nbeta after revocation', 'utf8'));
    const job = await repo.knowledge.createJob(db, {
      type: 'ingest',
      baseId: fixtureBase.baseId,
      documentId: document.id,
      sourceId: null,
      payload: {
        type: 'ingest',
        documentId: document.id,
        publish: 'draft',
        input: {
          blobSha256: sha,
          filename: 'revoked-mid-flight.md',
          mimeType: 'text/markdown',
          expectedCurrentVersionId: published.currentVersionId,
        },
      },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('ingest job missing');
    // 处理期间来源撤权：解析失败前先把文档置为不可读，旧状态快照不能把它写回 ready。
    fixtureBase.deps.parse = async () => {
      await repo.knowledge.updateDocument(db, document.id, {
        status: 'disabled',
        disabledReason: 'source',
      });
      throw new Error('parse failed after revocation');
    };
    await expect(
      runIngest(fixtureBase.deps, claimed, new AbortController().signal),
    ).rejects.toThrow('parse failed after revocation');

    const after = await repo.knowledge.getDocument(db, document.id);
    expect(after?.status).toBe('disabled');
    expect(after?.disabledReason).toBe('source');
    expect(after?.currentVersionId).toBe(published.currentVersionId);
  });

  it('U: an automatic ingest with a stale expected pointer does not publish', async () => {
    const fixtureBase = await makeBase();
    const document = await seedManualDocument(
      fixtureBase,
      'stale-pointer',
      '# Note\n\npublished alpha marker',
    );
    await runIngestJob(fixtureBase, document.id);
    const published = await repo.knowledge.getDocument(db, document.id);
    if (!published?.currentVersionId) throw new Error('initial publish missing');
    const sha = await writeBlob(Buffer.from('# Note\n\nbeta with stale pointer', 'utf8'));

    await expect(
      runIngestJob(fixtureBase, document.id, {
        input: {
          blobSha256: sha,
          filename: 'stale-pointer.md',
          mimeType: 'text/markdown',
          expectedCurrentVersionId: null,
        },
      }),
    ).rejects.toThrow(/未发布本次结果|配置已变化/);

    const after = await repo.knowledge.getDocument(db, document.id);
    expect(after?.currentVersionId).toBe(published.currentVersionId);
    expect(after?.contentHash).toBe(published.contentHash);
  });

  it('N: a source disabled mid-sync cannot publish the in-flight version', async () => {
    const fixtureBase = await makeBase();
    let content = '# Alpha\n\nfirst published marker';
    let revoke = false;
    let sourceId = '';
    const connector: KnowledgeConnector = {
      async *sync() {
        if (revoke) await repo.knowledge.updateSource(db, sourceId, { status: 'disabled' });
        yield item(content);
        yield* [];
      },
    };
    const source = await makeSource(fixtureBase, connector);
    sourceId = source.sourceId;
    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document?.currentVersionId) throw new Error('synced document missing');
    const publishedVersionId = document.currentVersionId;

    content = '# Alpha\n\nsecond revoked marker';
    revoke = true;
    await expect(runSyncJob(fixtureBase, sourceId)).rejects.toThrow(/来源配置已变化|未发布|失败/);

    const after = await repo.knowledge.getDocument(db, document.id);
    expect(after?.currentVersionId).toBe(publishedVersionId);
    const secondHits = await searchHits(fixtureBase, 'second');
    expect(secondHits.hits.every((hit) => hit.versionId === publishedVersionId)).toBe(true);
    expect(secondHits.hits.some((hit) => hit.quote.includes('second'))).toBe(false);
    expect((await searchHits(fixtureBase, 'first')).hits).toHaveLength(0);
  });

  it('O: a range revoked mid-sync cannot revive the document from the old scope', async () => {
    const fixtureBase = await makeBase();
    let content = '# Alpha\n\nfirst scoped marker';
    let revoke = false;
    let sourceId = '';
    const connector: KnowledgeConnector = {
      async *sync() {
        if (revoke) await repo.knowledge.replaceSourceScope(db, sourceId, { ranges: [] });
        yield item(content);
        yield* [];
      },
    };
    const source = await makeSource(fixtureBase, connector);
    sourceId = source.sourceId;
    await runSyncJob(fixtureBase, sourceId);
    const [document] = await documentsOfBase(fixtureBase);
    if (!document?.currentVersionId) throw new Error('synced document missing');
    const publishedVersionId = document.currentVersionId;

    content = '# Alpha\n\nsecond revoked range marker';
    revoke = true;
    await expect(runSyncJob(fixtureBase, sourceId)).rejects.toThrow();

    const after = await repo.knowledge.getDocument(db, document.id);
    expect(after?.currentVersionId).toBe(publishedVersionId);
    const memberships = await db
      .select()
      .from(schema.knowledgeDocumentSourceRanges)
      .where(eq(schema.knowledgeDocumentSourceRanges.documentId, document.id));
    expect(memberships).toHaveLength(0);
    const secondHits = await searchHits(fixtureBase, 'second');
    expect(secondHits.hits.every((hit) => hit.versionId === publishedVersionId)).toBe(true);
    expect(secondHits.hits.some((hit) => hit.quote.includes('second'))).toBe(false);
    expect((await searchHits(fixtureBase, 'first')).hits).toHaveLength(0);
  });

  it('P: a probe with no enabled range fails instead of an empty every() success', async () => {
    const fixtureBase = await makeBase();
    const connector: KnowledgeConnector = {
      async probe() {
        throw new Error('probe must not run without a range');
      },
      async *sync() {
        yield* [];
      },
    };
    const { sourceId } = await makeSource(fixtureBase, connector);
    await repo.knowledge.replaceRanges(db, sourceId, []);
    const job = await repo.knowledge.createJob(db, {
      type: 'source_probe',
      baseId: fixtureBase.baseId,
      documentId: null,
      sourceId,
      payload: { type: 'source_probe', sourceId },
    });
    await repo.knowledge.claimJob(db, job.id);
    const claimed = await repo.knowledge.getJob(db, job.id);
    if (!claimed) throw new Error('probe job missing');

    await expect(
      runSourceProbe(fixtureBase.deps, claimed, new AbortController().signal),
    ).rejects.toThrow(/没有启用的范围/);
  });

  it('Q: Docling blocks carry real page/bbox/offsets through ingest into search hits', async () => {
    const fixtureBase = await makeBase();
    const adapter = createParsingAdapter({ parserUrl: `${fixtureUrl}/docling` });
    fixtureBase.deps.parse = adapter.parse;
    fixtureBase.deps.chunkMarkdown = adapter.chunkMarkdown;
    const data = Buffer.from('%PDF-1.7');
    const filename = 'report.pdf';
    const parsed = await adapter.parse({ filename, mimeType: 'application/pdf', data });
    const document = await seedManualDocument(fixtureBase, 'docling-report', '', {
      mimeType: 'application/pdf',
      filename,
    });
    const sha = await writeBlob(data);
    await repo.knowledge.updateDocument(db, document.id, { contentHash: sha });
    await runIngestJob(fixtureBase, document.id);

    const chunks = await currentChunks(document.id);
    const paragraph = chunks.find(
      (chunk) => chunk.indexRole === 'leaf' && chunk.content === '第一段内容。',
    );
    expect(paragraph?.locator).toMatchObject({
      pageFrom: 2,
      parserRef: '#/texts/1',
      bbox: { left: 1, top: 2, right: 3, bottom: 4 },
    });
    const paragraphAt = parsed.markdown.indexOf('第一段内容。');
    expect(paragraph?.locator?.startOffset).toBe(paragraphAt);
    expect(paragraph?.locator?.endOffset).toBe(paragraphAt + '第一段内容。'.length);
    expect(paragraph?.locator?.lineFrom).toBe(3);

    const table = chunks.find(
      (chunk) => chunk.indexRole === 'leaf' && chunk.content.includes('| 收入 | 100 |'),
    );
    expect(table?.locator).toMatchObject({
      pageFrom: 4,
      parserRef: '#/tables/0',
      bbox: { left: 0, top: 0, right: 9, bottom: 9 },
    });
    const tableAt = parsed.markdown.indexOf('| 指标 | 数值 |');
    expect(table?.locator?.startOffset).toBe(tableAt);
    expect(table?.locator?.endOffset).toBe(
      tableAt + '| 指标 | 数值 |\n| --- | --- |\n| 收入 | 100 |'.length,
    );

    const result = await searchHits(fixtureBase, '第一段内容');
    const hit = result.hits.find((row) => row.documentId === document.id);
    expect(hit?.locator).toMatchObject({
      pageFrom: 2,
      parserRef: '#/texts/1',
      bbox: { left: 1, top: 2, right: 3, bottom: 4 },
    });
  });
});
