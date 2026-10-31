import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getKnowledgeQueue } from '../src/queue/producer.js';
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

  async function createWikiPageInBase(targetBaseId: string, slug: string, title: string) {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${targetBaseId}/wiki-pages`,
      headers: { cookie },
      payload: { slug, title },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
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

  /** 内部索引正文按内容寻址写在这里；预先占成目录可稳定注入写文件失败。 */
  function blobPathFor(markdown: string) {
    const sha = createHash('sha256').update(markdown, 'utf8').digest('hex');
    return join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
  }

  type WikiIndexJob = {
    type: string;
    status: string;
    payload: {
      documentId: string;
      publish: string;
      input: {
        blobSha256: string;
        filename: string;
        mimeType: string;
        expectedCurrentVersionId: string | null;
      };
      versionMetadata: { wikiPageId: string; wikiVersionId: string };
    };
  };

  async function blobForJob(job: WikiIndexJob): Promise<string> {
    const sha = job.payload.input.blobSha256;
    return readFile(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha), 'utf8');
  }

  async function indexJobs(documentId: string): Promise<WikiIndexJob[]> {
    const rows = await app.pool.query<WikiIndexJob>(
      `select type, status, payload from knowledge_jobs
       where document_id = $1 and type = 'ingest' order by created_at, id`,
      [documentId],
    );
    return rows.rows;
  }

  function firstRow<T>(rows: T[]): T {
    const [row] = rows;
    if (!row) throw new Error('expected at least one row');
    return row;
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

  it('manual edits append drafts and never rewrite history; publish switches explicitly', async () => {
    const page = await createPage();
    const first = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第一版' },
    });
    expect(first.statusCode, first.body).toBe(200);
    // 保存草稿不隐式发布：线上指针仍为空。
    expect(first.json()).toMatchObject({ status: 'draft', currentVersionId: null });

    const second = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第二版', title: '认证（改）' },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ title: '认证（改）', status: 'draft' });

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const versions = detail.json<{
      currentVersionId: string | null;
      versions: Array<{ id: string; version: number; markdown: string; generatedBy: string }>;
    }>().versions;
    expect(versions).toHaveLength(2);
    expect(versions.map((row) => row.version).sort()).toEqual([1, 2]);
    expect(versions.map((row) => row.markdown).sort()).toEqual(['# 第一版', '# 第二版']);
    expect(versions.every((row) => row.generatedBy === 'manual')).toBe(true);

    const secondVersionId = versions.find((row) => row.markdown === '# 第二版')?.id ?? '';
    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: secondVersionId },
    });
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.json()).toMatchObject({
      status: 'published',
      currentVersionId: secondVersionId,
    });
    // 发布只切指针，历史版本正文不变。
    const after = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    expect(
      after.json<{ versions: Array<{ markdown: string }> }>().versions.map((row) => row.markdown),
    ).toEqual(expect.arrayContaining(['# 第一版', '# 第二版']));
  });

  it('writes each wiki version with one insert that computes the next number in SQL', async () => {
    const page = await createPage();

    const statements: string[] = [];
    const clientProto = (
      app.pool as unknown as { Client: { prototype: { query: (...args: unknown[]) => unknown } } }
    ).Client.prototype;
    const originalQuery = clientProto.query;
    const spy = vi.spyOn(clientProto, 'query').mockImplementation(function (
      this: unknown,
      first: unknown,
      ...rest: unknown[]
    ) {
      if (typeof first === 'string') statements.push(first);
      else if (first && typeof first === 'object' && 'text' in first) {
        statements.push(String((first as { text: unknown }).text));
      }
      return originalQuery.apply(this, [first, ...rest]);
    });
    let first: Awaited<ReturnType<typeof repo.knowledge.saveWikiVersion>>;
    let second: Awaited<ReturnType<typeof repo.knowledge.saveWikiVersion>>;
    try {
      first = await repo.knowledge.saveWikiVersion(app.db, page.id, {
        markdown: '# 第一稿',
        sourceChunkIds: [],
        model: 'wiki-model',
        generatedBy: 'sdk',
      });
      second = await repo.knowledge.saveWikiVersion(app.db, page.id, {
        markdown: '# 第二稿',
        sourceChunkIds: [],
        model: 'wiki-model',
        generatedBy: 'sdk',
      });
    } finally {
      spy.mockRestore();
    }

    expect([first?.version, second?.version]).toEqual([1, 2]);
    const writes = statements.filter((text) => /insert into "knowledge_wiki_versions"/i.test(text));
    expect(writes).toHaveLength(2);
    for (const text of writes) {
      expect(text).toMatch(
        /select coalesce\(max\("knowledge_wiki_versions"\."version"\), 0\) \+ 1 from "knowledge_wiki_versions" where "knowledge_wiki_versions"\."page_id" =/i,
      );
    }
    expect(
      statements.filter(
        (text) =>
          /\bmax\("knowledge_wiki_versions"\."version"\)/i.test(text) &&
          !/insert into "knowledge_wiki_versions"/i.test(text),
      ),
    ).toEqual([]);
  });

  it('serializes two concurrent saves on one page into versions 1 and 2', async () => {
    const page = await createPage();
    const saved = await Promise.all([
      repo.knowledge.saveWikiVersion(app.db, page.id, {
        markdown: '# 并发 A',
        sourceChunkIds: [],
        model: 'wiki-model',
        generatedBy: 'sdk',
      }),
      repo.knowledge.saveWikiVersion(app.db, page.id, {
        markdown: '# 并发 B',
        sourceChunkIds: [],
        model: 'wiki-model',
        generatedBy: 'sdk',
      }),
    ]);
    expect(saved.map((row) => row?.version).sort()).toEqual([1, 2]);

    const versions = await app.pool.query<{ version: number; markdown: string }>(
      'select version, markdown from knowledge_wiki_versions where page_id = $1 order by version',
      [page.id],
    );
    expect(versions.rows).toEqual([
      { version: 1, markdown: expect.stringMatching(/^# 并发 [AB]$/) },
      { version: 2, markdown: expect.stringMatching(/^# 并发 [AB]$/) },
    ]);
    expect(versions.rows[0]?.markdown).not.toBe(versions.rows[1]?.markdown);
  });

  it('publish records only validated source snapshots; missing sources stay unsaved', async () => {
    const page = await createPage();
    const documentId = await seedSourceDocument();
    const source = await addSourceVersion(documentId, 1);
    const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 引用有效来源',
      sourceChunkIds: [source.chunkId],
      model: 'wiki-model',
      generatedBy: 'sdk',
    });
    // 保存草稿不写来源账本，也不切线上指针。
    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'draft',
      currentVersionId: null,
    });
    expect(
      (await app.pool.query('select 1 from knowledge_wiki_sources where page_id = $1', [page.id]))
        .rows,
    ).toEqual([]);

    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: draft?.id },
    });
    expect(publish.statusCode, publish.body).toBe(200);
    const sources = await app.pool.query(
      'select document_id, version_id, chunk_id, stale from knowledge_wiki_sources where page_id = $1',
      [page.id],
    );
    expect(sources.rows).toEqual([
      {
        document_id: documentId,
        version_id: source.versionId,
        chunk_id: source.chunkId,
        stale: false,
      },
    ]);
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

  it('schedules a wiki internal index ingest on publish and rollback', async () => {
    const page = await createPage('索引页');
    const pageRow = await app.pool.query<{ slug: string }>(
      'select slug from knowledge_wiki_pages where id = $1',
      [page.id],
    );
    const slug = pageRow.rows[0]?.slug ?? '';
    const save = async (markdown: string) =>
      repo.knowledge.saveWikiVersion(app.db, page.id, {
        markdown,
        sourceChunkIds: [],
        model: 'manual',
        generatedBy: 'manual',
      });
    const first = await save('# 索引第一版');
    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: first?.id },
    });
    expect(publish.statusCode, publish.body).toBe(200);

    const indexRows = await app.pool.query<{
      id: string;
      content_hash: string | null;
      metadata: { wikiPageId?: string; wikiVersionId?: string };
    }>(
      `select id, content_hash, metadata from knowledge_documents
       where base_id = $1 and content_kind = 'wiki' and metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    expect(indexRows.rows).toHaveLength(1);
    const index = firstRow(indexRows.rows);
    expect(index.metadata.wikiVersionId).toBe(first?.id);
    // 索引文档的 contentHash 是线上指纹，发布不再用准备内容覆盖它。
    expect(index.content_hash).toBeNull();

    const firstJobs = await indexJobs(index.id);
    expect(firstJobs).toHaveLength(1);
    const firstJob = firstRow(firstJobs);
    expect(firstJob).toMatchObject({
      type: 'ingest',
      payload: {
        documentId: index.id,
        publish: 'automatic',
        input: {
          filename: `${slug}.md`,
          mimeType: 'text/markdown',
          expectedCurrentVersionId: null,
        },
        versionMetadata: { wikiPageId: page.id, wikiVersionId: first?.id },
      },
    });
    expect(await blobForJob(firstJob)).toBe('# 索引第一版');

    const second = await save('# 索引第二版');
    const rollback = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/rollback`,
      headers: { cookie },
      payload: { versionId: second?.id },
    });
    expect(rollback.statusCode, rollback.body).toBe(201);
    const updated = await app.pool.query<{
      id: string;
      metadata: { wikiVersionId?: string };
    }>(
      `select id, metadata from knowledge_documents
       where base_id = $1 and content_kind = 'wiki' and metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    // 每页只保留一个内部索引文档，回退复用同一身份并更新版本 metadata。
    expect(updated.rows).toHaveLength(1);
    expect(updated.rows[0]?.id).toBe(index.id);
    const rolledBackVersionId = rollback.json<{ id: string }>().id;
    expect(updated.rows[0]?.metadata.wikiVersionId).toBe(rolledBackVersionId);
    const jobs = await indexJobs(index.id);
    expect(jobs.map((job) => job.payload.versionMetadata.wikiVersionId)).toEqual([
      first?.id,
      rolledBackVersionId,
    ]);
    // 每个任务消费自己的 blob，旧任务不被后续发布改写。
    expect(await blobForJob(firstRow(jobs))).toBe('# 索引第一版');
    const rollbackJob = firstRow(jobs.slice(1));
    expect(rollbackJob.payload.input.expectedCurrentVersionId).toBeNull();
    expect(await blobForJob(rollbackJob)).toBe('# 索引第二版');
  });

  it('索引文件准备失败时不切换线上指针，也不留索引文档或任务', async () => {
    const page = await createPage('准备失败页');
    const markdown = `# 准备失败正文 ${Math.random().toString(36).slice(2, 8)}`;
    const saved = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const versionId = detail.json<{ versions: Array<{ id: string }> }>().versions[0]?.id ?? '';

    // 在内容寻址的目标路径放一个目录，让 writeFile 以 EISDIR 失败。
    const blobPath = blobPathFor(markdown);
    await mkdir(blobPath, { recursive: true });
    let publish: Awaited<ReturnType<typeof inject>>;
    try {
      publish = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${page.id}/publish`,
        headers: { cookie },
        payload: { versionId },
      });
      expect(publish.statusCode, publish.body).toBe(500);
    } finally {
      await rm(blobPath, { recursive: true, force: true });
    }

    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'draft',
      currentVersionId: null,
    });
    const indexes = await app.pool.query(
      `select 1 from knowledge_documents
       where base_id = $1 and content_kind = 'wiki' and metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    expect(indexes.rows).toEqual([]);
  });

  it('同页并发首次发布只创建一个内部索引文档', async () => {
    const page = await createPage('并发索引页');
    const save = (markdown: string) =>
      repo.knowledge.saveWikiVersion(app.db, page.id, {
        markdown,
        sourceChunkIds: [],
        model: 'manual',
        generatedBy: 'manual',
      });
    const [first, second] = await Promise.all([save('# 并发索引 A'), save('# 并发索引 B')]);
    const publish = (versionId: string | undefined) =>
      inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${page.id}/publish`,
        headers: { cookie },
        payload: { versionId },
      });
    const [left, right] = await Promise.all([publish(first?.id), publish(second?.id)]);
    expect(left.statusCode, left.body).toBe(200);
    expect(right.statusCode, right.body).toBe(200);

    const indexes = await app.pool.query<{ id: string }>(
      `select id from knowledge_documents
       where base_id = $1 and content_kind = 'wiki' and metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    expect(indexes.rows).toHaveLength(1);
    const jobs = await indexJobs(firstRow(indexes.rows).id);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.payload.versionMetadata.wikiVersionId).sort()).toEqual(
      [first?.id, second?.id].sort(),
    );
    // 每个任务消费自己的任务输入快照，不依赖后来被改写的文档指纹。
    expect((await Promise.all(jobs.map(blobForJob))).sort()).toEqual([
      '# 并发索引 A',
      '# 并发索引 B',
    ]);
  });

  it('发布失败不改旧索引指针，旧 queued 任务真实摄取仍读取 w1', async () => {
    const page = await createPage('失败保旧索引');
    const w1 = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# w1 正文',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    const publishFirst = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: w1?.id },
    });
    expect(publishFirst.statusCode, publishFirst.body).toBe(200);
    const indexRows = await app.pool.query<{ id: string; metadata: { wikiVersionId?: string } }>(
      `select id, metadata from knowledge_documents
       where base_id = $1 and content_kind = 'wiki' and metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    const index = firstRow(indexRows.rows);
    const queuedBefore = await indexJobs(index.id);
    expect(queuedBefore).toHaveLength(1);
    expect(queuedBefore[0]?.status).toBe('queued');

    // w2 引用已停用来源：准备会写出 w2 blob，但发布事务在来源校验处 409。
    const documentId = await seedSourceDocument();
    const source = await addSourceVersion(documentId, 1);
    await app.pool.query(`update knowledge_documents set status = 'disabled' where id = $1`, [
      documentId,
    ]);
    const w2 = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# w2 正文',
      sourceChunkIds: [source.chunkId],
      model: 'wiki-model',
      generatedBy: 'sdk',
    });
    const failed = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: w2?.id },
    });
    expect(failed.statusCode, failed.body).toBe(409);

    // 页面、索引文档与任务输入都没有被失败发布改动。
    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'published',
      currentVersionId: w1?.id,
    });
    const indexAfter = await app.pool.query<{ id: string; metadata: { wikiVersionId?: string } }>(
      `select id, metadata from knowledge_documents
       where base_id = $1 and content_kind = 'wiki' and metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    expect(indexAfter.rows).toHaveLength(1);
    expect(indexAfter.rows[0]?.id).toBe(index.id);
    expect(indexAfter.rows[0]?.metadata.wikiVersionId).toBe(w1?.id);
    const queuedAfter = await indexJobs(index.id);
    expect(queuedAfter).toHaveLength(1);
    expect(queuedAfter[0]?.payload).toEqual(queuedBefore[0]?.payload);
    // worker 只按任务输入快照的 blob 摄取，失败发布不会把它的输入挤成 w2。
    expect(await blobForJob(firstRow(queuedAfter))).toBe('# w1 正文');
  });

  it('索引任务写库失败时页面指针与索引文档整体回滚', async () => {
    const page = await createPage('任务写库失败页');
    const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 不应发布正文',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    const create = vi
      .spyOn(repo.knowledge, 'createJob')
      .mockRejectedValueOnce(new Error('insert job failed'));
    let publish: Awaited<ReturnType<typeof inject>>;
    try {
      publish = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${page.id}/publish`,
        headers: { cookie },
        payload: { versionId: draft?.id },
      });
    } finally {
      create.mockRestore();
    }
    expect(publish.statusCode, publish.body).toBe(500);

    // 事务回滚：不切指针、不建索引文档、不留任务。
    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'draft',
      currentVersionId: null,
    });
    const indexes = await app.pool.query(
      `select 1 from knowledge_documents
       where base_id = $1 and content_kind = 'wiki' and metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    expect(indexes.rows).toEqual([]);
    const jobs = await app.pool.query(
      `select 1 from knowledge_jobs j
       join knowledge_documents d on d.id = j.document_id
       where d.base_id = $1 and d.content_kind = 'wiki' and d.metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    expect(jobs.rows).toEqual([]);
  });

  it('索引任务入队失败时保留 queued 任务供 reconcile 补投', async () => {
    const page = await createPage('入队失败页');
    const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 入队失败正文',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    const add = vi.spyOn(getKnowledgeQueue(), 'add').mockRejectedValueOnce(new Error('redis down'));
    let publish: Awaited<ReturnType<typeof inject>>;
    try {
      publish = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${page.id}/publish`,
        headers: { cookie },
        payload: { versionId: draft?.id },
      });
    } finally {
      add.mockRestore();
    }
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.json()).toMatchObject({ status: 'published', currentVersionId: draft?.id });

    const jobs = await app.pool.query<{ status: string }>(
      `select j.status from knowledge_jobs j
       join knowledge_documents d on d.id = j.document_id
       where d.base_id = $1 and d.content_kind = 'wiki'
         and d.metadata ->> 'wikiPageId' = $2 and j.type = 'ingest'`,
      [baseId, page.id],
    );
    expect(jobs.rows).toEqual([{ status: 'queued' }]);
  });

  it('回退的索引准备失败时保留原线上版本', async () => {
    const page = await createPage('回退准备失败页');
    const save = (markdown: string) =>
      repo.knowledge.saveWikiVersion(app.db, page.id, {
        markdown,
        sourceChunkIds: [],
        model: 'manual',
        generatedBy: 'manual',
      });
    const targetMarkdown = `# 回退目标正文 ${Math.random().toString(36).slice(2, 8)}`;
    const target = await save(targetMarkdown);
    const first = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: target?.id },
    });
    expect(first.statusCode, first.body).toBe(200);
    const current = await save('# 当前线上正文');
    const second = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: current?.id },
    });
    expect(second.statusCode, second.body).toBe(200);

    // 回退会复制目标版本正文；同一内容地址预先占成目录让准备阶段失败。
    const blobPath = blobPathFor(targetMarkdown);
    await rm(blobPath, { force: true });
    await mkdir(blobPath, { recursive: true });
    let rollback: Awaited<ReturnType<typeof inject>>;
    try {
      rollback = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/wiki-pages/${page.id}/rollback`,
        headers: { cookie },
        payload: { versionId: target?.id },
      });
      expect(rollback.statusCode, rollback.body).toBe(500);
    } finally {
      await rm(blobPath, { recursive: true, force: true });
    }

    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'published',
      currentVersionId: current?.id,
    });
    // 准备失败不改索引指针、不追加任务。
    const indexRows = await app.pool.query<{ id: string; metadata: { wikiVersionId?: string } }>(
      `select id, metadata from knowledge_documents
       where base_id = $1 and content_kind = 'wiki' and metadata ->> 'wikiPageId' = $2`,
      [baseId, page.id],
    );
    expect(indexRows.rows).toHaveLength(1);
    expect(indexRows.rows[0]?.metadata.wikiVersionId).toBe(current?.id);
    // 前两次发布各留一个任务；失败的回退不再追加。
    expect(await indexJobs(firstRow(indexRows.rows).id)).toHaveLength(2);
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
    const saved = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 已发布' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const publishedVersionId = detail.json<{ versions: Array<{ id: string }> }>().versions[0]?.id;
    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: publishedVersionId },
    });
    expect(publish.statusCode, publish.body).toBe(200);

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
    expect(first.statusCode, first.body).toBe(200);
    const firstDetail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const firstVersionId = firstDetail.json<{ versions: Array<{ id: string }> }>().versions[0]?.id;
    await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第二版' },
    });
    const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 待发布草稿',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
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
    expect(first.statusCode, first.body).toBe(200);
    const firstDetail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const staleVersionId = firstDetail.json<{ versions: Array<{ id: string }> }>().versions[0]?.id;
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

  it('正文冲突时标题不被单独写入：结构与正文同事务', async () => {
    const page = await createPage('原标题');
    await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
      payload: { markdown: '# 第一版' },
    });
    const firstDetail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const staleVersionId = firstDetail.json<{ versions: Array<{ id: string }> }>().versions[0]?.id;
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
      payload: { markdown: '# 旧标签页保存', title: '新标题', expectedVersion: staleVersionId },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json<{ code: string }>().code).toBe('CONFLICT_STALE');

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const body = detail.json<{
      title: string;
      versions: Array<{ markdown: string }>;
    }>();
    // 冲突发生在结构写入前：标题不能先落库，正文也不得新增版本。
    expect(body.title).toBe('原标题');
    expect(body.versions.map((row) => row.markdown).sort()).toEqual(['# 第一版', '# 第二版']);
  });

  it('结构无效时正文不落库：同事务回滚真实 PG 写入', async () => {
    const parent = await createPage('父页');
    const child = await createWikiPageInBase(
      baseId,
      `child-${Math.random().toString(36).slice(2, 8)}`,
      '子页',
    );
    const moveChild = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${child}`,
      headers: { cookie },
      payload: { parentId: parent.id },
    });
    expect(moveChild.statusCode, moveChild.body).toBe(200);

    const cycle = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${parent.id}`,
      headers: { cookie },
      payload: { parentId: child, markdown: '# 不应落库' },
    });
    expect(cycle.statusCode, cycle.body).toBe(400);
    expect(cycle.json<{ code: string }>().code).toBe('INVALID_INPUT');

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${parent.id}`,
      headers: { cookie },
    });
    const body = detail.json<{
      parentId: string | null;
      versions: Array<{ markdown: string }>;
    }>();
    expect(body.parentId).toBeNull();
    expect(body.versions).toEqual([]);
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
    expect(detail.json()).toMatchObject({ status: 'draft', currentVersionId: null });
  });

  it('首次草稿只追加：current 为空，不被误判为已发布', async () => {
    const page = await createPage();
    const documentId = await seedSourceDocument();
    const v1 = await addSourceVersion(documentId, 1);
    const draft = await saveDraft(page.id, {
      markdown: '# 首轮草稿',
      documentId,
      ...v1,
    });
    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'draft',
      currentVersionId: null,
    });

    // 来源更新与 stale 标记只影响已发布页；草稿页没有线上版本可受影响。
    await addSourceVersion(documentId, 2);
    await repo.knowledge.markWikiStaleByDocument(app.db, documentId);
    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'draft',
      currentVersionId: null,
    });

    const next = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 第二轮草稿',
      sourceChunkIds: [],
      model: 'wiki-model',
      generatedBy: 'sdk',
    });
    expect(next?.version).toBe((draft?.version ?? 0) + 1);
    expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
      status: 'draft',
      currentVersionId: null,
    });
  });

  it('已发布页遇来源更新：只追加草稿，current 与已发布状态不动', async () => {
    const page = await createPage();
    const documentId = await seedSourceDocument();
    const v1 = await addSourceVersion(documentId, 1);
    const candidate = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 已发布',
      sourceChunkIds: [v1.chunkId],
      model: 'manual',
      generatedBy: 'manual',
    });
    const published = await repo.knowledge.publishWikiVersion(app.db, page.id, candidate?.id ?? '');
    expect(published?.currentVersionId).toBe(candidate?.id);
    await repo.knowledge.markWikiStaleByDocument(app.db, documentId);
    const stalePage = await repo.knowledge.getWikiPage(app.db, page.id);
    expect(stalePage?.currentVersionId).toBe(candidate?.id);
    expect(stalePage?.status).toBe('stale');

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
      currentVersionId: candidate?.id,
    });
    expect(afterDraft?.status).toBe('stale');
    expect(draft?.id).not.toBe(candidate?.id);
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
    expect(after).toMatchObject({ status: 'draft', currentVersionId: null });

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
    '保存含无效来源的草稿（$name）不切线上；发布 409',
    async ({ prepare }) => {
      const { ids } = await prepare();
      for (const generatedBy of ['manual', 'sdk'] as const) {
        const page = await createPage();
        const draft = await repo.knowledge.saveWikiVersion(app.db, page.id, {
          markdown: '# 草稿',
          sourceChunkIds: ids,
          model: generatedBy === 'manual' ? 'manual' : 'wiki-model',
          generatedBy,
        });
        expect(draft).not.toBeNull();
        // 保存草稿永远只追加：线上指针为空，来源账本暂不写。
        expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
          status: 'draft',
          currentVersionId: null,
        });
        expect(
          (
            await app.pool.query('select 1 from knowledge_wiki_sources where page_id = $1', [
              page.id,
            ])
          ).rows,
        ).toEqual([]);

        const publish = await inject(app, {
          method: 'POST',
          url: `/api/knowledge/wiki-pages/${page.id}/publish`,
          headers: { cookie },
          payload: { versionId: draft?.id },
        });
        expect(publish.statusCode, publish.body).toBe(409);
        expect(publish.json<{ code: string }>().code).toBe('CONFLICT');
        expect(await repo.knowledge.getWikiPage(app.db, page.id)).toMatchObject({
          status: 'draft',
          currentVersionId: null,
        });
      }
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

  it.each(usableSourceCases)('显式发布有效来源（$name）后去重记账', async ({ prepare }) => {
    const { ids, usable } = await prepare();
    const page = await createPage();
    const saved = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: '# 有效来源',
      sourceChunkIds: ids,
      model: 'manual',
      generatedBy: 'manual',
    });
    expect(saved).not.toBeNull();
    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/wiki-pages/${page.id}/publish`,
      headers: { cookie },
      payload: { versionId: saved?.id },
    });
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.json()).toMatchObject({
      status: 'published',
      currentVersionId: saved?.id,
    });
    const sources = await app.pool.query<{ chunk_id: string }>(
      'select chunk_id from knowledge_wiki_sources where page_id = $1 order by chunk_id',
      [page.id],
    );
    expect(sources.rows.map((row) => row.chunk_id)).toEqual([...usable].sort());
  });

  it('目录 parent/position 落库，拒绝跨库与循环', async () => {
    const parent = await createPage('目录父页');
    const childRes = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/wiki-pages`,
      headers: { cookie },
      payload: {
        slug: `child-${Math.random().toString(36).slice(2, 8)}`,
        title: '子页',
        parentId: parent.id,
        position: 3,
      },
    });
    expect(childRes.statusCode, childRes.body).toBe(201);
    const child = childRes.json<{ id: string; parentId: string; position: number }>();
    expect(child).toMatchObject({ parentId: parent.id, position: 3 });

    const cycle = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${parent.id}`,
      headers: { cookie },
      payload: { parentId: child.id },
    });
    expect(cycle.statusCode, cycle.body).toBe(400);
    expect(cycle.json<{ code: string }>().code).toBe('INVALID_INPUT');

    const foreignParent = await createWikiPageInBase(otherBaseId, 'foreign-parent', '外库目录');
    const rejected = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${child.id}`,
      headers: { cookie },
      payload: { parentId: foreignParent },
    });
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json<{ code: string }>().code).toBe('INVALID_INPUT');
  });

  it('links 从 Markdown AST 推导，代码块不算链接，坏链接返回 null 目标', async () => {
    const target = await createWikiPageInBase(baseId, 'wiki-target', '目标页');
    const source = await createWikiPageInBase(baseId, 'wiki-source', '来源页');
    const markdown = [
      '正文 [[wiki-target]] 与 [[wiki-target#section|显示名]]',
      '```',
      '[[wiki-target]]',
      '```',
      '坏链接 [[missing-page]]',
    ].join('\n');
    const save = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${source}`,
      headers: { cookie },
      payload: { markdown },
    });
    expect(save.statusCode, save.body).toBe(200);

    const links = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${source}/links`,
      headers: { cookie },
    });
    expect(links.statusCode, links.body).toBe(200);
    expect(links.json()).toEqual({
      outgoing: [
        { targetPageId: target, anchor: null },
        { targetPageId: target, anchor: 'section' },
        { targetPageId: null, anchor: null },
      ],
      incoming: [],
    });

    const incoming = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${target}/links`,
      headers: { cookie },
    });
    expect(incoming.json()).toEqual({
      outgoing: [],
      incoming: [
        { sourcePageId: source, anchor: null },
        { sourcePageId: source, anchor: 'section' },
      ],
    });
  });

  it('版本 diff 按行多重集合与来源集合比较，历史版本不变', async () => {
    const page = await createPage();
    const documentId = await seedSourceDocument();
    const chunk = await addSourceVersion(documentId, 1);
    const first = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: 'a\nb\nc',
      sourceChunkIds: [chunk.chunkId],
      model: 'manual',
      generatedBy: 'manual',
    });
    const second = await repo.knowledge.saveWikiVersion(app.db, page.id, {
      markdown: 'a\nb\nc\nc\nd',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}/diff?fromVersionId=${first?.id}&toVersionId=${second?.id}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      fromVersionId: first?.id,
      toVersionId: second?.id,
      addedLines: ['c', 'd'],
      removedLines: [],
      addedSourceChunkIds: [],
      removedSourceChunkIds: [chunk.chunkId],
    });

    const reverse = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}/diff?fromVersionId=${second?.id}&toVersionId=${first?.id}`,
      headers: { cookie },
    });
    expect(reverse.json()).toMatchObject({
      addedLines: [],
      removedLines: ['c', 'd'],
      addedSourceChunkIds: [chunk.chunkId],
      removedSourceChunkIds: [],
    });

    const other = await createPage();
    const missing = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${other.id}/diff?fromVersionId=${first?.id}&toVersionId=${second?.id}`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});
