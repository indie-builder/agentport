import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FastifyInstance,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('knowledge wiki routes', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  let baseId = '';
  let otherBaseId = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function createProfile() {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('wiki-emb'),
        endpointUrl: 'http://127.0.0.1:1/embeddings',
        model: 'test',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    profileIds.push(id);
    return id;
  }

  async function createBase(embeddingProfileId: string) {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('wiki-kb'), name: 'Wiki 库', embeddingProfileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const base = res.json<{ id: string }>();
    baseIds.push(base.id);
    return base.id;
  }

  async function createPage(title = '认证') {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/wiki-pages`,
      headers: { cookie },
      payload: { slug: `auth-${Math.random().toString(36).slice(2, 8)}`, title },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; title: string; status: string }>();
  }

  async function seedSourceDocument(targetBaseId = baseId): Promise<string> {
    const documentId = `kdoc_wiki${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_documents (id, base_id, title, source_type, mime_type, status)
       values ($1, $2, '来源文档', 'upload', 'text/markdown', 'processing')`,
      [documentId, targetBaseId],
    );
    return documentId;
  }

  /** 追加文档版本并切为当前版本，等价于摄取成功后的版本切换。 */
  async function addSourceVersion(
    documentId: string,
    version: number,
    options: { enabled?: boolean; current?: boolean; baseId?: string } = {},
  ): Promise<{ versionId: string; chunkId: string }> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const versionId = `kdv_wiki${suffix}`;
    const chunkId = `kchk_wiki${suffix}`;
    const targetBaseId = options.baseId ?? baseId;
    await app.pool.query(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id)
       values ($1, $2, $3, $4, $4, 'a.md', 'text/markdown', 1, 'parsed', '[]', '[]',
               (select embedding_profile_id from knowledge_bases where id = $5))`,
      [versionId, documentId, version, 'b'.repeat(64), targetBaseId],
    );
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text, enabled)
       values ($1, $2, $3, $4, 0, 'text', '正文', '正文', $5)`,
      [chunkId, targetBaseId, documentId, versionId, options.enabled ?? true],
    );
    await app.pool.query(
      `update knowledge_documents set status = 'ready', current_version_id = $2 where id = $1`,
      [documentId, options.current === false ? null : versionId],
    );
    return { versionId, chunkId };
  }

  async function saveDraft(
    pageId: string,
    input: { markdown: string; documentId: string; versionId: string; chunkId: string },
  ) {
    return repo.knowledge.saveWikiVersion(app.db, pageId, {
      markdown: input.markdown,
      sourceChunkIds: [input.chunkId],
      model: 'wiki-model',
      generatedBy: 'sdk',
      sources: [
        { documentId: input.documentId, versionId: input.versionId, chunkId: input.chunkId },
      ],
    });
  }

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-wiki-routes-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
    baseId = await createBase(await createProfile());
    otherBaseId = await createBase(await createProfile());
  });

  afterAll(async () => {
    if (baseIds.length > 0) {
      await app.pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
    }
    if (profileIds.length > 0) {
      await app.pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
        profileIds,
      ]);
    }
    await app.close();
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  it('rejects anonymous access to wiki routes', async () => {
    const page = await createPage();
    const cases = [
      ['GET', `/api/knowledge/bases/${baseId}/wiki-pages`, undefined],
      ['POST', `/api/knowledge/bases/${baseId}/wiki-pages`, { slug: 'anon', title: '匿名' }],
      ['GET', `/api/knowledge/wiki-pages/${page.id}`, undefined],
      ['GET', `/api/knowledge/wiki-pages/${page.id}/versions`, undefined],
      ['PATCH', `/api/knowledge/wiki-pages/${page.id}`, { markdown: '# x' }],
      ['POST', `/api/knowledge/wiki-pages/${page.id}/generate`, {}],
      ['POST', `/api/knowledge/wiki-pages/${page.id}/publish`, { versionId: 'kwv_x' }],
      ['POST', `/api/knowledge/wiki-pages/${page.id}/rollback`, { versionId: 'kwv_x' }],
    ] as const;
    for (const [method, url, payload] of cases) {
      const res = await inject(app, { method, url, ...(payload === undefined ? {} : { payload }) });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(401);
    }
  });

  it('lists and creates pages, then returns versions on get', async () => {
    const page = await createPage('部署手册');
    const list = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/wiki-pages`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json<{ items: Array<{ id: string; title: string }> }>().items;
    expect(items.some((item) => item.id === page.id && item.title === '部署手册')).toBe(true);

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ id: page.id, status: 'draft', versions: [] });
  });

  it('manual edits produce a new published version and never rewrite history', async () => {
    const page = await createPage();
    const first = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第一版' },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: 'published' });

    const second = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第二版', title: '认证（改）' },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ title: '认证（改）', status: 'published' });

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const versions = detail.json<{
      currentVersionId: string;
      versions: Array<{ id: string; version: number; markdown: string; generatedBy: string }>;
    }>().versions;
    expect(versions).toHaveLength(2);
    expect(versions.map((row) => row.version).sort()).toEqual([1, 2]);
    expect(versions.map((row) => row.markdown).sort()).toEqual(['# 第一版', '# 第二版']);
    expect(versions.every((row) => row.generatedBy === 'manual')).toBe(true);
    const currentId = detail.json<{ currentVersionId: string }>().currentVersionId;
    const current = versions.find((row) => row.id === currentId);
    expect(current?.markdown).toBe('# 第二版');
  });

  it('rollback copies the target version into a new published version', async () => {
    const page = await createPage();
    const firstPatch = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 稳定版' },
    });
    expect(firstPatch.statusCode, firstPatch.body).toBe(200);
    await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 回退前' },
    });
    const before = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const target = before
      .json<{ versions: Array<{ id: string; markdown: string }> }>()
      .versions.find((row) => row.markdown === '# 稳定版');
    expect(target).toBeDefined();
    const targetId = target?.id ?? '';

    const rollback = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/rollback`,
      headers: { cookie },
      payload: { versionId: targetId },
    });
    expect(rollback.statusCode, rollback.body).toBe(201);
    const created = rollback.json<{ id: string; version: number; markdown: string }>();
    expect(created.markdown).toBe('# 稳定版');
    expect(created.id).not.toBe(targetId);
    expect(created.version).toBe(3);

    const after = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const body = after.json<{
      currentVersionId: string;
      versions: Array<{ id: string; markdown: string }>;
    }>();
    expect(body.versions).toHaveLength(3);
    expect(body.currentVersionId).toBe(created.id);
    // 历史版本仍在，且原始目标版本内容未被改写。
    expect(body.versions.find((row) => row.id === targetId)?.markdown).toBe('# 稳定版');
  });

  it('queues a wiki_generate job and returns 202', async () => {
    const page = await createPage();
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/generate`,
      headers: { cookie },
      payload: { instruction: '写短一些' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();

    const job = await app.pool.query<{
      type: string;
      base_id: string;
      status: string;
      payload: { pageId: string; instruction: string };
    }>('select type, base_id, status, payload from knowledge_jobs where id = $1', [jobId]);
    expect(job.rows[0]).toMatchObject({ type: 'wiki_generate', base_id: baseId, status: 'queued' });
    expect(job.rows[0]?.payload).toMatchObject({ pageId: page.id, instruction: '写短一些' });
  });

  it('returns 404 for unknown pages and mismatched versions', async () => {
    const missing = await inject(app, {
      method: 'GET',
      url: '/api/knowledge/wiki-pages/kwp_missing',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);

    const page = await createPage();
    const other = await createPage();
    await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# a' },
    });
    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const versionId = detail.json<{ versions: Array<{ id: string }> }>().versions[0]?.id ?? '';

    const rollback = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${other.id}/rollback`,
      headers: { cookie },
      payload: { versionId },
    });
    expect(rollback.statusCode).toBe(404);

    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${other.id}/publish`,
      headers: { cookie },
      payload: { versionId },
    });
    expect(publish.statusCode).toBe(404);
  });

  it('sdk 草稿只追加；模型失败后 current 仍是原发布版本', async () => {
    const page = await createPage();
    const published = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 已发布' },
    });
    expect(published.statusCode, published.body).toBe(200);
    const publishedVersionId = published.json<{ currentVersionId: string }>().currentVersionId;

    const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 自动草稿',
      sourceChunkIds: [],
      model: 'wiki-model',
      generatedBy: 'sdk',
    });
    expect(draft?.id).not.toBe(publishedVersionId);

    const afterDraft = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    // 已发布页面：草稿追加进列表，但不改 currentVersionId，也不把状态降成 draft。
    expect(afterDraft.json()).toMatchObject({
      status: 'published',
      currentVersionId: publishedVersionId,
    });
    expect(
      afterDraft.json<{ versions: Array<{ id: string }> }>().versions.map((row) => row.id),
    ).toEqual(expect.arrayContaining([publishedVersionId, draft?.id]));

    const versions = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}/versions`,
      headers: { cookie },
    });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json<{ items: Array<{ generatedBy: string }> }>().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ generatedBy: 'sdk' })]),
    );

    // 模型失败：只有 job 失败、没有新版本，已发布指针必须原地不动。
    const failedJobId = `kjob_wiki${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_jobs (id, type, base_id, status, error, payload, ended_at)
       values ($1, 'wiki_generate', $2, 'failed', '模型不可用', $3::jsonb, now())`,
      [failedJobId, baseId, JSON.stringify({ type: 'wiki_generate', baseId, pageId: page.id })],
    );
    const afterFailure = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    expect(afterFailure.json()).toMatchObject({
      status: 'published',
      currentVersionId: publishedVersionId,
    });
  });

  it('publish 只接受属于该页的版本，并切到该版本', async () => {
    const page = await createPage();
    const first = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第一版' },
    });
    const firstVersionId = first.json<{ currentVersionId: string }>().currentVersionId;
    await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第二版' },
    });
    const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 待发布草稿',
      sourceChunkIds: [],
      model: 'wiki-model',
      generatedBy: 'sdk',
    });

    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: draft?.id },
    });
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.json()).toMatchObject({ status: 'published', currentVersionId: draft?.id });

    const back = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: firstVersionId },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ currentVersionId: firstVersionId });
  });

  it('expectedVersion 不一致时 409，不静默覆盖别人的发布', async () => {
    const page = await createPage();
    const first = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第一版' },
    });
    const staleVersionId = first.json<{ currentVersionId: string }>().currentVersionId;
    await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第二版' },
    });

    const conflict = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 旧标签页保存', expectedVersion: staleVersionId },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json<{ code: string }>().code).toBe('CONFLICT_STALE');

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    expect(detail.json<{ versions: Array<{ markdown: string }> }>().versions).toHaveLength(2);
  });

  it('发布时来源已禁用则 409，草稿不能绕过撤权', async () => {
    const page = await createPage();
    const documentId = `kdoc_wiki${Math.random().toString(36).slice(2, 10)}`;
    const versionId = `kdv_wiki${Math.random().toString(36).slice(2, 10)}`;
    const chunkId = `kchk_wiki${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_documents (id, base_id, title, source_type, mime_type, status)
       values ($1, $2, '来源文档', 'upload', 'text/markdown', 'disabled')`,
      [documentId, baseId],
    );
    await app.pool.query(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id)
       values ($1, $2, 1, $3, $3, 'a.md', 'text/markdown', 1, 'parsed', '[]', '[]',
               (select embedding_profile_id from knowledge_bases where id = $4))`,
      [versionId, documentId, 'b'.repeat(64), baseId],
    );
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text)
       values ($1, $2, $3, $4, 0, 'text', '正文', '正文')`,
      [chunkId, baseId, documentId, versionId],
    );
    const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 引用失效来源',
      sourceChunkIds: [chunkId],
      model: 'wiki-model',
      generatedBy: 'sdk',
    });
    expect(draft).not.toBeNull();

    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: draft?.id },
    });
    expect(publish.statusCode, publish.body).toBe(409);

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    expect(detail.json()).toMatchObject({ status: 'draft', currentVersionId: draft?.id });
  });

  it('首次草稿遇来源更新：保持 draft，不被误判为已发布', async () => {
    const page = await createPage();
    const documentId = await seedSourceDocument();
    const v1 = await addSourceVersion(documentId, 1);
    const draft = await saveDraft(page.id, {
      markdown: '# 首轮草稿',
      documentId,
      ...v1,
    });
    const first = await repo.knowledge.getWikiPage(app.db, page.id);
    expect(first).toMatchObject({ status: 'draft', currentVersionId: draft?.id });

    // 来源更新 v2：已发布页才标 stale；首次草稿仍必须是 draft。
    await addSourceVersion(documentId, 2);
    await repo.knowledge.markWikiStaleByDocument(app.db, documentId);
    const afterUpdate = await repo.knowledge.getWikiPage(app.db, page.id);
    expect(afterUpdate).toMatchObject({ status: 'draft', currentVersionId: draft?.id });
    expect(
      await app.pool.query('select stale from knowledge_wiki_sources where page_id = $1', [
        page.id,
      ]),
    ).toMatchObject({ rows: [{ stale: true }] });

    // 自动生成：页面仍无已发布内容，新草稿应更新 current（而不是只追加）。
    const next = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 第二轮草稿',
      sourceChunkIds: [],
      model: 'wiki-model',
      generatedBy: 'sdk',
    });
    const afterRegenerate = await repo.knowledge.getWikiPage(app.db, page.id);
    expect(afterRegenerate).toMatchObject({ status: 'draft', currentVersionId: next?.id });
  });

  it('已发布页遇来源更新：只追加草稿，current 与已发布状态不动', async () => {
    const page = await createPage();
    const documentId = await seedSourceDocument();
    const v1 = await addSourceVersion(documentId, 1);
    const published = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 已发布',
      sourceChunkIds: [v1.chunkId],
      model: 'manual',
      generatedBy: 'manual',
    });
    await repo.knowledge.markWikiStaleByDocument(app.db, documentId);
    const stalePage = await repo.knowledge.getWikiPage(app.db, page.id);
    expect(stalePage?.currentVersionId).toBe(published?.id);

    const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 自动草稿',
      sourceChunkIds: [],
      model: 'wiki-model',
      generatedBy: 'sdk',
    });
    const afterDraft = await repo.knowledge.getWikiPage(app.db, page.id);
    // 已发布指针不动；draft 的追加不能把 stale 抹成 published。
    expect(afterDraft).toMatchObject({
      status: stalePage?.status,
      currentVersionId: published?.id,
    });
    expect(afterDraft?.status).toBe('stale');
    expect(draft?.id).not.toBe(published?.id);
  });

  it('发布引用旧文档版本的草稿被拒（409），旧版本不能洗成已发布', async () => {
    const page = await createPage();
    const documentId = await seedSourceDocument();
    const v1 = await addSourceVersion(documentId, 1);
    const draft = await saveDraft(page.id, {
      markdown: '# 引用 v1 的草稿',
      documentId,
      ...v1,
    });

    const v2 = await addSourceVersion(documentId, 2);
    expect(v2.chunkId).not.toBe(v1.chunkId);

    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: draft?.id },
    });
    expect(publish.statusCode, publish.body).toBe(409);
    expect(publish.json<{ code: string }>().code).toBe('CONFLICT');

    const after = await repo.knowledge.getWikiPage(app.db, page.id);
    expect(after).toMatchObject({ status: 'draft', currentVersionId: draft?.id });

    // 用当前版本的 chunk 重新生成后可以正常发布。
    const fresh = await saveDraft(page.id, {
      markdown: '# 引用 v2 的草稿',
      documentId,
      ...v2,
    });
    const retry = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: fresh?.id },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'published', currentVersionId: fresh?.id });
  });

  const invalidSourceCases = [
    {
      name: '禁用 chunk',
      prepare: async () => {
        const documentId = await seedSourceDocument();
        const chunk = await addSourceVersion(documentId, 1, { enabled: false });
        return { ids: [chunk.chunkId], usable: [] };
      },
    },
    {
      name: '文档 currentVersionId 为 NULL',
      prepare: async () => {
        const documentId = await seedSourceDocument();
        const chunk = await addSourceVersion(documentId, 1, { current: false });
        return { ids: [chunk.chunkId], usable: [] };
      },
    },
    {
      name: '有效与失效混合',
      prepare: async () => {
        const validDocument = await seedSourceDocument();
        const valid = await addSourceVersion(validDocument, 1);
        const disabledDocument = await seedSourceDocument();
        const disabled = await addSourceVersion(disabledDocument, 1, { enabled: false });
        return { ids: [valid.chunkId, disabled.chunkId], usable: [valid.chunkId] };
      },
    },
    {
      name: '跨 base 的 chunk',
      prepare: async () => {
        const documentId = await seedSourceDocument(otherBaseId);
        const chunk = await addSourceVersion(documentId, 1, { baseId: otherBaseId });
        return { ids: [chunk.chunkId], usable: [] };
      },
    },
    {
      name: '不存在的 chunk',
      prepare: async () => ({
        ids: [`kchk_missing${Math.random().toString(36).slice(2, 10)}`],
        usable: [],
      }),
    },
  ];

  it.each(invalidSourceCases)(
    '人工保存无效来源（$name）保持 stale，发布对应草稿 409',
    async ({ prepare }) => {
      const { ids, usable } = await prepare();
      const manualPage = await createPage();
      const saved = await repo.knowledge.saveWikiVersion(app.db, manualPage.id, {
        markdown: '# 人工保存',
        sourceChunkIds: ids,
        model: 'manual',
        generatedBy: 'manual',
      });
      expect(saved).not.toBeNull();
      expect(await repo.knowledge.getWikiPage(app.db, manualPage.id)).toMatchObject({
        status: 'stale',
        currentVersionId: saved?.id,
      });
      const manualSources = await app.pool.query<{ chunk_id: string; stale: boolean }>(
        'select chunk_id, stale from knowledge_wiki_sources where page_id = $1 order by chunk_id',
        [manualPage.id],
      );
      expect(manualSources.rows).toEqual(
        [...usable].sort().map((chunkId) => ({ chunk_id: chunkId, stale: false })),
      );

      const draftPage = await createPage();
      const draft = await repo.knowledge.saveWikiVersion(app.db, draftPage.id, {
        markdown: '# 草稿',
        sourceChunkIds: ids,
        model: 'wiki-model',
        generatedBy: 'sdk',
      });
      const publish = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${draftPage.id}/publish`,
        headers: { cookie },
        payload: { versionId: draft?.id },
      });
      expect(publish.statusCode, publish.body).toBe(409);
      expect(publish.json<{ code: string }>().code).toBe('CONFLICT');
      expect(await repo.knowledge.getWikiPage(app.db, draftPage.id)).toMatchObject({
        status: 'draft',
        currentVersionId: draft?.id,
      });
      const draftSources = await app.pool.query(
        'select 1 from knowledge_wiki_sources where page_id = $1',
        [draftPage.id],
      );
      expect(draftSources.rows).toEqual([]);
    },
  );

  const usableSourceCases = [
    {
      name: '空输入',
      prepare: async () => ({ ids: [] as string[], usable: [] as string[] }),
    },
    {
      name: '重复有效 ID',
      prepare: async () => {
        const documentId = await seedSourceDocument();
        const chunk = await addSourceVersion(documentId, 1);
        return { ids: [chunk.chunkId, chunk.chunkId], usable: [chunk.chunkId] };
      },
    },
  ];

  it.each(usableSourceCases)('人工保存有效来源（$name）直接发布并去重', async ({ prepare }) => {
    const { ids, usable } = await prepare();
    const page = await createPage();
    const saved = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 有效来源',
      sourceChunkIds: ids,
      model: 'manual',
      generatedBy: 'manual',
    });
    expect(saved).not.toBeNull();
    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'published',
      currentVersionId: saved?.id,
    });
    const sources = await app.pool.query<{ chunk_id: string }>(
      'select chunk_id from knowledge_wiki_sources where page_id = $1 order by chunk_id',
      [page.id],
    );
    expect(sources.rows.map((row) => row.chunk_id)).toEqual([...usable].sort());
  });
});
