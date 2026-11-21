import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cookieOf, createAccount, createRole, grants, login } from './access-helpers.js';
import {
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

function rawId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}`;
}

interface SeedImage {
  name: string;
  mimeType: string;
  page: number | null;
}

interface SeedChunk {
  name: string;
  role: 'caption' | 'ocr';
  content: string;
}

interface SeedDocumentInput {
  baseId: string;
  documentId: string;
  title: string;
  versionId: string;
  updatedAt: string;
  status?: 'ready' | 'disabled';
  disabledReason?: 'manual' | null;
  images: SeedImage[];
  chunks?: SeedChunk[];
}

describe.skipIf(!ready)('knowledge image gallery', () => {
  let app: TestApp;
  let cookie = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function createBase(): Promise<string> {
    const profile = await request(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('gallery-emb'),
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    profileIds.push(profile.json<{ id: string }>().id);

    const res = await request(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('gallery-kb'), name: '图库', embeddingProfileId: profileIds.at(-1) },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    baseIds.push(id);
    return id;
  }

  async function seedDocument(input: SeedDocumentInput): Promise<void> {
    const [base] = await app.client.unsafe<{ embedding_profile_id: string }[]>(
      'select embedding_profile_id from knowledge_bases where id = $1',
      [input.baseId],
    );
    if (!base) throw new Error('base row missing');
    await app.client.unsafe(
      `insert into knowledge_documents
         (id, base_id, title, source_type, mime_type, status, disabled_reason,
          current_version_id, updated_at)
       values ($1, $2, $3, 'upload', 'application/pdf', $4, $5, $6, $7)`,
      [
        input.documentId,
        input.baseId,
        input.title,
        input.status ?? 'ready',
        input.disabledReason ?? null,
        input.versionId,
        input.updatedAt,
      ],
    );
    await app.client.unsafe(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, images, embedding_profile_id)
       values ($1, $2, 1, $3, $3, 'album.pdf', 'application/pdf', 9, 'parsed', $4::jsonb, $5)`,
      [
        input.versionId,
        input.documentId,
        'c'.repeat(64),
        JSON.stringify(
          input.images.map((image) => ({ ...image, sha256: 'd'.repeat(64), warnings: [] })),
        ),
        base.embedding_profile_id,
      ],
    );
    const byName = new Map(input.images.map((image) => [image.name, image] as const));
    for (const [index, chunk] of (input.chunks ?? []).entries()) {
      const image = byName.get(chunk.name);
      if (!image) throw new Error(`chunk references unknown image ${chunk.name}`);
      await app.client.unsafe(
        `insert into knowledge_chunks
           (id, base_id, document_id, version_id, ordinal, kind, content, search_text, metadata)
         values ($1, $2, $3, $4, $5, 'image', $6, $6, $7::jsonb)`,
        [
          rawId('kchk'),
          input.baseId,
          input.documentId,
          input.versionId,
          index,
          chunk.content,
          JSON.stringify({ image, imageRole: chunk.role }),
        ],
      );
    }
  }

  function listImages(baseId: string, query = '', cookieValue: string | null = cookie) {
    return request(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/images${query}`,
      ...(cookieValue === null ? {} : { headers: { cookie: cookieValue } }),
    });
  }

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (baseIds.length > 0) {
      await app.client.unsafe('delete from knowledge_bases where id = any($1::text[])', [
        app.client.array(baseIds, 'TEXT'),
      ]);
    }
    if (profileIds.length > 0) {
      await app.client.unsafe('delete from knowledge_model_profiles where id = any($1::text[])', [
        app.client.array(profileIds, 'TEXT'),
      ]);
    }
    await app.close();
  });

  it('版本清单中的图片即使没有分块也会出现', async () => {
    const baseId = await createBase();
    const documentId = rawId('kdoc');
    const versionId = rawId('kdv');
    await seedDocument({
      baseId,
      documentId,
      title: '未处理图册',
      versionId,
      updatedAt: '2026-01-01T00:00:00.500Z',
      images: [{ name: 'raw.png', mimeType: 'image/png', page: 2 }],
    });

    const res = await listImages(baseId);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>();
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        documentId,
        documentTitle: '未处理图册',
        versionId,
        name: 'raw.png',
        mimeType: 'image/png',
        page: 2,
        caption: null,
        ocrText: null,
        createdAt: '2026-01-01T00:00:00.500Z',
      },
    ]);
  });

  it('超过 int32 的页码不会 500，原样返回', async () => {
    const baseId = await createBase();
    const documentId = rawId('kdoc');
    const versionId = rawId('kdv');
    await seedDocument({
      baseId,
      documentId,
      title: '超大页码',
      versionId,
      updatedAt: '2026-01-01T00:00:00Z',
      images: [
        { name: 'huge.png', mimeType: 'image/png', page: 2147483648 },
        { name: 'unsafe.png', mimeType: 'image/png', page: 1e20 },
      ],
    });

    const res = await listImages(baseId);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: Array<{ name: string; page: number | null }> }>().items;
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'huge.png', page: 2147483648 }),
        expect.objectContaining({ name: 'unsafe.png', page: null }),
      ]),
    );
  });

  it('同一图片的 OCR 与描述合并为一条素材', async () => {
    const baseId = await createBase();
    const documentId = rawId('kdoc');
    const versionId = rawId('kdv');
    await seedDocument({
      baseId,
      documentId,
      title: '季度报告',
      versionId,
      updatedAt: '2026-01-01T00:00:00Z',
      images: [{ name: 'chart.png', mimeType: 'image/png', page: 3 }],
      chunks: [
        { name: 'chart.png', role: 'caption', content: 'Revenue chart' },
        { name: 'chart.png', role: 'ocr', content: 'TOTAL 120' },
      ],
    });

    const res = await listImages(baseId);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>();
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      documentId,
      documentTitle: '季度报告',
      versionId,
      name: 'chart.png',
      mimeType: 'image/png',
      page: 3,
      caption: 'Revenue chart',
      ocrText: 'TOTAL 120',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('q 命中名称、描述或 OCR 时返回完整文本', async () => {
    const baseId = await createBase();
    await seedDocument({
      baseId,
      documentId: rawId('kdoc'),
      title: '产品手册',
      versionId: rawId('kdv'),
      updatedAt: '2026-01-01T00:00:00Z',
      images: [{ name: 'cover.jpg', mimeType: 'image/jpeg', page: 1 }],
      chunks: [
        { name: 'cover.jpg', role: 'caption', content: '产品封面 完整描述文字' },
        { name: 'cover.jpg', role: 'ocr', content: 'TOTAL 900 COMPLETE' },
      ],
    });

    const byName = await listImages(baseId, '?q=cover');
    expect(byName.statusCode, byName.body).toBe(200);
    const nameItems = byName.json<{
      items: Array<{ name: string; caption: string | null; ocrText: string | null }>;
    }>().items;
    expect(nameItems).toHaveLength(1);
    expect(nameItems[0]).toMatchObject({
      name: 'cover.jpg',
      caption: '产品封面 完整描述文字',
      ocrText: 'TOTAL 900 COMPLETE',
    });

    const byOcr = await listImages(baseId, '?q=complete');
    expect(byOcr.statusCode, byOcr.body).toBe(200);
    expect(byOcr.json<{ items: Array<Record<string, unknown>> }>().items).toEqual([
      {
        documentId: expect.any(String),
        documentTitle: '产品手册',
        versionId: expect.any(String),
        name: 'cover.jpg',
        mimeType: 'image/jpeg',
        page: 1,
        caption: '产品封面 完整描述文字',
        ocrText: 'TOTAL 900 COMPLETE',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const byCaption = await listImages(baseId, '?q=完整描述');
    expect(byCaption.statusCode, byCaption.body).toBe(200);
    const captionItems = byCaption.json<{
      items: Array<{ name: string; caption: string | null; ocrText: string | null }>;
    }>().items;
    expect(captionItems).toHaveLength(1);
    expect(captionItems[0]).toMatchObject({
      name: 'cover.jpg',
      caption: '产品封面 完整描述文字',
      ocrText: 'TOTAL 900 COMPLETE',
    });

    const miss = await listImages(baseId, '?q=nothing-matches');
    expect(miss.statusCode, miss.body).toBe(200);
    expect(miss.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('limit=1 的游标按素材翻页，跨微秒与同版本多图都不重复', async () => {
    const baseId = await createBase();
    await seedDocument({
      baseId,
      documentId: rawId('kdoc'),
      title: '晚图',
      versionId: rawId('kdv'),
      updatedAt: '2026-01-03T00:00:00.123789Z',
      images: [
        { name: 'alpha.png', mimeType: 'image/png', page: 1 },
        { name: 'beta.png', mimeType: 'image/png', page: 2 },
      ],
      chunks: [
        { name: 'beta.png', role: 'caption', content: 'Beta caption' },
        { name: 'beta.png', role: 'ocr', content: 'BETA OCR' },
      ],
    });
    await seedDocument({
      baseId,
      documentId: rawId('kdoc'),
      title: '同毫秒图',
      versionId: rawId('kdv'),
      updatedAt: '2026-01-03T00:00:00.123456Z',
      images: [{ name: 'delta.jpg', mimeType: 'image/jpeg', page: 3 }],
      chunks: [{ name: 'delta.jpg', role: 'ocr', content: 'DELTA OCR' }],
    });
    await seedDocument({
      baseId,
      documentId: rawId('kdoc'),
      title: '早图',
      versionId: rawId('kdv'),
      updatedAt: '2026-01-02T00:00:00Z',
      images: [{ name: 'gamma.jpg', mimeType: 'image/jpeg', page: 4 }],
    });

    const names: string[] = [];
    let cursor: string | null = null;
    let finished = false;
    let pages = 0;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const query = cursor === null ? '?limit=1' : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const res = await listImages(baseId, query);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{ items: Array<{ name: string }>; nextCursor: string | null }>();
      expect(page.items).toHaveLength(1);
      pages += 1;
      names.push(...page.items.map((item) => item.name));
      if (page.nextCursor === null) {
        finished = true;
        break;
      }
      cursor = page.nextCursor;
    }

    expect(finished).toBe(true);
    expect(pages).toBe(4);
    expect(names).toEqual(['beta.png', 'alpha.png', 'delta.jpg', 'gamma.jpg']);

    expectProblem(await listImages(baseId, '?cursor=not-a-cursor'), 'INVALID_INPUT');
    const forged = Buffer.from(
      JSON.stringify({ u: 'not-a-date', d: 'kdoc_x', n: 'x.png' }),
      'utf8',
    ).toString('base64url');
    expectProblem(
      await listImages(baseId, `?cursor=${encodeURIComponent(forged)}`),
      'INVALID_INPUT',
    );
    const feb30 = Buffer.from(
      JSON.stringify({ u: '2026-02-30T00:00:00.000000Z', d: 'kdoc_x', n: 'x.png' }),
      'utf8',
    ).toString('base64url');
    expectProblem(
      await listImages(baseId, `?cursor=${encodeURIComponent(feb30)}`),
      'INVALID_INPUT',
    );
    const yearZero = Buffer.from(
      JSON.stringify({ u: '0000-01-01T00:00:00.000000Z', d: 'kdoc_x', n: 'x.png' }),
      'utf8',
    ).toString('base64url');
    expectProblem(
      await listImages(baseId, `?cursor=${encodeURIComponent(yearZero)}`),
      'INVALID_INPUT',
    );
  });

  it('停用文档的图片即使分块仍启用也不会出现', async () => {
    const baseId = await createBase();
    await seedDocument({
      baseId,
      documentId: rawId('kdoc'),
      title: '正常图册',
      versionId: rawId('kdv'),
      updatedAt: '2026-01-01T00:00:00Z',
      images: [{ name: 'visible.png', mimeType: 'image/png', page: 1 }],
      chunks: [{ name: 'visible.png', role: 'ocr', content: 'VISIBLE' }],
    });
    await seedDocument({
      baseId,
      documentId: rawId('kdoc'),
      title: '停用图册',
      versionId: rawId('kdv'),
      updatedAt: '2026-01-02T00:00:00Z',
      status: 'disabled',
      disabledReason: 'manual',
      images: [{ name: 'hidden.png', mimeType: 'image/png', page: 2 }],
      chunks: [{ name: 'hidden.png', role: 'ocr', content: 'HIDDEN' }],
    });

    const res = await listImages(baseId);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: Array<{ name: string }> }>().items;
    expect(items.map((item) => item.name)).toEqual(['visible.png']);
  });

  it('未登录 401，越权访问 404，其他知识库不串图', async () => {
    const baseId = await createBase();
    await seedDocument({
      baseId,
      documentId: rawId('kdoc'),
      title: '私有图册',
      versionId: rawId('kdv'),
      updatedAt: '2026-01-01T00:00:00Z',
      images: [{ name: 'private.png', mimeType: 'image/png', page: 1 }],
      chunks: [
        { name: 'private.png', role: 'caption', content: '私有封面' },
        { name: 'private.png', role: 'ocr', content: 'PRIVATE 1' },
      ],
    });

    const unauth = await listImages(baseId, '', null);
    expect(unauth.statusCode, unauth.body).toBe(401);

    expectProblem(await listImages('kb_missing_gallery'), 'NOT_FOUND');

    const readerRole = await createRole(
      app,
      cookie,
      unique('gallery-reader'),
      grants(['knowledge.read', 'own_data']),
    );
    const readerPassword = '{{SECRET_udqz9t0a}}';
    const reader = await createAccount(app, cookie, {
      roleIds: [readerRole.id],
      password: readerPassword,
    });
    expect(reader.statusCode, reader.body).toBe(201);
    const signIn = await login(app, reader.account.username, readerPassword);
    expect(signIn.statusCode, signIn.body).toBe(200);
    expectProblem(await listImages(baseId, '', cookieOf(signIn)), 'NOT_FOUND');

    const viewerRole = await createRole(
      app,
      cookie,
      unique('gallery-viewer'),
      grants(['overview.read', 'platform']),
    );
    const viewer = await createAccount(app, cookie, {
      roleIds: [viewerRole.id],
      password: '{{SECRET_udqz9t0a}}',
    });
    expect(viewer.statusCode, viewer.body).toBe(201);
    const viewerSignIn = await login(app, viewer.account.username, '{{SECRET_udqz9t0a}}');
    expect(viewerSignIn.statusCode, viewerSignIn.body).toBe(200);
    expectProblem(await listImages(baseId, '', cookieOf(viewerSignIn)), 'FORBIDDEN');

    const other = await createBase();
    const res = await listImages(other);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});
