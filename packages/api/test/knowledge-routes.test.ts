import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance, inject, loginCookie, startApp, testConfig } from './helpers.js';

let app: FastifyInstance;
let cookie = '';
let fixture: Server;
let fixtureUrl = '';
let knowledgeDir = '';
let embeddingMode: 'ok' | 'fail' = 'ok';
const profileIds: string[] = [];
const baseIds: string[] = [];

function vectorFor(text: string): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = text.includes('令牌') || text.includes('token') ? 1 : 0.01;
  return vector;
}

beforeAll(async () => {
  fixture = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url !== '/embeddings') return respond(404, { error: 'not found' });
      if (embeddingMode === 'fail') return respond(500, { error: 'boom' });
      const { input } = JSON.parse(raw) as { input: string[] };
      respond(200, { data: input.map((text) => ({ embedding: vectorFor(text) })) });
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-routes-'));
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
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(knowledgeDir, { recursive: true, force: true });
});

async function createProfile(kind: 'embedding' | 'rerank') {
  const res = await inject(app, {
    method: 'POST',
    url: '/api/knowledge/model-profiles',
    headers: { cookie },
    payload: {
      kind,
      name: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      endpointUrl: fixtureUrl,
      model: 'test-model',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const profile = res.json<{ id: string }>();
  profileIds.push(profile.id);
  return profile.id;
}

async function createBase(embeddingProfileId: string, rerankProfileId: string | null = null) {
  const res = await inject(app, {
    method: 'POST',
    url: '/api/knowledge/bases',
    headers: { cookie },
    payload: {
      slug: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'API 知识库',
      embeddingProfileId,
      rerankProfileId,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const base = res.json<{ id: string; serverId: string }>();
  baseIds.push(base.id);
  return base;
}

async function upload(baseId: string, content: string, filename = 'notes.md') {
  return inject(app, {
    method: 'PUT',
    url: `/api/knowledge/bases/${baseId}/documents/upload`,
    headers: { cookie },
    payload: {
      filename,
      mimeType: 'text/markdown',
      dataBase64: Buffer.from(content, 'utf8').toString('base64'),
    },
  });
}

/** 捕获 rebuild 期间的文档归属查询，区分一次批量查询与逐条查询。 */
async function rebuildCapturingDocumentSelects(
  baseId: string,
  payload: { documentIds?: string[]; chunksOnly?: boolean },
) {
  const spy = vi.spyOn(app.pool, 'query');
  try {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/rebuild`,
      headers: { cookie },
      payload,
    });
    const selects = spy.mock.calls
      .map(([query]) => (typeof query === 'string' ? query : query.text))
      .filter((text) => /from "knowledge_documents"/.test(text));
    return { res, selects };
  } finally {
    spy.mockRestore();
  }
}

/** 检索依赖 chunk 与当前版本；这里直接落 ready 文档，验证 API 层而不是 worker。 */
async function seedReadyDocument(baseId: string, profileId: string, content: string) {
  const document = await inject(app, {
    method: 'PUT',
    url: `/api/knowledge/bases/${baseId}/documents/upload`,
    headers: { cookie },
    payload: {
      filename: 'seed.md',
      mimeType: 'text/markdown',
      dataBase64: Buffer.from(content, 'utf8').toString('base64'),
    },
  });
  expect(document.statusCode, document.body).toBe(202);
  const documentId = document.json<{ documentId: string }>().documentId;

  const version = await app.pool.query<{ id: string }>(
    `insert into knowledge_document_versions
       (id, document_id, version, blob_sha256, markdown_sha256, original_filename, mime_type,
        size_bytes, parse_status, page_map, images, embedding_profile_id)
     values ($1, $2, 1, $3, $3, 'seed.md', 'text/markdown', 1, 'parsed', '[]', '[]', $4)
     returning id`,
    [`kdv_${documentId.slice(4)}`, documentId, 'a'.repeat(64), profileId],
  );
  const versionId = version.rows[0]!.id;
  await app.pool.query(
    `insert into knowledge_chunks
       (id, base_id, document_id, version_id, ordinal, kind, content, search_text, embedding)
     values ($1, $2, $3, $4, 0, 'text', $5, $6, $7::vector)`,
    [
      `kchk_${documentId.slice(4)}`,
      baseId,
      documentId,
      versionId,
      content,
      content.split(/\s+/).join(' '),
      `[${vectorFor(content).join(',')}]`,
    ],
  );
  await app.pool.query(
    "update knowledge_documents set status = 'ready', current_version_id = $2 where id = $1",
    [documentId, versionId],
  );
  return { documentId, versionId };
}

async function createFolder(baseId: string, name: string, parentId: string | null = null) {
  const res = await inject(app, {
    method: 'POST',
    url: `/api/knowledge/bases/${baseId}/folders`,
    headers: { cookie },
    payload: { name, parentId },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>();
}

async function folderPaths(baseId: string): Promise<Map<string, string>> {
  const res = await inject(app, {
    method: 'GET',
    url: `/api/knowledge/bases/${baseId}/folders`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return new Map(res.json<Array<{ id: string; path: string }>>().map((f) => [f.id, f.path]));
}

describe('knowledge routes', () => {
  it('未登录访问知识路由返回 401', async () => {
    for (const url of [
      '/api/knowledge/bases',
      '/api/knowledge/model-profiles',
      '/api/knowledge/jobs',
    ]) {
      const res = await inject(app, { method: 'GET', url });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(401);
    }
  });

  it('建库 → 上传 → job 入队', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const res = await upload(base.id, '访问令牌需要定期轮换');
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json<{ documentId: string; jobId: string }>();
    expect(body.documentId).toMatch(/^kdoc_/);

    const job = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/jobs/${body.jobId}`,
      headers: { cookie },
    });
    expect(job.statusCode, job.body).toBe(200);
    expect(job.json()).toMatchObject({ type: 'ingest', status: 'queued' });

    const document = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${body.documentId}`,
      headers: { cookie },
    });
    expect(document.statusCode, document.body).toBe(200);
    expect(document.json()).toMatchObject({ title: 'notes', status: 'pending' });

    const jobRow = await app.pool.query<{ payload: { documentId: string } }>(
      'select payload from knowledge_jobs where id = $1',
      [body.jobId],
    );
    expect(jobRow.rows[0]?.payload.documentId).toBe(body.documentId);
  });

  it('任务列表只返回展示字段，列表查询不读 payload，单任务仍保留 payload', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const uploaded = await upload(base.id, '任务列表投影');
    expect(uploaded.statusCode, uploaded.body).toBe(202);
    const { documentId, jobId } = uploaded.json<{ documentId: string; jobId: string }>();

    const spy = vi.spyOn(app.pool, 'query');
    try {
      const list = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/jobs?baseId=${base.id}`,
        headers: { cookie },
      });
      expect(list.statusCode, list.body).toBe(200);
      const [item] = list.json<{ items: Array<Record<string, unknown>> }>().items;
      expect(Object.keys(item ?? {}).sort()).toEqual(
        [
          'id',
          'type',
          'status',
          'step',
          'progress',
          'attempts',
          'error',
          'result',
          'documentId',
          'sourceId',
          'documentTitle',
          'sourceName',
          'createdAt',
          'startedAt',
          'endedAt',
        ].sort(),
      );

      const detail = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/jobs/${jobId}`,
        headers: { cookie },
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({ id: jobId, type: 'ingest', status: 'queued' });

      const jobSelects = spy.mock.calls
        .map(([query]) => (typeof query === 'string' ? query : query.text))
        .filter((text) => /from "knowledge_jobs"/.test(text));
      expect(jobSelects).toHaveLength(2);
      expect(jobSelects[0]).not.toMatch(/"payload"/i);
      expect(jobSelects[1]).toMatch(/"payload"/i);
    } finally {
      spy.mockRestore();
    }

    const stored = await app.pool.query<{ payload: { documentId: string } }>(
      'select payload from knowledge_jobs where id = $1',
      [jobId],
    );
    expect(stored.rows[0]?.payload.documentId).toBe(documentId);
  });

  it('任务列表按 baseId 与 status 过滤', async () => {
    const embedding = await createProfile('embedding');
    const first = await createBase(embedding);
    const second = await createBase(embedding);
    const queued = await upload(first.id, '排队任务');
    expect(queued.statusCode, queued.body).toBe(202);
    const queuedId = queued.json<{ jobId: string }>().jobId;
    const failedId = `kjob_failed_${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_jobs (id, type, base_id, status, payload, error, ended_at)
       values ($1, 'reindex', $2, 'failed', $3::jsonb, 'boom', now())`,
      [
        failedId,
        first.id,
        JSON.stringify({ type: 'reindex', baseId: first.id, chunksOnly: false }),
      ],
    );
    const other = await upload(second.id, '其他库任务');
    expect(other.statusCode, other.body).toBe(202);
    const otherId = other.json<{ jobId: string }>().jobId;

    const ids = async (query: string) => {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/jobs?${query}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id);
    };

    expect((await ids(`baseId=${first.id}`)).sort()).toEqual([queuedId, failedId].sort());
    expect(await ids(`baseId=${first.id}&status=failed`)).toEqual([failedId]);
    expect(await ids(`baseId=${first.id}&status=queued`)).toEqual([queuedId]);
    expect(await ids(`baseId=${second.id}`)).toEqual([otherId]);
  });

  it('任务列表游标跨页覆盖同一时间戳的行', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const suffix = Math.random().toString(36).slice(2, 10);
    const jobIds = [1, 2, 3].map((n) => `kjob_cursor_${suffix}_${n}`);
    await app.pool.query(
      `insert into knowledge_jobs (id, type, base_id, status, payload, created_at)
       select id, 'cleanup', $1, 'queued', '{}'::jsonb, '2026-01-01T00:00:00Z'::timestamptz
       from unnest($2::text[]) as id`,
      [base.id, jobIds],
    );

    const getPage = async (cursor?: string) => {
      const params = new URLSearchParams({ baseId: base.id, limit: '2' });
      if (cursor) params.set('cursor', cursor);
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/jobs?${params}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
    };

    const first = await getPage();
    expect(first.items.map((item) => item.id)).toEqual([jobIds[2], jobIds[1]]);
    expect(first.nextCursor).toBe(jobIds[1]);
    const second = await getPage(first.nextCursor ?? undefined);
    expect(second.items.map((item) => item.id)).toEqual([jobIds[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it('检索命中；删除文档后不再召回', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const { documentId } = await seedReadyDocument(base.id, embedding, '访问 令牌 需要 定期 轮换');

    const hit = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${base.id}/search?q=${encodeURIComponent('令牌')}`,
      headers: { cookie },
    });
    expect(hit.statusCode, hit.body).toBe(200);
    const payload = hit.json<{ hits: Array<{ documentId: string }>; degraded: boolean }>();
    expect(payload.degraded).toBe(false);
    expect(payload.hits.map((h) => h.documentId)).toContain(documentId);

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/documents/${documentId}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const after = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${base.id}/search?q=${encodeURIComponent('令牌')}`,
      headers: { cookie },
    });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json<{ hits: unknown[] }>().hits).toHaveLength(0);
  });

  it('embedding 失败时检索降级为 degraded 并仍返回关键词结果', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    await seedReadyDocument(base.id, embedding, '访问 令牌 需要 定期 轮换');
    embeddingMode = 'fail';
    try {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/bases/${base.id}/search?q=${encodeURIComponent('令牌')}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      const payload = res.json<{ hits: unknown[]; degraded: boolean }>();
      expect(payload.degraded).toBe(true);
      expect(payload.hits.length).toBeGreaterThan(0);
    } finally {
      embeddingMode = 'ok';
    }
  });

  it('检索不会跨库召回', async () => {
    const embedding = await createProfile('embedding');
    const first = await createBase(embedding);
    const second = await createBase(embedding);
    await seedReadyDocument(second.id, embedding, '访问 令牌 需要 定期 轮换');
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${first.id}/search?q=${encodeURIComponent('令牌')}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ hits: unknown[] }>().hits).toHaveLength(0);
  });

  it('上传非法 base64 返回 400，且不建文档', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const before = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_documents where base_id = $1',
      [base.id],
    );
    const res = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/bases/${base.id}/documents/upload`,
      headers: { cookie },
      payload: { filename: 'x.md', mimeType: 'text/markdown', dataBase64: '!!!not-base64!!!' },
    });
    expect(res.statusCode, res.body).toBe(400);
    const after = await app.pool.query<{ count: string }>(
      'select count(*) from knowledge_documents where base_id = $1',
      [base.id],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('删除知识库同时删内置 server 并解绑专家', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const agent = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: {
        slug: `kb-agent-${Math.random().toString(36).slice(2, 10)}`,
        name: 'KB agent',
        systemPrompt: 'x',
        serverIds: [base.serverId],
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const agentId = agent.json<{ id: string }>().id;

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/bases/${base.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    baseIds.length = 0;

    const server = await app.pool.query('select id from servers where id = $1', [base.serverId]);
    expect(server.rowCount).toBe(0);
    const bound = await app.pool.query('select 1 from agent_servers where agent_id = $1', [
      agentId,
    ]);
    expect(bound.rowCount).toBe(0);
    await app.pool.query('delete from agents where id = $1', [agentId]);
  });

  it('取消排队任务直接写终态，运行中任务只发 cancel key 并保持 running', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const queued = await upload(base.id, '排队取消');
    expect(queued.statusCode, queued.body).toBe(202);
    const queuedJobId = queued.json<{ jobId: string }>().jobId;

    const cancelled = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/jobs/${queuedJobId}/cancel`,
      headers: { cookie },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    const endedAt = await app.pool.query<{ ended_at: string | null }>(
      'select ended_at from knowledge_jobs where id = $1',
      [queuedJobId],
    );
    expect(endedAt.rows[0]?.ended_at).not.toBeNull();

    // 运行中：API 不能自己把 DB 改成 cancelled，否则 worker 还在跑却显示已取消。
    const runningJobId = `kjob_run${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_jobs (id, type, base_id, status, payload, started_at)
       values ($1, 'reindex', $2, 'running', $3::jsonb, now())`,
      [
        runningJobId,
        base.id,
        JSON.stringify({ type: 'reindex', baseId: base.id, chunksOnly: true }),
      ],
    );
    const redis = new Redis(testConfig().REDIS_URL);
    try {
      const running = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/jobs/${runningJobId}/cancel`,
        headers: { cookie },
      });
      expect(running.statusCode, running.body).toBe(200);
      expect(running.json()).toMatchObject({ status: 'running' });
      const row = await app.pool.query<{ status: string }>(
        'select status from knowledge_jobs where id = $1',
        [runningJobId],
      );
      expect(row.rows[0]?.status).toBe('running');
      expect(await redis.get(`knowledge:${runningJobId}:cancel`)).toBe('1');

      const finished = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/jobs/${queuedJobId}/cancel`,
        headers: { cookie },
      });
      expect(finished.statusCode, finished.body).toBe(409);
    } finally {
      await redis.del(`knowledge:${runningJobId}:cancel`).catch(() => undefined);
      await redis.quit();
    }
  });

  it('新增分块要求当前版本指针，拒绝伪造旧版本，序号取整版最大值', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const target = await seedReadyDocument(base.id, embedding, '目标 文档');
    const other = await seedReadyDocument(base.id, embedding, '其他 文档');

    // 不传 expectedVersionId 是入口校验失败。
    const missing = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${target.documentId}/chunks`,
      headers: { cookie },
      payload: { content: '越权写入' },
    });
    expect(missing.statusCode, missing.body).toBe(400);

    // 传别的文档版本指针不能覆盖当前指针。
    const foreign = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${target.documentId}/chunks`,
      headers: { cookie },
      payload: { expectedVersionId: other.versionId, content: '越权写入' },
    });
    expect(foreign.statusCode, foreign.body).toBe(409);
    expect(foreign.json()).toMatchObject({ code: 'CONFLICT_STALE' });

    // 超过单页 200 条后，序号仍必须接在整版最大值之后。
    await app.pool.query(
      `insert into knowledge_chunks (id, base_id, document_id, version_id, ordinal, kind, content, search_text)
       select 'kchk_bulk_' || g, $1, $2, $3, g + 1, 'text', 'bulk', 'bulk'
       from generate_series(0, 249) g`,
      [base.id, target.documentId, target.versionId],
    );
    const created = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${target.documentId}/chunks`,
      headers: { cookie },
      payload: { expectedVersionId: target.versionId, content: '人工补充' },
    });
    expect(created.statusCode, created.body).toBe(201);
    // 种子行是 0，批量插入 1..250；新版按原顺序克隆后追加，序号接在尾部。
    expect(created.json<{ chunk: { ordinal: number } }>().chunk.ordinal).toBe(251);
  });

  it('重建拒绝其他知识库的文档', async () => {
    const embedding = await createProfile('embedding');
    const first = await createBase(embedding);
    const second = await createBase(embedding);
    const { documentId } = await seedReadyDocument(second.id, embedding, '另一个库');

    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${first.id}/rebuild`,
      headers: { cookie },
      payload: { documentIds: [documentId] },
    });
    expect(res.statusCode, res.body).toBe(400);
    const jobs = await app.pool.query<{ count: string }>(
      "select count(*)::text as count from knowledge_jobs where base_id = $1 and type = 'reindex'",
      [first.id],
    );
    expect(jobs.rows[0]?.count).toBe('0');
  });

  it('重建多个合法文档只做一次归属查询且只取 id', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const first = await upload(base.id, '文档一', 'one.md');
    const second = await upload(base.id, '文档二', 'two.md');
    expect(first.statusCode, first.body).toBe(202);
    expect(second.statusCode, second.body).toBe(202);
    const documentIds = [
      first.json<{ documentId: string }>().documentId,
      second.json<{ documentId: string }>().documentId,
    ];

    const { res, selects } = await rebuildCapturingDocumentSelects(base.id, {
      documentIds,
      chunksOnly: true,
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(selects).toHaveLength(1);
    const sql = selects[0]?.replace(/\s+/g, ' ') ?? '';
    expect(sql).toMatch(/^select "id" from "knowledge_documents"/i);
    expect(sql).not.toMatch(/"metadata"|"content_hash"/i);

    const jobs = await app.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from knowledge_jobs where base_id = $1 and type = 'reindex'",
      [base.id],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.payload).toEqual({
      type: 'reindex',
      baseId: base.id,
      documentIds,
      chunksOnly: true,
      confirmOverwriteManualChunks: false,
    });
  });

  it('重建混合跨库或缺失文档仍 400 且不入队', async () => {
    const embedding = await createProfile('embedding');
    const first = await createBase(embedding);
    const second = await createBase(embedding);
    const own = await upload(first.id, '本库文档', 'own.md');
    const foreign = await upload(second.id, '外库文档', 'foreign.md');
    expect(own.statusCode, own.body).toBe(202);
    expect(foreign.statusCode, foreign.body).toBe(202);
    const ownId = own.json<{ documentId: string }>().documentId;
    const foreignId = foreign.json<{ documentId: string }>().documentId;

    const cross = await rebuildCapturingDocumentSelects(first.id, {
      documentIds: [ownId, foreignId],
    });
    expect(cross.res.statusCode, cross.res.body).toBe(400);
    expect(cross.res.json<{ code: string; message: string }>()).toMatchObject({
      code: 'INVALID_INPUT',
      message: '存在不属于该知识库的文档',
    });
    expect(cross.selects).toHaveLength(1);

    const missing = await rebuildCapturingDocumentSelects(first.id, {
      documentIds: [ownId, 'kdoc_missing'],
    });
    expect(missing.res.statusCode, missing.res.body).toBe(400);
    expect(missing.res.json<{ code: string; message: string }>()).toMatchObject({
      code: 'INVALID_INPUT',
      message: '存在不属于该知识库的文档',
    });
    expect(missing.selects).toHaveLength(1);

    const jobs = await app.pool.query<{ count: string }>(
      "select count(*)::text as count from knowledge_jobs where base_id = $1 and type = 'reindex'",
      [first.id],
    );
    expect(jobs.rows[0]?.count).toBe('0');
  });

  it('重建重复文档只做一次归属查询并保留原数组入队', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const uploaded = await upload(base.id, '重复文档');
    expect(uploaded.statusCode, uploaded.body).toBe(202);
    const documentId = uploaded.json<{ documentId: string }>().documentId;

    const { res, selects } = await rebuildCapturingDocumentSelects(base.id, {
      documentIds: [documentId, documentId],
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(selects).toHaveLength(1);

    const jobs = await app.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from knowledge_jobs where base_id = $1 and type = 'reindex'",
      [base.id],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.payload).toEqual({
      type: 'reindex',
      baseId: base.id,
      documentIds: [documentId, documentId],
      chunksOnly: false,
      confirmOverwriteManualChunks: false,
    });
  });

  it('重建空数组不查询文档并以空数组入队', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);

    const { res, selects } = await rebuildCapturingDocumentSelects(base.id, { documentIds: [] });
    expect(res.statusCode, res.body).toBe(202);
    expect(selects).toHaveLength(0);

    const jobs = await app.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from knowledge_jobs where base_id = $1 and type = 'reindex'",
      [base.id],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.payload).toEqual({
      type: 'reindex',
      baseId: base.id,
      documentIds: [],
      chunksOnly: false,
      confirmOverwriteManualChunks: false,
    });
  });

  it('重建缺省 documentIds 不查询且不传该属性', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);

    const { res, selects } = await rebuildCapturingDocumentSelects(base.id, { chunksOnly: true });
    expect(res.statusCode, res.body).toBe(202);
    expect(selects).toHaveLength(0);

    const jobs = await app.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from knowledge_jobs where base_id = $1 and type = 'reindex'",
      [base.id],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.payload).toEqual({
      type: 'reindex',
      baseId: base.id,
      chunksOnly: true,
      confirmOverwriteManualChunks: false,
    });
  });

  it('模型端点保存与测试都走 SSRF 边界，allowlist 内网主机放行', async () => {
    const blocked = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: `blocked-${Math.random().toString(36).slice(2, 8)}`,
        endpointUrl: 'http://10.9.8.7:8080/v1',
        model: 'm',
      },
    });
    expect(blocked.statusCode, blocked.body).toBe(400);
    expect(blocked.json<{ code: string }>().code).toBe('INVALID_URL');

    const second = await startApp({
      KNOWLEDGE_DIR: knowledgeDir,
      KNOWLEDGE_PRIVATE_HOST_ALLOWLIST: '10.9.8.7:8080',
    });
    try {
      const secondCookie = await loginCookie(second);
      const allowed = await inject(second, {
        method: 'POST',
        url: '/api/knowledge/model-profiles',
        headers: { cookie: secondCookie },
        payload: {
          kind: 'embedding',
          name: `allowed-${Math.random().toString(36).slice(2, 8)}`,
          endpointUrl: 'http://10.9.8.7:8080/v1',
          model: 'm',
        },
      });
      expect(allowed.statusCode, allowed.body).toBe(201);
      profileIds.push(allowed.json<{ id: string }>().id);
    } finally {
      await second.close();
    }

    // 存量行不经过创建校验：测试端点必须再拦一次，不能成为内网探针。
    const storedId = `kmp_${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_model_profiles (id, kind, name, endpoint_url, model, dimensions)
       values ($1, 'embedding', $2, 'http://10.9.8.7:8080/v1', 'm', 1024)`,
      [storedId, `stored-${storedId}`],
    );
    profileIds.push(storedId);
    const tested = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/model-profiles/${storedId}/test`,
      headers: { cookie },
    });
    expect(tested.statusCode, tested.body).toBe(400);
    expect(tested.json<{ code: string }>().code).toBe('INVALID_URL');
  });

  it('文件夹改名转义 LIKE 通配符，不误改相邻子树', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const cases = [
      { name: 'a_', sibling: 'ab' },
      { name: 'x%y', sibling: 'xzzzy' },
      { name: 'p\\q', sibling: 'pq' },
    ];
    const roots: Array<{
      id: string;
      childId: string;
      siblingId: string;
      siblingChildId: string;
    }> = [];
    for (const [index, item] of cases.entries()) {
      const root = await createFolder(base.id, item.name);
      const child = await createFolder(base.id, `child-${index}`, root.id);
      const sibling = await createFolder(base.id, item.sibling);
      const siblingChild = await createFolder(base.id, `sibling-${index}`, sibling.id);
      roots.push({
        id: root.id,
        childId: child.id,
        siblingId: sibling.id,
        siblingChildId: siblingChild.id,
      });
    }

    for (const [index] of cases.entries()) {
      const res = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/folders/${roots[index]!.id}`,
        headers: { cookie },
        payload: { name: `renamed-${index}` },
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    const paths = await folderPaths(base.id);
    for (const [index, item] of cases.entries()) {
      expect(paths.get(roots[index]!.id)).toBe(`/renamed-${index}`);
      expect(paths.get(roots[index]!.childId)).toBe(`/renamed-${index}/child-${index}`);
      expect(paths.get(roots[index]!.siblingId)).toBe(`/${item.sibling}`);
      expect(paths.get(roots[index]!.siblingChildId)).toBe(`/${item.sibling}/sibling-${index}`);
    }
  });

  it('文件夹改名按字符计算前缀，emoji 子路径不被截断', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const root = await createFolder(base.id, '🚀');
    const child = await createFolder(base.id, '子', root.id);

    const res = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/folders/${root.id}`,
      headers: { cookie },
      payload: { name: 'rocket' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const paths = await folderPaths(base.id);
    expect(paths.get(root.id)).toBe('/rocket');
    expect(paths.get(child.id)).toBe('/rocket/子');
  });

  it('同时改名和移动冲突时整体回滚，不留下中间位置', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const a = await createFolder(base.id, 'A');
    const aChild = await createFolder(base.id, 'a-child', a.id);
    const b = await createFolder(base.id, 'B');
    const target = await createFolder(base.id, 'target', b.id);

    const res = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/folders/${a.id}`,
      headers: { cookie },
      payload: { parentId: b.id, name: 'target' },
    });
    expect(res.statusCode, res.body).toBe(409);

    const paths = await folderPaths(base.id);
    expect(paths.get(a.id)).toBe('/A');
    expect(paths.get(aChild.id)).toBe('/A/a-child');
    expect(paths.get(b.id)).toBe('/B');
    expect(paths.get(target.id)).toBe('/B/target');
  });

  it('重解析统计全部人工编辑分块，分页外的人工块也触发确认', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const { documentId, versionId } = await seedReadyDocument(base.id, embedding, '基础 分块');
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text, edited_by_user)
       select 'kchk_manual_' || g, $1, $2, $3, g + 1, 'text', 'bulk', 'bulk', g = 249
       from generate_series(0, 249) g`,
      [base.id, documentId, versionId],
    );

    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${documentId}/reprocess`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ message: string }>().message).toContain('1 个');

    const confirmed = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/${documentId}/reprocess`,
      headers: { cookie },
      payload: { confirmOverwriteManualChunks: true },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(202);
  });

  it('分块列表返回展示字段，响应不含向量', async () => {
    const embedding = await createProfile('embedding');
    const base = await createBase(embedding);
    const { documentId } = await seedReadyDocument(base.id, embedding, '访问 令牌 需要 定期 轮换');

    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/documents/${documentId}/chunks`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [chunk] = res.json<{ items: Array<Record<string, unknown>> }>().items;
    expect(chunk).not.toHaveProperty('embedding');
    expect(Object.keys(chunk ?? {}).sort()).toEqual(
      [
        'content',
        'documentId',
        'editedByUser',
        'enabled',
        'heading',
        'id',
        'indexRole',
        'kind',
        'locator',
        'metadata',
        'ordinal',
        'pageFrom',
        'pageTo',
        'parentOrdinal',
        'versionId',
      ].sort(),
    );
  });
});
