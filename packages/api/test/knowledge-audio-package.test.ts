import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  expectProblem,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;
const ASR_KEY = ['unit', 'test', 'key'].join('-');

const MP3 = Buffer.from('fffb9064', 'hex');
const MARKDOWN = '第一段\n\n第二段';
const AUDIO_METADATA = {
  protocol: 'openai_transcriptions',
  profileName: '',
  model: 'whisper-1',
  durationMs: 3500,
  segments: [
    { startOffset: 0, endOffset: 3, timeFromMs: 0, timeToMs: 1250 },
    { startOffset: 5, endOffset: 8, timeFromMs: 1250, timeToMs: 3500 },
  ],
};
const TIME_LOCATORS = [
  { startOffset: 0, endOffset: 3, timeFromMs: 0, timeToMs: 1250 },
  { startOffset: 5, endOffset: 8, timeFromMs: 1250, timeToMs: 3500 },
];

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ManifestVersion {
  id: string;
  version: number;
  originalPath: string;
  markdownPath: string | null;
  sizeBytes: number;
  blobSha256: string;
  mimeType: string;
  metadata: Record<string, unknown>;
  chunks: Array<{ id: string; locator: Record<string, unknown> | null }>;
}

interface Manifest {
  format: string;
  version: number;
  base: {
    slug: string;
    embeddingProfileName: string;
    rerankProfileName: string | null;
    asrProfileName: string | null;
    asrProfile: { protocol: string; model: string } | null;
  };
  documents: Array<{
    id: string;
    currentVersionId: string | null;
    versions: ManifestVersion[];
    pending: { originalPath: string; sizeBytes: number; blobSha256: string } | null;
  }>;
  files: Array<{ path: string; sha256: string; size: number }>;
}

function readManifest(buffer: Buffer): Manifest {
  const raw = unzipSync(new Uint8Array(buffer))['manifest.json'];
  if (!raw) throw new Error('manifest.json missing');
  return JSON.parse(Buffer.from(raw).toString('utf8')) as Manifest;
}

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

function replaceOriginal(
  manifest: Manifest,
  files: Record<string, Uint8Array>,
  version: ManifestVersion,
  replacement: Buffer,
): void {
  files[version.originalPath] = replacement;
  const entry = manifest.files.find((file) => file.path === version.originalPath)!;
  entry.size = replacement.length;
  entry.sha256 = sha256(replacement);
  version.sizeBytes = replacement.length;
  version.blobSha256 = sha256(replacement);
}

let app: FastifyInstance;
let cookie = '';
let knowledgeDir = '';
let embeddingProfileId = '';
let asrProfileId = '';
let asrProfileName = '';
let exported = Buffer.alloc(0);
let exportedManifest: Manifest;
const profileIds: string[] = [];
const baseIds: string[] = [];

beforeAll(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-audio-package-'));
  app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
  cookie = await loginCookie(app);

  const embedding = await inject(app, {
    method: 'POST',
    url: '/api/knowledge/model-profiles',
    headers: { cookie },
    payload: {
      kind: 'embedding',
      name: unique('audio-emb'),
      endpointUrl: 'http://127.0.0.1:1/embeddings',
      model: 'test-embedding',
    },
  });
  expect(embedding.statusCode, embedding.body).toBe(201);
  embeddingProfileId = embedding.json<{ id: string }>().id;
  profileIds.push(embeddingProfileId);

  const asr = await inject(app, {
    method: 'POST',
    url: '/api/knowledge/model-profiles',
    headers: { cookie },
    payload: {
      kind: 'asr',
      name: unique('audio-asr'),
      endpointUrl: 'http://127.0.0.1:1/audio/transcriptions',
      model: 'whisper-1',
      apiKey: ASR_KEY,
    },
  });
  expect(asr.statusCode, asr.body).toBe(201);
  asrProfileId = asr.json<{ id: string }>().id;
  asrProfileName = asr.json<{ name: string }>().name;
  profileIds.push(asrProfileId);
  AUDIO_METADATA.profileName = asrProfileName;

  const baseId = await seedAudioLibrary();
  exported = await exportPackage(baseId);
  exportedManifest = readManifest(exported);
  await deleteBaseBySlug(exportedManifest.base.slug);
});

afterEach(async () => {
  if (exportedManifest) await deleteBaseBySlug(exportedManifest.base.slug);
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

async function createBase(): Promise<string> {
  const res = await inject(app, {
    method: 'POST',
    url: '/api/knowledge/bases',
    headers: { cookie },
    payload: {
      slug: unique('audio-pkg'),
      name: '音频打包库',
      embeddingProfileId,
      asrProfileId,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const baseId = res.json<{ id: string }>().id;
  baseIds.push(baseId);
  return baseId;
}

async function seedAudioLibrary(): Promise<string> {
  const baseId = await createBase();
  const upload = await inject(app, {
    method: 'PUT',
    url: `/api/knowledge/bases/${baseId}/documents/upload`,
    headers: { cookie },
    payload: {
      filename: 'clip.mp3',
      mimeType: 'audio/mpeg',
      dataBase64: MP3.toString('base64'),
    },
  });
  expect(upload.statusCode, upload.body).toBe(202);
  const documentId = upload.json<{ documentId: string }>().documentId;

  const versionId = `kdv_${randomUUID().replace(/-/g, '')}`;
  const versionDir = join(knowledgeDir, 'docs', documentId, versionId);
  await mkdir(versionDir, { recursive: true });
  await writeFile(join(versionDir, 'markdown.md'), MARKDOWN, 'utf8');
  await app.pool.query(
    `insert into knowledge_document_versions
       (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
        size_bytes, parse_status, page_map, images, embedding_profile_id, metadata)
     values ($1, $2, 1, $3, $4, 'clip.mp3', 'audio/mpeg', $5, 'parsed', '[]', '[]', $6, $7)`,
    [
      versionId,
      documentId,
      sha256(MP3),
      sha256(Buffer.from(MARKDOWN, 'utf8')),
      MP3.length,
      embeddingProfileId,
      JSON.stringify({ audio: AUDIO_METADATA }),
    ],
  );
  for (const [ordinal, locator] of TIME_LOCATORS.entries()) {
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, heading, content, search_text,
          enabled, edited_by_user, page_from, page_to, locator, token_count, metadata)
       values ($1, $2, $3, $4, $5, 'text', null, $6, $7, true, false, null, null, $8, 4, '{}')`,
      [
        `kchk_${randomUUID().replace(/-/g, '')}`,
        baseId,
        documentId,
        versionId,
        ordinal,
        ordinal === 0 ? '第一段' : '第二段',
        ordinal === 0 ? '第一段' : '第二段',
        JSON.stringify(locator),
      ],
    );
  }
  await app.pool.query(
    "update knowledge_documents set status = 'ready', current_version_id = $2 where id = $1",
    [documentId, versionId],
  );
  return baseId;
}

async function exportPackage(baseId: string): Promise<Buffer> {
  const res = await injectZip(app, 'GET', `/api/knowledge/bases/${baseId}/export`, cookie);
  expect(res.statusCode, res.body).toBe(200);
  return res.rawPayload;
}

async function importPackage(archive: Buffer) {
  return injectZip(app, 'POST', '/api/knowledge/bases/import', cookie, archive);
}

async function deleteBaseBySlug(slug: string): Promise<void> {
  const rows = await app.pool.query<{ id: string; server_id: string }>(
    'select id, server_id from knowledge_bases where slug = $1',
    [slug],
  );
  if (rows.rows.length === 0) return;
  await app.pool.query('delete from knowledge_bases where slug = $1', [slug]);
  await app.pool.query('delete from servers where id = any($1::text[])', [
    rows.rows.map((row) => row.server_id),
  ]);
}

async function baseCountBySlug(slug: string): Promise<number> {
  const rows = await app.pool.query<{ count: number }>(
    'select count(*)::int as count from knowledge_bases where slug = $1',
    [slug],
  );
  return rows.rows[0]!.count;
}

describe.skipIf(!ready)('knowledge package audio roundtrip', () => {
  it('导出只含可移植 ASR 绑定与真实时码，导入按 (kind,name,model) 重新绑定', async () => {
    const manifest = readManifest(exported);
    expect(manifest.base.asrProfileName).toBe(asrProfileName);
    expect(manifest.base.asrProfile).toEqual({
      protocol: 'openai_transcriptions',
      model: 'whisper-1',
    });
    const raw = JSON.stringify(manifest);
    expect(raw).not.toContain(ASR_KEY);
    expect(raw).not.toContain('http://127.0.0.1:1/audio/transcriptions');
    expect(raw).not.toContain(asrProfileId);

    const version = manifest.documents[0]!.versions[0]!;
    expect(version.metadata.audio).toMatchObject({
      profileName: asrProfileName,
      model: 'whisper-1',
    });
    expect(version.chunks.map((chunk) => chunk.locator)).toEqual(TIME_LOCATORS);

    const imported = await importPackage(exported);
    expect(imported.statusCode, imported.body).toBe(201);
    const { baseId } = imported.json<{ baseId: string }>();

    const base = await app.pool.query<{ asrProfileId: string | null }>(
      'select asr_profile_id as "asrProfileId" from knowledge_bases where id = $1',
      [baseId],
    );
    expect(base.rows[0]!.asrProfileId).toBe(asrProfileId);

    const versions = await app.pool.query<{
      id: string;
      metadata: Record<string, unknown>;
      mimeType: string;
    }>(
      `select id, metadata, mime_type as "mimeType" from knowledge_document_versions
       where document_id in (select id from knowledge_documents where base_id = $1)`,
      [baseId],
    );
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]!.metadata.audio).toEqual(AUDIO_METADATA);
    expect(versions.rows[0]!.mimeType).toBe('audio/mpeg');

    const chunks = await app.pool.query<{ locator: Record<string, unknown>; embedding: unknown }>(
      'select locator, embedding from knowledge_chunks where version_id = $1 order by ordinal',
      [versions.rows[0]!.id],
    );
    expect(chunks.rows.map((chunk) => chunk.locator)).toEqual(TIME_LOCATORS);
    expect(chunks.rows.every((chunk) => chunk.embedding === null)).toBe(true);

    const content = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/versions/${versions.rows[0]!.id}/content`,
      headers: { cookie },
    });
    expect(content.statusCode, content.body).toBe(200);
    expect(content.headers['content-type']).toBe('audio/mpeg');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.rawPayload.equals(MP3)).toBe(true);

    const jobs = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from knowledge_jobs where base_id = $1',
      [baseId],
    );
    expect(jobs.rows[0]!.count).toBe(0);
  });

  it('FORM 开头的 Markdown 原件不误判为音频，导出导入保留原件与正文', async () => {
    const baseId = await createBase();
    const original = Buffer.from('FORM is important\n');
    const markdown = '正文第一段\n\nFORM 只是正文里的普通文字';
    const upload = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/bases/${baseId}/documents/upload`,
      headers: { cookie },
      payload: {
        filename: 'notes.md',
        mimeType: 'text/markdown',
        dataBase64: original.toString('base64'),
      },
    });
    expect(upload.statusCode, upload.body).toBe(202);
    const documentId = upload.json<{ documentId: string }>().documentId;

    const versionId = `kdv_${randomUUID().replace(/-/g, '')}`;
    const versionDir = join(knowledgeDir, 'docs', documentId, versionId);
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, 'markdown.md'), markdown, 'utf8');
    await app.pool.query(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id, metadata)
       values ($1, $2, 1, $3, $4, 'notes.md', 'text/markdown', $5, 'parsed', '[]', '[]', $6, '{}')`,
      [
        versionId,
        documentId,
        sha256(original),
        sha256(Buffer.from(markdown, 'utf8')),
        original.length,
        embeddingProfileId,
      ],
    );
    await app.pool.query(
      "update knowledge_documents set status = 'ready', current_version_id = $2 where id = $1",
      [documentId, versionId],
    );

    const archive = await exportPackage(baseId);
    const manifest = readManifest(archive);
    await deleteBaseBySlug(manifest.base.slug);
    const imported = await importPackage(archive);
    expect(imported.statusCode, imported.body).toBe(201);
    const importedBaseId = imported.json<{ baseId: string }>().baseId;
    try {
      const version = await app.pool.query<{ id: string; metadata: Record<string, unknown> }>(
        `select v.id, v.metadata from knowledge_document_versions v
         join knowledge_documents d on d.id = v.document_id where d.base_id = $1`,
        [importedBaseId],
      );
      expect(version.rows).toHaveLength(1);
      expect(version.rows[0]!.metadata.audio).toBeUndefined();

      const content = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/versions/${version.rows[0]!.id}/content`,
        headers: { cookie },
      });
      expect(content.statusCode, content.body).toBe(200);
      expect(content.rawPayload.equals(original)).toBe(true);

      const body = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/versions/${version.rows[0]!.id}/markdown`,
        headers: { cookie },
      });
      expect(body.statusCode, body.body).toBe(200);
      expect(body.body).toBe(markdown);
    } finally {
      await deleteBaseBySlug(manifest.base.slug);
    }
  });

  it('复制的版本保留 metadata.audio 与原始时码 locator', async () => {
    const imported = await importPackage(exported);
    expect(imported.statusCode, imported.body).toBe(201);
    const { baseId } = imported.json<{ baseId: string }>();
    const document = await app.pool.query<{ id: string }>(
      'select id from knowledge_documents where base_id = $1',
      [baseId],
    );
    const copy = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [document.rows[0]!.id], action: 'copy' },
    });
    expect(copy.statusCode, copy.body).toBe(200);
    const result = copy.json<{ results: Array<{ status: string; newDocumentId?: string }> }>();
    expect(result.results[0]?.status).toBe('succeeded');
    const newDocumentId = result.results[0]!.newDocumentId!;

    const version = await app.pool.query<{ id: string; metadata: Record<string, unknown> }>(
      `select v.id, v.metadata from knowledge_document_versions v
       join knowledge_documents d on d.current_version_id = v.id
       where d.id = $1`,
      [newDocumentId],
    );
    expect(version.rows[0]!.metadata.audio).toEqual(AUDIO_METADATA);
    const chunks = await app.pool.query<{ locator: Record<string, unknown> }>(
      'select locator from knowledge_chunks where version_id = $1 order by ordinal',
      [version.rows[0]!.id],
    );
    expect(chunks.rows.map((chunk) => chunk.locator)).toEqual(TIME_LOCATORS);
  });

  it('人工派生版清空 segment map，回退到音频原版时 metadata 与时码仍在', async () => {
    const imported = await importPackage(exported);
    expect(imported.statusCode, imported.body).toBe(201);
    const { baseId } = imported.json<{ baseId: string }>();
    const document = await app.pool.query<{ id: string; currentVersionId: string }>(
      'select id, current_version_id as "currentVersionId" from knowledge_documents where base_id = $1',
      [baseId],
    );
    const documentId = document.rows[0]!.id;
    const originalVersionId = document.rows[0]!.currentVersionId;
    const chunk = await app.pool.query<{ id: string }>(
      'select id from knowledge_chunks where version_id = $1 order by ordinal limit 1',
      [originalVersionId],
    );

    const edited = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/chunks/${chunk.rows[0]!.id}`,
      headers: { cookie },
      payload: { expectedVersionId: originalVersionId, content: '修改后的第一段' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const manualVersionId = edited.json<{ document: { currentVersionId: string } }>().document
      .currentVersionId;
    expect(manualVersionId).not.toBe(originalVersionId);
    const manual = await app.pool.query<{ metadata: Record<string, unknown> }>(
      'select metadata from knowledge_document_versions where id = $1',
      [manualVersionId],
    );
    expect(manual.rows[0]!.metadata.audio).toEqual({ ...AUDIO_METADATA, segments: [] });

    const rolledBack = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${documentId}/rollback`,
      headers: { cookie },
      payload: { versionId: originalVersionId, expectedVersionId: manualVersionId },
    });
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);
    const restored = await app.pool.query<{ metadata: Record<string, unknown> }>(
      'select metadata from knowledge_document_versions where id = $1',
      [originalVersionId],
    );
    expect(restored.rows[0]!.metadata.audio).toEqual(AUDIO_METADATA);
    const chunks = await app.pool.query<{ locator: Record<string, unknown> }>(
      'select locator from knowledge_chunks where version_id = $1 order by ordinal',
      [originalVersionId],
    );
    expect(chunks.rows.map((row) => row.locator)).toEqual(TIME_LOCATORS);
  });

  it('缺少启用 ASR profile 或模型不符时整包 409，不落库', async () => {
    const missing = rewritePackage(exported, (manifest) => {
      manifest.base.asrProfileName = unique('missing-asr');
    });
    const missingRes = await importPackage(missing);
    expect(missingRes.statusCode, missingRes.body).toBe(409);
    expectProblem(missingRes, 'CONFLICT');
    expect(await baseCountBySlug(exportedManifest.base.slug)).toBe(0);

    const mismatch = rewritePackage(exported, (manifest) => {
      manifest.base.asrProfile!.model = 'another-model';
    });
    const mismatchRes = await importPackage(mismatch);
    expect(mismatchRes.statusCode, mismatchRes.body).toBe(409);
    expectProblem(mismatchRes, 'CONFLICT');
    expect(await baseCountBySlug(exportedManifest.base.slug)).toBe(0);

    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/model-profiles/${asrProfileId}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    try {
      const disabledRes = await importPackage(exported);
      expect(disabledRes.statusCode, disabledRes.body).toBe(409);
      expect(await baseCountBySlug(exportedManifest.base.slug)).toBe(0);
    } finally {
      await app.pool.query('update knowledge_model_profiles set enabled = true where id = $1', [
        asrProfileId,
      ]);
    }
  });

  it('ASR 绑定关闭时历史音频仍可导回并保留正文/时码，不触发转录', async () => {
    const detached = rewritePackage(exported, (manifest) => {
      manifest.base.asrProfileName = null;
      manifest.base.asrProfile = null;
    });
    const imported = await importPackage(detached);
    expect(imported.statusCode, imported.body).toBe(201);
    const { baseId } = imported.json<{ baseId: string }>();
    const base = await app.pool.query<{ asrProfileId: string | null }>(
      'select asr_profile_id as "asrProfileId" from knowledge_bases where id = $1',
      [baseId],
    );
    expect(base.rows[0]!.asrProfileId).toBeNull();

    const version = await app.pool.query<{ id: string; metadata: Record<string, unknown> }>(
      `select v.id, v.metadata from knowledge_document_versions v
       join knowledge_documents d on d.id = v.document_id where d.base_id = $1`,
      [baseId],
    );
    expect(version.rows[0]!.metadata.audio).toEqual(AUDIO_METADATA);
    const chunks = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from knowledge_chunks where version_id = $1',
      [version.rows[0]!.id],
    );
    expect(chunks.rows[0]!.count).toBe(2);
    const jobs = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from knowledge_jobs where base_id = $1',
      [baseId],
    );
    expect(jobs.rows[0]!.count).toBe(0);
  });

  it('metadata.audio 偏移越界或重叠时拒绝导入', async () => {
    for (const mutate of [
      (segment: { endOffset: number }) => {
        segment.endOffset = MARKDOWN.length + 10;
      },
      (segment: { startOffset: number }) => {
        segment.startOffset = 0;
      },
    ]) {
      const invalid = rewritePackage(exported, (manifest) => {
        const audio = manifest.documents[0]!.versions[0]!.metadata.audio as {
          segments: Array<{ startOffset: number; endOffset: number }>;
        };
        mutate(audio.segments[1]!);
      });
      const res = await importPackage(invalid);
      expect(res.statusCode, res.body).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
      expect(await baseCountBySlug(exportedManifest.base.slug)).toBe(0);
    }
  });

  it('伪装音频与超过 25 MB 的原件分别按真实字节拒绝', async () => {
    const fake = rewritePackage(exported, (manifest, files) => {
      replaceOriginal(
        manifest,
        files,
        manifest.documents[0]!.versions[0]!,
        Buffer.from('plain text', 'utf8'),
      );
    });
    const fakeRes = await importPackage(fake);
    expect(fakeRes.statusCode, fakeRes.body).toBe(415);
    expectProblem(fakeRes, 'UNSUPPORTED_MEDIA_TYPE');
    expect(await baseCountBySlug(exportedManifest.base.slug)).toBe(0);

    const oversized = Buffer.alloc(25_000_001);
    MP3.copy(oversized);
    const huge = rewritePackage(exported, (manifest, files) => {
      replaceOriginal(manifest, files, manifest.documents[0]!.versions[0]!, oversized);
    });
    const hugeRes = await importPackage(huge);
    expect(hugeRes.statusCode, hugeRes.body).toBe(413);
    expectProblem(hugeRes, 'PAYLOAD_TOO_LARGE');
    expect(await baseCountBySlug(exportedManifest.base.slug)).toBe(0);
  });

  it('pending 音频按待处理语义导回，不自动创建转录任务', async () => {
    const baseId = await createBase();
    const upload = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/bases/${baseId}/documents/upload`,
      headers: { cookie },
      payload: {
        filename: 'pending.mp3',
        mimeType: 'audio/mpeg',
        dataBase64: MP3.toString('base64'),
      },
    });
    expect(upload.statusCode, upload.body).toBe(202);
    const archive = await exportPackage(baseId);
    const manifest = readManifest(archive);
    expect(manifest.documents[0]!.pending).not.toBeNull();
    expect(manifest.documents[0]!.versions).toHaveLength(0);
    await deleteBaseBySlug(manifest.base.slug);

    const imported = await importPackage(archive);
    expect(imported.statusCode, imported.body).toBe(201);
    const { baseId: importedBaseId } = imported.json<{ baseId: string }>();
    const document = await app.pool.query<{
      status: string;
      currentVersionId: string | null;
      mimeType: string;
    }>(
      `select status, current_version_id as "currentVersionId", mime_type as "mimeType"
       from knowledge_documents where base_id = $1`,
      [importedBaseId],
    );
    expect(document.rows[0]).toMatchObject({
      status: 'pending',
      currentVersionId: null,
      mimeType: 'audio/mpeg',
    });
    const jobs = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from knowledge_jobs where base_id = $1',
      [importedBaseId],
    );
    expect(jobs.rows[0]!.count).toBe(0);
    await deleteBaseBySlug(manifest.base.slug);
  });
});
