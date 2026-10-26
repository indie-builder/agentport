import { createServer, type Server } from 'node:http';
import { createDb, repo } from '@agentport/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchKnowledge } from '../src/features/knowledge/retrieval.js';

const SECRET_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const { db, pool } = createDb(process.env.DATABASE_URL ?? '');

// 真实本地 HTTP fixture：embedding 走 OpenAI 兼容 /embeddings。
let fixture: Server;
let fixtureUrl = '';
let embeddingMode: 'ok' | 'fail' = 'ok';
let embeddingCalls = 0;

function vectorFor(text: string): number[] {
  // 第一个维度编码「主题」：包含 token 的文本落在正方向，其余接近 0。
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = text.includes('token') || text.includes('令牌') ? 1 : 0.01;
  vector[1] = text.includes('backup') ? 1 : 0.01;
  return vector;
}

beforeAll(async () => {
  fixture = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url !== '/embeddings') return respond(404, { error: 'not found' });
      embeddingCalls += 1;
      if (embeddingMode === 'fail') return respond(500, { error: 'boom' });
      const { input } = JSON.parse(raw) as { input: string[] };
      respond(200, { data: input.map((text) => ({ embedding: vectorFor(text) })) });
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await pool.end();
});

let baseId = '';
let profileId = '';
let rerankProfileId = '';
const documentIds: string[] = [];

async function seedDocument(input: {
  title: string;
  chunks: Array<{
    content: string;
    searchText: string;
    embedding: number[] | null;
    enabled?: boolean;
  }>;
  status?: 'ready' | 'disabled';
  currentVersion?: boolean;
  base?: string;
  folderId?: string | null;
}) {
  const targetBase = input.base ?? baseId;
  const folderId = input.folderId ?? null;
  const document = await repo.knowledge.createDocument(db, {
    baseId: targetBase,
    folderId,
    title: input.title,
    sourceType: 'manual',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'text/markdown',
    sizeBytes: 10,
  });
  documentIds.push(document.id);
  const version = await repo.knowledge.createVersion(db, {
    documentId: document.id,
    blobSha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    originalFilename: `${input.title}.md`,
    mimeType: 'text/markdown',
    sizeBytes: 10,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: profileId,
  });
  await repo.knowledge.insertChunks(db, {
    baseId: targetBase,
    documentId: document.id,
    versionId: version.id,
    folderId,
    chunks: input.chunks.map((chunk, ordinal) => ({
      ordinal,
      kind: 'text' as const,
      heading: null,
      content: chunk.content,
      searchText: chunk.searchText,
      embedding: chunk.embedding,
      enabled: chunk.enabled ?? true,
      pageFrom: null,
      pageTo: null,
      tokenCount: 1,
    })),
  });
  if (input.currentVersion !== false) {
    await repo.knowledge.setCurrentVersion(db, document.id, version.id);
    if (input.status === 'disabled') {
      await repo.knowledge.updateDocument(db, document.id, { status: 'disabled' });
    }
  }
  return { document, version };
}

async function createBase() {
  const embedding = await repo.knowledge.createModelProfile(db, {
    kind: 'embedding',
    name: `embed-${Date.now()}-${Math.random()}`,
    endpointUrl: fixtureUrl,
    model: 'test-embed',
    dimensions: 1024,
    secretsEncrypted: null,
    enabled: true,
  });
  profileId = embedding.id;
  const rerank = await repo.knowledge.createModelProfile(db, {
    kind: 'rerank',
    name: `rerank-${Date.now()}-${Math.random()}`,
    endpointUrl: fixtureUrl,
    model: 'test-rerank',
    dimensions: null,
    secretsEncrypted: null,
    enabled: true,
  });
  rerankProfileId = rerank.id;
  const server = await repo.servers.createServer(db, {
    name: `kb-retrieval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: 'knowledge' as never,
    description: '',
    config: {},
    secretsEncrypted: null,
  });
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Retrieval base',
    description: '',
    serverId: server.id,
    embeddingProfileId: embedding.id,
    rerankProfileId: rerank.id,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  });
  baseId = base.id;
}

describe('searchKnowledge', () => {
  beforeEach(async () => {
    embeddingMode = 'ok';
    embeddingCalls = 0;
    await createBase();
    await seedDocument({
      title: '令牌文档',
      chunks: [
        {
          content: '访问令牌需要定期轮换',
          searchText: '访问 令牌 需要 定期 轮换',
          embedding: vectorFor('token'),
        },
      ],
    });
    await seedDocument({
      title: '备份文档',
      chunks: [
        {
          content: '备份每天执行一次',
          searchText: '备份 每天 执行 一次',
          embedding: vectorFor('backup'),
        },
      ],
    });
  });

  afterEach(async () => {
    await pool.query('delete from knowledge_bases where id = $1', [baseId]);
    await pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
      [profileId, rerankProfileId],
    ]);
    await pool.query('delete from servers where name like $1', ['kb-retrieval-%']);
    documentIds.length = 0;
  });

  it('关键词命中：中文分词结果能召回对应 chunk', async () => {
    const query = { q: '令牌', folders: [], tags: [], limit: 10, rerank: false };
    const result = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
    expect(result.degraded).toBe(false);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.title).toBe('令牌文档');
    expect(result.hits[0]?.quote).toContain('令牌');
  });

  it('向量路也能召回没有关键词重合的 chunk', async () => {
    const query = { q: 'token rotation policy', folders: [], tags: [], limit: 10, rerank: false };
    const result = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
    expect(result.hits.map((hit) => hit.title)).toContain('令牌文档');
  });

  it('embedding 失败时降级为关键词结果并标记 degraded', async () => {
    embeddingMode = 'fail';
    const query = { q: '令牌', folders: [], tags: [], limit: 10, rerank: false };
    const result = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
    expect(embeddingCalls).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.hits[0]?.title).toBe('令牌文档');
  });

  it('rerank 不可用时保留融合顺序而不是报错', async () => {
    const query = { q: '令牌', folders: [], tags: [], limit: 10, rerank: true };
    // fixture 没有 /rerank，走 bad_response 分支。
    const result = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
    expect(result.degraded).toBe(false);
    expect(result.hits[0]?.title).toBe('令牌文档');
  });

  it('删除文档后不再召回', async () => {
    const columns = await pool.query<{ id: string }>(
      "select id from knowledge_documents where base_id = $1 and title = '令牌文档'",
      [baseId],
    );
    await repo.knowledge.deleteDocument(db, columns.rows[0]!.id);
    const query = { q: '令牌', folders: [], tags: [], limit: 10, rerank: false };
    const result = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
    expect(result.hits.map((hit) => hit.title)).not.toContain('令牌文档');
  });

  it('禁用文档、禁用 chunk、非当前版本都不召回', async () => {
    const disabled = await seedDocument({
      title: '禁用文档',
      status: 'disabled',
      chunks: [
        { content: '令牌已禁用', searchText: '令牌 已 禁用', embedding: vectorFor('token') },
      ],
    });
    const disabledChunk = await seedDocument({
      title: '禁用分块',
      chunks: [
        {
          content: '令牌分块已禁用',
          searchText: '令牌 分块 已 禁用',
          embedding: vectorFor('token'),
          enabled: false,
        },
      ],
    });
    const old = await seedDocument({
      title: '旧版本',
      chunks: [
        { content: '令牌旧版本', searchText: '令牌 旧 版本', embedding: vectorFor('token') },
      ],
    });
    // 再建一个版本并切成当前版本，旧版本 chunk 必须掉出召回。
    const newer = await repo.knowledge.createVersion(db, {
      documentId: old.document.id,
      blobSha256: 'c'.repeat(64),
      markdownSha256: 'd'.repeat(64),
      originalFilename: '旧版本.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      sourceRevision: null,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: profileId,
    });
    await repo.knowledge.setCurrentVersion(db, old.document.id, newer.id);

    const query = { q: '令牌', folders: [], tags: [], limit: 50, rerank: false };
    const result = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
    const titles = result.hits.map((hit) => hit.title);
    expect(titles).not.toContain('禁用文档');
    expect(titles).not.toContain('禁用分块');
    expect(titles).not.toContain('旧版本');
    expect(titles).toContain('令牌文档');
    expect(disabledChunk.document.id).toBeTruthy();
    expect(disabled.document.id).toBeTruthy();
  });

  it('停用知识库后管理端检索也立即拒绝，不返回仍可读的历史命中', async () => {
    await pool.query("update knowledge_bases set status = 'disabled' where id = $1", [baseId]);
    const query = { q: '令牌', folders: [], tags: [], limit: 10, rerank: false };
    await expect(
      searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await pool.query("update knowledge_bases set status = 'active' where id = $1", [baseId]);
    const result = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('跨库过滤：另一个库的 chunk 不会出现在本库结果里', async () => {
    const other = await repo.knowledge.createBase(db, {
      slug: `kb-other-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Other',
      description: '',
      serverId: (
        await repo.servers.createServer(db, {
          name: `kb-retrieval-other-${Math.random().toString(36).slice(2)}`,
          kind: 'knowledge' as never,
          description: '',
          config: {},
          secretsEncrypted: null,
        })
      ).id,
      embeddingProfileId: profileId,
      rerankProfileId: null,
      settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
    });
    try {
      await seedDocument({
        base: other.id,
        title: '他库令牌',
        chunks: [
          { content: '令牌在别的库', searchText: '令牌 在 别的 库', embedding: vectorFor('token') },
        ],
      });
      const query = { q: '令牌', folders: [], tags: [], limit: 50, rerank: false };
      const result = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
      expect(result.hits.map((hit) => hit.title)).not.toContain('他库令牌');
    } finally {
      await pool.query('delete from knowledge_bases where id = $1', [other.id]);
    }
  });

  it('移文档后按文档当前文件夹过滤，不读分块写入时的旧 folder_id', async () => {
    const folderA = await repo.knowledge.createFolder(db, {
      baseId,
      parentId: null,
      name: 'A',
      path: '/A',
    });
    const folderB = await repo.knowledge.createFolder(db, {
      baseId,
      parentId: null,
      name: 'B',
      path: '/B',
    });
    const moved = await seedDocument({
      title: '移动文档',
      folderId: folderA.id,
      chunks: [
        { content: '令牌移动归属', searchText: '令牌 移动 归属', embedding: vectorFor('token') },
      ],
    });
    await repo.knowledge.updateDocument(db, moved.document.id, { folderId: folderB.id });

    const query = { q: '令牌', tags: [], limit: 20, rerank: false };
    const inA = await searchKnowledge(
      db,
      baseId,
      { ...query, folders: [folderA.id] },
      { secretKey: SECRET_KEY },
    );
    expect(inA.hits.map((hit) => hit.title)).not.toContain('移动文档');

    const inB = await searchKnowledge(
      db,
      baseId,
      { ...query, folders: [folderB.id] },
      { secretKey: SECRET_KEY },
    );
    expect(inB.hits.map((hit) => hit.title)).toContain('移动文档');
  });
});
