import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
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

describe.skipIf(!ready)('knowledge maintenance routes', () => {
  let app: TestApp;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-maintenance-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
  });

  afterEach(async () => {
    if (baseIds.length > 0) {
      await app.client.unsafe('delete from knowledge_bases where id = any($1::text[])', [
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

  async function createBase(): Promise<{ id: string; slug: string; embeddingProfileId: string }> {
    const profile = await request(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('maint-emb'),
        endpointUrl: 'http://127.0.0.1:1/embeddings',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const embeddingProfileId = profile.json<{ id: string }>().id;
    profileIds.push(embeddingProfileId);

    const slug = unique('maint-kb');
    const res = await request(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug, name: '维护库', embeddingProfileId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    baseIds.push(id);
    return { id, slug, embeddingProfileId };
  }

  async function insertDocument(options: {
    baseId: string;
    title: string;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<string> {
    const id = `kdoc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    await app.client.unsafe(
      `insert into knowledge_documents
         (id, base_id, title, source_type, mime_type, status, created_at, updated_at)
       values ($1, $2, $3, 'upload', 'text/plain', 'ready', $4::timestamptz, $5::timestamptz)`,
      [
        id,
        options.baseId,
        options.title,
        options.createdAt ?? new Date().toISOString(),
        options.updatedAt ?? new Date().toISOString(),
      ],
    );
    return id;
  }

  async function insertVersion(options: {
    documentId: string;
    embeddingProfileId: string;
    filename: string;
    data: Buffer;
    markdown?: string;
    parseStatus?: 'parsed' | 'parse_failed';
    version?: number;
  }): Promise<string> {
    const sha = new Bun.CryptoHasher('sha256').update(options.data).digest('hex');
    const versionId = `kdv_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const blobPath = join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
    await mkdir(dirname(blobPath), { recursive: true });
    await writeFile(blobPath, options.data);
    await app.client.unsafe(
      `insert into knowledge_document_versions
         (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
          size_bytes, parse_status, page_map, images, embedding_profile_id)
       values ($1, $2, $3, $4, $4, $5, 'text/plain', $6, $7, '[]', '[]', $8)`,
      [
        versionId,
        options.documentId,
        options.version ?? 1,
        sha,
        options.filename,
        options.data.length,
        options.parseStatus ?? 'parsed',
        options.embeddingProfileId,
      ],
    );
    await app.client.unsafe(
      'update knowledge_documents set current_version_id = $2 where id = $1',
      [options.documentId, versionId],
    );
    if (options.markdown !== undefined) {
      const dir = join(knowledgeDir, 'docs', options.documentId, versionId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'markdown.md'), options.markdown, 'utf8');
    }
    return versionId;
  }

  async function listIds(
    baseId: string,
    params: Record<string, string | number>,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const res = await request(app, {
        method: 'GET',
        url: `/api/knowledge/bases/${baseId}/documents`,
        headers: { cookie },
        query: { ...params, ...(cursor === undefined ? {} : { cursor }) },
      });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
      ids.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) return ids;
      cursor = page.nextCursor;
    }
    throw new Error('cursor pagination did not terminate');
  }

  describe('document list sorting', () => {
    it('walks cursor pages by title/created/updated without gaps or duplicates', async () => {
      const base = await createBase();
      const docs = [
        {
          id: await insertDocument({
            baseId: base.id,
            title: 'Alpha',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-05T00:00:00Z',
          }),
          title: 'Alpha',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-05T00:00:00Z',
        },
        {
          id: await insertDocument({
            baseId: base.id,
            title: 'Zeta',
            createdAt: '2026-01-04T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          }),
          title: 'Zeta',
          createdAt: '2026-01-04T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: await insertDocument({
            baseId: base.id,
            title: 'Alpha',
            createdAt: '2026-01-03T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          }),
          title: 'Alpha',
          createdAt: '2026-01-03T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          id: await insertDocument({
            baseId: base.id,
            title: 'Beta',
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-04T00:00:00Z',
          }),
          title: 'Beta',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-04T00:00:00Z',
        },
        {
          id: await insertDocument({
            baseId: base.id,
            title: 'Echo',
            createdAt: '2026-01-05T00:00:00Z',
            updatedAt: '2026-01-03T00:00:00Z',
          }),
          title: 'Echo',
          createdAt: '2026-01-05T00:00:00Z',
          updatedAt: '2026-01-03T00:00:00Z',
        },
      ];
      const byString = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
      const expected = (key: 'title' | 'createdAt' | 'updatedAt', direction: 'asc' | 'desc') =>
        [...docs]
          .sort((left, right) => {
            const primary = byString(left[key], right[key]);
            const tie = primary === 0 ? byString(left.id, right.id) : primary;
            return direction === 'asc' ? tie : -tie;
          })
          .map((doc) => doc.id);

      const titleAsc = await listIds(base.id, { sort: 'title', order: 'asc', limit: 1 });
      expect(titleAsc).toEqual(expected('title', 'asc'));
      expect(new Set(titleAsc).size).toBe(docs.length);

      expect(await listIds(base.id, { sort: 'created', order: 'desc', limit: 2 })).toEqual(
        expected('createdAt', 'desc'),
      );
      expect(await listIds(base.id, { sort: 'updated', order: 'desc', limit: 2 })).toEqual(
        expected('updatedAt', 'desc'),
      );
      expect(await listIds(base.id, { limit: 2 })).toEqual(expected('createdAt', 'desc'));
    });
  });

  describe('batch document download', () => {
    it('zips current originals, dedupes names, and rejects bad selections', async () => {
      const base = await createBase();
      const first = await insertDocument({ baseId: base.id, title: 'A' });
      await insertVersion({
        documentId: first,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'a.md',
        data: Buffer.from('alpha-bytes'),
      });
      const second = await insertDocument({ baseId: base.id, title: 'Same 1' });
      await insertVersion({
        documentId: second,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'same.txt',
        data: Buffer.from('first-copy'),
      });
      const third = await insertDocument({ baseId: base.id, title: 'Same 2' });
      await insertVersion({
        documentId: third,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'same.txt',
        data: Buffer.from('second-copy'),
      });
      const pending = await insertDocument({ baseId: base.id, title: 'Pending' });

      const res = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: [first, second, third, pending] },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-disposition')).toContain(`${base.slug}-documents.zip`);
      const files = unzipSync(new Uint8Array(res.rawPayload));
      expect(Object.keys(files).sort()).toEqual(['a.md', 'same (1).txt', 'same.txt']);
      expect(Buffer.from(files['a.md'] ?? new Uint8Array()).toString('utf8')).toBe('alpha-bytes');
      expect(Buffer.from(files['same.txt'] ?? new Uint8Array()).toString('utf8')).toBe(
        'first-copy',
      );
      expect(Buffer.from(files['same (1).txt'] ?? new Uint8Array()).toString('utf8')).toBe(
        'second-copy',
      );

      const otherBase = await createBase();
      const foreign = await insertDocument({ baseId: otherBase.id, title: 'Foreign' });
      const crossBase = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: [foreign] },
      });
      expectProblem(crossBase, 'NOT_FOUND');

      const missing = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: ['kdoc_missing'] },
      });
      expectProblem(missing, 'NOT_FOUND');

      const empty = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: [] },
      });
      expectProblem(empty, 'INVALID_INPUT');

      const duplicate = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: [first, first] },
      });
      expectProblem(duplicate, 'INVALID_INPUT');

      const nothingDownloadable = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: [pending] },
      });
      expectProblem(nothingDownloadable, 'INVALID_INPUT');
    });

    it('keeps unsafe filenames as safe zip entries without dropping files', async () => {
      const base = await createBase();
      const proto = await insertDocument({ baseId: base.id, title: 'Proto' });
      await insertVersion({
        documentId: proto,
        embeddingProfileId: base.embeddingProfileId,
        filename: '__proto__',
        data: Buffer.from('proto-bytes'),
      });
      const dotdot = await insertDocument({ baseId: base.id, title: 'Dotdot' });
      await insertVersion({
        documentId: dotdot,
        embeddingProfileId: base.embeddingProfileId,
        filename: '..',
        data: Buffer.from('dotdot-bytes'),
      });
      const dot = await insertDocument({ baseId: base.id, title: 'Dot' });
      await insertVersion({
        documentId: dot,
        embeddingProfileId: base.embeddingProfileId,
        filename: '.',
        data: Buffer.from('dot-bytes'),
      });

      const res = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: [proto, dotdot, dot] },
      });
      expect(res.statusCode, res.body).toBe(200);
      const files = unzipSync(new Uint8Array(res.rawPayload));
      expect(Object.keys(files).sort()).toEqual(['___proto__', 'document', 'document (1)']);
      expect(Buffer.from(files.___proto__ ?? new Uint8Array()).toString('utf8')).toBe(
        'proto-bytes',
      );
      expect(Buffer.from(files.document ?? new Uint8Array()).toString('utf8')).toBe('dotdot-bytes');
      expect(Buffer.from(files['document (1)'] ?? new Uint8Array()).toString('utf8')).toBe(
        'dot-bytes',
      );
    });

    it('excludes disabled documents from the zip', async () => {
      const base = await createBase();
      const active = await insertDocument({ baseId: base.id, title: 'Active' });
      await insertVersion({
        documentId: active,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'active.txt',
        data: Buffer.from('active'),
      });
      const disabled = await insertDocument({ baseId: base.id, title: 'Disabled' });
      await insertVersion({
        documentId: disabled,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'disabled.txt',
        data: Buffer.from('disabled'),
      });
      await app.client.unsafe(
        `update knowledge_documents set status = 'disabled', disabled_reason = 'source' where id = $1`,
        [disabled],
      );

      const onlyDisabled = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: [disabled] },
      });
      expectProblem(onlyDisabled, 'INVALID_INPUT');

      const mixed = await request(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${base.id}/documents/download`,
        headers: { cookie },
        payload: { documentIds: [active, disabled] },
      });
      expect(mixed.statusCode, mixed.body).toBe(200);
      const files = unzipSync(new Uint8Array(mixed.rawPayload));
      expect(Object.keys(files)).toEqual(['active.txt']);
      expect(Buffer.from(files['active.txt'] ?? new Uint8Array()).toString('utf8')).toBe('active');
    });
  });

  describe('document version diff', () => {
    it('diffs markdown across versions and rejects another document versions', async () => {
      const base = await createBase();
      const documentId = await insertDocument({ baseId: base.id, title: 'Diff' });
      const first = await insertVersion({
        documentId,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'diff.md',
        data: Buffer.from('v1'),
        markdown: 'a\nb\nc',
      });
      const second = await insertVersion({
        documentId,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'diff.md',
        data: Buffer.from('v2'),
        markdown: 'a\nb\nc\nc\nd',
        version: 2,
      });

      const res = await request(app, {
        method: 'GET',
        url: `/api/knowledge/documents/${documentId}/diff`,
        headers: { cookie },
        query: { fromVersionId: first, toVersionId: second },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        fromVersionId: first,
        toVersionId: second,
        addedLines: ['c', 'd'],
        removedLines: [],
      });

      const reverse = await request(app, {
        method: 'GET',
        url: `/api/knowledge/documents/${documentId}/diff`,
        headers: { cookie },
        query: { fromVersionId: second, toVersionId: first },
      });
      expect(reverse.json()).toEqual({
        fromVersionId: second,
        toVersionId: first,
        addedLines: [],
        removedLines: ['c', 'd'],
      });

      const otherDocument = await insertDocument({ baseId: base.id, title: 'Other' });
      const foreignVersion = await insertVersion({
        documentId: otherDocument,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'other.md',
        data: Buffer.from('other'),
        markdown: 'x\ny',
      });
      const foreign = await request(app, {
        method: 'GET',
        url: `/api/knowledge/documents/${documentId}/diff`,
        headers: { cookie },
        query: { fromVersionId: first, toVersionId: foreignVersion },
      });
      expectProblem(foreign, 'NOT_FOUND');

      const parseFailedDocument = await insertDocument({ baseId: base.id, title: 'Failed' });
      const parsed = await insertVersion({
        documentId: parseFailedDocument,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'failed.md',
        data: Buffer.from('ok'),
        markdown: 'kept',
      });
      const failed = await insertVersion({
        documentId: parseFailedDocument,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'failed.md',
        data: Buffer.from('bad'),
        parseStatus: 'parse_failed',
        version: 2,
      });
      const failedDiff = await request(app, {
        method: 'GET',
        url: `/api/knowledge/documents/${parseFailedDocument}/diff`,
        headers: { cookie },
        query: { fromVersionId: parsed, toVersionId: failed },
      });
      expect(failedDiff.statusCode, failedDiff.body).toBe(400);
      expectProblem(failedDiff, 'INVALID_INPUT');
    });

    it('reports reordered lines as changes instead of a no-op diff', async () => {
      const base = await createBase();
      const documentId = await insertDocument({ baseId: base.id, title: 'Reorder' });
      const first = await insertVersion({
        documentId,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'order.md',
        data: Buffer.from('v1'),
        markdown: 'a\nb\nc',
      });
      const second = await insertVersion({
        documentId,
        embeddingProfileId: base.embeddingProfileId,
        filename: 'order.md',
        data: Buffer.from('v2'),
        markdown: 'c\nb\na',
        version: 2,
      });

      const res = await request(app, {
        method: 'GET',
        url: `/api/knowledge/documents/${documentId}/diff`,
        headers: { cookie },
        query: { fromVersionId: first, toVersionId: second },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ addedLines: string[]; removedLines: string[] }>();
      expect(body.addedLines.length).toBeGreaterThan(0);
      expect(body.removedLines.length).toBeGreaterThan(0);
    });
  });
});
