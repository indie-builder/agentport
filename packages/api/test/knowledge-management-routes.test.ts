import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { newId, repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type FastifyInstance,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('knowledge management routes', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-management-routes-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
  });

  afterEach(async () => {
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
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  async function createBase(): Promise<string> {
    const profile = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('mgmt-emb'),
        endpointUrl: 'http://127.0.0.1:1',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const profileId = profile.json<{ id: string }>().id;
    profileIds.push(profileId);

    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('mgmt-kb'), name: '管理库', embeddingProfileId: profileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  async function writeMarkdown(documentId: string, versionId: string, markdown: string) {
    const dir = join(knowledgeDir, 'docs', documentId, versionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'markdown.md'), markdown, 'utf8');
  }

  async function writeImages(documentId: string, versionId: string, files: Record<string, Buffer>) {
    const dir = join(knowledgeDir, 'docs', documentId, versionId, 'images');
    await mkdir(dir, { recursive: true });
    for (const [name, data] of Object.entries(files)) await writeFile(join(dir, name), data);
  }

  async function writeBlob(data: Buffer): Promise<string> {
    const sha = createHash('sha256').update(data).digest('hex');
    const target = join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return sha;
  }

  async function seedDocument(
    baseId: string,
    options: {
      title?: string;
      contents?: string[];
      origin?: 'source' | 'manual';
      metadata?: Record<string, unknown>;
      sourceType?: 'manual' | 'upload';
      sourceConnectionId?: string | null;
      sourcePath?: string | null;
      images?: Array<{
        name: string;
        sha256: string;
        mimeType: string;
        page: number | null;
        warnings: string[];
      }>;
    } = {},
  ) {
    // 版本 profile 必须与所属库一致，否则发布守卫会拒绝切指针。
    const [baseRow] = (
      await app.pool.query<{ embedding_profile_id: string }>(
        'select embedding_profile_id from knowledge_bases where id = $1',
        [baseId],
      )
    ).rows;
    const profileId = baseRow!.embedding_profile_id;
    const document = await repo.knowledge.createDocument(app.db, {
      baseId,
      folderId: null,
      title: options.title ?? unique('doc'),
      sourceType: options.sourceType ?? 'upload',
      sourceId: null,
      sourceUrl: null,
      sourcePath: options.sourcePath ?? null,
      sourceConnectionId: options.sourceConnectionId ?? null,
      mimeType: 'text/markdown',
      sizeBytes: 1,
    });
    const version = await repo.knowledge.createVersion(app.db, {
      documentId: document.id,
      blobSha256: 'a'.repeat(64),
      markdownSha256: 'b'.repeat(64),
      originalFilename: 'doc.md',
      mimeType: 'text/markdown',
      sizeBytes: 1,
      sourceRevision: null,
      origin: options.origin ?? 'source',
      metadata: options.metadata ?? {},
      parseStatus: 'parsed',
      pageMap: [],
      images: options.images ?? [],
      embeddingProfileId: profileId,
    });
    const contents = options.contents ?? ['第一段', '第二段'];
    await repo.knowledge.insertChunks(app.db, {
      baseId,
      documentId: document.id,
      versionId: version.id,
      folderId: null,
      chunks: contents.map((content, ordinal) => ({
        ordinal,
        kind: 'text',
        heading: null,
        content,
        searchText: content,
        embedding: null,
        pageFrom: 1,
        pageTo: 1,
        tokenCount: 1,
      })),
    });
    await writeMarkdown(document.id, version.id, contents.join('\n\n'));
    await repo.knowledge.setCurrentVersion(app.db, document.id, version.id);
    return { document, version };
  }

  /** 手写草稿要能发布，必须来自同文档已成功的 draft ingest 任务；按 worker 落库顺序造齐关联。 */
  async function seedDraftVersion(input: {
    baseId: string;
    documentId: string;
    content: string;
    parentVersionId: string;
    profileId: string;
  }) {
    const blobSha = 'a'.repeat(64);
    const job = await repo.knowledge.createJob(app.db, {
      type: 'ingest',
      baseId: input.baseId,
      documentId: input.documentId,
      sourceId: null,
      payload: {
        type: 'ingest',
        documentId: input.documentId,
        publish: 'draft',
        input: {
          blobSha256: blobSha,
          filename: 'doc.md',
          mimeType: 'text/markdown',
          expectedCurrentVersionId: input.parentVersionId,
        },
      },
    });
    await app.pool.query(`update knowledge_jobs set status = 'succeeded' where id = $1`, [job.id]);
    const version = await repo.knowledge.createVersion(app.db, {
      documentId: input.documentId,
      blobSha256: blobSha,
      markdownSha256: 'b'.repeat(64),
      originalFilename: 'doc.md',
      mimeType: 'text/markdown',
      sizeBytes: 1,
      sourceRevision: null,
      origin: 'manual',
      parentVersionId: input.parentVersionId,
      metadata: { publication: 'draft', indexingJobId: job.id },
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: input.profileId,
    });
    await writeMarkdown(input.documentId, version.id, input.content);
    return version;
  }

  it('lists versions with origin/parent and rolls back without deleting history', async () => {
    const baseId = await createBase();
    const profileId = profileIds.at(-1)!;
    const seeded = await seedDocument(baseId, { origin: 'manual' });
    const v2 = await repo.knowledge.createVersion(app.db, {
      documentId: seeded.document.id,
      blobSha256: 'a'.repeat(64),
      markdownSha256: 'b'.repeat(64),
      originalFilename: 'doc.md',
      mimeType: 'text/markdown',
      sizeBytes: 1,
      sourceRevision: null,
      origin: 'manual',
      parentVersionId: seeded.version.id,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: profileId,
    });
    await writeMarkdown(seeded.document.id, v2.id, '第二版');
    await repo.knowledge.setCurrentVersion(app.db, seeded.document.id, v2.id);

    const list = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${seeded.document.id}/versions`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json<{
      items: Array<{
        id: string;
        isCurrent: boolean;
        origin: string;
        parentVersionId: string | null;
        createdAt: string;
      }>;
      nextCursor: string | null;
    }>().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: v2.id,
      isCurrent: true,
      origin: 'manual',
      parentVersionId: seeded.version.id,
    });
    expect(typeof items[0]!.createdAt).toBe('string');

    const rollback = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${seeded.document.id}/rollback`,
      headers: { cookie },
      payload: { versionId: seeded.version.id, expectedVersionId: v2.id },
    });
    expect(rollback.statusCode, rollback.body).toBe(200);
    expect(rollback.json()).toMatchObject({ currentVersionId: seeded.version.id });

    const stale = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${seeded.document.id}/rollback`,
      headers: { cookie },
      payload: { versionId: v2.id, expectedVersionId: v2.id },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'CONFLICT_STALE' });

    const other = await seedDocument(baseId);
    const foreign = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${seeded.document.id}/rollback`,
      headers: { cookie },
      payload: { versionId: other.version.id, expectedVersionId: seeded.version.id },
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'NOT_FOUND' });

    const remaining = await app.pool.query<{ count: string }>(
      'select count(*)::text as count from knowledge_document_versions where document_id = $1',
      [seeded.document.id],
    );
    expect(remaining.rows[0]?.count).toBe('2');
  });

  it('chunk add/update/delete create new versions and keep old chunks immutable', async () => {
    const baseId = await createBase();
    const seeded = await seedDocument(baseId, { contents: ['原文一', '原文二'] });
    const oldChunks = await repo.knowledge.listChunks(app.db, seeded.version.id);
    const firstChunk = oldChunks.items[0]!;
    expect(firstChunk.pageFrom).toBe(1);

    const added = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${seeded.document.id}/chunks`,
      headers: { cookie },
      payload: { expectedVersionId: seeded.version.id, content: '新增段' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const addedBody = added.json<{
      document: { currentVersionId: string };
      chunk: { id: string; ordinal: number; editedByUser: boolean; pageFrom: number | null };
      jobId: string | null;
    }>();
    expect(addedBody.document.currentVersionId).not.toBe(seeded.version.id);
    expect(addedBody.chunk.editedByUser).toBe(true);
    expect(addedBody.chunk.pageFrom).toBeNull();
    expect(addedBody.chunk.ordinal).toBe(2);
    expect(addedBody.jobId).toMatch(/^kjob_/);

    const old = await repo.knowledge.listChunks(app.db, seeded.version.id);
    expect(old.items.map((chunk) => chunk.content)).toEqual(['原文一', '原文二']);
    const newVersion = await repo.knowledge.getVersion(app.db, addedBody.document.currentVersionId);
    expect(newVersion).toMatchObject({
      origin: 'manual',
      parentVersionId: seeded.version.id,
    });
    const markdown = await readFile(
      join(
        knowledgeDir,
        'docs',
        seeded.document.id,
        addedBody.document.currentVersionId,
        'markdown.md',
      ),
      'utf8',
    );
    expect(markdown).toContain('新增段');

    const stale = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/chunks/${addedBody.chunk.id}`,
      headers: { cookie },
      payload: { expectedVersionId: seeded.version.id, content: '改正文' },
    });
    expect(stale.statusCode, stale.body).toBe(409);

    const updated = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/chunks/${addedBody.chunk.id}`,
      headers: { cookie },
      payload: {
        expectedVersionId: addedBody.document.currentVersionId,
        content: '人工改写',
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedBody = updated.json<{
      document: { currentVersionId: string };
      chunk: {
        id: string;
        content: string;
        editedByUser: boolean;
        pageFrom: number | null;
        locator: unknown;
        metadata: Record<string, unknown>;
      };
    }>();
    expect(updatedBody.chunk.content).toBe('人工改写');
    expect(updatedBody.chunk.editedByUser).toBe(true);
    expect(updatedBody.chunk.pageFrom).toBeNull();
    expect(updatedBody.chunk.locator).toBeNull();
    expect(updatedBody.chunk.metadata.originalChunkId).toBe(addedBody.chunk.id);

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/chunks/${updatedBody.chunk.id}`,
      headers: { cookie },
      payload: { expectedVersionId: updatedBody.document.currentVersionId },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ chunk: null, jobId: null });
    const afterDelete = await repo.knowledge.listChunkSummaries(
      app.db,
      removed.json<{ document: { currentVersionId: string } }>().document.currentVersionId,
    );
    expect(afterDelete.items.map((chunk) => chunk.content)).toEqual(['原文一', '原文二']);
  });

  it('manual draft stays out of the current pointer until publish', async () => {
    const baseId = await createBase();
    const profileId = profileIds.at(-1)!;
    const created = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/manual`,
      headers: { cookie },
      payload: { title: '手写稿', content: '初始正文' },
    });
    expect(created.statusCode, created.body).toBe(202);
    const documentId = created.json<{ documentId: string }>().documentId;
    const initialJob = await app.pool.query<{ payload: { publish?: string } }>(
      'select payload from knowledge_jobs where id = $1',
      [created.json<{ jobId: string }>().jobId],
    );
    expect(initialJob.rows[0]?.payload.publish).toBe('draft');
    expect(documentId).toMatch(/^kdoc_/);

    const published = await seedDocument(baseId, {
      title: '手写稿',
      contents: ['已发布正文'],
      origin: 'manual',
      sourceType: 'manual',
    });
    const targetId = published.document.id;

    const readPublished = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${targetId}/manual`,
      headers: { cookie },
    });
    expect(readPublished.statusCode, readPublished.body).toBe(200);
    expect(readPublished.json()).toMatchObject({
      status: 'published',
      versionId: published.version.id,
      content: '已发布正文',
    });

    const draft = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/documents/${targetId}/manual`,
      headers: { cookie },
      payload: { content: '草稿正文', expectedVersionId: published.version.id },
    });
    expect(draft.statusCode, draft.body).toBe(202);
    const draftJob = await app.pool.query<{ payload: { publish?: string } }>(
      'select payload from knowledge_jobs where id = $1',
      [draft.json<{ jobId: string }>().jobId],
    );
    expect(draftJob.rows[0]?.payload.publish).toBe('draft');

    const draftVersion = await seedDraftVersion({
      baseId,
      documentId: targetId,
      content: '草稿正文',
      parentVersionId: published.version.id,
      profileId,
    });

    const readDraft = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${targetId}/manual`,
      headers: { cookie },
    });
    expect(readDraft.statusCode, readDraft.body).toBe(200);
    expect(readDraft.json()).toMatchObject({
      status: 'draft',
      versionId: draftVersion.id,
      content: '草稿正文',
    });

    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${targetId}/publish`,
      headers: { cookie },
      payload: { versionId: draftVersion.id, expectedVersionId: published.version.id },
    });
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.json()).toMatchObject({
      currentVersionId: draftVersion.id,
      status: 'ready',
    });

    const afterPublish = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${targetId}/manual`,
      headers: { cookie },
    });
    expect(afterPublish.json()).toMatchObject({
      status: 'published',
      versionId: draftVersion.id,
    });
  });

  it('rejects a manual save based on the published version once a newer draft exists', async () => {
    const baseId = await createBase();
    const profileId = profileIds.at(-1)!;
    const published = await seedDocument(baseId, {
      title: '旧窗口草稿',
      contents: ['已发布正文'],
      origin: 'manual',
      sourceType: 'manual',
    });
    const documentId = published.document.id;

    // 窗口 A 打开编辑器时读到线上版本 P。
    const readByA = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
    });
    expect(readByA.statusCode, readByA.body).toBe(200);
    const baseVersionId = readByA.json<{ versionId: string }>().versionId;
    expect(readByA.json()).toMatchObject({
      status: 'published',
      versionId: published.version.id,
      content: '已发布正文',
    });

    // 窗口 B 基于同一版本保存，真实摄取任务成功产出草稿 D。
    const savedByB = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
      payload: { content: '草稿正文', expectedVersionId: baseVersionId },
    });
    expect(savedByB.statusCode, savedByB.body).toBe(202);
    const draft = await seedDraftVersion({
      baseId,
      documentId,
      content: '草稿正文',
      parentVersionId: baseVersionId,
      profileId,
    });

    // 窗口 A 仍持有旧读，基于 P 再保存不得覆盖 D，也不得新增任务或版本。
    const jobsBefore = await app.pool.query<{ count: string }>(
      'select count(*)::text as count from knowledge_jobs where document_id = $1',
      [documentId],
    );
    const staleSave = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
      payload: { content: '旧窗口覆盖稿', expectedVersionId: baseVersionId },
    });
    expect(staleSave.statusCode, staleSave.body).toBe(409);
    expect(staleSave.json()).toMatchObject({ code: 'CONFLICT_STALE' });

    const jobsAfter = await app.pool.query<{ count: string }>(
      'select count(*)::text as count from knowledge_jobs where document_id = $1',
      [documentId],
    );
    expect(jobsAfter.rows[0]?.count).toBe(jobsBefore.rows[0]?.count);
    const versionsAfter = await app.pool.query<{ count: string }>(
      'select count(*)::text as count from knowledge_document_versions where document_id = $1',
      [documentId],
    );
    expect(versionsAfter.rows[0]?.count).toBe('2');
    const currentAfter = await app.pool.query<{ current_version_id: string }>(
      'select current_version_id from knowledge_documents where id = $1',
      [documentId],
    );
    expect(currentAfter.rows[0]?.current_version_id).toBe(baseVersionId);

    const readAfterStale = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
    });
    expect(readAfterStale.statusCode, readAfterStale.body).toBe(200);
    expect(readAfterStale.json()).toMatchObject({
      status: 'draft',
      versionId: draft.id,
      content: '草稿正文',
    });

    // 基于编辑器当前拿到的草稿 D 继续保存仍可入队。
    const savedByDraft = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
      payload: { content: '草稿续写', expectedVersionId: draft.id },
    });
    expect(savedByDraft.statusCode, savedByDraft.body).toBe(202);
  });

  it('batch operations report per-item results including foreign and missing docs', async () => {
    const baseId = await createBase();
    const otherBaseId = await createBase();
    const first = await seedDocument(baseId, { title: '一' });
    const second = await seedDocument(baseId, { title: '二' });
    const foreign = await seedDocument(otherBaseId, { title: '外' });

    const tagged = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: {
        documentIds: [first.document.id, foreign.document.id, 'kdoc_missing'],
        action: 'tag',
        tags: ['批量'],
        tagMode: 'add',
      },
    });
    expect(tagged.statusCode, tagged.body).toBe(200);
    const tagResults = tagged.json<{
      results: Array<{ documentId: string; status: string; code?: string }>;
    }>().results;
    expect(tagResults.map((result) => result.status)).toEqual(['succeeded', 'failed', 'failed']);
    expect(tagResults[1]?.code).toBe('INVALID_INPUT');
    expect(tagResults[2]?.code).toBe('NOT_FOUND');

    const copied = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [first.document.id], action: 'copy' },
    });
    const newDocumentId = copied.json<{ results: Array<{ newDocumentId: string }> }>().results[0]!
      .newDocumentId;
    const copyRow = await app.pool.query<{
      source_type: string;
      source_connection_id: string | null;
      title: string;
    }>('select source_type, source_connection_id, title from knowledge_documents where id = $1', [
      newDocumentId,
    ]);
    expect(copyRow.rows[0], copied.body).toMatchObject({
      source_type: 'manual',
      source_connection_id: null,
      title: first.document.title,
    });
    const copyChunks = await repo.knowledge.listChunkSummaries(
      app.db,
      (
        await app.pool.query<{ current_version_id: string }>(
          'select current_version_id from knowledge_documents where id = $1',
          [newDocumentId],
        )
      ).rows[0]!.current_version_id,
    );
    expect(copyChunks.items.map((chunk) => chunk.content)).toEqual(['第一段', '第二段']);

    const moved = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [second.document.id], action: 'move', folderId: null },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    // 人工编辑过的文档：未确认时逐项失败，确认后才入队。
    const edited = await repo.knowledge.listChunks(app.db, second.version.id);
    await repo.knowledge.patchChunk(app.db, edited.items[0]!.id, { editedByUser: true });
    const blocked = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [second.document.id], action: 'reprocess' },
    });
    expect(
      blocked.json<{ results: Array<{ status: string; code?: string }> }>().results[0],
    ).toMatchObject({ status: 'failed', code: 'CONFLICT' });
    const confirmed = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: {
        documentIds: [second.document.id],
        action: 'reprocess',
        confirmOverwriteManualChunks: true,
      },
    });
    expect(
      confirmed.json<{ results: Array<{ status: string; jobId?: string }> }>().results[0],
    ).toMatchObject({ status: 'succeeded', jobId: expect.stringMatching(/^kjob_/) });

    const deleted = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [first.document.id], action: 'delete' },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const gone = await app.pool.query('select 1 from knowledge_documents where id = $1', [
      first.document.id,
    ]);
    expect(gone.rowCount).toBe(0);
  });

  it('copies version images one by one and fails the copy before creating it when one is missing', async () => {
    const baseId = await createBase();
    const images = [
      { name: 'fig-1.png', sha256: 'c'.repeat(64), mimeType: 'image/png', page: 1, warnings: [] },
      { name: 'fig-2.png', sha256: 'd'.repeat(64), mimeType: 'image/png', page: 2, warnings: [] },
    ];
    const source = await seedDocument(baseId, { title: '带图', images });
    await writeImages(source.document.id, source.version.id, {
      'fig-1.png': Buffer.from('first-image'),
      'fig-2.png': Buffer.from('second-image'),
    });

    const copied = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [source.document.id], action: 'copy' },
    });
    expect(copied.statusCode, copied.body).toBe(200);
    const copyResult = copied.json<{
      results: Array<{ status: string; newDocumentId?: string }>;
    }>().results[0]!;
    expect(copyResult.status).toBe('succeeded');
    const copyVersionId = (await repo.knowledge.getDocument(app.db, copyResult.newDocumentId!))!
      .currentVersionId!;
    const copyImagesDir = join(
      knowledgeDir,
      'docs',
      copyResult.newDocumentId!,
      copyVersionId,
      'images',
    );
    expect((await readdir(copyImagesDir)).sort()).toEqual(['fig-1.png', 'fig-2.png']);
    expect(await readFile(join(copyImagesDir, 'fig-1.png'), 'utf8')).toBe('first-image');

    // 清单声明了 fig-2.png，但源目录只放了 fig-1.png。
    const missing = await seedDocument(baseId, { title: '缺图', images });
    await writeImages(missing.document.id, missing.version.id, {
      'fig-1.png': Buffer.from('only-image'),
    });
    const beforeDocuments = await app.pool.query<{ id: string }>(
      'select id from knowledge_documents where base_id = $1 order by id',
      [baseId],
    );
    const beforeDirs = (await readdir(join(knowledgeDir, 'docs'))).sort();

    const failed = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [missing.document.id], action: 'copy' },
    });
    expect(failed.statusCode, failed.body).toBe(200);
    expect(
      failed.json<{ results: Array<{ status: string; code?: string }> }>().results[0],
    ).toMatchObject({ status: 'failed', code: 'CONFLICT' });

    // 失败不建副本、不留预分配目录，源版本图片仍可读。
    const afterDocuments = await app.pool.query<{ id: string }>(
      'select id from knowledge_documents where base_id = $1 order by id',
      [baseId],
    );
    expect(afterDocuments.rows.map((row) => row.id)).toEqual(
      beforeDocuments.rows.map((row) => row.id),
    );
    expect((await readdir(join(knowledgeDir, 'docs'))).sort()).toEqual(beforeDirs);
    expect(
      await readFile(
        join(knowledgeDir, 'docs', missing.document.id, missing.version.id, 'images', 'fig-1.png'),
        'utf8',
      ),
    ).toBe('only-image');

    // 空目录：清单声明了图片，但源 images/ 目录里一个文件都没有。
    const emptyImages = images.slice(0, 1);
    const empty = await seedDocument(baseId, { title: '空图', images: emptyImages });
    await mkdir(join(knowledgeDir, 'docs', empty.document.id, empty.version.id, 'images'), {
      recursive: true,
    });
    const emptyDirs = (await readdir(join(knowledgeDir, 'docs'))).sort();
    const emptyFailed = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [empty.document.id], action: 'copy' },
    });
    expect(emptyFailed.statusCode, emptyFailed.body).toBe(200);
    expect(
      emptyFailed.json<{ results: Array<{ status: string; code?: string }> }>().results[0],
    ).toMatchObject({ status: 'failed', code: 'CONFLICT' });
    expect((await repo.knowledge.getDocument(app.db, empty.document.id))!.currentVersionId).toBe(
      empty.version.id,
    );
    expect((await readdir(join(knowledgeDir, 'docs'))).sort()).toEqual(emptyDirs);
    expect(
      await readFile(
        join(knowledgeDir, 'docs', empty.document.id, empty.version.id, 'markdown.md'),
        'utf8',
      ),
    ).toBe('第一段\n\n第二段');
  });

  it('carries manifest images into chunk-edit versions and rejects a missing one without switching', async () => {
    const baseId = await createBase();
    const images = [
      { name: 'fig-1.png', sha256: 'c'.repeat(64), mimeType: 'image/png', page: 1, warnings: [] },
    ];
    const source = await seedDocument(baseId, { title: 'COW', images });
    await writeImages(source.document.id, source.version.id, {
      'fig-1.png': Buffer.from('cow-image'),
    });
    const [chunk] = (await repo.knowledge.listChunks(app.db, source.version.id)).items;

    const edited = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/chunks/${chunk!.id}`,
      headers: { cookie },
      payload: { content: '修改后的内容', expectedVersionId: source.version.id },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const newVersionId = edited.json<{ document: { currentVersionId: string } }>().document
      .currentVersionId;
    expect(newVersionId).not.toBe(source.version.id);
    const newImagesDir = join(knowledgeDir, 'docs', source.document.id, newVersionId, 'images');
    expect(await readdir(newImagesDir)).toEqual(['fig-1.png']);
    expect(await readFile(join(newImagesDir, 'fig-1.png'), 'utf8')).toBe('cow-image');
    // 旧版本及其图片保持只读可读。
    expect(
      await readFile(
        join(knowledgeDir, 'docs', source.document.id, source.version.id, 'images', 'fig-1.png'),
        'utf8',
      ),
    ).toBe('cow-image');

    const broken = await seedDocument(baseId, {
      title: 'COW 缺图',
      images: [
        ...images,
        {
          name: 'fig-2.png',
          sha256: 'd'.repeat(64),
          mimeType: 'image/png',
          page: 2,
          warnings: [],
        },
      ],
    });
    await writeImages(broken.document.id, broken.version.id, {
      'fig-1.png': Buffer.from('present'),
    });
    const [brokenChunk] = (await repo.knowledge.listChunks(app.db, broken.version.id)).items;
    const rejected = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/chunks/${brokenChunk!.id}`,
      headers: { cookie },
      payload: { content: '不应提交', expectedVersionId: broken.version.id },
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect((await repo.knowledge.getDocument(app.db, broken.document.id))!.currentVersionId).toBe(
      broken.version.id,
    );
    expect(await readdir(join(knowledgeDir, 'docs', broken.document.id))).toEqual([
      broken.version.id,
    ]);
    expect(
      await readFile(
        join(knowledgeDir, 'docs', broken.document.id, broken.version.id, 'images', 'fig-1.png'),
        'utf8',
      ),
    ).toBe('present');

    // 空目录：清单声明了图片，但源 images/ 目录里一个文件都没有。
    const empty = await seedDocument(baseId, { title: 'COW 空图', images });
    await mkdir(join(knowledgeDir, 'docs', empty.document.id, empty.version.id, 'images'), {
      recursive: true,
    });
    const [emptyChunk] = (await repo.knowledge.listChunks(app.db, empty.version.id)).items;
    const emptyRejected = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/chunks/${emptyChunk!.id}`,
      headers: { cookie },
      payload: { content: '不应提交', expectedVersionId: empty.version.id },
    });
    expect(emptyRejected.statusCode, emptyRejected.body).toBe(409);
    expect((await repo.knowledge.getDocument(app.db, empty.document.id))!.currentVersionId).toBe(
      empty.version.id,
    );
    expect(await readdir(join(knowledgeDir, 'docs', empty.document.id))).toEqual([
      empty.version.id,
    ]);
    expect(
      await readFile(
        join(knowledgeDir, 'docs', empty.document.id, empty.version.id, 'markdown.md'),
        'utf8',
      ),
    ).toBe('第一段\n\n第二段');
  });

  it('directory upload creates a real folder tree and rejects traversal paths', async () => {
    const baseId = await createBase();
    for (const relativePath of ['a/notes.md', 'b/notes.md']) {
      const res = await inject(app, {
        method: 'PUT',
        url: `/api/knowledge/bases/${baseId}/documents/upload`,
        headers: { cookie },
        payload: {
          filename: 'notes.md',
          mimeType: 'text/markdown',
          dataBase64: Buffer.from(relativePath).toString('base64'),
          relativePath,
        },
      });
      expect(res.statusCode, res.body).toBe(202);
    }
    const folders = await app.pool.query<{ path: string }>(
      'select path from knowledge_folders where base_id = $1 order by path',
      [baseId],
    );
    expect(folders.rows.map((row) => row.path)).toEqual(['/a', '/b']);
    const documents = await app.pool.query<{ title: string; folder_id: string }>(
      `select d.title, f.path as folder_id from knowledge_documents d
       join knowledge_folders f on f.id = d.folder_id
       where d.base_id = $1 order by f.path`,
      [baseId],
    );
    expect(documents.rows).toEqual([
      { title: 'notes', folder_id: '/a' },
      { title: 'notes', folder_id: '/b' },
    ]);

    for (const relativePath of ['../escape.md', '/abs.md', 'a//b.md', 'a\\b.md']) {
      const res = await inject(app, {
        method: 'PUT',
        url: `/api/knowledge/bases/${baseId}/documents/upload`,
        headers: { cookie },
        payload: {
          filename: 'escape.md',
          mimeType: 'text/markdown',
          dataBase64: Buffer.from('x').toString('base64'),
          relativePath,
        },
      });
      expect(res.statusCode, `${relativePath}: ${res.body}`).toBe(400);
    }
  });

  it('sync items are paginated per run and reject runs from another source', async () => {
    const baseId = await createBase();
    const source = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: {
        type: 'feed',
        name: 'feed',
        config: {},
        secrets: {},
        ranges: [{ kind: 'feed', externalId: 'https://example.com/feed.xml' }],
      },
    });
    expect(source.statusCode, source.body).toBe(201);
    const sourceId = source.json<{ id: string }>().id;
    const runId = 'ksyn_management_test';
    await app.pool.query(
      `insert into knowledge_sync_runs (id, source_id, status) values ($1, $2, 'succeeded')`,
      [runId, sourceId],
    );
    await app.pool.query(
      `insert into knowledge_sync_items
         (id, sync_run_id, source_id, external_id, status, code, message, retryable)
       values
         ('ksit_a', $1, $2, 'item-a', 'failed', 'AUTH_FAILED', '凭证失效', true),
         ('ksit_b', $1, $2, 'item-b', 'skipped', 'UNSUPPORTED', '不支持', false)`,
      [runId, sourceId],
    );

    const items = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/sources/${sourceId}/runs/${runId}/items?status=failed`,
      headers: { cookie },
    });
    expect(items.statusCode, items.body).toBe(200);
    expect(items.json<{ items: Array<{ externalId: string }> }>().items).toEqual([
      expect.objectContaining({ externalId: 'item-a' }),
    ]);

    const otherSource = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: {
        type: 'feed',
        name: 'feed-2',
        config: {},
        secrets: {},
        ranges: [{ kind: 'feed', externalId: 'https://example.com/feed-2.xml' }],
      },
    });
    const otherSourceId = otherSource.json<{ id: string }>().id;
    const wrong = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/sources/${otherSourceId}/runs/${runId}/items`,
      headers: { cookie },
    });
    expect(wrong.statusCode, wrong.body).toBe(404);
  });

  it('probe job result is visible on the job detail', async () => {
    const baseId = await createBase();
    const jobId = 'kjob_probe_result';
    await app.pool.query(
      `insert into knowledge_jobs (id, type, base_id, status, payload, result, ended_at)
       values ($1, 'source_probe', $2, 'succeeded', $3::jsonb, $4::jsonb, now())`,
      [
        jobId,
        baseId,
        JSON.stringify({ type: 'source_probe', sourceId: 'ksrc_x' }),
        JSON.stringify({ ok: false, checks: [{ rangeId: 'krng_a', ok: false, code: 'AUTH' }] }),
      ],
    );
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/jobs/${jobId}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: jobId,
      type: 'source_probe',
      result: { ok: false, checks: [{ rangeId: 'krng_a', ok: false, code: 'AUTH' }] },
    });
  });

  it('knowledge package round-trips FAQ data and Wiki directory fields', async () => {
    const baseId = await createBase();
    const profileId = profileIds.at(-1)!;
    const faq = {
      question: '如何轮换令牌？',
      similarQuestions: ['令牌怎么换'],
      negativeQuestions: ['如何删除库'],
      answers: ['定期轮换并保留旧版。'],
      answerStrategy: 'all' as const,
      isRecommended: true,
    };
    const faqDocument = await repo.knowledge.createDocument(app.db, {
      baseId,
      folderId: null,
      title: '令牌轮换',
      sourceType: 'manual',
      sourceId: null,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: 1,
      contentKind: 'faq',
    });
    const original = Buffer.from(faq.question);
    const blobSha = await writeBlob(original);
    const faqVersion = await repo.knowledge.createVersion(app.db, {
      documentId: faqDocument.id,
      blobSha256: blobSha,
      markdownSha256: createHash('sha256').update(original).digest('hex'),
      originalFilename: 'faq.md',
      mimeType: 'text/markdown',
      sizeBytes: original.length,
      sourceRevision: null,
      origin: 'faq',
      faq,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: profileId,
    });
    await repo.knowledge.insertChunks(app.db, {
      baseId,
      documentId: faqDocument.id,
      versionId: faqVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          kind: 'text',
          heading: null,
          content: faq.question,
          searchText: faq.question,
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });
    await writeMarkdown(faqDocument.id, faqVersion.id, faq.question);
    await repo.knowledge.setCurrentVersion(app.db, faqDocument.id, faqVersion.id);

    const parent = await repo.knowledge.createWikiPage(app.db, {
      baseId,
      slug: 'parent',
      title: '父页面',
    });
    const child = await repo.knowledge.createWikiPage(app.db, {
      baseId,
      slug: 'child',
      title: '子页面',
    });
    await repo.knowledge.updateWikiPageStructure(app.db, child.id, {
      parentId: parent.id,
      position: 3,
    });

    const exported = await injectZip(app, 'GET', `/api/knowledge/bases/${baseId}/export`, cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/bases/${baseId}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const index = baseIds.indexOf(baseId);
    if (index >= 0) baseIds.splice(index, 1);

    const imported = await injectZip(
      app,
      'POST',
      '/api/knowledge/bases/import',
      cookie,
      exported.rawPayload,
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const importedBaseId = imported.json<{ baseId: string }>().baseId;
    baseIds.push(importedBaseId);

    const faqRows = await app.pool.query<{ content_kind: string; faq: typeof faq }>(
      `select d.content_kind, v.faq from knowledge_documents d
       join knowledge_document_versions v on v.document_id = d.id and v.id = d.current_version_id
       where d.base_id = $1`,
      [importedBaseId],
    );
    expect(faqRows.rows[0]).toEqual({ content_kind: 'faq', faq });

    const wikiRows = await app.pool.query<{
      slug: string;
      parent_slug: string | null;
      position: number;
    }>(
      `select p.slug, parent.slug as parent_slug, p.position
       from knowledge_wiki_pages p
       left join knowledge_wiki_pages parent on parent.id = p.parent_id
       where p.base_id = $1 order by p.slug`,
      [importedBaseId],
    );
    expect(wikiRows.rows).toEqual([
      { slug: 'child', parent_slug: 'parent', position: 3 },
      { slug: 'parent', parent_slug: null, position: 0 },
    ]);
  });

  it('chunk version file failure keeps the old pointer, chunks and files readable', async () => {
    const baseId = await createBase();
    const seeded = await seedDocument(baseId, { contents: ['第一段', '第二段'] });
    const documentId = seeded.document.id;
    const docDir = join(knowledgeDir, 'docs', documentId);
    await chmod(docDir, 0o555);
    let response: Awaited<ReturnType<typeof inject>>;
    try {
      response = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/documents/${documentId}/chunks`,
        headers: { cookie },
        payload: { expectedVersionId: seeded.version.id, content: '新段' },
      });
    } finally {
      await chmod(docDir, 0o755);
    }
    expect(response.statusCode, response.body).toBe(500);

    const row = await app.pool.query<{ current_version_id: string; status: string }>(
      'select current_version_id, status from knowledge_documents where id = $1',
      [documentId],
    );
    expect(row.rows[0]).toEqual({ current_version_id: seeded.version.id, status: 'ready' });
    const chunks = await repo.knowledge.listChunkSummaries(app.db, seeded.version.id);
    expect(chunks.items.map((chunk) => chunk.content)).toEqual(['第一段', '第二段']);
    const markdown = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/versions/${seeded.version.id}/markdown`,
      headers: { cookie },
    });
    expect(markdown.statusCode, markdown.body).toBe(200);
    expect(markdown.body).toBe('第一段\n\n第二段');
  });

  it('cloning chunks keeps an old disabled chunk disabled', async () => {
    const baseId = await createBase();
    const seeded = await seedDocument(baseId, { contents: ['第一段', '第二段'] });
    const initial = await repo.knowledge.listChunks(app.db, seeded.version.id);
    const disabled = initial.items[0]!;
    const toggled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/chunks/${disabled.id}`,
      headers: { cookie },
      payload: { expectedVersionId: seeded.version.id, enabled: false },
    });
    expect(toggled.statusCode, toggled.body).toBe(200);
    const versionId = toggled.json<{ document: { currentVersionId: string } }>().document
      .currentVersionId;
    const added = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${seeded.document.id}/chunks`,
      headers: { cookie },
      payload: { expectedVersionId: versionId, content: '第三段' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const addedVersionId = added.json<{ document: { currentVersionId: string } }>().document
      .currentVersionId;
    const current = await repo.knowledge.listChunkSummaries(app.db, addedVersionId);
    expect(current.items.map((chunk) => [chunk.content, chunk.enabled])).toEqual([
      ['第一段', false],
      ['第二段', true],
      ['第三段', true],
    ]);
  });

  it('manual disable writes manual reason and explicit enable clears it', async () => {
    const baseId = await createBase();
    const seeded = await seedDocument(baseId, { sourceType: 'manual' });
    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/documents/${seeded.document.id}`,
      headers: { cookie },
      payload: { status: 'disabled' },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    const blocked = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${seeded.document.id}/reprocess`,
      headers: { cookie },
      payload: { confirmOverwriteManualChunks: true },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    const enabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/documents/${seeded.document.id}`,
      headers: { cookie },
      payload: { status: 'ready' },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ status: 'ready', disabledReason: null });
  });

  it('explicit enable still requires valid source authorization', async () => {
    const baseId = await createBase();
    const source = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: {
        type: 'feed',
        name: '授权来源',
        config: {},
        secrets: {},
        ranges: [{ kind: 'feed', externalId: 'https://example.com/auth.xml' }],
      },
    });
    expect(source.statusCode, source.body).toBe(201);
    const sourceBody = source.json<{ id: string; ranges: Array<{ id: string }> }>();
    const seeded = await seedDocument(baseId, {
      sourceConnectionId: sourceBody.id,
      sourcePath: '/item.md',
      contents: ['来源正文'],
    });
    const read = await repo.knowledge.getSourceReadSnapshot(app.db, sourceBody.id);
    if (!read) throw new Error('来源快照缺失');
    await repo.knowledge.setDocumentSourceRanges(
      app.db,
      seeded.document.id,
      [sourceBody.ranges[0]!.id],
      read.snapshot,
      {
        title: seeded.document.title,
        sourceUrl: seeded.document.sourceUrl,
        sourcePath: seeded.document.sourcePath,
        mimeType: seeded.document.mimeType,
        sizeBytes: seeded.document.sizeBytes,
        metadata: seeded.document.metadata,
      },
    );
    // seedDocument 切版时范围还没挂上，这里补一次发布。
    await repo.knowledge.setCurrentVersion(app.db, seeded.document.id, seeded.version.id);

    const revoked = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/sources/${sourceBody.id}`,
      headers: { cookie },
      payload: { status: 'disabled' },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json<{ disabledDocumentIds: string[] }>().disabledDocumentIds).toContain(
      seeded.document.id,
    );

    const blocked = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/documents/${seeded.document.id}`,
      headers: { cookie },
      payload: { status: 'ready' },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    const stillDisabled = await app.pool.query<{ status: string; disabled_reason: string | null }>(
      'select status, disabled_reason from knowledge_documents where id = $1',
      [seeded.document.id],
    );
    expect(stillDisabled.rows[0]).toEqual({ status: 'disabled', disabled_reason: 'source' });

    const restored = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/sources/${sourceBody.id}`,
      headers: { cookie },
      payload: { status: 'active' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const enabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/documents/${seeded.document.id}`,
      headers: { cookie },
      payload: { status: 'ready' },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ status: 'ready', disabledReason: null });
  });

  it('passes confirmOverwriteManualChunks through reprocess, rebuild and batch jobs', async () => {
    const baseId = await createBase();
    const seeded = await seedDocument(baseId, { contents: ['人工段'] });
    const chunks = await repo.knowledge.listChunks(app.db, seeded.version.id);
    await repo.knowledge.patchChunk(app.db, chunks.items[0]!.id, { editedByUser: true });

    async function payloadOf(jobId: string): Promise<Record<string, unknown>> {
      const rows = await app.pool.query<{ payload: Record<string, unknown> }>(
        'select payload from knowledge_jobs where id = $1',
        [jobId],
      );
      return rows.rows[0]!.payload;
    }

    const reprocessed = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${seeded.document.id}/reprocess`,
      headers: { cookie },
      payload: { confirmOverwriteManualChunks: true },
    });
    expect(reprocessed.statusCode, reprocessed.body).toBe(202);
    expect(await payloadOf(reprocessed.json<{ jobId: string }>().jobId)).toMatchObject({
      type: 'reindex',
      documentIds: [seeded.document.id],
      chunksOnly: false,
      confirmOverwriteManualChunks: true,
    });

    const rebuilt = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/rebuild`,
      headers: { cookie },
      payload: { documentIds: [seeded.document.id], confirmOverwriteManualChunks: true },
    });
    expect(rebuilt.statusCode, rebuilt.body).toBe(202);
    expect(await payloadOf(rebuilt.json<{ jobId: string }>().jobId)).toMatchObject({
      type: 'reindex',
      documentIds: [seeded.document.id],
      chunksOnly: false,
      confirmOverwriteManualChunks: true,
    });

    const batch = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: {
        documentIds: [seeded.document.id],
        action: 'reprocess',
        confirmOverwriteManualChunks: true,
      },
    });
    expect(batch.statusCode, batch.body).toBe(200);
    const jobId = batch.json<{ results: Array<{ jobId: string }> }>().results[0]!.jobId;
    expect(await payloadOf(jobId)).toMatchObject({
      type: 'reindex',
      documentIds: [seeded.document.id],
      chunksOnly: false,
      confirmOverwriteManualChunks: true,
    });
  });

  it('ordinary document list and manual editor exclude FAQ and Wiki internals', async () => {
    const baseId = await createBase();
    const normal = await seedDocument(baseId, { title: '普通文档' });
    const faq = await repo.knowledge.createDocument(app.db, {
      baseId,
      folderId: null,
      title: 'FAQ 草稿',
      sourceType: 'manual',
      sourceId: null,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: 1,
      contentKind: 'faq',
    });
    const wikiIndex = await repo.knowledge.createDocument(app.db, {
      baseId,
      folderId: null,
      title: 'Wiki 索引',
      sourceType: 'manual',
      sourceId: null,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: 1,
      contentKind: 'wiki',
    });

    const list = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/documents`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toEqual([
      normal.document.id,
    ]);
    expect(list.json<{ items: Array<{ id: string }> }>().items).not.toContainEqual(
      expect.objectContaining({ id: faq.id }),
    );
    expect(list.json<{ items: Array<{ id: string }> }>().items).not.toContainEqual(
      expect.objectContaining({ id: wikiIndex.id }),
    );

    const manual = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${faq.id}/manual`,
      headers: { cookie },
    });
    expect(manual.statusCode, manual.body).toBe(400);
    expect(manual.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('package import remaps internal Wiki index metadata and drops batch runtime state', async () => {
    const baseId = await createBase();
    const profileId = profileIds.at(-1)!;
    const page = await repo.knowledge.createWikiPage(app.db, {
      baseId,
      slug: unique('index-page'),
      title: '索引页',
    });
    const wikiVersionId = newId('knowledgeWikiVersion');
    await app.db.insert(schema.knowledgeWikiVersions).values({
      id: wikiVersionId,
      pageId: page.id,
      version: 1,
      markdown: '# 索引页\n\n索引内容 alpha',
      sourceChunkIds: [],
      model: 'test',
      generatedBy: 'manual',
    });
    await app.db
      .update(schema.knowledgeWikiPages)
      .set({ currentVersionId: wikiVersionId, status: 'published' })
      .where(eq(schema.knowledgeWikiPages.id, page.id));

    const indexDocument = await repo.knowledge.createDocument(app.db, {
      baseId,
      folderId: null,
      title: '索引页',
      sourceType: 'manual',
      sourceId: null,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: 1,
      contentKind: 'wiki',
      metadata: { wikiPageId: page.id },
    });
    const indexContent = Buffer.from('索引内容 alpha');
    const indexBlobSha = await writeBlob(indexContent);
    const indexVersion = await repo.knowledge.createVersion(app.db, {
      documentId: indexDocument.id,
      blobSha256: indexBlobSha,
      markdownSha256: createHash('sha256').update(indexContent).digest('hex'),
      originalFilename: 'wiki.md',
      mimeType: 'text/markdown',
      sizeBytes: indexContent.length,
      sourceRevision: null,
      origin: 'wiki',
      metadata: { wikiPageId: page.id, wikiVersionId },
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: profileId,
    });
    await repo.knowledge.insertChunks(app.db, {
      baseId,
      documentId: indexDocument.id,
      versionId: indexVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          kind: 'text',
          heading: '索引页',
          content: '索引内容 alpha',
          searchText: '索引内容 alpha',
          embedding: null,
          tokenCount: 1,
        },
      ],
    });
    await writeMarkdown(indexDocument.id, indexVersion.id, '索引内容 alpha');
    await repo.knowledge.setCurrentVersion(app.db, indexDocument.id, indexVersion.id);

    const faqDocument = await repo.knowledge.createDocument(app.db, {
      baseId,
      folderId: null,
      title: '批次 FAQ',
      sourceType: 'manual',
      sourceId: null,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: 1,
      contentKind: 'faq',
    });
    const faqContent = Buffer.from('导入问题');
    const faqBlobSha = await writeBlob(faqContent);
    const faqVersion = await repo.knowledge.createVersion(app.db, {
      documentId: faqDocument.id,
      blobSha256: faqBlobSha,
      markdownSha256: createHash('sha256').update(faqContent).digest('hex'),
      originalFilename: 'faq.md',
      mimeType: 'text/markdown',
      sizeBytes: faqContent.length,
      sourceRevision: null,
      origin: 'faq',
      metadata: {
        publication: 'draft',
        faqImport: {
          batchId: 'batch-1',
          mode: 'append',
          enabled: true,
          expectedVersionId: null,
        },
      },
      faq: {
        question: '导入问题',
        similarQuestions: [],
        negativeQuestions: [],
        answers: ['导入答案'],
        answerStrategy: 'all',
        isRecommended: true,
      },
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: profileId,
    });
    await writeMarkdown(faqDocument.id, faqVersion.id, '导入问题');

    const exported = await injectZip(app, 'GET', `/api/knowledge/bases/${baseId}/export`, cookie);
    expect(exported.statusCode, exported.body).toBe(200);
    await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/bases/${baseId}`,
      headers: { cookie },
    });
    const index = baseIds.indexOf(baseId);
    if (index >= 0) baseIds.splice(index, 1);

    const imported = await injectZip(
      app,
      'POST',
      '/api/knowledge/bases/import',
      cookie,
      exported.rawPayload,
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const importedBaseId = imported.json<{ baseId: string }>().baseId;
    baseIds.push(importedBaseId);

    const importedPage = await app.pool.query<{ id: string; current_version_id: string }>(
      'select id, current_version_id from knowledge_wiki_pages where base_id = $1',
      [importedBaseId],
    );
    expect(importedPage.rows[0]?.id).not.toBe(page.id);

    const importedRows = await app.pool.query<{
      content_kind: string;
      metadata: Record<string, unknown>;
      version_metadata: Record<string, unknown>;
    }>(
      `select d.content_kind, d.metadata, v.metadata as version_metadata
       from knowledge_documents d
       join knowledge_document_versions v on v.document_id = d.id
       where d.base_id = $1`,
      [importedBaseId],
    );
    const wikiRow = importedRows.rows.find((row) => row.content_kind === 'wiki')!;
    expect(wikiRow.metadata.wikiPageId).toBe(importedPage.rows[0]!.id);
    expect(wikiRow.version_metadata).toEqual({
      wikiPageId: importedPage.rows[0]!.id,
      wikiVersionId: importedPage.rows[0]!.current_version_id,
    });
    const faqRow = importedRows.rows.find((row) => row.content_kind === 'faq')!;
    expect(faqRow.version_metadata).toEqual({ publication: 'draft' });

    const list = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${importedBaseId}/documents`,
      headers: { cookie },
    });
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);

    const search = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${importedBaseId}/search?q=${encodeURIComponent('索引内容')}&kinds=wiki`,
      headers: { cookie },
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(
      search.json<{ hits: Array<{ target: { kind: string; id: string } }> }>().hits[0],
    ).toMatchObject({ target: { kind: 'wiki', id: importedPage.rows[0]!.id } });

    const wikiRead = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/wiki-pages/${importedPage.rows[0]!.id}`,
      headers: { cookie },
    });
    expect(wikiRead.statusCode, wikiRead.body).toBe(200);
    expect(wikiRead.json()).toMatchObject({
      currentVersionId: importedPage.rows[0]!.current_version_id,
    });
  });

  it('management search accepts the FAQ policy fields and returns the shared wire', async () => {
    const baseId = await createBase();
    await seedDocument(baseId, { contents: ['检索词 alpha'] });
    const res = await inject(app, {
      method: 'GET',
      url:
        `/api/knowledge/bases/${baseId}/search?q=alpha` +
        '&kinds=document&onlyRecommended=true&faqPriority=true&faqDirectAnswerThreshold=0.8' +
        '&diagnostics=true',
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      hits: [expect.objectContaining({ target: expect.objectContaining({ kind: 'document' }) })],
      degraded: true,
      directAnswer: null,
    });
    expect(Array.isArray(res.json<{ warnings: unknown[] }>().warnings)).toBe(true);
  });

  async function blockJobInserts(documentId: string) {
    const suffix = unique('blockjobs').replace(/-/g, '_');
    const fn = `${suffix}_fn`;
    const trigger = `${suffix}_trg`;
    await app.pool.query(
      `create function ${fn}() returns trigger language plpgsql as $$
       begin raise exception 'knowledge job insert blocked for test'; end $$`,
    );
    await app.pool.query(
      `create trigger ${trigger} before insert on knowledge_jobs
       for each row when (new.document_id = '${documentId}')
       execute function ${fn}()`,
    );
    return async () => {
      await app.pool.query(`drop trigger if exists ${trigger} on knowledge_jobs`);
      await app.pool.query(`drop function if exists ${fn}()`);
    };
  }

  it('keeps committed chunk version files when reindex job creation fails after commit', async () => {
    const baseId = await createBase();
    const seeded = await seedDocument(baseId, { contents: ['第一段'] });
    const restore = await blockJobInserts(seeded.document.id);
    let response: Awaited<ReturnType<typeof inject>>;
    try {
      response = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/documents/${seeded.document.id}/chunks`,
        headers: { cookie },
        payload: { expectedVersionId: seeded.version.id, content: '提交后入队失败' },
      });
    } finally {
      await restore();
    }
    expect(response.statusCode, response.body).toBe(500);

    const row = await app.pool.query<{ current_version_id: string }>(
      'select current_version_id from knowledge_documents where id = $1',
      [seeded.document.id],
    );
    const committedVersionId = row.rows[0]!.current_version_id;
    expect(committedVersionId).not.toBe(seeded.version.id);
    // 指针已切到新版本：它的正文文件必须可读，不能因后续任务失败被清理。
    const markdown = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/versions/${committedVersionId}/markdown`,
      headers: { cookie },
    });
    expect(markdown.statusCode, markdown.body).toBe(200);
    expect(markdown.body).toBe('第一段\n\n提交后入队失败');
  });

  it('manual draft jobs snapshot immutable input and never overwrite the published hash', async () => {
    const baseId = await createBase();
    const seeded = await seedDocument(baseId, { origin: 'manual', sourceType: 'manual' });
    const documentId = seeded.document.id;
    await app.pool.query('update knowledge_documents set content_hash = $1 where id = $2', [
      'published-hash',
      documentId,
    ]);
    const sha = (content: string) => createHash('sha256').update(content).digest('hex');

    async function payloadOf(jobId: string): Promise<Record<string, unknown>> {
      const rows = await app.pool.query<{ payload: Record<string, unknown> }>(
        'select payload from knowledge_jobs where id = $1',
        [jobId],
      );
      return rows.rows[0]!.payload;
    }

    const first = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
      payload: { content: '草稿 A', expectedVersionId: seeded.version.id },
    });
    expect(first.statusCode, first.body).toBe(202);
    const second = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
      payload: { content: '草稿 B', expectedVersionId: seeded.version.id },
    });
    expect(second.statusCode, second.body).toBe(202);

    const firstJobId = first.json<{ jobId: string }>().jobId;
    const secondJobId = second.json<{ jobId: string }>().jobId;
    expect(await payloadOf(firstJobId)).toMatchObject({
      type: 'ingest',
      publish: 'draft',
      documentId,
      input: {
        blobSha256: sha('草稿 A'),
        filename: `${seeded.document.title}.md`,
        mimeType: 'text/markdown',
        expectedCurrentVersionId: seeded.version.id,
      },
    });
    expect(await payloadOf(secondJobId)).toMatchObject({
      input: { blobSha256: sha('草稿 B') },
    });

    const kept = await app.pool.query<{ content_hash: string }>(
      'select content_hash from knowledge_documents where id = $1',
      [documentId],
    );
    expect(kept.rows[0]?.content_hash).toBe('published-hash');

    // 重试必须沿用同一快照，而不是重新读取运行时的文档指针。
    await app.pool.query(
      `update knowledge_jobs set status = 'failed', ended_at = now() where id = $1`,
      [firstJobId],
    );
    const retried = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/jobs/${firstJobId}/retry`,
      headers: { cookie },
    });
    expect(retried.statusCode, retried.body).toBe(202);
    expect(await payloadOf(retried.json<{ jobId: string }>().jobId)).toMatchObject({
      input: {
        blobSha256: sha('草稿 A'),
        filename: `${seeded.document.title}.md`,
        mimeType: 'text/markdown',
        expectedCurrentVersionId: seeded.version.id,
      },
    });

    const restore = await blockJobInserts(documentId);
    let blocked: Awaited<ReturnType<typeof inject>>;
    try {
      blocked = await inject(app, {
        method: 'PUT',
        url: `/api/knowledge/documents/${documentId}/manual`,
        headers: { cookie },
        payload: { content: '草稿 C', expectedVersionId: seeded.version.id },
      });
    } finally {
      await restore();
    }
    expect(blocked.statusCode, blocked.body).toBe(500);
    const afterFailure = await app.pool.query<{ content_hash: string }>(
      'select content_hash from knowledge_documents where id = $1',
      [documentId],
    );
    expect(afterFailure.rows[0]?.content_hash).toBe('published-hash');
  });

  it('batch copy preserves document and chunk state without inheriting source authorization', async () => {
    const baseId = await createBase();
    const source = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: {
        type: 'feed',
        name: '复制来源',
        config: {},
        secrets: {},
        ranges: [{ kind: 'feed', externalId: 'https://example.com/copy.xml' }],
      },
    });
    expect(source.statusCode, source.body).toBe(201);
    const sourceBody = source.json<{ id: string; ranges: Array<{ id: string }> }>();
    const sourceId = sourceBody.id;
    const seeded = await seedDocument(baseId, {
      contents: ['启用段', '停用段'],
      sourceConnectionId: sourceId,
      sourcePath: '/item.md',
    });
    // 有来源连接的文档必须先有覆盖范围才能发布，seed 时范围还没挂上。
    const read = await repo.knowledge.getSourceReadSnapshot(app.db, sourceId);
    if (!read) throw new Error('来源快照缺失');
    await repo.knowledge.setDocumentSourceRanges(
      app.db,
      seeded.document.id,
      [sourceBody.ranges[0]!.id],
      read.snapshot,
      {
        title: seeded.document.title,
        sourceUrl: seeded.document.sourceUrl,
        sourcePath: seeded.document.sourcePath,
        mimeType: seeded.document.mimeType,
        sizeBytes: seeded.document.sizeBytes,
        metadata: seeded.document.metadata,
      },
    );
    await repo.knowledge.setCurrentVersion(app.db, seeded.document.id, seeded.version.id);
    const initial = await repo.knowledge.listChunks(app.db, seeded.version.id);
    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/chunks/${initial.items[1]!.id}`,
      headers: { cookie },
      payload: { expectedVersionId: seeded.version.id, enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const versionId = disabled.json<{ document: { currentVersionId: string } }>().document
      .currentVersionId;
    const docDisabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/documents/${seeded.document.id}`,
      headers: { cookie },
      payload: { status: 'disabled' },
    });
    expect(docDisabled.statusCode, docDisabled.body).toBe(200);

    const copied = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [seeded.document.id], action: 'copy' },
    });
    expect(copied.statusCode, copied.body).toBe(200);
    const result = copied.json<{ results: Array<{ status: string; newDocumentId?: string }> }>()
      .results[0]!;
    expect(result.status).toBe('succeeded');
    const copyRow = await app.pool.query<{
      status: string;
      disabled_reason: string | null;
      source_type: string;
      source_connection_id: string | null;
      current_version_id: string;
    }>(
      `select status, disabled_reason, source_type, source_connection_id, current_version_id
       from knowledge_documents where id = $1`,
      [result.newDocumentId],
    );
    expect(copyRow.rows[0]).toMatchObject({
      status: 'disabled',
      disabled_reason: 'manual',
      source_type: 'manual',
      source_connection_id: null,
    });
    const copyChunks = await repo.knowledge.listChunkSummaries(
      app.db,
      copyRow.rows[0]!.current_version_id,
    );
    expect(copyChunks.items.map((chunk) => [chunk.content, chunk.enabled])).toEqual([
      ['启用段', true],
      ['停用段', false],
    ]);
    expect(versionId).not.toBe(seeded.version.id);
  });

  it('batch copy fails and removes the new directory when declared images are missing', async () => {
    const baseId = await createBase();
    const seeded = await seedDocument(baseId, {
      contents: ['带图正文'],
      images: [
        {
          name: 'fig-1.png',
          sha256: 'c'.repeat(64),
          mimeType: 'image/png',
          page: 1,
          warnings: [],
        },
      ],
    });
    const countDocs = async () =>
      (
        await app.pool.query<{ count: string }>(
          'select count(*)::text as count from knowledge_documents where base_id = $1',
          [baseId],
        )
      ).rows[0]!.count;
    const dirsBefore = (await readdir(join(knowledgeDir, 'docs'))).length;
    const before = await countDocs();

    const copied = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [seeded.document.id], action: 'copy' },
    });
    expect(copied.statusCode, copied.body).toBe(200);
    expect(
      copied.json<{ results: Array<{ status: string; newDocumentId?: string }> }>().results[0],
    ).toMatchObject({ status: 'failed' });
    expect(await countDocs()).toBe(before);
    expect((await readdir(join(knowledgeDir, 'docs'))).length).toBe(dirsBefore);

    // 图片清单存在且源文件真实存在时复制成功，图片随版本一起落到新目录。
    const imagesDir = join(knowledgeDir, 'docs', seeded.document.id, seeded.version.id, 'images');
    await mkdir(imagesDir, { recursive: true });
    await writeFile(join(imagesDir, 'fig-1.png'), Buffer.from('png'));
    const ok = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/documents/batch`,
      headers: { cookie },
      payload: { documentIds: [seeded.document.id], action: 'copy' },
    });
    const okResult = ok.json<{ results: Array<{ status: string; newDocumentId?: string }> }>()
      .results[0]!;
    expect(okResult).toMatchObject({ status: 'succeeded' });
    const copiedVersion = await app.pool.query<{ current_version_id: string; images: unknown[] }>(
      `select d.current_version_id, v.images
       from knowledge_documents d join knowledge_document_versions v on v.id = d.current_version_id
       where d.id = $1`,
      [okResult.newDocumentId],
    );
    expect(copiedVersion.rows[0]?.images).toHaveLength(1);
    expect(
      await readFile(
        join(
          knowledgeDir,
          'docs',
          okResult.newDocumentId!,
          copiedVersion.rows[0]!.current_version_id,
          'images',
          'fig-1.png',
        ),
      ),
    ).toEqual(Buffer.from('png'));
  });

  it('rejects generic chunk mutations on FAQ and Wiki internal documents', async () => {
    const baseId = await createBase();
    const profileId = profileIds.at(-1)!;
    for (const contentKind of ['faq', 'wiki'] as const) {
      const document = await repo.knowledge.createDocument(app.db, {
        baseId,
        folderId: null,
        title: `${contentKind} 内部`,
        sourceType: 'manual',
        sourceId: null,
        sourceUrl: null,
        sourcePath: null,
        mimeType: 'text/markdown',
        sizeBytes: 1,
        contentKind,
      });
      const version = await repo.knowledge.createVersion(app.db, {
        documentId: document.id,
        blobSha256: 'a'.repeat(64),
        markdownSha256: 'b'.repeat(64),
        originalFilename: 'internal.md',
        mimeType: 'text/markdown',
        sizeBytes: 1,
        sourceRevision: null,
        origin: contentKind,
        parseStatus: 'parsed',
        pageMap: [],
        images: [],
        embeddingProfileId: profileId,
      });
      const [chunk] = await repo.knowledge.insertChunks(app.db, {
        baseId,
        documentId: document.id,
        versionId: version.id,
        folderId: null,
        chunks: [
          {
            ordinal: 0,
            kind: 'text',
            heading: null,
            content: '内部块',
            searchText: '内部块',
            embedding: null,
            tokenCount: 1,
          },
        ],
      });
      await writeMarkdown(document.id, version.id, '内部块');
      await repo.knowledge.setCurrentVersion(app.db, document.id, version.id);

      const add = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/documents/${document.id}/chunks`,
        headers: { cookie },
        payload: { expectedVersionId: version.id, content: '越权新增' },
      });
      const update = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/chunks/${chunk!.id}`,
        headers: { cookie },
        payload: { expectedVersionId: version.id, content: '越权修改' },
      });
      const remove = await inject(app, {
        method: 'DELETE',
        url: `/api/knowledge/chunks/${chunk!.id}`,
        headers: { cookie },
        payload: { expectedVersionId: version.id },
      });
      for (const res of [add, update, remove]) {
        expect(res.statusCode, `${contentKind}: ${res.body}`).toBe(409);
        expect(res.json()).toMatchObject({ code: 'CONFLICT' });
      }
      const pointer = await app.pool.query<{ current_version_id: string }>(
        'select current_version_id from knowledge_documents where id = $1',
        [document.id],
      );
      expect(pointer.rows[0]?.current_version_id).toBe(version.id);
      const versions = await repo.knowledge.listVersions(app.db, document.id);
      expect(versions.items).toHaveLength(1);
    }
  });

  it('manual editor never mistakes published history for the pending draft', async () => {
    const baseId = await createBase();
    const profileId = profileIds.at(-1)!;
    const seeded = await seedDocument(baseId, {
      contents: ['线上 v1'],
      origin: 'manual',
      sourceType: 'manual',
    });
    const documentId = seeded.document.id;

    async function addDraft(content: string, parentVersionId: string) {
      return seedDraftVersion({ baseId, documentId, content, parentVersionId, profileId });
    }

    const v2 = await addDraft('线上 v2', seeded.version.id);
    const publishV2 = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId: v2.id, expectedVersionId: seeded.version.id },
    });
    expect(publishV2.statusCode, publishV2.body).toBe(200);

    const v3 = await addDraft('线上 v3', v2.id);
    const publishV3 = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId: v3.id, expectedVersionId: v2.id },
    });
    expect(publishV3.statusCode, publishV3.body).toBe(200);
    const afterV3 = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
    });
    expect(afterV3.json()).toMatchObject({
      status: 'published',
      versionId: v3.id,
      content: '线上 v3',
    });

    const rollback = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${documentId}/rollback`,
      headers: { cookie },
      payload: { versionId: seeded.version.id, expectedVersionId: v3.id },
    });
    expect(rollback.statusCode, rollback.body).toBe(200);
    const afterRollback = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
    });
    expect(afterRollback.json()).toMatchObject({
      status: 'published',
      versionId: seeded.version.id,
      content: '线上 v1',
    });

    const v4 = await addDraft('未发布 v4', seeded.version.id);
    const beforePublish = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
    });
    expect(beforePublish.json()).toMatchObject({
      status: 'draft',
      versionId: v4.id,
      content: '未发布 v4',
    });
    const saveAgain = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/documents/${documentId}/manual`,
      headers: { cookie },
      payload: { content: '未发布 v4 续写', expectedVersionId: v4.id },
    });
    expect(saveAgain.statusCode, saveAgain.body).toBe(202);
  });
});
