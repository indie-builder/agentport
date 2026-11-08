import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cookieOf,
  createAccount,
  createRole,
  expectProblem,
  grants,
  login,
} from './access-helpers.js';
import { infraReady, loginCookie, request, startApp, type TestApp, unique } from './helpers.js';

const ready = await infraReady;
const PASSWORD = 'test-password-123';

type ChunkPreview = {
  chunks: { index: number; heading: string; content: string; length: number }[];
  stats: { count: number; avgChars: number; minChars: number; maxChars: number };
  truncated: boolean;
};

/** 每段固定长度、用空行分隔：小预算逐段成块，大预算合并成一块。 */
function paragraphs(count: number, length = 150): string {
  const unit = '分块预览用于核对切分效果。';
  const body = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  return Array.from({ length: count }, (_, index) => `${body}${index + 1}`).join('\n\n');
}

describe.skipIf(!ready)('knowledge chunk preview', () => {
  let app: TestApp;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-chunk-preview-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
  });

  afterEach(async () => {
    if (baseIds.length > 0) {
      // 知识库 server 是独立行；删 server 会级联删库，避免留下 kb-<slug> 名称占用。
      await app.client.unsafe(
        "delete from servers where kind = 'knowledge' and config->>'knowledgeBaseId' = any($1::text[])",
        [app.client.array(baseIds, 'TEXT')],
      );
      await app.client.unsafe('delete from knowledge_bases where id = any($1::text[])', [
        app.client.array(baseIds, 'TEXT'),
      ]);
      baseIds.length = 0;
    }
    if (profileIds.length > 0) {
      await app.client.unsafe('delete from knowledge_model_profiles where id = any($1::text[])', [
        app.client.array(profileIds, 'TEXT'),
      ]);
      profileIds.length = 0;
    }
  });

  afterAll(async () => {
    await app.close();
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  async function createBase(): Promise<string> {
    const profile = await request(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('preview-emb'),
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const profileId = profile.json<{ id: string }>().id;
    profileIds.push(profileId);

    const res = await request(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('preview-kb'), name: '预览库', embeddingProfileId: profileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  function preview(
    baseId: string,
    body: { sample: string; chunkTokens?: number; chunkOverlap?: number },
    actorCookie = cookie,
  ) {
    return request(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/chunk-preview`,
      headers: { cookie: actorCookie },
      payload: body,
    });
  }

  async function previewOk(
    baseId: string,
    body: { sample: string; chunkTokens?: number; chunkOverlap?: number },
  ): Promise<ChunkPreview> {
    const res = await preview(baseId, body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ChunkPreview>();
  }

  it('produces fewer chunks as the chunk budget grows', async () => {
    const baseId = await createBase();
    const sample = paragraphs(6);

    const small = await previewOk(baseId, { sample, chunkTokens: 200, chunkOverlap: 0 });
    const large = await previewOk(baseId, { sample, chunkTokens: 1000, chunkOverlap: 0 });

    expect(small.stats.count).toBe(6);
    expect(large.stats.count).toBe(1);
    expect(small.chunks.map((chunk) => chunk.length)).toEqual(
      small.chunks.map((chunk) => chunk.content.length),
    );
    expect(small.stats.minChars).toBeLessThanOrEqual(small.stats.avgChars);
    expect(small.stats.maxChars).toBeGreaterThanOrEqual(small.stats.avgChars);
  });

  it('clamps oversized paragraphs and keeps a table apart from the prose around it', async () => {
    const baseId = await createBase();
    const rows = Array.from(
      { length: 20 },
      (_, index) => `| 项目${index} | 指标${index}说明文本 |`,
    );
    const sample = [
      '# 数据报告',
      '',
      `段落哨兵${'长段落用于验证超长块会被二次切分。'.repeat(40)}`,
      '',
      '| 名称 | 说明 |',
      '| --- | --- |',
      ...rows,
      '',
      `尾段哨兵${'收尾段落同样参与合并与切分。'.repeat(12)}`,
    ].join('\n');

    const result = await previewOk(baseId, { sample, chunkTokens: 200, chunkOverlap: 0 });

    expect(result.chunks.length).toBeGreaterThan(1);
    // clamp 生效：长段落与长表格都被切到预算以内，没有整段超预算的块。
    for (const chunk of result.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      expect(chunk.length).toBe(chunk.content.length);
    }
    expect(result.stats.maxChars).toBeLessThanOrEqual(200);

    // 表格块独立：不与相邻段落合并，且每段都重复表头。
    const tableChunks = result.chunks.filter((chunk) => chunk.content.includes('| 名称 | 说明 |'));
    expect(tableChunks.length).toBeGreaterThan(1);
    for (const chunk of tableChunks) {
      expect(chunk.content.startsWith('| 名称 | 说明 |\n| --- | --- |')).toBe(true);
      expect(chunk.content).not.toContain('段落哨兵');
      expect(chunk.content).not.toContain('尾段哨兵');
    }
    const prose = result.chunks.filter(
      (chunk) => chunk.content.includes('段落哨兵') || chunk.content.includes('尾段哨兵'),
    );
    expect(prose).toHaveLength(2);
    for (const chunk of prose) expect(chunk.content).not.toContain('| --- |');
  });

  it('repeats the tail of a chunk as the head of the next one when overlap is set', async () => {
    const baseId = await createBase();
    // 每 10 字符一个唯一前缀，避免周期性文本让「不同位置内容相同」掩盖重叠差异。
    const sample = Array.from(
      { length: 100 },
      (_, block) => `${String.fromCharCode(0x4e00 + block)}ABCDEFGHI`,
    ).join('');
    const overlap = 100;

    const result = await previewOk(baseId, { sample, chunkTokens: 200, chunkOverlap: overlap });
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks[0]?.content).toBe(sample.slice(0, 200));
    expect(result.chunks[1]?.content).toBe(sample.slice(100, 300));

    const strictly = await previewOk(baseId, { sample, chunkTokens: 200, chunkOverlap: 0 });
    expect(strictly.chunks[1]?.content).toBe(sample.slice(200, 400));
  });

  it('falls back to the base settings when no chunk options are sent', async () => {
    const baseId = await createBase();
    const sample = paragraphs(6);
    const beforePatch = await previewOk(baseId, { sample });

    const patched = await request(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${baseId}`,
      headers: { cookie },
      payload: { settings: { chunkTokens: 1000, chunkOverlap: 0 } },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const afterPatch = await previewOk(baseId, { sample });
    expect(afterPatch).toEqual(
      await previewOk(baseId, { sample, chunkTokens: 1000, chunkOverlap: 0 }),
    );
    expect(afterPatch.stats.count).toBe(1);
    expect(afterPatch).not.toEqual(beforePatch);
  });

  it('rejects an overlap that is not smaller than the chunk budget', async () => {
    const baseId = await createBase();

    expectProblem(
      await preview(baseId, { sample: paragraphs(2), chunkTokens: 200, chunkOverlap: 200 }),
      'INVALID_INPUT',
    );
    expectProblem(
      await preview(baseId, { sample: paragraphs(2), chunkTokens: 300, chunkOverlap: 400 }),
      'INVALID_INPUT',
    );
  });

  it('reports a missing base instead of an empty preview', async () => {
    expectProblem(await preview(unique('kb'), { sample: paragraphs(1) }), 'NOT_FOUND');
  });

  it('runs for a knowledge.read subject without execute or content permissions', async () => {
    const baseId = await createBase();
    const readerRole = await createRole(
      app,
      cookie,
      unique('preview-reader'),
      grants(['knowledge.read', 'platform']),
    );
    const reader = await createAccount(app, cookie, {
      roleIds: [readerRole.id],
      password: PASSWORD,
    });
    expect(reader.statusCode, reader.body).toBe(201);
    const readerSignIn = await login(app, reader.account.username, PASSWORD);
    expect(readerSignIn.statusCode, readerSignIn.body).toBe(200);
    const readerCookie = cookieOf(readerSignIn);

    const res = await preview(baseId, { sample: paragraphs(2), chunkTokens: 200 }, readerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ChunkPreview>().stats.count).toBe(2);
    // 预览是纯计算：不建任务，也不要求 knowledge.execute / content.manage。
    const jobs = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from knowledge_jobs where base_id = $1',
      [baseId],
    );
    expect(jobs[0]?.count).toBe(0);

    const noReadRole = await createRole(
      app,
      cookie,
      unique('preview-blocked'),
      grants(['overview.read', 'platform']),
    );
    const blocked = await createAccount(app, cookie, {
      roleIds: [noReadRole.id],
      password: PASSWORD,
    });
    expect(blocked.statusCode, blocked.body).toBe(201);
    const blockedSignIn = await login(app, blocked.account.username, PASSWORD);
    expect(blockedSignIn.statusCode, blockedSignIn.body).toBe(200);
    expectProblem(
      await preview(baseId, { sample: paragraphs(1) }, cookieOf(blockedSignIn)),
      'FORBIDDEN',
    );
  });

  it('truncates the returned chunks but keeps the stats over every chunk', async () => {
    const baseId = await createBase();
    const sample = paragraphs(60);

    const result = await previewOk(baseId, { sample, chunkTokens: 200, chunkOverlap: 0 });
    expect(result.stats.count).toBe(60);
    expect(result.chunks.length).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.chunks.map((chunk) => chunk.index)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );

    const full = await previewOk(baseId, { sample: paragraphs(3), chunkTokens: 200 });
    expect(full.truncated).toBe(false);
  });
});
