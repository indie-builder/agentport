import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getKnowledgeQueue } from '../src/queue/producer.js';
import {
  type FastifyInstance,
  infraReady,
  inject,
  loginCookie,
  testConfig,
  unique,
} from './helpers.js';

const ready = await infraReady;

const HTML = '<html><body><h1>网页标题</h1><p>访问令牌需要定期轮换。</p></body></html>';

describe.skipIf(!ready)('knowledge content routes', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  let fixture: Server;
  let fixtureUrl = '';
  let route = '/ok';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function buildTestApp(overrides: Record<string, string> = {}) {
    const instance = await buildApp(testConfig(overrides));
    await instance.ready();
    return instance;
  }

  async function createBase(target: FastifyInstance = app): Promise<string> {
    const profile = await inject(target, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('content-emb'),
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    profileIds.push(profile.json<{ id: string }>().id);

    const res = await inject(target, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: {
        slug: unique('content-kb'),
        name: '内容库',
        embeddingProfileId: profileIds.at(-1),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  async function createManual(baseId: string, payload: Record<string, unknown> = {}) {
    return inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/manual`,
      headers: { cookie },
      payload: { title: '手写笔记', content: '手写正文，令牌需要轮换。', ...payload },
    });
  }

  async function importUrl(baseId: string, payload: Record<string, unknown> = {}) {
    return inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/url`,
      headers: { cookie },
      payload: { url: `${fixtureUrl}${route}`, ...payload },
    });
  }

  async function getDocument(documentId: string) {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${documentId}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      sourceType: string;
      sourceUrl: string | null;
      mimeType: string;
      sizeBytes: number;
      status: string;
      tags: string[];
      title: string;
    }>();
  }

  async function documentRow(documentId: string) {
    const rows = await app.pool.query<{ content_hash: string; source_type: string }>(
      'select content_hash, source_type from knowledge_documents where id = $1',
      [documentId],
    );
    return rows.rows[0];
  }

  beforeAll(async () => {
    fixture = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      }
      if (req.url === '/binary') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.end(Buffer.from('PK'));
        return;
      }
      if (req.url === '/empty') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
    fixtureUrl = `http://127.0.0.1:${address.port}`;

    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-content-routes-'));
    app = await buildTestApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
  });

  afterEach(async () => {
    route = '/ok';
    if (baseIds.length > 0) {
      await app.pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
      baseIds.length = 0;
    }
    if (profileIds.length > 0) {
      await app.pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
        profileIds,
      ]);
      profileIds.length = 0;
    }
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  it('未登录导入返回 401', async () => {
    const baseId = 'kb_unknown';
    for (const path of ['manual', 'url']) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/documents/${path}`,
        payload: path === 'manual' ? { title: 't', content: 'c' } : { url: 'https://example.com' },
      });
      expect(res.statusCode, res.body).toBe(401);
    }
  });

  it('手写入库：text/markdown 原件落 blob 并入队 ingest', async () => {
    const baseId = await createBase();
    const res = await createManual(baseId, { tags: ['规范', '规范', '令牌'] });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json<{ documentId: string; jobId: string }>();

    const document = await getDocument(body.documentId);
    expect(document).toMatchObject({
      sourceType: 'manual',
      sourceUrl: null,
      mimeType: 'text/markdown',
      status: 'pending',
      title: '手写笔记',
      tags: ['令牌', '规范'],
    });

    const row = await documentRow(body.documentId);
    expect(row?.source_type).toBe('manual');
    const expectedSha = createHash('sha256').update('手写正文，令牌需要轮换。').digest('hex');
    expect(row?.content_hash).toBe(expectedSha);
    const blob = await readFile(
      join(knowledgeDir, 'blobs', expectedSha.slice(0, 2), expectedSha),
      'utf8',
    );
    expect(blob).toBe('手写正文，令牌需要轮换。');

    const job = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/jobs/${body.jobId}`,
      headers: { cookie },
    });
    expect(job.statusCode, job.body).toBe(200);
    expect(job.json()).toMatchObject({ type: 'ingest', status: 'queued' });
  });

  it('PATCH 多标签替换与空数组清空关联', async () => {
    const baseId = await createBase();
    const created = await createManual(baseId, { tags: ['initial'] });
    expect(created.statusCode, created.body).toBe(202);
    const documentId = created.json<{ documentId: string }>().documentId;

    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/documents/${documentId}`,
      headers: { cookie },
      payload: { tags: ['beta', 'alpha', 'gamma'] },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<{ tags: string[] }>().tags).toEqual(['alpha', 'beta', 'gamma']);

    const links = await app.pool.query<{ name: string }>(
      `select t.name from knowledge_document_tags l
       join knowledge_tags t on t.id = l.tag_id
       where l.document_id = $1 order by t.name`,
      [documentId],
    );
    expect(links.rows.map((row) => row.name)).toEqual(['alpha', 'beta', 'gamma']);

    const cleared = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/documents/${documentId}`,
      headers: { cookie },
      payload: { tags: [] },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<{ tags: string[] }>().tags).toEqual([]);
    const remaining = await app.pool.query<{ n: number }>(
      'select count(*)::int as n from knowledge_document_tags where document_id = $1',
      [documentId],
    );
    expect(remaining.rows[0]?.n).toBe(0);
  });

  it('手写校验：空正文 400，其他库的文件夹 400', async () => {
    const baseId = await createBase();
    const otherBaseId = await createBase();
    const folder = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${otherBaseId}/folders`,
      headers: { cookie },
      payload: { name: '别的库文件夹' },
    });
    expect(folder.statusCode, folder.body).toBe(201);

    const blank = await createManual(baseId, { content: '   ' });
    expect(blank.statusCode, blank.body).toBe(400);

    const wrongFolder = await createManual(baseId, {
      folderId: folder.json<{ id: string }>().id,
    });
    expect(wrongFolder.statusCode, wrongFolder.body).toBe(400);
    expect(wrongFolder.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('禁用的知识库拒绝导入', async () => {
    const baseId = await createBase();
    const patch = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${baseId}`,
      headers: { cookie },
      payload: { status: 'disabled' },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const res = await createManual(baseId);
    expect(res.statusCode, res.body).toBe(409);
  });

  it('网页导入：原始 HTML 落 blob，来源与 mime 按响应记录', async () => {
    const baseId = await createBase();
    const res = await importUrl(baseId);
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json<{ documentId: string; jobId: string }>();

    const document = await getDocument(body.documentId);
    expect(document).toMatchObject({
      sourceType: 'url',
      sourceUrl: `${fixtureUrl}/ok`,
      mimeType: 'text/html',
      status: 'pending',
      title: 'ok',
      sizeBytes: Buffer.byteLength(HTML),
    });

    const row = await documentRow(body.documentId);
    const expectedSha = createHash('sha256').update(HTML).digest('hex');
    expect(row?.content_hash).toBe(expectedSha);
    const blob = await readFile(
      join(knowledgeDir, 'blobs', expectedSha.slice(0, 2), expectedSha),
      'utf8',
    );
    expect(blob).toBe(HTML);

    const job = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/jobs/${body.jobId}`,
      headers: { cookie },
    });
    expect(job.json()).toMatchObject({ type: 'ingest', status: 'queued' });
  });

  it('网页导入拒绝重定向、不支持的类型与空响应', async () => {
    const baseId = await createBase();

    route = '/redirect';
    const redirect = await importUrl(baseId);
    expect(redirect.statusCode, redirect.body).toBe(400);
    expect(redirect.json()).toMatchObject({ code: 'INVALID_URL' });

    route = '/binary';
    const binary = await importUrl(baseId);
    expect(binary.statusCode, binary.body).toBe(415);

    route = '/empty';
    const empty = await importUrl(baseId);
    expect(empty.statusCode, empty.body).toBe(502);
  });

  it('生产环境拒绝解析到内网的地址，且不发起抓取', async () => {
    const baseId = await createBase();
    const prodApp = await buildTestApp({ KNOWLEDGE_DIR: knowledgeDir, NODE_ENV: 'production' });
    try {
      const prodCookie = await loginCookie(prodApp);
      const res = await inject(prodApp, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/documents/url`,
        headers: { cookie: prodCookie },
        payload: { url: `${fixtureUrl}/ok` },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ code: 'INVALID_URL' });
    } finally {
      await prodApp.close();
    }
  });

  it('入队失败返回 503，且不留半成品文档', async () => {
    const baseId = await createBase();
    const queue = getKnowledgeQueue();
    const add = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('redis down'));
    let res: Awaited<ReturnType<typeof createManual>>;
    try {
      res = await createManual(baseId);
    } finally {
      add.mockRestore();
    }
    expect(res.statusCode, res.body).toBe(503);
    const rows = await app.pool.query<{ count: string }>(
      'select count(*)::text as count from knowledge_documents where base_id = $1',
      [baseId],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });
});
