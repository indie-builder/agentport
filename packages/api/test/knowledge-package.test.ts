import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { infraReady, inject, injectZip, loginCookie, testConfig, unique } from './helpers.js';

const ready = await infraReady;

// 1x1 PNG：真实字节，用来验证图片随包归档与恢复。
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const IMAGE_NAME = 'fig-1.png';
const IMAGE_PAGE = 2;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface Manifest {
  format: string;
  version: number;
  base: {
    slug: string;
    name: string;
    embeddingProfileName: string;
    rerankProfileName: string | null;
  };
  folders: Array<{ id: string; parentId: string | null; name: string; path: string }>;
  tags: Array<{ id: string; name: string }>;
  documents: Array<{
    id: string;
    folderId: string | null;
    title: string;
    currentVersionId: string | null;
    tags: string[];
    versions: Array<{
      id: string;
      version: number;
      originalPath: string;
      markdownPath: string | null;
      blobSha256: string;
      markdownSha256: string | null;
      sizeBytes: number;
      images: Array<{ name: string; sha256: string; mimeType: string; page: number; path: string }>;
      chunks: Array<Record<string, unknown>>;
    }>;
  }>;
  wikiPages: Array<{
    id: string;
    slug: string;
    status: string;
    currentVersionId: string | null;
    versions: Array<{
      id: string;
      version: number;
      markdown: string;
      sourceChunkIds: string[];
      unresolvedSourceChunkIds?: string[];
    }>;
    sources: Array<{ documentId: string | null; versionId: string | null; chunkId: string | null }>;
  }>;
  files: Array<{ path: string; sha256: string; size: number }>;
}

function readManifest(buffer: Buffer): Manifest {
  const raw = unzipSync(new Uint8Array(buffer))['manifest.json'];
  if (!raw) throw new Error('manifest.json missing');
  return JSON.parse(Buffer.from(raw).toString('utf8')) as Manifest;
}

function rewriteManifest(buffer: Buffer, mutate: (manifest: Manifest) => void): Buffer {
  const files = unzipSync(new Uint8Array(buffer));
  const manifest = readManifest(buffer);
  mutate(manifest);
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** 同时改 manifest 与条目，用来构造「清单登记了但内容缺失」的包。 */
function rewritePackage(
  buffer: Buffer,
  mutate: (manifest: Manifest, files: Record<string, Uint8Array>) => void,
): Buffer {
  const files = unzipSync(new Uint8Array(buffer));
  const manifest = readManifest(buffer);
  mutate(manifest, files);
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  return Buffer.from(zipSync(files, { level: 6 }));
}

describe.skipIf(!ready)('knowledge package import/export', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  let profileId = '';
  let profileName = '';
  let baseId = '';
  let documentId = '';
  let versionId = '';
  let chunkId = '';
  let wikiPageId = '';
  let exported = Buffer.alloc(0);
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-package-'));
    app = await buildApp(testConfig({ KNOWLEDGE_DIR: knowledgeDir }));
    await app.ready();
    cookie = await loginCookie(app);
    const profile = await createProfile();
    profileId = profile.id;
    profileName = profile.name;
    await seedLibrary();
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

  async function createProfile(): Promise<{ id: string; name: string }> {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('pkg-emb'),
        endpointUrl: 'http://127.0.0.1:1/embeddings',
        model: 'test-model',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const profile = res.json<{ id: string; name: string }>();
    profileIds.push(profile.id);
    return profile;
  }

  async function createBase(embeddingProfileId: string): Promise<string> {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('pkg-kb'), name: '打包知识库', embeddingProfileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const base = res.json<{ id: string }>();
    baseIds.push(base.id);
    return base.id;
  }

  async function seedLibrary(): Promise<void> {
    baseId = await createBase(profileId);
    const folder = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/folders`,
      headers: { cookie },
      payload: { name: 'runbooks' },
    });
    expect(folder.statusCode, folder.body).toBe(201);
    const folderId = folder.json<{ id: string }>().id;

    const tag = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/tags`,
      headers: { cookie },
      payload: { name: 'ops' },
    });
    expect(tag.statusCode, tag.body).toBe(201);

    const original = Buffer.from('# 访问令牌\n\n访问令牌需要定期轮换。', 'utf8');
    const upload = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/bases/${baseId}/documents/upload`,
      headers: { cookie },
      payload: {
        filename: 'tokens.md',
        mimeType: 'text/markdown',
        dataBase64: original.toString('base64'),
        folderId,
      },
    });
    expect(upload.statusCode, upload.body).toBe(202);
    documentId = upload.json<{ documentId: string }>().documentId;

    const patch = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/documents/${documentId}`,
      headers: { cookie },
      payload: { tags: ['ops'] },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    versionId = `kdv_${randomUUID().replace(/-/g, '')}`;
    const markdown = '# 访问令牌\n\n访问令牌需要定期轮换。\n';
    await mkdir(join(knowledgeDir, 'docs', documentId, versionId, 'images'), { recursive: true });
    await writeFile(join(knowledgeDir, 'docs', documentId, versionId, 'markdown.md'), markdown);
    await writeFile(
      join(knowledgeDir, 'docs', documentId, versionId, 'images', IMAGE_NAME),
      TINY_PNG,
    );
    await app.pool.query(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, source_revision, parse_status, page_map, images, embedding_profile_id)
       values ($1, $2, 1, $3, $4, 'tokens.md', 'text/markdown', $5, null, 'parsed', '[]', $6, $7)`,
      [
        versionId,
        documentId,
        sha256(original),
        sha256(Buffer.from(markdown, 'utf8')),
        original.length,
        JSON.stringify([
          { name: IMAGE_NAME, sha256: sha256(TINY_PNG), mimeType: 'image/png', page: IMAGE_PAGE },
        ]),
        profileId,
      ],
    );

    // 250 个 chunk：验证导出按游标分页，不会在 200 条处截断。
    for (let index = 0; index < 250; index += 1) {
      const id = `kchk_${randomUUID().replace(/-/g, '')}`;
      if (index === 0) chunkId = id;
      await app.pool.query(
        `insert into knowledge_chunks
           (id, base_id, document_id, version_id, folder_id, ordinal, kind, heading, content,
            search_text, enabled, edited_by_user, page_from, page_to, token_count, metadata)
         values ($1, $2, $3, $4, $5, $6, 'text', null, $7, '令牌 轮换', true, $8, null, null, 8, '{}')`,
        [
          id,
          baseId,
          documentId,
          versionId,
          folderId,
          index,
          `第 ${index} 段：访问令牌需要定期轮换。`,
          index === 0,
        ],
      );
    }
    await app.pool.query(
      "update knowledge_documents set status = 'ready', current_version_id = $2 where id = $1",
      [documentId, versionId],
    );

    const page = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/wiki-pages`,
      headers: { cookie },
      payload: { slug: 'token-rotation', title: '令牌轮换' },
    });
    expect(page.statusCode, page.body).toBe(201);
    wikiPageId = page.json<{ id: string }>().id;
    const edited = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/wiki-pages/${wikiPageId}`,
      headers: { cookie },
      payload: { markdown: '# 令牌轮换\n\n来源：访问令牌文档。' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    await app.pool.query(
      `insert into knowledge_wiki_sources (page_id, document_id, version_id, chunk_id, stale)
       values ($1, $2, $3, $4, false)`,
      [wikiPageId, documentId, versionId, chunkId],
    );
    await app.pool.query(
      `update knowledge_wiki_versions set source_chunk_ids = $2::jsonb where page_id = $1`,
      [wikiPageId, JSON.stringify([chunkId])],
    );
  }

  it('未登录不能导出或导入', async () => {
    const exported = await inject(app, { method: 'GET', url: '/api/knowledge/bases/x/export' });
    expect(exported.statusCode).toBe(401);
    const imported = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases/import',
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.from('zip'),
    });
    expect(imported.statusCode).toBe(401);
  });

  it('导出 manifest、原件、Markdown、人工 chunk 与 Wiki 引用，且不含向量', async () => {
    const res = await injectZip(app, 'GET', `/api/knowledge/bases/${baseId}/export`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    exported = res.rawPayload;

    const manifest = readManifest(exported);
    expect(manifest.format).toBe('pace/knowledge@1');
    expect(manifest.base.embeddingProfileName).toBe(profileName);
    expect(manifest.folders).toHaveLength(1);
    expect(manifest.tags.map((tag) => tag.name)).toEqual(['ops']);
    expect(manifest.documents).toHaveLength(1);

    const document = manifest.documents[0]!;
    const version = document.versions[0]!;
    expect(document.tags).toHaveLength(1);
    expect(version.chunks).toHaveLength(250);
    expect(version.chunks[0]!.editedByUser).toBe(true);
    for (const chunk of version.chunks) expect(chunk).not.toHaveProperty('embedding');

    const imagePath = `documents/${documentId}/${versionId}/images/${IMAGE_NAME}`;
    expect(version.images).toEqual([
      {
        name: IMAGE_NAME,
        sha256: sha256(TINY_PNG),
        mimeType: 'image/png',
        page: IMAGE_PAGE,
        path: imagePath,
      },
    ]);

    const files = unzipSync(new Uint8Array(exported));
    expect(Buffer.from(files[imagePath]!)).toEqual(TINY_PNG);
    expect(sha256(Buffer.from(files[version.originalPath]!))).toBe(version.blobSha256);
    expect(sha256(Buffer.from(files[version.markdownPath!]!))).toBe(version.markdownSha256);
    for (const [path, bytes] of Object.entries(files)) {
      if (path === 'manifest.json') continue;
      const entry = manifest.files.find((file) => file.path === path);
      expect(entry, path).toBeTruthy();
      expect(entry!.sha256).toBe(sha256(Buffer.from(bytes)));
      expect(entry!.size).toBe(bytes.length);
    }

    const wiki = manifest.wikiPages[0]!;
    expect(wiki.versions).toHaveLength(1);
    expect(wiki.currentVersionId).toBe(wiki.versions[0]!.id);
    expect(wiki.sources).toEqual([{ documentId, versionId, chunkId, stale: false }]);
  });

  it('版本声明了图片文件但磁盘上缺失时导出报错，不静默丢掉图片', async () => {
    const source = join(knowledgeDir, 'docs', documentId, versionId, 'images', IMAGE_NAME);
    const moved = `${source}.moved`;
    await rename(source, moved);
    try {
      const res = await injectZip(app, 'GET', `/api/knowledge/bases/${baseId}/export`, cookie);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ message: string }>().message).toContain(IMAGE_NAME);
    } finally {
      await rename(moved, source);
    }
  });

  it('导入还原到新库：新 ID、文件夹/标签/人工 chunk/Wiki 引用，embedding 为空但可关键词检索和重建', async () => {
    // 移除原库避免 slug 冲突；导出的 ZIP 已保存在内存里。
    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/bases/${baseId}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    baseIds.length = 0;

    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, exported);
    expect(res.statusCode, res.body).toBe(201);
    const result = res.json<{
      baseId: string;
      counts: { documents: number; versions: number; chunks: number; wikiPages: number };
    }>();
    baseIds.push(result.baseId);
    expect(result.counts).toEqual({
      folders: 1,
      tags: 1,
      documents: 1,
      versions: 1,
      chunks: 250,
      wikiPages: 1,
    });

    const base = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${result.baseId}`,
      headers: { cookie },
    });
    expect(base.json<{ embeddingProfileId: string }>().embeddingProfileId).toBe(profileId);

    const folders = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${result.baseId}/folders`,
      headers: { cookie },
    });
    expect(folders.json<Array<{ path: string }>>().map((folder) => folder.path)).toEqual([
      '/runbooks',
    ]);

    const docs = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${result.baseId}/documents`,
      headers: { cookie },
    });
    const imported = docs.json<{
      items: Array<{
        id: string;
        folderId: string | null;
        status: string;
        tags: string[];
        currentVersionId: string;
      }>;
    }>().items[0]!;
    expect(imported.id).not.toBe(documentId);
    expect(imported.currentVersionId).not.toBe(versionId);
    expect(imported.status).toBe('ready');
    expect(imported.folderId).not.toBeNull();
    expect(imported.tags).toEqual(['ops']);

    const importedVersion = await app.pool.query<{
      id: string;
      images: Array<{ name: string; sha256: string; mimeType: string; page: number }>;
    }>('select id, images from knowledge_document_versions where document_id = $1', [imported.id]);
    expect(importedVersion.rows[0]!.id).not.toBe(versionId);
    expect(importedVersion.rows[0]!.images).toEqual([
      {
        name: IMAGE_NAME,
        sha256: sha256(TINY_PNG),
        mimeType: 'image/png',
        page: IMAGE_PAGE,
        warnings: [],
      },
    ]);
    const restored = await readFile(
      join(knowledgeDir, 'docs', imported.id, importedVersion.rows[0]!.id, 'images', IMAGE_NAME),
    );
    expect(restored).toEqual(TINY_PNG);

    const chunks = await app.pool.query<{
      id: string;
      embedding: string | null;
      edited_by_user: boolean;
    }>(
      'select id, embedding::text, edited_by_user from knowledge_chunks where document_id = $1 order by ordinal limit 1',
      [imported.id],
    );
    expect(chunks.rows[0]!.embedding).toBeNull();
    expect(chunks.rows[0]!.edited_by_user).toBe(true);
    expect(chunks.rows[0]!.id).not.toBe(chunkId);

    const search = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${result.baseId}/search?q=${encodeURIComponent('令牌')}&rerank=false`,
      headers: { cookie },
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json<{ hits: unknown[] }>().hits.length).toBeGreaterThan(0);

    const rebuild = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${result.baseId}/rebuild`,
      headers: { cookie },
      payload: {},
    });
    expect(rebuild.statusCode, rebuild.body).toBe(202);

    const pages = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${result.baseId}/wiki-pages`,
      headers: { cookie },
    });
    const page = pages.json<{ items: Array<{ id: string; status: string }> }>().items[0]!;
    expect(page.id).not.toBe(wikiPageId);
    expect(page.status).toBe('published');

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const wiki = detail.json<{
      currentVersionId: string;
      versions: Array<{ id: string; markdown: string; sourceChunkIds: string[] }>;
    }>();
    expect(wiki.versions[0]!.markdown).toContain('来源：访问令牌文档。');
    expect(wiki.versions[0]!.sourceChunkIds).toEqual([chunks.rows[0]!.id]);
    expect(wiki.currentVersionId).toBe(wiki.versions[0]!.id);

    const sources = await app.pool.query(
      'select document_id, version_id, chunk_id, stale from knowledge_wiki_sources where page_id = $1',
      [page.id],
    );
    expect(sources.rows).toEqual([
      {
        document_id: imported.id,
        version_id: imported.currentVersionId,
        chunk_id: chunks.rows[0]!.id,
        stale: false,
      },
    ]);
  });

  it('篡改文件内容（sha256 不符）时拒绝导入，且不落半库', async () => {
    const manifest = readManifest(exported);
    const files = unzipSync(new Uint8Array(exported));
    const target = manifest.documents[0]!.versions[0]!.markdownPath!;
    files[target]![0] = files[target]![0]! ^ 0xff;

    const before = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_bases where embedding_profile_id = $1',
      [profileId],
    );
    const res = await injectZip(
      app,
      'POST',
      '/api/knowledge/bases/import',
      cookie,
      Buffer.from(zipSync(files, { level: 6 })),
    );
    expect(res.statusCode, res.body).toBe(400);
    const after = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_bases where embedding_profile_id = $1',
      [profileId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('图片 sha256 与清单不符时拒绝导入，且不落半库', async () => {
    const mutated = rewritePackage(exported, (manifest) => {
      const image = manifest.documents[0]!.versions[0]!.images[0]!;
      image.sha256 = '0'.repeat(64);
    });
    const before = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_bases where embedding_profile_id = $1',
      [profileId],
    );
    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, mutated);
    expect(res.statusCode, res.body).toBe(400);
    const after = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_bases where embedding_profile_id = $1',
      [profileId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('清单登记了图片但 ZIP 缺少该文件时拒绝导入', async () => {
    const mutated = rewritePackage(exported, (manifest, files) => {
      const version = manifest.documents[0]!.versions[0]!;
      const image = version.images[0]!;
      delete files[image.path];
      manifest.files = manifest.files.filter((file) => file.path !== image.path);
    });
    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, mutated);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_INPUT');
  });

  it('图片路径不在白名单目录时拒绝导入', async () => {
    const mutated = rewritePackage(exported, (manifest, files) => {
      const version = manifest.documents[0]!.versions[0]!;
      const image = version.images[0]!;
      // 语法合法的相对路径，但不在该版本的 images/ 目录下。
      const outside = version.originalPath;
      files[outside] = files[image.path]!;
      delete files[image.path];
      manifest.files = manifest.files.map((file) =>
        file.path === image.path ? { ...file, path: outside } : file,
      );
      image.path = outside;
    });
    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, mutated);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_INPUT');
  });

  it('路径穿越条目被拒绝', async () => {
    const files = unzipSync(new Uint8Array(exported));
    files['../escape'] = new TextEncoder().encode('x');
    const res = await injectZip(
      app,
      'POST',
      '/api/knowledge/bases/import',
      cookie,
      Buffer.from(zipSync(files, { level: 6 })),
    );
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_INPUT');
  });

  it('缺少同名模型 profile 返回 409，不创建任何库', async () => {
    const mutated = rewriteManifest(exported, (manifest) => {
      manifest.base.embeddingProfileName = 'missing-profile';
    });
    const before = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_bases where embedding_profile_id = $1',
      [profileId],
    );
    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, mutated);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ message: string }>().message).toContain('missing-profile');
    const after = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_bases where embedding_profile_id = $1',
      [profileId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('声明体积超过单文件上限时拒绝导入', async () => {
    const mutated = rewriteManifest(exported, (manifest) => {
      manifest.documents[0]!.versions[0]!.sizeBytes = 32 * 1024 * 1024 + 1;
    });
    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, mutated);
    expect(res.statusCode, res.body).toBe(400);
  });

  it('同一序号用于不同版本、同一版本号用于不同作用域时仍可导入', async () => {
    const mutated = rewriteManifest(exported, (manifest) => {
      manifest.base.slug = unique('pkg-scope');
      const document = manifest.documents[0]!;
      const version = document.versions[0]!;
      document.versions.push({
        ...version,
        id: randomUUID(),
        version: version.version + 1,
        // 序号只在单个版本内唯一；不同版本重复同一序号合法。
        chunks: version.chunks.map((chunk) => ({ ...chunk, id: randomUUID() })),
      });
    });
    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, mutated);
    expect(res.statusCode, res.body).toBe(201);
    const result = res.json<{ baseId: string; counts: Record<string, number> }>();
    baseIds.push(result.baseId);
    expect(result.counts).toMatchObject({ documents: 1, versions: 2, chunks: 500, wikiPages: 1 });
  });

  const duplicateCases: Array<{
    label: string;
    mutate: (manifest: Manifest) => void;
    message: (manifest: Manifest) => string;
  }> = [
    {
      label: '标签名',
      mutate: (manifest) => {
        manifest.tags.push({ id: randomUUID(), name: manifest.tags[0]!.name });
      },
      message: (manifest) => `标签「${manifest.tags[0]!.name}」重复`,
    },
    {
      label: '文档版本号',
      mutate: (manifest) => {
        const document = manifest.documents[0]!;
        document.versions.push({ ...document.versions[0]!, id: randomUUID() });
      },
      message: (manifest) => `文档「${manifest.documents[0]!.title}」版本号重复`,
    },
    {
      label: '分块序号',
      mutate: (manifest) => {
        const version = manifest.documents[0]!.versions[0]!;
        version.chunks.push({ ...version.chunks[0]!, id: randomUUID() });
      },
      message: (manifest) => {
        const version = manifest.documents[0]!.versions[0]!;
        return `版本「${version.id}」的分块序号 ${String(version.chunks[0]!.ordinal)} 重复`;
      },
    },
    {
      label: 'Wiki 版本号',
      mutate: (manifest) => {
        const page = manifest.wikiPages[0]!;
        page.versions.push({ ...page.versions[0]!, id: randomUUID() });
      },
      message: (manifest) => `Wiki 页面「${manifest.wikiPages[0]!.slug}」版本号重复`,
    },
    {
      label: 'Wiki 版本 ID',
      mutate: (manifest) => {
        const page = manifest.wikiPages[0]!;
        const version = page.versions[0]!;
        page.versions.push({ ...version, version: version.version + 1 });
      },
      message: (manifest) => `Wiki 页面「${manifest.wikiPages[0]!.slug}」版本 ID 重复`,
    },
    {
      label: '同页重复引用分块',
      mutate: (manifest) => {
        const page = manifest.wikiPages[0]!;
        page.sources.push({ ...page.sources[0]! });
      },
      message: (manifest) => `Wiki 页面「${manifest.wikiPages[0]!.slug}」重复引用同一分块`,
    },
  ];

  it.each(duplicateCases)(
    '重复$label 的知识包被拒绝，且不落库、不写文件',
    async ({ mutate, message }) => {
      const mutated = rewriteManifest(exported, (manifest) => {
        // 旧实现会放过重复并在落库时撞 slug；换唯一 slug 才能证明拒绝来自重复校验。
        manifest.base.slug = unique('pkg-dup');
        mutate(manifest);
      });
      const expected = message(readManifest(mutated));
      const before = await app.pool.query<{ count: string }>(
        'select count(*) from knowledge_bases where embedding_profile_id = $1',
        [profileId],
      );
      const docsBefore = (await readdir(join(knowledgeDir, 'docs'))).sort();

      const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, mutated);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json<{ code: string; message: string }>()).toMatchObject({
        code: 'INVALID_INPUT',
        message: expected,
      });

      const after = await app.pool.query<{ count: string }>(
        'select count(*) from knowledge_bases where embedding_profile_id = $1',
        [profileId],
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
      expect((await readdir(join(knowledgeDir, 'docs'))).sort()).toEqual(docsBefore);
    },
  );

  /** 独立小库：一篇文档 + 一个 chunk + 一页引用它的已发布 Wiki。 */
  async function seedReferencedWiki(): Promise<{
    baseId: string;
    documentId: string;
    versionId: string;
    chunkId: string;
    pageId: string;
  }> {
    const newBaseId = await createBase(profileId);
    const original = Buffer.from('# 被引用的文档\n', 'utf8');
    const upload = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/bases/${newBaseId}/documents/upload`,
      headers: { cookie },
      payload: {
        filename: 'cited.md',
        mimeType: 'text/markdown',
        dataBase64: original.toString('base64'),
      },
    });
    expect(upload.statusCode, upload.body).toBe(202);
    const newDocumentId = upload.json<{ documentId: string }>().documentId;

    const newVersionId = `kdv_${randomUUID().replace(/-/g, '')}`;
    const newChunkId = `kchk_${randomUUID().replace(/-/g, '')}`;
    await app.pool.query(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id)
       values ($1, $2, 1, $3, $3, 'cited.md', 'text/markdown', $4, 'parsed', '[]', '[]', $5)`,
      [newVersionId, newDocumentId, sha256(original), original.length, profileId],
    );
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text)
       values ($1, $2, $3, $4, 0, 'text', '被引用的正文', '被引用 正文')`,
      [newChunkId, newBaseId, newDocumentId, newVersionId],
    );
    await app.pool.query(
      "update knowledge_documents set status = 'ready', current_version_id = $2 where id = $1",
      [newDocumentId, newVersionId],
    );

    const page = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${newBaseId}/wiki-pages`,
      headers: { cookie },
      payload: { slug: 'cited-page', title: '被引用的页面' },
    });
    expect(page.statusCode, page.body).toBe(201);
    const newPageId = page.json<{ id: string }>().id;
    const version = await repo.knowledge.saveWikiVersion(app.db, newPageId, {
      markdown: '# 引用被删文档的 Wiki',
      sourceChunkIds: [newChunkId],
      model: 'manual',
      generatedBy: 'manual',
    });
    expect(version).not.toBeNull();
    expect((await repo.knowledge.getWikiPage(app.db, newPageId))?.status).toBe('published');
    return {
      baseId: newBaseId,
      documentId: newDocumentId,
      versionId: newVersionId,
      chunkId: newChunkId,
      pageId: newPageId,
    };
  }

  async function exportBase(targetBaseId: string): Promise<Buffer> {
    const res = await injectZip(app, 'GET', `/api/knowledge/bases/${targetBaseId}/export`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.rawPayload;
  }

  async function deleteBase(targetBaseId: string): Promise<void> {
    const res = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/bases/${targetBaseId}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(204);
    const index = baseIds.indexOf(targetBaseId);
    if (index >= 0) baseIds.splice(index, 1);
  }

  /** 导入后核对：Wiki 文本保留，被删 chunk 的身份原样保留且明确失效，页面不装作有效。 */
  async function expectStaleReferenceRoundtrip(
    archive: Buffer,
    originalChunkId: string,
  ): Promise<void> {
    const imported = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, archive);
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{ baseId: string }>();
    baseIds.push(result.baseId);

    const pages = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${result.baseId}/wiki-pages`,
      headers: { cookie },
    });
    const page = pages.json<{ items: Array<{ id: string; status: string }> }>().items[0]!;
    expect(page.status).toBe('stale');

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${page.id}`,
      headers: { cookie },
    });
    const version = detail.json<{
      versions: Array<{ markdown: string; sourceChunkIds: string[] }>;
    }>().versions[0]!;
    expect(version.markdown).toContain('引用被删文档的 Wiki');
    // 失效引用保留原身份，但不指向任何导入后的 chunk。
    expect(version.sourceChunkIds).toEqual([originalChunkId]);
    expect(
      await app.pool.query('select id from knowledge_chunks where id = $1', [originalChunkId]),
    ).toMatchObject({ rows: [] });
  }

  it('删除被 Wiki 引用的 chunk 后导出再导入：历史引用显式失效仍可恢复', async () => {
    const seeded = await seedReferencedWiki();
    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/chunks/${seeded.chunkId}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const archive = await exportBase(seeded.baseId);
    const wiki = readManifest(archive).wikiPages[0]!;
    expect(wiki.status).toBe('stale');
    expect(wiki.versions[0]!.sourceChunkIds).toEqual([]);
    expect(wiki.versions[0]!.unresolvedSourceChunkIds).toEqual([seeded.chunkId]);
    expect(wiki.sources).toEqual([
      { documentId: seeded.documentId, versionId: seeded.versionId, chunkId: null, stale: true },
    ]);

    await deleteBase(seeded.baseId);
    await expectStaleReferenceRoundtrip(archive, seeded.chunkId);
  });

  it('删除被 Wiki 引用的整篇文档后导出再导入：历史引用显式失效仍可恢复', async () => {
    const seeded = await seedReferencedWiki();
    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/documents/${seeded.documentId}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json<{ wikiPagesMarkedStale: number }>().wikiPagesMarkedStale).toBe(1);

    const archive = await exportBase(seeded.baseId);
    const manifest = readManifest(archive);
    expect(manifest.documents).toEqual([]);
    const wiki = manifest.wikiPages[0]!;
    expect(wiki.status).toBe('stale');
    expect(wiki.versions[0]!.sourceChunkIds).toEqual([]);
    expect(wiki.versions[0]!.unresolvedSourceChunkIds).toEqual([seeded.chunkId]);

    await deleteBase(seeded.baseId);
    await expectStaleReferenceRoundtrip(archive, seeded.chunkId);
  });

  it('未声明的失效引用仍被拒绝：sourceChunkIds 指向包外 chunk 时导入失败', async () => {
    const seeded = await seedReferencedWiki();
    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/chunks/${seeded.chunkId}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const archive = await exportBase(seeded.baseId);

    // 把失效 id 挪回有效列表：导入端必须拒绝，不能接受「无声丢失」的伪造引用。
    const forged = rewriteManifest(archive, (manifest) => {
      const version = manifest.wikiPages[0]!.versions[0]!;
      version.sourceChunkIds = version.unresolvedSourceChunkIds ?? [];
      version.unresolvedSourceChunkIds = [];
    });
    await deleteBase(seeded.baseId);
    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, forged);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_INPUT');
  });
});
