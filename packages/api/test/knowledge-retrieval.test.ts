import { createServer, type Server } from 'node:http';
import { createDb, repo } from '@agentport/db';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchKnowledge } from '../src/features/knowledge/retrieval.js';

const SECRET_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const { db, pool } = createDb(process.env.DATABASE_URL ?? '');

// 真实本地 HTTP fixture：embedding 走 OpenAI 兼容 /embeddings。
let fixture: Server;
let fixtureUrl = '';
let embeddingMode: 'ok' | 'fail' = 'ok';
let rerankMode: 'ok' | 'fail' | 'partial' = 'ok';
let embeddingCalls = 0;

function vectorFor(text: string): number[] {
  // 第一个维度编码「主题」：包含 token 的文本落在正方向，其余接近 0。
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = text.includes('token') || text.includes('令牌') ? 1 : 0.01;
  vector[1] = text.includes('backup') ? 1 : 0.01;
  return vector;
}

/** 与 vectorFor('令牌') 的 cosine 近似为给定值，用于 directAnswer 门槛测试。 */
function vectorAt(cosine: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = cosine;
  vector[1] = Math.sqrt(1 - cosine * cosine);
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
      if (req.url !== '/embeddings' && req.url !== '/rerank')
        return respond(404, { error: 'not found' });
      if (req.url === '/rerank') {
        if (rerankMode === 'fail') return respond(500, { error: 'boom' });
        const { documents } = JSON.parse(raw) as { documents: string[] };
        // 倒序打分；partial 只回第一条，用于验证「部分结果=失败」。
        const results = documents
          .map((_document, index) => ({ index, score: documents.length - index }))
          .slice(0, rerankMode === 'partial' ? 0 : documents.length);
        return respond(200, { results });
      }
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
    indexRole?: 'leaf' | 'parent';
    parentOrdinal?: number | null;
    locator?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  }>;
  status?: 'ready' | 'disabled';
  currentVersion?: boolean;
  base?: string;
  folderId?: string | null;
  contentKind?: 'document' | 'faq' | 'wiki';
  faq?: {
    question: string;
    similarQuestions: string[];
    negativeQuestions: string[];
    answers: string[];
    answerStrategy?: 'all' | 'random';
    isRecommended?: boolean;
  } | null;
  versionMetadata?: Record<string, unknown>;
  documentMetadata?: Record<string, unknown>;
  sourceConnectionId?: string | null;
  sourcePath?: string | null;
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
    sourcePath: input.sourcePath ?? null,
    mimeType: 'text/markdown',
    sizeBytes: 10,
    contentKind: input.contentKind ?? 'document',
    sourceConnectionId: input.sourceConnectionId ?? null,
    metadata: input.documentMetadata ?? {},
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
    faq: input.faq ? { answerStrategy: 'all', isRecommended: true, ...input.faq } : null,
    metadata: input.versionMetadata ?? {},
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
      indexRole: chunk.indexRole ?? 'leaf',
      parentOrdinal: chunk.parentOrdinal ?? null,
      locator: chunk.locator ?? null,
      ...(chunk.metadata ? { metadata: chunk.metadata } : {}),
    })),
  });
  if (input.currentVersion !== false) {
    await repo.knowledge.setCurrentVersion(db, document.id, version.id);
    if (input.status === 'disabled') {
      await repo.knowledge.updateDocument(db, document.id, {
        status: 'disabled',
        disabledReason: 'manual',
      });
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
    rerankMode = 'ok';
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

  it('文本向量门槛在融合前过滤，关键词命中不受影响', async () => {
    await seedDocument({
      title: '门槛文档',
      chunks: [
        {
          content: '令牌低频相似',
          searchText: '令牌 低频 相似',
          // 与查询向量近似正交，低于默认 0.3。
          embedding: vectorFor('backup'),
        },
      ],
    });
    const strict = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    const strictHit = strict.hits.find((hit) => hit.title === '门槛文档');
    expect(strictHit?.scores.keyword).not.toBeNull();
    expect(strictHit?.scores.vector).toBeNull();
    expect(strict.degraded).toBe(false);

    const loose = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 20, rerank: false, minVectorScore: 0 },
      { secretKey: SECRET_KEY },
    );
    const looseHit = loose.hits.find((hit) => hit.title === '门槛文档');
    expect(looseHit?.scores.vector).not.toBeNull();
    expect(looseHit!.scores.vector!).toBeLessThan(0.3);
  });

  it('rerank 成功时 scoreKind=rerank，失败/部分响应保留完整 RRF 列表', async () => {
    const baseline = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    const baselineIds = baseline.hits.map((hit) => hit.chunkId);

    rerankMode = 'ok';
    const reranked = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 20, rerank: true },
      { secretKey: SECRET_KEY },
    );
    expect(reranked.hits.length).toBeGreaterThan(0);
    expect(reranked.hits[0]?.scoreKind).toBe('rerank');
    expect(reranked.hits[0]?.scores.rerank).not.toBeNull();
    expect(reranked.hits[0]?.score).toBe(reranked.hits[0]?.scores.rerank);
    expect(reranked.hits[0]?.scores.rrf).toBeGreaterThan(0);
    expect(reranked.hits[0]?.scores.keyword).not.toBeNull();
    expect(reranked.warnings).toEqual([]);

    for (const mode of ['fail', 'partial'] as const) {
      rerankMode = mode;
      const fallback = await searchKnowledge(
        db,
        baseId,
        { q: '令牌', folders: [], tags: [], limit: 20, rerank: true },
        { secretKey: SECRET_KEY },
      );
      expect(fallback.hits.map((hit) => hit.chunkId)).toEqual(baselineIds);
      expect(fallback.hits.every((hit) => hit.scoreKind === 'rrf')).toBe(true);
      expect(fallback.warnings.map((warning) => warning.code)).toContain('rerank_unavailable');
    }
  });

  it('diagnostics 只在显式开启时返回路径计数与候选分数', async () => {
    const plain = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 5, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(plain.diagnostics).toBeUndefined();

    const diagnosed = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 5, rerank: false, diagnostics: true },
      { secretKey: SECRET_KEY },
    );
    expect(diagnosed.diagnostics?.paths.keyword).toBeGreaterThan(0);
    expect(diagnosed.diagnostics?.paths.vector).toBeGreaterThan(0);
    expect(diagnosed.diagnostics?.fused).toBe(diagnosed.diagnostics?.candidates.length);
    expect(diagnosed.diagnostics?.returned).toBe(diagnosed.hits.length);
    expect(diagnosed.diagnostics?.rerank).toBe('off');
    expect(diagnosed.diagnostics?.candidates[0]?.scores.rrf).toBeGreaterThan(0);
  });

  it('FAQ 反例按归一化精确匹配排除，多答案 quote 明确标注', async () => {
    const faq = await seedDocument({
      title: '密码 FAQ',
      contentKind: 'faq',
      faq: {
        question: '如何重置密码',
        similarQuestions: ['忘记密码怎么办'],
        negativeQuestions: ['如何注销账号'],
        answers: ['打开设置页面重置。', '联系管理员重置。'],
      },
      chunks: [
        {
          content: '如何重置密码',
          searchText: '如何 重置 密码',
          embedding: vectorFor('token'),
          metadata: { questionKind: 'standard', matchedQuestion: '如何重置密码', answerOrdinal: 0 },
        },
        {
          content: '忘记密码怎么办',
          searchText: '忘记 密码 怎么办',
          embedding: vectorFor('token'),
          metadata: {
            questionKind: 'similar',
            matchedQuestion: '忘记密码怎么办',
            answerOrdinal: 0,
          },
        },
        {
          content: '如何注销账号',
          searchText: '如何 注销 账号',
          embedding: vectorFor('token'),
          metadata: { questionKind: 'standard', matchedQuestion: '如何注销账号', answerOrdinal: 0 },
        },
      ],
    });

    const hit = await searchKnowledge(
      db,
      baseId,
      { q: '重置密码', folders: [], tags: [], limit: 10, rerank: false },
      { secretKey: SECRET_KEY },
    );
    const faqHit = hit.hits.find((entry) => entry.target.kind === 'faq');
    expect(faqHit?.target.id).toBe(faq.document.id);
    expect(faqHit?.targetVersionId).toBe(faq.version.id);
    expect(faqHit?.quote).toContain('共 2 个答案');

    const negative = await searchKnowledge(
      db,
      baseId,
      { q: ' 如何注销账号 ', folders: [], tags: [], limit: 10, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(negative.hits.some((entry) => entry.target.kind === 'faq')).toBe(false);
  });

  it('FAQ 命中按文档去重并返回策略、匹配问句与推荐标记', async () => {
    const faq = await seedDocument({
      title: '密码 FAQ',
      contentKind: 'faq',
      faq: {
        question: '如何重置密码',
        similarQuestions: ['忘记密码怎么办'],
        negativeQuestions: [],
        answers: ['打开设置页面重置。', '联系管理员重置。'],
        answerStrategy: 'all',
        isRecommended: true,
      },
      chunks: [
        {
          content: '如何重置密码',
          searchText: '如何 重置 密码',
          embedding: vectorFor('token'),
          metadata: { questionKind: 'standard', matchedQuestion: '如何重置密码', answerOrdinal: 0 },
        },
        {
          content: '忘记密码怎么办',
          searchText: '忘记 密码 怎么办',
          embedding: vectorFor('token'),
          metadata: {
            questionKind: 'similar',
            matchedQuestion: '忘记密码怎么办',
            answerOrdinal: 0,
          },
        },
      ],
    });
    const result = await searchKnowledge(
      db,
      baseId,
      { q: '重置密码', folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
      { secretKey: SECRET_KEY },
    );
    const faqHits = result.hits.filter(
      (entry) => entry.target.kind === 'faq' && entry.target.id === faq.document.id,
    );
    // 标准问与相似问同属一份 FAQ，只保留排名最高的一条。
    expect(faqHits).toHaveLength(1);
    const hit = faqHits[0]!;
    expect(hit.faq?.answers).toEqual(['打开设置页面重置。', '联系管理员重置。']);
    expect(hit.faq?.answerStrategy).toBe('all');
    expect(hit.faq?.isRecommended).toBe(true);
    expect(['如何重置密码', '忘记密码怎么办']).toContain(hit.faq?.matchedQuestion);
    expect(hit.faq?.questionKind).toBe(
      hit.faq?.matchedQuestion === '忘记密码怎么办' ? 'similar' : 'standard',
    );
    expect(hit.quote).toContain('共 2 个答案');
  });

  it('真实 ingest 正问叶形状：similar 问命中返回 similar 与 matchedQuestion', async () => {
    embeddingMode = 'fail';
    const faq = await seedDocument({
      title: '相似问 FAQ',
      contentKind: 'faq',
      faq: {
        question: '如何重置密码',
        similarQuestions: ['忘记密码怎么办'],
        negativeQuestions: [],
        answers: ['打开设置页面重置。'],
      },
      chunks: [
        {
          content: '如何重置密码',
          searchText: '如何 重置 密码',
          embedding: null,
          metadata: { questionKind: 'standard', matchedQuestion: '如何重置密码', answerOrdinal: 0 },
        },
        {
          content: '忘记密码怎么办',
          searchText: '忘记 密码 怎么办',
          embedding: null,
          metadata: {
            questionKind: 'similar',
            matchedQuestion: '忘记密码怎么办',
            answerOrdinal: 0,
          },
        },
      ],
    });
    const result = await searchKnowledge(
      db,
      baseId,
      { q: '忘记', folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
      { secretKey: SECRET_KEY },
    );
    const hit = result.hits.find((entry) => entry.target.id === faq.document.id);
    expect(hit?.faq?.questionKind).toBe('similar');
    expect(hit?.faq?.matchedQuestion).toBe('忘记密码怎么办');
  });

  it('random 策略每次只返回一个答案且不改写版本', async () => {
    embeddingMode = 'fail';
    const answers = ['答案甲', '答案乙', '答案丙'];
    const faq = await seedDocument({
      title: '随机 FAQ',
      contentKind: 'faq',
      faq: {
        question: '重置密码',
        similarQuestions: [],
        negativeQuestions: [],
        answers,
        answerStrategy: 'random',
        isRecommended: true,
      },
      chunks: [{ content: '重置密码', searchText: '重置 密码', embedding: vectorFor('token') }],
    });
    const seen = new Set<string>();
    for (let run = 0; run < 30; run += 1) {
      const result = await searchKnowledge(
        db,
        baseId,
        { q: '密码', folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
        { secretKey: SECRET_KEY },
      );
      const hit = result.hits.find((entry) => entry.target.id === faq.document.id);
      expect(hit?.faq?.answerStrategy).toBe('random');
      expect(hit?.faq?.answers).toHaveLength(1);
      // 父上下文也不得泄露未抽中的答案。
      expect(hit?.parentContent).toBe(hit?.faq?.answers[0]);
      expect(answers).toContain(hit?.faq?.answers[0]);
      seen.add(hit!.faq!.answers[0]!);
    }
    expect(seen.size).toBe(answers.length);
    const version = await repo.knowledge.getVersion(db, faq.version.id);
    expect(version?.faq?.answers).toEqual(answers);
  });

  it('onlyRecommended 只筛 FAQ，不影响文档', async () => {
    embeddingMode = 'fail';
    const recommended = await seedDocument({
      title: '推荐 FAQ',
      contentKind: 'faq',
      faq: {
        question: '推荐问题',
        similarQuestions: [],
        negativeQuestions: [],
        answers: ['推荐答案'],
        isRecommended: true,
      },
      chunks: [{ content: '推荐问题', searchText: '推荐 问题', embedding: null }],
    });
    const hidden = await seedDocument({
      title: '不推荐 FAQ',
      contentKind: 'faq',
      faq: {
        question: '不推荐问题',
        similarQuestions: [],
        negativeQuestions: [],
        answers: ['不推荐答案'],
        isRecommended: false,
      },
      chunks: [{ content: '不推荐问题', searchText: '推荐 问题', embedding: null }],
    });
    const doc = await seedDocument({
      title: '推荐文档',
      chunks: [{ content: '推荐问题说明', searchText: '推荐 问题', embedding: null }],
    });
    const query = {
      q: '推荐 问题',
      folders: [],
      tags: [],
      limit: 20,
      rerank: false,
      kinds: ['document', 'faq'] as const,
    };
    const recommendedOnly = await searchKnowledge(
      db,
      baseId,
      { ...query, onlyRecommended: true },
      { secretKey: SECRET_KEY },
    );
    const ids = recommendedOnly.hits.map((entry) => entry.target.id);
    expect(ids).toContain(recommended.document.id);
    expect(ids).not.toContain(hidden.document.id);
    expect(ids).toContain(doc.document.id);

    const all = await searchKnowledge(db, baseId, query, { secretKey: SECRET_KEY });
    expect(all.hits.map((entry) => entry.target.id)).toContain(hidden.document.id);
    expect(
      all.hits.find((entry) => entry.target.id === hidden.document.id)?.faq?.isRecommended,
    ).toBe(false);
  });

  it('faqPriority 提前 FAQ，并用原始 cosine 决定 directAnswer', async () => {
    const faq = await seedDocument({
      title: '令牌 FAQ',
      contentKind: 'faq',
      faq: {
        question: '令牌怎么轮换',
        similarQuestions: [],
        negativeQuestions: [],
        answers: ['先撤销旧令牌。'],
        answerStrategy: 'all',
        isRecommended: true,
      },
      chunks: [
        {
          content: '令牌怎么轮换',
          searchText: '令牌 怎么 轮换',
          embedding: vectorAt(0.99),
        },
      ],
    });
    await seedDocument({
      title: '令牌说明',
      chunks: [
        { content: '令牌说明正文', searchText: '令牌 说明 正文', embedding: vectorFor('token') },
      ],
    });
    const base = {
      q: '令牌',
      folders: [],
      tags: [],
      limit: 10,
      rerank: false,
      kinds: ['document', 'faq'] as const,
    };
    const prioritized = await searchKnowledge(
      db,
      baseId,
      { ...base, faqPriority: true, faqDirectAnswerThreshold: 0.9 },
      { secretKey: SECRET_KEY },
    );
    expect(prioritized.hits[0]?.target.kind).toBe('faq');
    expect(prioritized.directAnswer).toEqual({
      target: { kind: 'faq', id: faq.document.id },
      versionId: faq.version.id,
      answers: ['先撤销旧令牌。'],
      vectorScore: expect.any(Number),
    });
    expect(prioritized.directAnswer!.vectorScore).toBeGreaterThanOrEqual(0.9);

    const mixed = await searchKnowledge(db, baseId, base, { secretKey: SECRET_KEY });
    expect(mixed.directAnswer).toBeNull();
  });

  it('低 cosine 或关键词降级时不返回 directAnswer', async () => {
    const faq = await seedDocument({
      title: '低分 FAQ',
      contentKind: 'faq',
      faq: {
        question: '令牌低分问题',
        similarQuestions: [],
        negativeQuestions: [],
        answers: ['低分答案'],
        answerStrategy: 'all',
        isRecommended: true,
      },
      chunks: [{ content: '令牌低分问题', searchText: '令牌 低分 问题', embedding: vectorAt(0.5) }],
    });
    const query = {
      q: '令牌',
      folders: [],
      tags: [],
      limit: 10,
      rerank: false,
      kinds: ['faq'] as const,
      faqPriority: true,
    };
    const below = await searchKnowledge(
      db,
      baseId,
      { ...query, faqDirectAnswerThreshold: 0.9 },
      { secretKey: SECRET_KEY },
    );
    expect(below.hits.some((entry) => entry.target.id === faq.document.id)).toBe(true);
    expect(
      below.hits.find((entry) => entry.target.id === faq.document.id)?.scores.vector,
    ).toBeGreaterThan(0.3);
    expect(below.directAnswer).toBeNull();

    // 同一原始 cosine 在较低门槛下可用，证明门槛比较的是 cosine 而不是 RRF。
    const above = await searchKnowledge(
      db,
      baseId,
      { ...query, faqDirectAnswerThreshold: 0.4 },
      { secretKey: SECRET_KEY },
    );
    expect(above.directAnswer?.vectorScore).toBeGreaterThanOrEqual(0.4);

    embeddingMode = 'fail';
    const degraded = await searchKnowledge(
      db,
      baseId,
      { ...query, faqDirectAnswerThreshold: -1 },
      { secretKey: SECRET_KEY },
    );
    expect(degraded.degraded).toBe(true);
    expect(degraded.directAnswer).toBeNull();
  });

  it('反例复用共享归一化：URL、大小写、全角与空白都按精确相等排除', async () => {
    const faq = await seedDocument({
      title: '反例 FAQ',
      contentKind: 'faq',
      faq: {
        question: '如何重置密码',
        similarQuestions: [],
        negativeQuestions: ['如何注销账号？ https://example.test/help', 'ＤＥＬＥＴＥ   ACCOUNT'],
        answers: ['打开设置重置。'],
      },
      chunks: [
        { content: '如何重置密码', searchText: '如何 重置 密码', embedding: vectorFor('token') },
        {
          content: '如何注销账号',
          searchText: '如何 注销 账号',
          embedding: vectorFor('token'),
          metadata: { questionKind: 'standard', matchedQuestion: '如何注销账号', answerOrdinal: 0 },
        },
        {
          content: 'Delete Account',
          searchText: 'delete account',
          embedding: vectorFor('token'),
          metadata: {
            questionKind: 'standard',
            matchedQuestion: 'Delete Account',
            answerOrdinal: 0,
          },
        },
      ],
    });
    for (const q of [' 如何注销账号 ', 'delete   account']) {
      const result = await searchKnowledge(
        db,
        baseId,
        { q, folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
        { secretKey: SECRET_KEY },
      );
      expect(result.hits.some((entry) => entry.target.id === faq.document.id)).toBe(false);
    }
    const positive = await searchKnowledge(
      db,
      baseId,
      { q: '如何重置密码', folders: [], tags: [], limit: 10, rerank: false, kinds: ['faq'] },
      { secretKey: SECRET_KEY },
    );
    expect(positive.hits.some((entry) => entry.target.id === faq.document.id)).toBe(true);
  });

  it('父上下文只含仍启用的子块，不返回父块旧内容', async () => {
    const { document } = await seedDocument({
      title: '禁用子块文档',
      chunks: [
        {
          content: '父块旧内容：启用子块正文 禁用子块内容',
          searchText: '父块 旧 内容',
          embedding: null,
          indexRole: 'parent',
        },
        {
          content: '启用子块正文',
          searchText: '启用 子块 正文 令牌',
          embedding: vectorFor('token'),
          parentOrdinal: 0,
        },
        {
          content: '禁用子块内容',
          searchText: '禁用 子块 内容 令牌',
          embedding: vectorFor('token'),
          enabled: false,
          parentOrdinal: 0,
        },
      ],
    });
    const result = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 20, rerank: false, kinds: ['document'] },
      { secretKey: SECRET_KEY },
    );
    const hit = result.hits.find((entry) => entry.documentId === document.id);
    expect(hit?.parentContent).toBe('启用子块正文');
  });

  it('kinds 过滤三类对象，父块只提供上下文不参与排名', async () => {
    const { document } = await seedDocument({
      title: '父子文档',
      chunks: [
        {
          content: '父块上下文：令牌轮换背景',
          searchText: '父块 上下文 令牌 轮换 背景',
          embedding: vectorFor('token'),
          indexRole: 'parent',
        },
        {
          content: '子块正文：先轮换再撤销',
          searchText: '子块 正文 令牌 轮换 撤销',
          embedding: vectorFor('token'),
          parentOrdinal: 0,
          locator: { pageFrom: 2, lineFrom: 10 },
        },
      ],
    });
    const result = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 20, rerank: false, kinds: ['document'] },
      { secretKey: SECRET_KEY },
    );
    const hit = result.hits.find((entry) => entry.documentId === document.id);
    // 父上下文只由仍启用的子块重建，不直接回显父块存储正文。
    expect(hit?.parentContent).toBe('子块正文：先轮换再撤销');
    expect(hit?.locator).toEqual({ pageFrom: 2, lineFrom: 10 });
    expect(result.hits.every((entry) => entry.target.kind === 'document')).toBe(true);

    const faqOnly = await searchKnowledge(
      db,
      baseId,
      { q: '令牌', folders: [], tags: [], limit: 20, rerank: false, kinds: ['faq'] },
      { secretKey: SECRET_KEY },
    );
    expect(faqOnly.hits.every((entry) => entry.target.kind === 'faq')).toBe(true);
  });

  it('Wiki 只召回已发布且索引追上线指针、来源仍有效的页面', async () => {
    const source = await seedDocument({
      title: 'Wiki 来源',
      chunks: [{ content: '来源正文', searchText: '来源 正文', embedding: vectorFor('token') }],
    });
    const chunk = await db.execute<{ id: string }>(
      sql`select id from knowledge_chunks where document_id = ${source.document.id} limit 1`,
    );
    const page = await repo.knowledge.createWikiPage(db, {
      baseId,
      slug: `wiki-${Math.random().toString(36).slice(2, 8)}`,
      title: 'Wiki 页面',
    });
    const published = await repo.knowledge.saveWikiVersion(db, page.id, {
      markdown: '线上 Wiki 正文',
      sourceChunkIds: [chunk.rows[0]!.id],
      model: 'manual',
      generatedBy: 'manual',
    });
    await repo.knowledge.publishWikiVersion(db, page.id, published!.id);
    await seedDocument({
      title: 'Wiki 索引',
      contentKind: 'wiki',
      documentMetadata: { wikiPageId: page.id },
      versionMetadata: { wikiPageId: page.id, wikiVersionId: published!.id },
      chunks: [{ content: 'Wiki 正文', searchText: 'Wiki 正文', embedding: vectorFor('token') }],
    });

    const hit = await searchKnowledge(
      db,
      baseId,
      { q: 'Wiki', folders: [], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    const wikiHit = hit.hits.find((entry) => entry.target.kind === 'wiki');
    expect(wikiHit?.target.id).toBe(page.id);
    expect(wikiHit?.targetVersionId).toBe(published?.id);
    expect(wikiHit?.documentId).not.toBe(page.id);

    // Wiki 默认不受自己的目录/标签影响；带过滤时看来源文档。
    const matchingFolder = await repo.knowledge.createFolder(db, {
      baseId,
      parentId: null,
      name: '匹配目录',
      path: '/matching',
    });
    const otherFolder = await repo.knowledge.createFolder(db, {
      baseId,
      parentId: null,
      name: '其他目录',
      path: '/other',
    });
    await repo.knowledge.updateDocument(db, source.document.id, { folderId: matchingFolder.id });
    const tag = await repo.knowledge.upsertTag(db, baseId, 'wiki-source');
    await repo.knowledge.setDocumentTags(db, source.document.id, [tag.id]);
    const byMatchingFolder = await searchKnowledge(
      db,
      baseId,
      { q: 'Wiki', folders: [matchingFolder.id], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(byMatchingFolder.hits.some((entry) => entry.target.id === page.id)).toBe(true);
    const byOtherFolder = await searchKnowledge(
      db,
      baseId,
      { q: 'Wiki', folders: [otherFolder.id], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(byOtherFolder.hits.some((entry) => entry.target.id === page.id)).toBe(false);
    const byTag = await searchKnowledge(
      db,
      baseId,
      { q: 'Wiki', folders: [], tags: ['wiki-source'], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(byTag.hits.some((entry) => entry.target.id === page.id)).toBe(true);
    const byOtherTag = await searchKnowledge(
      db,
      baseId,
      { q: 'Wiki', folders: [], tags: ['missing-tag'], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(byOtherTag.hits.some((entry) => entry.target.id === page.id)).toBe(false);

    // 线上指针前进但索引未追上：旧索引不召回，并给出 pending 警告。
    const next = await repo.knowledge.saveWikiVersion(db, page.id, {
      markdown: '线上 Wiki 新正文',
      sourceChunkIds: [chunk.rows[0]!.id],
      model: 'manual',
      generatedBy: 'manual',
    });
    await repo.knowledge.publishWikiVersion(db, page.id, next!.id);
    const stale = await searchKnowledge(
      db,
      baseId,
      { q: 'Wiki', folders: [], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(stale.hits.some((entry) => entry.target.id === page.id)).toBe(false);
    expect(stale.warnings.map((warning) => warning.code)).toContain('wiki_index_pending');

    // 来源撤权后，即使索引仍指向线上版本也不能召回。
    await repo.knowledge.updateDocument(db, source.document.id, {
      status: 'disabled',
      disabledReason: 'manual',
    });
    await seedDocument({
      title: 'Wiki 索引二',
      contentKind: 'wiki',
      documentMetadata: { wikiPageId: page.id },
      versionMetadata: { wikiPageId: page.id, wikiVersionId: next!.id },
      chunks: [
        { content: 'Wiki 新正文', searchText: 'Wiki 新正文', embedding: vectorFor('token') },
      ],
    });
    const revoked = await searchKnowledge(
      db,
      baseId,
      { q: 'Wiki', folders: [], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(revoked.hits.some((entry) => entry.target.id === page.id)).toBe(false);
  });

  it('来源范围撤权后关键词命中也不返回', async () => {
    const source = await repo.knowledge.createSource(db, {
      baseId,
      type: 'github',
      name: `src-${Math.random().toString(36).slice(2, 8)}`,
      config: { baseUrl: 'https://api.github.com', projectId: 'o/r' },
      secretsEncrypted: null,
      syncCron: null,
    });
    const [range] = await repo.knowledge.replaceRanges(db, source.id, [
      { kind: 'github_repo', externalId: 'o/r', ref: null, paths: ['docs'], enabled: true },
    ]);
    const document = await seedDocument({
      title: '外部文档',
      sourceConnectionId: source.id,
      sourcePath: 'docs/guide.md',
      currentVersion: false,
      chunks: [
        { content: '外部令牌正文', searchText: '外部 令牌 正文', embedding: vectorFor('token') },
      ],
    });
    await db.execute(
      sql`insert into knowledge_document_source_ranges (document_id, range_id)
          values (${document.document.id}, ${range!.id})`,
    );
    // 来源文档先证明范围归属，再切当前版本（发布守卫会拒绝无归属的外部文档）。
    await repo.knowledge.setCurrentVersion(db, document.document.id, document.version.id);
    const before = await searchKnowledge(
      db,
      baseId,
      { q: '外部令牌', folders: [], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(before.hits.some((entry) => entry.documentId === document.document.id)).toBe(true);

    await db.execute(
      sql`update knowledge_source_ranges set enabled = false where id = ${range!.id}`,
    );
    const after = await searchKnowledge(
      db,
      baseId,
      { q: '外部令牌', folders: [], tags: [], limit: 20, rerank: false },
      { secretKey: SECRET_KEY },
    );
    expect(after.hits.some((entry) => entry.documentId === document.document.id)).toBe(false);
  });
});
