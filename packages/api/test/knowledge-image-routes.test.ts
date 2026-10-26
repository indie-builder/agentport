import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  type FastifyInstance,
  infraReady,
  inject,
  loginCookie,
  testConfig,
  unique,
} from './helpers.js';

const ready = await infraReady;

function mustRow<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('seed query returned no row');
  return row;
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);

describe.skipIf(!ready)('knowledge image routes', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  let baseId = '';
  let documentId = '';
  let versionId = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function createBase(): Promise<string> {
    const profile = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('image-emb'),
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    profileIds.push(profile.json<{ id: string }>().id);

    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('image-kb'), name: '图片库', embeddingProfileId: profileIds.at(-1) },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    baseIds.push(id);
    return id;
  }

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-image-routes-'));
    app = await buildApp(testConfig({ KNOWLEDGE_DIR: knowledgeDir }));
    await app.ready();
    cookie = await loginCookie(app);
    baseId = await createBase();

    // 直接落一条已解析版本：图片 route 只依赖版本行与磁盘图片目录。
    const document = await app.pool.query<{ id: string }>(
      `insert into knowledge_documents (id, base_id, title, source_type, mime_type, status)
       values ($1, $2, '图册', 'upload', 'application/pdf', 'ready') returning id`,
      [`kdoc_${Math.random().toString(36).slice(2, 12)}`, baseId],
    );
    documentId = mustRow(document.rows).id;
    const profile = await app.pool.query<{ embedding_profile_id: string }>(
      'select embedding_profile_id from knowledge_bases where id = $1',
      [baseId],
    );
    versionId = `kdv_${Math.random().toString(36).slice(2, 12)}`;
    const pageMap = [
      { page: 1, startOffset: 0, endOffset: 4 },
      { page: 2, startOffset: 4, endOffset: 9 },
    ];
    const images = [
      {
        name: 'image-1.png',
        sha256: createHash('sha256').update(PNG).digest('hex'),
        mimeType: 'image/png',
        page: 1,
      },
    ];
    await app.pool.query(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id)
       values ($1, $2, 1, $3, $3, 'album.pdf', 'application/pdf', 9, 'parsed',
               $4::jsonb, $5::jsonb, $6)`,
      [
        versionId,
        documentId,
        'b'.repeat(64),
        JSON.stringify(pageMap),
        JSON.stringify(images),
        mustRow(profile.rows).embedding_profile_id,
      ],
    );

    const imageDir = join(knowledgeDir, 'docs', documentId, versionId, 'images');
    await mkdir(imageDir, { recursive: true });
    await writeFile(join(imageDir, 'image-1.png'), PNG);
    // 白名单外的文件：就算出现在磁盘上也不能通过 URL 读到。
    await writeFile(join(imageDir, 'secret.png'), Buffer.from('not-whitelisted'));
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

  it('未登录读取图片与版本详情返回 401', async () => {
    for (const url of [
      `/api/knowledge/versions/${versionId}/images/image-1.png`,
      `/api/knowledge/versions/${versionId}/details`,
    ]) {
      const res = await inject(app, { method: 'GET', url });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(401);
    }
  });

  it('白名单内的图片返回原始字节、sniff 防护与私有缓存', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/versions/${versionId}/images/image-1.png`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private');
    expect(Buffer.from(res.rawPayload).equals(PNG)).toBe(true);
  });

  it('未登记在版本白名单里的文件名 404，即使磁盘上存在同名文件', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/versions/${versionId}/images/secret.png`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('路径穿越与非常规文件名在 schema 边界被拒绝，不读磁盘', async () => {
    // `..`/`.` 会被框架先规范化成别的路径（404 未命中）；合法形状但不在白名单也得 404。
    for (const [name, statuses] of [
      ['..%2F..%2Fetc%2Fpasswd', [400]],
      ['..', [400, 404]],
      ['.', [400, 404]],
      ['.hidden', [404]],
      ['image-1.png%00', [400]],
      ['%2e%2e%2fsecret.png', [400]],
      ['a%5Cb.png', [400]],
    ] as const) {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/versions/${versionId}/images/${name}`,
        headers: { cookie },
      });
      expect(statuses, `${name}: ${res.body}`).toContain(res.statusCode);
    }
  });

  it('不存在的版本返回 404', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: '/api/knowledge/versions/kdv_missing/images/image-1.png',
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('版本详情报出 images 与 pageMap 但不下发磁盘信息', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/versions/${versionId}/details`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      id: versionId,
      documentId,
      version: 1,
      originalFilename: 'album.pdf',
      parseStatus: 'parsed',
      images: [{ name: 'image-1.png', mimeType: 'image/png', page: 1 }],
      pageMap: [
        { page: 1, startOffset: 0, endOffset: 4 },
        { page: 2, startOffset: 4, endOffset: 9 },
      ],
    });
    expect(body).not.toHaveProperty('blobSha256');
    expect(JSON.stringify(body)).not.toContain(knowledgeDir);
  });

  it('禁用知识库后图片与详情仍按管理员鉴权读取', async () => {
    await app.pool.query("update knowledge_bases set status = 'disabled' where id = $1", [baseId]);
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/versions/${versionId}/images/image-1.png`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    await app.pool.query("update knowledge_bases set status = 'active' where id = $1", [baseId]);
  });
});
