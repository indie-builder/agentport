import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, repo } from '@agentport/db';
import {
  KNOWLEDGE_JOBS_QUEUE,
  knowledgeCancelKey,
  knowledgeEnqueueOptions,
} from '@agentport/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  KnowledgeCancelled,
  type KnowledgeConnector,
} from '../../worker/src/knowledge/ingestion.js';
import { startKnowledgeWorker } from '../../worker/src/knowledge/queue.js';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { buildApp } from '../src/app.js';
import {
  type FastifyInstance,
  infraReady,
  inject,
  loginAs,
  loginCookie,
  testConfig,
  unique,
} from './helpers.js';

const ready = await infraReady;

const JOB_KEYS = [
  'id',
  'type',
  'status',
  'step',
  'progress',
  'attempts',
  'error',
  'documentId',
  'sourceId',
  'documentTitle',
  'sourceName',
  'createdAt',
  'startedAt',
  'endedAt',
].sort();

describe.skipIf(!ready)('knowledge job projections', () => {
  let app: FastifyInstance;
  let cookie = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function createBase(): Promise<string> {
    const profile = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('jobs-emb'),
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
      payload: {
        slug: unique('jobs-kb'),
        name: '任务库',
        embeddingProfileId: profileIds.at(-1),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const baseId = res.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  async function seedDocument(baseId: string, id: string, title: string) {
    await app.pool.query(
      `insert into knowledge_documents (id, base_id, title, source_type, mime_type, size_bytes)
       values ($1, $2, $3, 'upload', 'text/markdown', 12)`,
      [id, baseId, title],
    );
  }

  async function seedSource(baseId: string, id: string, name: string) {
    await app.pool.query(
      `insert into knowledge_sources (id, base_id, type, name, config)
       values ($1, $2, 'gitlab', $3, $4::jsonb)`,
      [id, baseId, name, JSON.stringify({ token: 'SOURCE_CONFIG_SECRET' })],
    );
  }

  async function seedJob(input: {
    id: string;
    baseId: string;
    type?: 'ingest' | 'reindex' | 'sync' | 'wiki_generate' | 'cleanup';
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    documentId?: string | null;
    sourceId?: string | null;
    createdAt?: string;
    payload?: Record<string, unknown>;
  }) {
    await app.pool.query(
      `insert into knowledge_jobs
         (id, type, base_id, document_id, source_id, status, payload, created_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, coalesce($8::timestamptz, now()))`,
      [
        input.id,
        input.type ?? 'ingest',
        input.baseId,
        input.documentId ?? null,
        input.sourceId ?? null,
        input.status ?? 'queued',
        JSON.stringify(input.payload ?? { type: 'cleanup', baseId: input.baseId }),
        input.createdAt ?? null,
      ],
    );
  }

  async function list(query: string) {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/jobs?${query}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>();
  }

  beforeAll(async () => {
    app = await buildApp(testConfig());
    await app.ready();
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
  });

  it('列表补齐文档/来源名字，但不暴露 payload、正文与来源配置', async () => {
    const baseId = await createBase();
    const suffix = Math.random().toString(36).slice(2, 8);
    const documentId = `kdoc_jobs_${suffix}`;
    const sourceId = `ksrc_jobs_${suffix}`;
    await seedDocument(baseId, documentId, '合同正文');
    await seedSource(baseId, sourceId, '内部 GitLab');
    await seedJob({
      id: `kjob_doc_${suffix}`,
      baseId,
      documentId,
      payload: { type: 'ingest', documentId, secret: 'PAYLOAD_SECRET' },
    });
    await seedJob({
      id: `kjob_src_${suffix}`,
      baseId,
      type: 'sync',
      sourceId,
      payload: { type: 'sync', sourceId, syncRunId: 'ksyn_missing' },
    });

    const spy = vi.spyOn(app.pool, 'query');
    let body: Awaited<ReturnType<typeof list>>;
    let selects: string[] = [];
    try {
      body = await list(`baseId=${baseId}`);
      selects = spy.mock.calls
        .map(([query]) => (typeof query === 'string' ? query : query.text))
        .filter((text) => /from "knowledge_jobs"/.test(text));
    } finally {
      spy.mockRestore();
    }

    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(JOB_KEYS);
    const documentJob = body.items.find((item) => item.documentId === documentId);
    expect(documentJob).toMatchObject({
      documentId,
      documentTitle: '合同正文',
      sourceId: null,
      sourceName: null,
    });
    const sourceJob = body.items.find((item) => item.sourceId === sourceId);
    expect(sourceJob).toMatchObject({
      documentId: null,
      documentTitle: null,
      sourceId,
      sourceName: '内部 GitLab',
    });

    const wire = JSON.stringify(body);
    expect(wire).not.toContain('PAYLOAD_SECRET');
    expect(wire).not.toContain('SOURCE_CONFIG_SECRET');
    expect(wire).not.toContain('payload');

    expect(selects.length).toBeGreaterThan(0);
    for (const text of selects) expect(text).not.toMatch(/"payload"/i);
  });

  it('documentId 与 base/status/cursor/limit 同时生效，且不跨库', async () => {
    const first = await createBase();
    const second = await createBase();
    const suffix = Math.random().toString(36).slice(2, 8);
    const documentA = `kdoc_page_a_${suffix}`;
    const documentB = `kdoc_page_b_${suffix}`;
    const documentOther = `kdoc_page_other_${suffix}`;
    await seedDocument(first, documentA, '文档 A');
    await seedDocument(first, documentB, '文档 B');
    await seedDocument(second, documentOther, '跨库文档');

    const sameTime = '2026-01-01T00:00:00Z';
    const pageIds = [1, 2, 3].map((n) => `kjob_page_${suffix}_${n}`);
    for (const id of pageIds) {
      await seedJob({ id, baseId: first, documentId: documentA, createdAt: sameTime });
    }
    const failedId = `kjob_page_failed_${suffix}`;
    await seedJob({ id: failedId, baseId: first, documentId: documentA, status: 'failed' });
    await seedJob({ id: `kjob_page_b_${suffix}`, baseId: first, documentId: documentB });
    await seedJob({ id: `kjob_page_cross_${suffix}`, baseId: second, documentId: documentOther });

    const allForDocument = await list(`baseId=${first}&documentId=${documentA}`);
    expect(allForDocument.items.map((item) => item.id).sort()).toEqual(
      [...pageIds, failedId].sort(),
    );

    const failed = await list(`baseId=${first}&documentId=${documentA}&status=failed`);
    expect(failed.items.map((item) => item.id)).toEqual([failedId]);

    const crossBase = await list(`baseId=${first}&documentId=${documentOther}`);
    expect(crossBase.items).toEqual([]);

    const firstPage = await list(`baseId=${first}&documentId=${documentA}&limit=2`);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await list(
      `baseId=${first}&documentId=${documentA}&limit=2&cursor=${firstPage.nextCursor}`,
    );
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();
    const seen = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...pageIds, failedId].sort());
  });

  it('单任务 get 与 cancel 都带四个字段，名字可为 null', async () => {
    const baseId = await createBase();
    const suffix = Math.random().toString(36).slice(2, 8);
    const documentId = `kdoc_single_${suffix}`;
    const sourceId = `ksrc_single_${suffix}`;
    const jobId = `kjob_single_${suffix}`;
    await seedDocument(baseId, documentId, '单任务文档');
    await seedSource(baseId, sourceId, '单任务来源');
    await seedJob({ id: jobId, baseId, documentId, sourceId });

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/jobs/${jobId}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const job = detail.json<Record<string, unknown>>();
    expect(Object.keys(job).sort()).toEqual(JOB_KEYS);
    expect(job).toMatchObject({ documentId, sourceId, documentTitle: null, sourceName: null });

    const cancelled = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/jobs/${jobId}/cancel`,
      headers: { cookie },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const cancelledJob = cancelled.json<Record<string, unknown>>();
    expect(Object.keys(cancelledJob).sort()).toEqual(JOB_KEYS);
    expect(cancelledJob).toMatchObject({
      status: 'cancelled',
      documentId,
      sourceId,
      documentTitle: null,
      sourceName: null,
    });
  });
});

// 排队取消与认领的竞争必须在独享库上按真实行锁顺序验证，不能靠 sleep 猜时序。
const raceDatabase = await createIsolatedDatabase(
  'api_knowledge_cancel_race',
  process.env.DATABASE_URL ?? '',
);
const raceReady = ready && raceDatabase !== null;
if (!raceReady) await raceDatabase?.close();

describe.skipIf(!raceReady)('queued cancel loses to a claimed sync job', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';

  const redisUrl = process.env.REDIS_URL ?? '';
  const prefix = `knowledge-cancel-race-${Math.random().toString(36).slice(2, 10)}`;
  const quietLogger = (() => {
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
    return { ...logger, child: () => logger } as unknown as Parameters<
      typeof startKnowledgeWorker
    >[0]['logger'];
  })();

  beforeAll(async () => {
    if (!raceDatabase) throw new Error('isolated database unavailable');
    const url = raceDatabase.url;
    app = await buildApp(testConfig({ DATABASE_URL: url }));
    await app.ready();
    const config = testConfig({ DATABASE_URL: url });
    cookie = await loginAs(app, config.ADMIN_USER, config.ADMIN_PASSWORD);
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-cancel-race-'));
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await rm(knowledgeDir, { recursive: true, force: true }).catch(() => undefined);
      await raceDatabase?.close();
    }
  });

  async function seedSyncPair(): Promise<{ sourceId: string; jobId: string; runId: string }> {
    const suffix = Math.random().toString(36).slice(2, 8);
    const serverId = newId('server');
    await app.pool.query(
      `insert into servers (id, name, kind, config) values ($1, $2, 'knowledge', '{}')`,
      [serverId, `race-${suffix}`],
    );
    const profileId = newId('knowledgeModelProfile');
    await app.pool.query(
      `insert into knowledge_model_profiles (id, kind, name, endpoint_url, model, dimensions, enabled)
       values ($1, 'embedding', $2, 'http://127.0.0.1:1', 'test', 1024, true)`,
      [profileId, `race-${suffix}`],
    );
    const baseId = newId('knowledgeBase');
    await app.pool.query(
      `insert into knowledge_bases (id, slug, name, description, server_id, embedding_profile_id, settings)
       values ($1, $2, 'race', '', $3, $4, $5::jsonb)`,
      [
        baseId,
        `race-${suffix}`,
        serverId,
        profileId,
        JSON.stringify({ chunkTokens: 400, chunkOverlap: 40, wikiAutoUpdate: false }),
      ],
    );
    const source = await repo.knowledge.createSource(app.db, {
      baseId,
      type: 'feed',
      name: `race-${suffix}`,
      config: { syncDeletions: false },
      secretsEncrypted: null,
      syncCron: null,
    });
    await repo.knowledge.replaceRanges(app.db, source.id, [
      { kind: 'feed', externalId: 'https://example.com/feed', ref: null, paths: [], enabled: true },
    ]);
    const created = await repo.knowledge.createSyncJob(app.db, source.id);
    if (created.status !== 'created') throw new Error(`pair not created: ${created.status}`);
    return { sourceId: source.id, jobId: created.job.id, runId: created.run.id };
  }

  /**
   * 等待真实行锁事件：claim 先锁 job 再锁 sync run，取消的 CAS 只能等 claim 提交。
   * 计数只含本库会话的未授予 transactionid/tuple 锁，不按时间猜竞争次序。
   */
  async function waitForWaitingRowLocks(expected: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await app.pool.query<{ waiting: string }>(
        `select count(*) as waiting
           from pg_locks l
           join pg_stat_activity a on a.pid = l.pid
          where not l.granted and l.locktype in ('transactionid', 'tuple')
            and a.datname = current_database()`,
      );
      if (Number(rows[0]?.waiting ?? 0) >= expected) return;
      if (Date.now() > deadline) {
        const locks = await app.pool.query(
          `select l.pid, l.locktype, l.mode, l.granted, l.relation::regclass::text as relation,
                  a.state, a.wait_event_type, a.wait_event, left(a.query, 120) as query
             from pg_locks l
             join pg_stat_activity a on a.pid = l.pid
            where a.datname = current_database()
            order by l.granted, l.pid`,
        );
        throw new Error(
          `did not observe ${expected} waiting row lock(s): ${JSON.stringify(locks.rows)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForJobStatus(jobId: string, statuses: string[]) {
    const deadline = Date.now() + 15_000;
    let row = await repo.knowledge.getJob(app.db, jobId);
    while (!statuses.includes(row?.status ?? '') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = await repo.knowledge.getJob(app.db, jobId);
    }
    return row;
  }

  it('publishes the worker cancel signal when the queued CAS loses and the worker settles the pair', async () => {
    const { sourceId, jobId, runId } = await seedSyncPair();
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const connector: KnowledgeConnector = {
      async *sync(input) {
        enteredResolve();
        await new Promise<never>((_, reject) => {
          if (input.signal.aborted) {
            reject(new KnowledgeCancelled());
            return;
          }
          input.signal.addEventListener('abort', () => reject(new KnowledgeCancelled()), {
            once: true,
          });
        });
      },
    };

    const locker = await app.pool.connect();
    const worker = await startKnowledgeWorker({
      db: app.db,
      logger: quietLogger,
      redisUrl,
      prefix,
      knowledgeDir,
      decrypt: () => ({}),
      connectors: { feed: connector },
    });
    const queue = new Queue(KNOWLEDGE_JOBS_QUEUE, { connection: { url: redisUrl }, prefix });
    const redis = new Redis(redisUrl);
    let released = false;
    try {
      // 锁住 sync run：claim 先成功锁住 job（尚未提交），再卡在 run；API 的 CAS 只能等 claim 提交。
      await locker.query('begin');
      await locker.query('select 1 from knowledge_sync_runs where id = $1 for update', [runId]);
      await queue.add('knowledge', { jobId }, knowledgeEnqueueOptions(jobId));
      await waitForWaitingRowLocks(1);

      const cancelPromise = inject(app, {
        method: 'POST',
        url: `/api/knowledge/jobs/${jobId}/cancel`,
        headers: { cookie },
      });
      // 第二个等锁事件证明 API 已读到 queued 并进入 finishJob 的 CAS UPDATE。
      await waitForWaitingRowLocks(2);
      await locker.query('rollback');
      released = true;

      const cancelResponse = await cancelPromise;
      expect(cancelResponse.statusCode, cancelResponse.body).toBe(200);
      // 输给认领时不能写终态：返回 claimed 的 running 行并只发 cancel 信号。
      expect(cancelResponse.json<Record<string, unknown>>()).toMatchObject({ status: 'running' });
      expect(await redis.get(knowledgeCancelKey(jobId))).toBe('1');
      expect((await repo.knowledge.getJob(app.db, jobId))?.status).toBe('running');

      await entered;
      const finished = await waitForJobStatus(jobId, ['cancelled', 'failed']);
      expect(finished).toMatchObject({ status: 'cancelled', error: 'cancelled' });

      const runs = await repo.knowledge.listSyncRuns(app.db, sourceId);
      const run = runs.items.find((item) => item.id === runId);
      expect(run).toMatchObject({ status: 'cancelled', error: 'cancelled' });
      expect(run?.endedAt).toBeInstanceOf(Date);
      const source = await repo.knowledge.getSource(app.db, sourceId);
      expect(source).toMatchObject({
        cursor: {},
        lastSyncStatus: 'cancelled',
        lastError: 'cancelled',
      });
    } finally {
      if (!released) await locker.query('rollback').catch(() => undefined);
      locker.release();
      await queue.close();
      await worker.close();
      redis.disconnect();
    }
  }, 30_000);
});
