import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe.skipIf(!ready)('knowledge source routes', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function createBase(): Promise<string> {
    const profile = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('src-emb'),
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
      payload: { slug: unique('src-kb'), name: '来源库', embeddingProfileId: profileIds.at(-1) },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  function sourcePayload(overrides: Record<string, unknown> = {}) {
    return {
      type: 'feed',
      name: 'rss',
      config: {},
      secrets: {},
      ranges: [{ kind: 'feed', externalId: `https://example.com/${unique('feed')}.xml` }],
      ...overrides,
    };
  }

  async function createSource(baseId: string, overrides: Record<string, unknown> = {}) {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: sourcePayload(overrides),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>();
  }

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-source-routes-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
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

  it('rejects anonymous access to source routes', async () => {
    const baseId = await createBase();
    const source = await createSource(baseId);
    const cases = [
      ['GET', `/api/knowledge/bases/${baseId}/sources`, undefined],
      ['POST', `/api/knowledge/bases/${baseId}/sources`, sourcePayload()],
      ['PATCH', `/api/knowledge/sources/${source.id}`, { name: 'x' }],
      ['DELETE', `/api/knowledge/sources/${source.id}?documents=keep`, undefined],
      ['POST', `/api/knowledge/sources/${source.id}/test`, undefined],
      ['POST', `/api/knowledge/sources/${source.id}/sync`, undefined],
      ['GET', `/api/knowledge/sources/${source.id}/runs`, undefined],
    ] as const;
    for (const [method, url, payload] of cases) {
      const res = await inject(app, {
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(401);
    }
  });

  it('creates a source with ranges, encrypts secrets, and never returns them', async () => {
    const baseId = await createBase();
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: {
        type: 'gitlab',
        name: 'gitlab',
        config: { baseUrl: 'https://gitlab.example.com', projectId: '42', ref: 'main' },
        secrets: { token: 'glpat-plaintext-token' },
        ranges: [{ kind: 'gitlab_project', externalId: '42', ref: 'main', paths: ['docs/*.md'] }],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const source = res.json<{
      id: string;
      hasSecret: boolean;
      config: Record<string, unknown>;
      ranges: Array<{ kind: string; externalId: string; paths: string[] }>;
    }>();
    expect(source.id).toMatch(/^ksrc_/);
    expect(source.hasSecret).toBe(true);
    expect(source.ranges).toEqual([
      expect.objectContaining({ kind: 'gitlab_project', externalId: '42', paths: ['docs/*.md'] }),
    ]);
    expect(JSON.stringify(source)).not.toContain('glpat-plaintext-token');
    expect(JSON.stringify(source)).not.toContain('secretsEncrypted');

    const stored = await app.pool.query<{ secrets_encrypted: string }>(
      'select secrets_encrypted from knowledge_sources where id = $1',
      [source.id],
    );
    expect(stored.rows[0]!.secrets_encrypted).not.toContain('glpat-plaintext-token');

    const list = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json<{ items: Array<{ id: string; hasSecret: boolean }> }>().items;
    expect(items).toEqual([expect.objectContaining({ id: source.id, hasSecret: true })]);
    expect(list.body).not.toContain('glpat-plaintext-token');
  });

  it('rejects empty ranges with 400', async () => {
    const baseId = await createBase();
    for (const ranges of [[], undefined]) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/sources`,
        headers: { cookie },
        payload: sourcePayload(ranges === undefined ? { ranges: undefined } : { ranges }),
      });
      expect(res.statusCode, res.body).toBe(400);
    }
    const count = await app.pool.query<{ n: string }>(
      'select count(*)::text as n from knowledge_sources where base_id = $1',
      [baseId],
    );
    expect(count.rows[0]!.n).toBe('0');
  });

  it('tests configuration only and reports issues', async () => {
    const baseId = await createBase();
    const source = await createSource(baseId);
    const ok = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/sources/${source.id}/test`,
      headers: { cookie },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ ok: true, issues: [] });

    // 清空 config/凭证后 test 必须报出缺失项，而不是假装通过。
    const broken = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/sources`,
      headers: { cookie },
      payload: {
        type: 'gitlab',
        name: 'broken',
        config: { baseUrl: 'https://gitlab.example.com', projectId: '1', ref: 'main' },
        secrets: { token: 't' },
        ranges: [{ kind: 'gitlab_project', externalId: '1', ref: 'main' }],
      },
    });
    expect(broken.statusCode, broken.body).toBe(201);
    const brokenId = broken.json<{ id: string }>().id;
    await app.pool.query('update knowledge_sources set secrets_encrypted = null where id = $1', [
      brokenId,
    ]);
    const bad = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/sources/${brokenId}/test`,
      headers: { cookie },
    });
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json()).toEqual({ ok: false, issues: ['缺少凭证 token'] });
  });

  it('enqueues a sync run and job, then lists runs', async () => {
    const baseId = await createBase();
    const source = await createSource(baseId);
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/sources/${source.id}/sync`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json<{ jobId: string; syncRunId: string }>();
    expect(body.jobId).toMatch(/^kjob_/);
    expect(body.syncRunId).toMatch(/^ksyn_/);

    const job = await app.pool.query<{ type: string; status: string; payload: unknown }>(
      'select type, status, payload from knowledge_jobs where id = $1',
      [body.jobId],
    );
    expect(job.rows[0]).toMatchObject({
      type: 'sync',
      status: 'queued',
      payload: { type: 'sync', sourceId: source.id, syncRunId: body.syncRunId },
    });

    const run = await app.pool.query<{ status: string }>(
      'select status from knowledge_sync_runs where id = $1',
      [body.syncRunId],
    );
    expect(run.rows[0]!.status).toBe('queued');

    const runs = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/sources/${source.id}/runs`,
      headers: { cookie },
    });
    expect(runs.statusCode, runs.body).toBe(200);
    const items = runs.json<{
      items: Array<{ id: string; status: string; stats: Record<string, number> }>;
    }>().items;
    expect(items).toEqual([
      expect.objectContaining({
        id: body.syncRunId,
        status: 'queued',
        stats: { listed: 0, created: 0, updated: 0, disabled: 0, failed: 0 },
      }),
    ]);
  });

  it('cancels a queued sync with its run and retries into a new run', async () => {
    const baseId = await createBase();
    const source = await createSource(baseId);
    const first = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/sources/${source.id}/sync`,
      headers: { cookie },
    });
    expect(first.statusCode, first.body).toBe(202);
    const created = first.json<{ jobId: string; syncRunId: string }>();

    const cancelled = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/jobs/${created.jobId}/cancel`,
      headers: { cookie },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    const run = await app.pool.query<{ status: string }>(
      'select status from knowledge_sync_runs where id = $1',
      [created.syncRunId],
    );
    expect(run.rows[0]!.status).toBe('cancelled');

    const retried = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/jobs/${created.jobId}/retry`,
      headers: { cookie },
    });
    expect(retried.statusCode, retried.body).toBe(202);
    const retryJobId = retried.json<{ jobId: string }>().jobId;
    const retryJob = await app.pool.query<{ payload: { syncRunId: string } }>(
      'select payload from knowledge_jobs where id = $1',
      [retryJobId],
    );
    const retryRunId = retryJob.rows[0]!.payload.syncRunId;
    expect(retryRunId).not.toBe(created.syncRunId);
    // 旧 run 的历史保持原样，不被重试覆写。
    const oldRun = await app.pool.query<{ status: string; ended_at: string | null }>(
      'select status, ended_at from knowledge_sync_runs where id = $1',
      [created.syncRunId],
    );
    expect(oldRun.rows[0]!.status).toBe('cancelled');
    expect(oldRun.rows[0]!.ended_at).not.toBeNull();
    const newRun = await app.pool.query<{ status: string }>(
      'select status from knowledge_sync_runs where id = $1',
      [retryRunId],
    );
    expect(newRun.rows[0]!.status).toBe('queued');
  });

  async function seedSourceDocument(baseId: string, sourceId: string): Promise<string> {
    const documentId = `kdoc_src${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_documents
         (id, base_id, title, source_type, source_id, mime_type, status, metadata)
       values ($1, $2, 'doc', 'feed', $3, 'text/markdown', 'ready', $4::jsonb)`,
      [
        documentId,
        baseId,
        `feed-item-${documentId}`,
        JSON.stringify({ knowledgeSourceId: sourceId }),
      ],
    );
    return documentId;
  }

  it('DELETE documents=keep disables documents and removes the source', async () => {
    const baseId = await createBase();
    const source = await createSource(baseId);
    const documentId = await seedSourceDocument(baseId, source.id);

    const res = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/sources/${source.id}?documents=keep`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ documents: 'keep', affected: 1 });

    const doc = await app.pool.query<{ status: string }>(
      'select status from knowledge_documents where id = $1',
      [documentId],
    );
    expect(doc.rows[0]!.status).toBe('disabled');
    const sourceRow = await app.pool.query('select 1 from knowledge_sources where id = $1', [
      source.id,
    ]);
    expect(sourceRow.rowCount).toBe(0);
  });

  it('disabling a source disables its documents and marks Wiki pages stale', async () => {
    const baseId = await createBase();
    const source = await createSource(baseId);
    const documentId = await seedSourceDocument(baseId, source.id);
    const pageId = `kwp_${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      "insert into knowledge_wiki_pages (id, base_id, slug, title, status) values ($1, $2, $3, '页面', 'published')",
      [pageId, baseId, `page-${pageId}`],
    );
    await app.pool.query(
      'insert into knowledge_wiki_sources (page_id, document_id, stale) values ($1, $2, false)',
      [pageId, documentId],
    );

    const res = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/sources/${source.id}`,
      headers: { cookie },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const doc = await app.pool.query<{ status: string }>(
      'select status from knowledge_documents where id = $1',
      [documentId],
    );
    expect(doc.rows[0]!.status).toBe('disabled');
    const page = await app.pool.query<{ status: string }>(
      'select status from knowledge_wiki_pages where id = $1',
      [pageId],
    );
    expect(page.rows[0]!.status).toBe('stale');
    const link = await app.pool.query<{ stale: boolean }>(
      'select stale from knowledge_wiki_sources where page_id = $1',
      [pageId],
    );
    expect(link.rows[0]!.stale).toBe(true);
  });

  it('DELETE documents=delete physically removes documents', async () => {
    const baseId = await createBase();
    const source = await createSource(baseId);
    const kept = await seedSourceDocument(baseId, 'ksrc_other');
    const removed = await seedSourceDocument(baseId, source.id);

    const res = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/sources/${source.id}?documents=delete`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ documents: 'delete', affected: 1 });

    const gone = await app.pool.query('select 1 from knowledge_documents where id = $1', [removed]);
    expect(gone.rowCount).toBe(0);
    const other = await app.pool.query<{ status: string }>(
      'select status from knowledge_documents where id = $1',
      [kept],
    );
    expect(other.rows[0]!.status).toBe('ready');
  });
});
