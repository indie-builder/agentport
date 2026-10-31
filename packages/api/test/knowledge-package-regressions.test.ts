import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '@agentport/core';
import type { FastifyInstance } from 'fastify';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { assertPackageCapacity } from '../src/features/knowledge/package.js';
import { infraReady, inject, injectZip, loginCookie, testConfig, unique } from './helpers.js';

const ready = await infraReady;

const SIGNATURE_EOCD = 0x06054b50;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function eocdOffset(archive: Buffer): number {
  const offset = archive.length - 22;
  if (archive.readUInt32LE(offset) !== SIGNATURE_EOCD) {
    throw new Error('fixture is not a ZIP without comment');
  }
  return offset;
}

function centralOffset(archive: Buffer): number {
  return archive.readUInt32LE(eocdOffset(archive) + 16);
}

function appErrorOf(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected AppError');
}

describe('knowledge package capacity preflight', () => {
  it('拒绝超过条目数/单条/总量的条目组，错误码为 CONFLICT', () => {
    const limits = { maxEntries: 2, maxEntryBytes: 5, maxUncompressedBytes: 9 };
    const tooMany = appErrorOf(() =>
      assertPackageCapacity(
        { a: new Uint8Array(1), b: new Uint8Array(1), c: new Uint8Array(1) },
        limits,
      ),
    );
    expect(tooMany.code).toBe('CONFLICT');
    expect(tooMany.message).toContain('条目数');

    const tooLarge = appErrorOf(() => assertPackageCapacity({ a: new Uint8Array(6) }, limits));
    expect(tooLarge.code).toBe('CONFLICT');
    expect(tooLarge.message).toContain('超过 5 字节');

    const tooTotal = appErrorOf(() =>
      assertPackageCapacity({ a: new Uint8Array(5), b: new Uint8Array(5) }, limits),
    );
    expect(tooTotal.code).toBe('CONFLICT');
    expect(tooTotal.message).toContain('总大小');
  });
});

describe.skipIf(!ready)('knowledge package regressions', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  let profileId = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  const readManifest = (archive: Buffer): Record<string, unknown> => {
    const raw = unzipSync(new Uint8Array(archive))['manifest.json'];
    if (!raw) throw new Error('manifest.json missing');
    return JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
  };

  async function createProfile(): Promise<{ id: string; name: string }> {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('pkg-reg-emb'),
        endpointUrl: 'http://127.0.0.1:1/embeddings',
        model: 'test-model',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const profile = res.json<{ id: string; name: string }>();
    profileIds.push(profile.id);
    return profile;
  }

  async function createBase(): Promise<string> {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('pkg-reg-kb'), name: '回归知识库', embeddingProfileId: profileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const base = res.json<{ id: string }>();
    baseIds.push(base.id);
    return base.id;
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

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-package-regressions-'));
    app = await buildApp(testConfig({ KNOWLEDGE_DIR: knowledgeDir }));
    await app.ready();
    cookie = await loginCookie(app);
    const profile = await createProfile();
    profileId = profile.id;
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

  it('中央目录低报 deflate 原大小时拒绝导入，不静默截断成空 manifest', async () => {
    const encoder = new TextEncoder();
    const archive = Buffer.from(
      zipSync({ 'manifest.json': encoder.encode('x'.repeat(20_000)) }, { level: 6 }),
    );
    // 真实解压 20000 字节，中央目录改成 19998：fflate 会按声明长度截断。
    archive.writeUInt32LE(19_998, centralOffset(archive) + 24);

    const before = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_bases where embedding_profile_id = $1',
      [profileId],
    );
    const res = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, archive);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_INPUT');
    const after = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_bases where embedding_profile_id = $1',
      [profileId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('无版本的 manual 草稿（排队/失败）随包保存原件与 pending，导入不改写成 ready', async () => {
    const targetBaseId = await createBase();
    const content = '# 未发布草稿\n\n这段正文还没有被解析成版本。\n';
    const bytes = Buffer.from(content, 'utf8');
    const created = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${targetBaseId}/documents/manual`,
      headers: { cookie },
      payload: { title: '未发布草稿', content, tags: [] },
    });
    expect(created.statusCode, created.body).toBe(202);
    const documentId = created.json<{ documentId: string }>().documentId;
    // 模拟排队后失败：没有版本，只有 original blob 与 contentHash。
    await app.pool.query("update knowledge_documents set status = 'failed' where id = $1", [
      documentId,
    ]);

    const archive = await exportBase(targetBaseId);
    const manifest = readManifest(archive);
    const exported = (manifest.documents as Array<Record<string, unknown>>)[0]!;
    expect(exported.versions).toEqual([]);
    expect(exported.pending).toMatchObject({
      originalFilename: '未发布草稿.md',
      mimeType: 'text/markdown',
      sizeBytes: bytes.length,
      blobSha256: sha256(bytes),
    });
    const pending = exported.pending as { originalPath: string };
    const files = unzipSync(new Uint8Array(archive));
    expect(Buffer.from(files[pending.originalPath]!)).toEqual(bytes);
    // 运行态批次身份不进入包。
    expect(archive.includes('faqImportJobId')).toBe(false);
    expect(archive.includes('faqImport')).toBe(false);

    await deleteBase(targetBaseId);
    const imported = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, archive);
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{
      baseId: string;
      counts: { documents: number; versions: number; chunks: number };
    }>();
    baseIds.push(result.baseId);
    expect(result.counts).toMatchObject({ documents: 1, versions: 0, chunks: 0 });

    const documentRows = await app.pool.query<{
      id: string;
      status: string;
      size_bytes: string;
      content_hash: string | null;
      current_version_id: string | null;
      metadata: { originalFilename?: string };
    }>(
      'select id, status, size_bytes, content_hash, current_version_id, metadata from knowledge_documents where base_id = $1',
      [result.baseId],
    );
    expect(documentRows.rows).toHaveLength(1);
    const row = documentRows.rows[0]!;
    expect(row.status).toBe('pending');
    expect(Number(row.size_bytes)).toBe(bytes.length);
    expect(row.content_hash).toBe(sha256(bytes));
    expect(row.current_version_id).toBeNull();
    expect(row.metadata.originalFilename).toBe('未发布草稿.md');

    const restored = await readFile(
      join(knowledgeDir, 'blobs', sha256(bytes).slice(0, 2), sha256(bytes)),
    );
    expect(restored).toEqual(bytes);
    const versions = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_document_versions where document_id = $1',
      [row.id],
    );
    expect(versions.rows[0]?.count).toBe('0');
    const chunks = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_chunks where document_id = $1',
      [row.id],
    );
    expect(chunks.rows[0]?.count).toBe('0');
  });

  it('Wiki 内部索引仍按派生态跳过，不因无版本把整库导出变成 409', async () => {
    const targetBaseId = await createBase();
    await app.pool.query(
      `insert into knowledge_documents
         (id, base_id, title, source_type, content_kind, mime_type, size_bytes, status, metadata)
       values ($1, $2, '内部索引', 'manual', 'wiki', 'text/markdown', 0, 'pending', '{}')`,
      [`kdoc_${sha256(Buffer.from(targetBaseId)).slice(0, 26)}`, targetBaseId],
    );

    const archive = await exportBase(targetBaseId);
    expect(readManifest(archive).documents).toEqual([]);
  });

  it('删除再导回后 Wiki [[slug]] 链接仍指向导入后的页面', async () => {
    const targetBaseId = await createBase();
    const alphaSlug = unique('alpha');
    const betaSlug = unique('beta');
    const create = async (slug: string, title: string): Promise<string> => {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${targetBaseId}/wiki-pages`,
        headers: { cookie },
        payload: { slug, title },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    };
    const alphaId = await create(alphaSlug, 'Alpha');
    const betaId = await create(betaSlug, 'Beta');
    for (const [pageId, markdown] of [
      [alphaId, `# Alpha\n\n见 [[${betaSlug}|Beta]]。`],
      [betaId, '# Beta\n\n被引用的页面。'],
    ] as const) {
      const patched = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/wiki-pages/${pageId}`,
        headers: { cookie },
        payload: { markdown },
      });
      expect(patched.statusCode, patched.body).toBe(200);
    }

    const archive = await exportBase(targetBaseId);
    await deleteBase(targetBaseId);
    const imported = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, archive);
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{ baseId: string }>();
    baseIds.push(result.baseId);

    const pages = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${result.baseId}/wiki-pages`,
      headers: { cookie },
    });
    const bySlug = new Map(
      pages
        .json<{ items: Array<{ id: string; slug: string }> }>()
        .items.map((page) => [page.slug, page.id]),
    );
    const importedAlphaId = bySlug.get(alphaSlug)!;
    const importedBetaId = bySlug.get(betaSlug)!;
    expect(importedAlphaId).not.toBe(alphaId);

    const links = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${importedAlphaId}/links`,
      headers: { cookie },
    });
    expect(links.statusCode, links.body).toBe(200);
    expect(
      links.json<{ outgoing: Array<{ targetPageId: string | null; anchor: string | null }> }>(),
    ).toEqual({
      outgoing: [{ targetPageId: importedBetaId, anchor: null }],
      incoming: [],
    });
  });

  it('草稿版本的 origin/publication 与 unknown sourceConnection 独立导入，批次身份被剥离', async () => {
    const targetBaseId = await createBase();
    const documentId = `kdoc_${sha256(Buffer.from(targetBaseId)).slice(0, 26)}`;
    const publishedVersionId = `kdv_${sha256(Buffer.from('published')).slice(0, 26)}`;
    const draftVersionId = `kdv_${sha256(Buffer.from('draft')).slice(0, 26)}`;
    const original = Buffer.from('# 来源文档\n', 'utf8');
    const blobSha = sha256(original);
    await mkdir(join(knowledgeDir, 'blobs', blobSha.slice(0, 2)), { recursive: true });
    await writeFile(join(knowledgeDir, 'blobs', blobSha.slice(0, 2), blobSha), original);

    await app.pool.query(
      `insert into knowledge_documents
         (id, base_id, title, source_type, source_id, source_connection_id, source_url, mime_type,
          size_bytes, status, content_kind, current_version_id, content_hash, metadata)
       values ($1, $2, '来源文档', 'github', 'repo:readme', 'deleted-source-connection', 'https://example.com/readme',
               'text/markdown', $3, 'ready', 'document', $4, $5, '{"originalFilename":"readme.md"}')`,
      [documentId, targetBaseId, original.length, publishedVersionId, blobSha],
    );
    await app.pool.query(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, origin, metadata, parse_status, page_map, images, embedding_profile_id)
       values
         ($1, $3, 1, $4, $5, 'readme.md', 'text/markdown', $6, 'source', '{}', 'parsed', '[]', '[]', $7),
         ($2, $3, 2, $4, $5, 'readme.md', 'text/markdown', $6, 'manual', $8, 'parsed', '[]', '[]', $7)`,
      [
        publishedVersionId,
        draftVersionId,
        documentId,
        blobSha,
        sha256(Buffer.from('')),
        original.length,
        profileId,
        JSON.stringify({
          publication: 'draft',
          faqImport: { batchId: 'old-batch' },
          faqImportJobId: 'old-job',
          keep: 'yes',
        }),
      ],
    );

    const archive = await exportBase(targetBaseId);
    const manifest = readManifest(archive);
    const exportedDocument = (manifest.documents as Array<Record<string, unknown>>)[0]!;
    const exportedVersions = exportedDocument.versions as Array<Record<string, unknown>>;
    expect(exportedVersions.find((version) => version.origin === 'manual')).toMatchObject({
      metadata: { publication: 'draft', keep: 'yes' },
    });
    expect(archive.includes('old-batch')).toBe(false);
    expect(archive.includes('old-job')).toBe(false);

    await deleteBase(targetBaseId);
    const imported = await injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, archive);
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{ baseId: string }>();
    baseIds.push(result.baseId);

    const documents = await app.pool.query<{
      id: string;
      source_type: string;
      source_id: string | null;
      source_connection_id: string | null;
    }>(
      'select id, source_type, source_id, source_connection_id from knowledge_documents where base_id = $1',
      [result.baseId],
    );
    expect(documents.rows[0]).toMatchObject({
      source_type: 'github',
      source_id: 'repo:readme',
      source_connection_id: null,
    });

    const versions = await app.pool.query<{
      version: number;
      origin: string;
      metadata: Record<string, unknown>;
    }>(
      'select version, origin, metadata from knowledge_document_versions where document_id = $1 order by version',
      [documents.rows[0]!.id],
    );
    expect(versions.rows[1]).toMatchObject({
      version: 2,
      origin: 'manual',
      metadata: { publication: 'draft', keep: 'yes' },
    });
    expect(versions.rows[1]!.metadata).not.toHaveProperty('faqImport');
    expect(versions.rows[1]!.metadata).not.toHaveProperty('faqImportJobId');
  });
});
