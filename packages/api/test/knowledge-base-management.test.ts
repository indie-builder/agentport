import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import type { KnowledgeBase, KnowledgeBaseSummary } from '@agentport/shared';
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

describe.skipIf(!ready)('knowledge base management', () => {
  let app: TestApp;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-base-management-'));
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
      await app.client.unsafe('delete from audit_log where target = any($1::text[])', [
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

  async function createProfile(kind: 'embedding' | 'rerank' = 'embedding'): Promise<string> {
    const res = await request(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind,
        name: unique(`mgmt-${kind}`),
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const profileId = res.json<{ id: string }>().id;
    profileIds.push(profileId);
    return profileId;
  }

  async function createBase(
    input: {
      embeddingProfileId?: string;
      rerankProfileId?: string | null;
      name?: string;
      description?: string;
    } = {},
  ): Promise<KnowledgeBase> {
    const res = await request(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: {
        slug: unique('mgmt-kb'),
        name: input.name ?? '管理库',
        ...(input.description === undefined ? {} : { description: input.description }),
        embeddingProfileId: input.embeddingProfileId ?? (await createProfile('embedding')),
        ...(input.rerankProfileId === undefined ? {} : { rerankProfileId: input.rerankProfileId }),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const base = res.json<KnowledgeBase>();
    baseIds.push(base.id);
    return base;
  }

  async function duplicate(baseId: string, body: Record<string, unknown>, actorCookie = cookie) {
    const res = await request(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/duplicate`,
      headers: { cookie: actorCookie },
      payload: body,
    });
    if (res.statusCode === 201) baseIds.push(res.json<KnowledgeBase>().id);
    return res;
  }

  function summary(baseId: string, actorCookie = cookie) {
    return request(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/summary`,
      headers: { cookie: actorCookie },
    });
  }

  async function seedDocument(
    baseId: string,
    contentKind: 'document' | 'faq' | 'wiki' = 'document',
  ) {
    return repo.knowledge.createDocument(app.db, {
      baseId,
      folderId: null,
      title: unique(contentKind),
      sourceType: 'manual',
      sourceId: null,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: 1,
      contentKind,
    });
  }

  it('counts each knowledge entity and the latest job per base', async () => {
    const empty = await createBase();

    const emptyRes = await summary(empty.id);
    expect(emptyRes.statusCode, emptyRes.body).toBe(200);
    expect(emptyRes.json<KnowledgeBaseSummary>()).toEqual({
      documents: 0,
      faqs: 0,
      wikiPages: 0,
      sources: 0,
      folders: 0,
      tags: 0,
      lastJob: null,
    });

    await seedDocument(empty.id);
    await seedDocument(empty.id);
    await seedDocument(empty.id, 'faq');
    await repo.knowledge.createWikiPage(app.db, {
      baseId: empty.id,
      slug: unique('page'),
      title: '页面',
    });
    await repo.knowledge.createSource(app.db, {
      baseId: empty.id,
      type: 'github',
      name: unique('src'),
      config: {},
      secretsEncrypted: null,
      syncCron: null,
    });
    await repo.knowledge.createFolder(app.db, {
      baseId: empty.id,
      parentId: null,
      name: '目录',
      path: '/目录',
    });
    await repo.knowledge.upsertTag(app.db, empty.id, '标签');

    const older = await repo.knowledge.createJob(app.db, {
      type: 'cleanup',
      baseId: empty.id,
      documentId: null,
      sourceId: null,
      payload: { type: 'cleanup', baseId: empty.id },
    });
    // 让两条任务的 created_at 有确定先后，避免同毫秒排序不稳。
    await app.client.unsafe(
      "update knowledge_jobs set created_at = created_at - interval '1 hour' where id = $1",
      [older.id],
    );
    const latest = await repo.knowledge.createJob(app.db, {
      type: 'reindex',
      baseId: empty.id,
      documentId: null,
      sourceId: null,
      payload: {
        type: 'reindex',
        baseId: empty.id,
        chunksOnly: false,
        confirmOverwriteManualChunks: false,
      },
    });

    const res = await summary(empty.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<KnowledgeBaseSummary>();
    expect(body).toMatchObject({
      documents: 2,
      faqs: 1,
      wikiPages: 1,
      sources: 1,
      folders: 1,
      tags: 1,
    });
    expect(body.lastJob).toMatchObject({ id: latest.id, type: 'reindex', status: 'queued' });
    // 未开始/未结束的任务没有起止时间，updatedAt 回落到 createdAt。
    expect(body.lastJob?.updatedAt).toBe(body.lastJob?.createdAt);
  });

  it('rejects summary of a missing base', async () => {
    const res = await summary(unique('missing'));
    expectProblem(res, 'NOT_FOUND');
  });

  it('keeps documents, faqs and wiki pages in disjoint buckets', async () => {
    const target = await createBase();
    await seedDocument(target.id);
    await seedDocument(target.id);
    await seedDocument(target.id, 'faq');
    await repo.knowledge.createWikiPage(app.db, {
      baseId: target.id,
      slug: unique('page'),
      title: '页面',
    });
    // Wiki 页在 documents 里有一行 content_kind='wiki' 的检索索引，不能被算进文档数。
    await seedDocument(target.id, 'wiki');

    const res = await summary(target.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<KnowledgeBaseSummary>()).toMatchObject({
      documents: 2,
      faqs: 1,
      wikiPages: 1,
    });
  });

  it('duplicates configuration only and suffixes a taken slug', async () => {
    const embeddingProfileId = await createProfile('embedding');
    const rerankProfileId = await createProfile('rerank');
    const source = await createBase({
      embeddingProfileId,
      rerankProfileId,
      name: '源库',
      description: '源描述',
    });
    const patched = await request(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${source.id}`,
      headers: { cookie },
      payload: { status: 'disabled', settings: { chunkTokens: 1024, chunkOverlap: 64 } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const sourceWire = patched.json<KnowledgeBase>();
    await seedDocument(source.id);

    const firstRes = await duplicate(source.id, {});
    expect(firstRes.statusCode, firstRes.body).toBe(201);
    const first = firstRes.json<KnowledgeBase>();
    expect(first.slug).toBe(`${sourceWire.slug}-copy`);
    expect(first.name).toBe(`${sourceWire.name} 副本`);
    expect(first.description).toBe('源描述');
    expect(first.status).toBe('disabled');
    expect(first.embeddingProfileId).toBe(embeddingProfileId);
    expect(first.rerankProfileId).toBe(rerankProfileId);
    expect(first.asrProfileId).toBeNull();
    expect(first.settings).toEqual(sourceWire.settings);

    const copySummary = await summary(first.id);
    expect(copySummary.statusCode, copySummary.body).toBe(200);
    expect(copySummary.json<KnowledgeBaseSummary>()).toEqual({
      documents: 0,
      faqs: 0,
      wikiPages: 0,
      sources: 0,
      folders: 0,
      tags: 0,
      lastJob: null,
    });

    const secondRes = await duplicate(source.id, {});
    expect(secondRes.statusCode, secondRes.body).toBe(201);
    expect(secondRes.json<KnowledgeBase>().slug).toBe(`${sourceWire.slug}-2`);

    const explicitSlug = unique('explicit-copy');
    const explicitRes = await duplicate(source.id, {
      name: '自定义副本',
      slug: explicitSlug,
      description: '副本描述',
    });
    expect(explicitRes.statusCode, explicitRes.body).toBe(201);
    expect(explicitRes.json<KnowledgeBase>()).toMatchObject({
      slug: explicitSlug,
      name: '自定义副本',
      description: '副本描述',
      status: 'disabled',
    });
  });

  it('rejects duplicating a missing base', async () => {
    expectProblem(await duplicate(unique('missing'), {}), 'NOT_FOUND');
  });

  it('rejects an explicit slug that another base already occupies', async () => {
    const source = await createBase();
    const taken = unique('taken-copy');
    const firstRes = await duplicate(source.id, { slug: taken });
    expect(firstRes.statusCode, firstRes.body).toBe(201);
    expect(firstRes.json<KnowledgeBase>().slug).toBe(taken);

    // 显式 slug 被占用时不做自动后缀，createBase 的唯一索引冲突映射成 CONFLICT。
    expectProblem(await duplicate(source.id, { slug: taken }), 'CONFLICT');
  });

  it('requires knowledge.create to duplicate a base', async () => {
    const source = await createBase();
    const readerRole = await createRole(
      app,
      cookie,
      unique('kb-reader'),
      grants(['knowledge.read', 'platform']),
    );
    const account = await createAccount(app, cookie, {
      roleIds: [readerRole.id],
      password: PASSWORD,
    });
    expect(account.statusCode, account.body).toBe(201);
    const readerSignIn = await login(app, account.account.username, PASSWORD);
    expect(readerSignIn.statusCode, readerSignIn.body).toBe(200);
    const readerCookie = cookieOf(readerSignIn);

    expectProblem(await duplicate(source.id, {}, readerCookie), 'FORBIDDEN');
    const readable = await summary(source.id, readerCookie);
    expect(readable.statusCode, readable.body).toBe(200);
  });

  it('writes a duplicated audit record pointing at the copy', async () => {
    const source = await createBase();
    const res = await duplicate(source.id, {});
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json<KnowledgeBase>();

    const rows = await app.client.unsafe<{ action: string; actor: string }[]>(
      "select action, actor from audit_log where target = $1 and action = 'knowledge.base.duplicated'",
      [copy.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.actor).toBeTruthy();
  });
});
