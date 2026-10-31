import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { createDb } from '../src/client.js';
import * as knowledge from '../src/repo/knowledge.js';
import { knowledgeJobs } from '../src/schema.js';

const isolated = await createIsolatedDatabase(
  'db_knowledge_lifecycle',
  process.env.DATABASE_URL ?? '',
);
const { db, pool } = createDb(
  isolated?.url ?? process.env.DATABASE_URL ?? 'postgres://unreachable@127.0.0.1:1/unavailable',
);
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const suffix = (): string => randomUUID().replaceAll('-', '').slice(0, 8);

let serverId = '';
let profileId = '';
let baseId = '';
let sourceId = '';
const cleanups: Array<() => Promise<void>> = [];

async function makeSource(): Promise<string> {
  const source = await knowledge.createSource(db, {
    baseId,
    type: 'feed',
    name: `feed-${suffix()}`,
    config: {},
    secretsEncrypted: null,
    syncCron: null,
  });
  return source.id;
}

async function createdPair(id = sourceId) {
  const created = await knowledge.createSyncJob(db, id);
  if (created.status !== 'created') throw new Error(`pair not created: ${created.status}`);
  return created;
}

async function injectFailure(
  kind: 'job_insert' | 'run_update' | 'source_update' | 'source_cursor',
  runId?: string,
) {
  const name = `knowledge_fault_${suffix()}`;
  const table =
    kind === 'job_insert'
      ? 'knowledge_jobs'
      : kind === 'run_update'
        ? 'knowledge_sync_runs'
        : 'knowledge_sources';
  const event = kind === 'job_insert' ? 'insert' : 'update';
  let condition: string;
  if (kind === 'job_insert') condition = `new.source_id = '${sourceId}'`;
  else if (kind === 'run_update') condition = `new.id = '${runId ?? ''}'`;
  else if (kind === 'source_cursor')
    condition = `new.id = '${sourceId}' and new.cursor is distinct from old.cursor`;
  else condition = `new.id = '${sourceId}'`;
  await pool.query(
    `create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'injected ${kind} failure'; end $$`,
  );
  await pool.query(
    `create trigger ${name}_trg before ${event} on ${table} for each row when (${condition}) execute function ${name}()`,
  );
  cleanups.push(async () => {
    await pool.query(`drop trigger if exists ${name}_trg on ${table}`);
    await pool.query(`drop function if exists ${name}()`);
  });
}

async function expectInjectedFailure(promise: Promise<unknown>, marker: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    let current = error as { message?: string; cause?: unknown } | undefined;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      if (String(current.message ?? '').includes(marker)) return true;
      current = current.cause as { message?: string; cause?: unknown } | undefined;
    }
    return false;
  });
}

async function rowsOf(source: string) {
  const [job] = await db
    .select()
    .from(knowledgeJobs)
    .where(eq(knowledgeJobs.sourceId, source))
    .limit(1);
  const runs = await knowledge.listSyncRuns(db, source);
  const row = await knowledge.getSource(db, source);
  return { job: job ?? null, run: runs.items[0] ?? null, source: row };
}

describe.skipIf(!ready)('knowledge sync lifecycle atomicity', () => {
  beforeAll(async () => {
    serverId = `srv_life_${suffix()}`;
    profileId = `kmp_life_${suffix()}`;
    baseId = `kbase_life_${suffix()}`;
    await pool.query(
      `insert into servers (id, name, kind, config) values ($1, $2, 'knowledge', '{}')`,
      [serverId, `life-${suffix()}`],
    );
    await pool.query(
      `insert into knowledge_model_profiles (id, kind, name, endpoint_url, model, dimensions, enabled)
       values ($1, 'embedding', $2, 'http://127.0.0.1:1', 'test', 1024, true)`,
      [profileId, `life-${suffix()}`],
    );
    await pool.query(
      `insert into knowledge_bases (id, slug, name, description, server_id, embedding_profile_id, settings)
       values ($1, $2, 'life', '', $3, $4, '{"chunkTokens":400,"chunkOverlap":40,"wikiAutoUpdate":false}')`,
      [baseId, `life-${suffix()}`, serverId, profileId],
    );
  });

  beforeEach(async () => {
    sourceId = await makeSource();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    await pool.query('delete from knowledge_sources where id = $1', [sourceId]);
  });

  afterAll(async () => {
    await pool.query('delete from knowledge_bases where id = $1', [baseId]);
    await pool.query('delete from knowledge_model_profiles where id = $1', [profileId]);
    await pool.query('delete from servers where id = $1', [serverId]);
    await pool.end();
    await isolated?.close();
  });

  it('creates the queued pair atomically and leaves no run when the job insert fails', async () => {
    await injectFailure('job_insert');
    await expectInjectedFailure(knowledge.createSyncJob(db, sourceId), 'injected job_insert');
    expect(await knowledge.listSyncRuns(db, sourceId)).toMatchObject({ items: [] });
    expect(await rowsOf(sourceId)).toMatchObject({ job: null, run: null });

    for (const cleanup of cleanups.splice(0)) await cleanup();
    const pair = await createdPair();
    expect(pair.job).toMatchObject({ type: 'sync', status: 'queued', sourceId });
    expect(pair.run).toMatchObject({ status: 'queued', cursorBefore: {} });
  });

  it('distinguishes missing, non-active and in-flight sources', async () => {
    expect(await knowledge.createSyncJob(db, 'ksrc_missing')).toEqual({ status: 'not_found' });
    await knowledge.updateSource(db, sourceId, { status: 'paused' });
    expect(await knowledge.createSyncJob(db, sourceId)).toEqual({ status: 'not_active' });
    await knowledge.updateSource(db, sourceId, { status: 'active' });
    await createdPair();
    expect(await knowledge.createSyncJob(db, sourceId)).toEqual({ status: 'in_progress' });
  });

  it('serializes concurrent creation for one source while different sources stay independent', async () => {
    const other = await makeSource();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => knowledge.createSyncJob(db, sourceId)),
    );
    expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'in_progress')).toHaveLength(4);
    expect((await knowledge.listSyncRuns(db, sourceId)).items).toHaveLength(1);

    const createdOther = await knowledge.createSyncJob(db, other);
    expect(createdOther.status).toBe('created');
    await pool.query('delete from knowledge_sources where id = $1', [other]);
  });

  it('claims the job and moves its queued run to running in the same transaction', async () => {
    const pair = await createdPair();
    const claims = await Promise.all([
      knowledge.claimJob(db, pair.job.id),
      knowledge.claimJob(db, pair.job.id),
      knowledge.claimJob(db, pair.job.id),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const { job, run } = await rowsOf(sourceId);
    expect(job).toMatchObject({ status: 'running', attempts: 1 });
    expect(run).toMatchObject({ status: 'running' });
    expect(run?.startedAt).toBeInstanceOf(Date);
    const started = run?.startedAt?.getTime();
    expect(await knowledge.claimJob(db, pair.job.id)).toBeNull();
    expect((await rowsOf(sourceId)).run?.startedAt?.getTime()).toBe(started);
  });

  it('commits job, run and source cursor together on success and refuses a second finish', async () => {
    const pair = await createdPair();
    await knowledge.claimJob(db, pair.job.id);
    const finished = await knowledge.finishJob(db, pair.job.id, {
      status: 'succeeded',
      result: {
        cursorAfter: { page: 1 },
        stats: { listed: 2, created: 1, updated: 1, disabled: 0, failed: 0 },
      },
    });
    expect(finished).toMatchObject({ status: 'succeeded' });
    let rows = await rowsOf(sourceId);
    expect(rows.run).toMatchObject({
      status: 'succeeded',
      cursorAfter: { page: 1 },
      error: null,
      stats: { listed: 2, created: 1, updated: 1, disabled: 0, failed: 0 },
    });
    expect(rows.run?.endedAt).toBeInstanceOf(Date);
    expect(rows.source).toMatchObject({
      cursor: { page: 1 },
      lastSyncStatus: 'succeeded',
      lastError: null,
    });

    const duplicate = await knowledge.finishJob(db, pair.job.id, {
      status: 'succeeded',
      result: {
        cursorAfter: { page: 2 },
        stats: { listed: 9, created: 9, updated: 0, disabled: 0, failed: 0 },
      },
    });
    expect(duplicate).toBeNull();
    rows = await rowsOf(sourceId);
    expect(rows.source?.cursor).toEqual({ page: 1 });
    expect(rows.run?.stats.listed).toBe(2);
  });

  it('writes failed and cancelled summaries without advancing the cursor', async () => {
    const failedPair = await createdPair();
    await knowledge.claimJob(db, failedPair.job.id);
    await knowledge.finishJob(db, failedPair.job.id, { status: 'failed', error: 'boom' });
    let rows = await rowsOf(sourceId);
    expect(rows.job).toMatchObject({ status: 'failed', error: 'boom' });
    expect(rows.run).toMatchObject({ status: 'failed', error: 'boom', cursorAfter: null });
    expect(rows.source).toMatchObject({
      cursor: {},
      lastSyncStatus: 'failed',
      lastError: 'boom',
    });

    sourceId = await makeSource();
    const cancelPair = await createdPair();
    await knowledge.claimJob(db, cancelPair.job.id);
    await knowledge.finishJob(db, cancelPair.job.id, { status: 'cancelled', error: 'cancelled' });
    rows = await rowsOf(sourceId);
    expect(rows.job).toMatchObject({ status: 'cancelled' });
    expect(rows.run).toMatchObject({ status: 'cancelled', error: 'cancelled' });
    expect(rows.source).toMatchObject({
      cursor: {},
      lastSyncStatus: 'cancelled',
      lastError: 'cancelled',
    });
  });

  it('only converts the declared fromStatus and never overwrites a claimed job', async () => {
    const pair = await createdPair();
    expect(await knowledge.finishJob(db, pair.job.id, { status: 'failed', error: 'x' })).toBeNull();
    let rows = await rowsOf(sourceId);
    expect(rows.job?.status).toBe('queued');
    expect(rows.source?.lastSyncStatus).toBeNull();

    await knowledge.claimJob(db, pair.job.id);
    expect(
      await knowledge.finishJob(db, pair.job.id, {
        fromStatus: 'queued',
        status: 'failed',
        error: 'x',
      }),
    ).toBeNull();
    rows = await rowsOf(sourceId);
    expect(rows.job?.status).toBe('running');
    expect(rows.run?.status).toBe('running');
    expect(rows.source?.lastSyncStatus).toBeNull();

    expect(
      await knowledge.finishJob(db, pair.job.id, {
        fromStatus: 'queued',
        status: 'cancelled',
        error: 'cancelled',
      }),
    ).toBeNull();
  });

  it('rolls back the job when the sync run terminal update fails', async () => {
    const pair = await createdPair();
    await knowledge.claimJob(db, pair.job.id);
    await injectFailure('run_update', pair.run.id);
    await expectInjectedFailure(
      knowledge.finishJob(db, pair.job.id, {
        status: 'succeeded',
        result: {
          cursorAfter: { page: 1 },
          stats: { listed: 1, created: 1, updated: 0, disabled: 0, failed: 0 },
        },
      }),
      'injected run_update',
    );
    let rows = await rowsOf(sourceId);
    expect(rows.job?.status).toBe('running');
    expect(rows.run?.status).toBe('running');
    expect(rows.source?.cursor).toEqual({});

    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(
      await knowledge.finishJob(db, pair.job.id, {
        status: 'succeeded',
        result: {
          cursorAfter: { page: 1 },
          stats: { listed: 1, created: 1, updated: 0, disabled: 0, failed: 0 },
        },
      }),
    ).not.toBeNull();
    rows = await rowsOf(sourceId);
    expect(rows.job?.status).toBe('succeeded');
    expect(rows.run?.status).toBe('succeeded');
  });

  it('rolls back job and run when the source summary update fails', async () => {
    const pair = await createdPair();
    await knowledge.claimJob(db, pair.job.id);
    await injectFailure('source_update');
    await expectInjectedFailure(
      knowledge.finishJob(db, pair.job.id, { status: 'failed', error: 'boom' }),
      'injected source_update',
    );
    let rows = await rowsOf(sourceId);
    expect(rows.job?.status).toBe('running');
    expect(rows.run?.status).toBe('running');
    expect(rows.source?.lastSyncStatus).toBeNull();

    // 移除故障后同一提交必须能重试成功，证明失败没有留下半提交状态。
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(
      await knowledge.finishJob(db, pair.job.id, { status: 'failed', error: 'boom' }),
    ).not.toBeNull();
    rows = await rowsOf(sourceId);
    expect(rows.job).toMatchObject({ status: 'failed', error: 'boom' });
    expect(rows.run).toMatchObject({ status: 'failed', error: 'boom', cursorAfter: null });
    expect(rows.source).toMatchObject({
      cursor: {},
      lastSyncStatus: 'failed',
      lastError: 'boom',
    });
  });

  it('rolls back job and run when advancing the success cursor fails', async () => {
    const pair = await createdPair();
    await knowledge.claimJob(db, pair.job.id);
    await injectFailure('source_cursor');
    await expectInjectedFailure(
      knowledge.finishJob(db, pair.job.id, {
        status: 'succeeded',
        result: {
          cursorAfter: { page: 1 },
          stats: { listed: 1, created: 1, updated: 0, disabled: 0, failed: 0 },
        },
      }),
      'injected source_cursor',
    );
    let rows = await rowsOf(sourceId);
    expect(rows.job?.status).toBe('running');
    expect(rows.run?.status).toBe('running');
    expect(rows.source?.cursor).toEqual({});

    // 移除故障后同一成功提交重试成功，游标与摘要一次落库。
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(
      await knowledge.finishJob(db, pair.job.id, {
        status: 'succeeded',
        result: {
          cursorAfter: { page: 1 },
          stats: { listed: 1, created: 1, updated: 0, disabled: 0, failed: 0 },
        },
      }),
    ).not.toBeNull();
    rows = await rowsOf(sourceId);
    expect(rows.job?.status).toBe('succeeded');
    expect(rows.run).toMatchObject({ status: 'succeeded', cursorAfter: { page: 1 } });
    expect(rows.source).toMatchObject({ cursor: { page: 1 }, lastSyncStatus: 'succeeded' });
  });

  it('requires an active sync run and a success result before committing', async () => {
    const pair = await createdPair();
    await knowledge.claimJob(db, pair.job.id);
    await expect(knowledge.finishJob(db, pair.job.id, { status: 'succeeded' })).rejects.toThrow(
      'cursorAfter',
    );
    expect((await rowsOf(sourceId)).job?.status).toBe('running');

    await pool.query('delete from knowledge_sync_runs where id = $1', [pair.run.id]);
    await expect(
      knowledge.finishJob(db, pair.job.id, { status: 'failed', error: 'lost' }),
    ).rejects.toThrow('sync run');
    expect((await rowsOf(sourceId)).job?.status).toBe('running');
  });

  it('rolls back the job when the sync run belongs to a different source', async () => {
    const pair = await createdPair();
    await knowledge.claimJob(db, pair.job.id);
    const other = await makeSource();
    cleanups.push(async () => {
      await pool.query('delete from knowledge_sources where id = $1', [other]);
    });
    await pool.query('update knowledge_sync_runs set source_id = $1 where id = $2', [
      other,
      pair.run.id,
    ]);

    await expect(
      knowledge.finishJob(db, pair.job.id, { status: 'failed', error: 'mismatch' }),
    ).rejects.toThrow('sync run');
    let rows = await rowsOf(sourceId);
    expect(rows.job?.status).toBe('running');
    expect(rows.source).toMatchObject({ cursor: {}, lastSyncStatus: null });
    const [mismatched] = (
      await pool.query<{ status: string; source_id: string }>(
        'select status, source_id from knowledge_sync_runs where id = $1',
        [pair.run.id],
      )
    ).rows;
    expect(mismatched).toMatchObject({ status: 'running', source_id: other });

    // 恢复关联后同一终态提交可以成功，证明错配只回滚本次事务。
    await pool.query('update knowledge_sync_runs set source_id = $1 where id = $2', [
      sourceId,
      pair.run.id,
    ]);
    expect(
      await knowledge.finishJob(db, pair.job.id, { status: 'failed', error: 'mismatch' }),
    ).not.toBeNull();
    rows = await rowsOf(sourceId);
    expect(rows.job).toMatchObject({ status: 'failed', error: 'mismatch' });
    expect(rows.run).toMatchObject({ status: 'failed', error: 'mismatch' });
    expect(rows.source).toMatchObject({ cursor: {}, lastSyncStatus: 'failed' });
  });

  it('keeps the sync run startedAt and checkpoint when a retry re-claims the job', async () => {
    const pair = await createdPair();
    await knowledge.claimJob(db, pair.job.id);
    const startedAt = (await rowsOf(sourceId)).run?.startedAt?.getTime();
    expect(typeof startedAt).toBe('number');
    await pool.query('update knowledge_sync_runs set cursor_after = $1::jsonb where id = $2', [
      JSON.stringify({ page: 1 }),
      pair.run.id,
    ]);
    // 与队列 resetToQueued 一致：可重试失败只把 job 退回 queued，不改 run 与检查点。
    await pool.query("update knowledge_jobs set status = 'queued' where id = $1", [pair.job.id]);

    const reclaimed = await knowledge.claimJob(db, pair.job.id);
    expect(reclaimed).toMatchObject({ status: 'running', attempts: 2 });
    const rows = await rowsOf(sourceId);
    expect(rows.run).toMatchObject({ status: 'running', cursorAfter: { page: 1 } });
    expect(rows.run?.startedAt?.getTime()).toBe(startedAt);
    expect(rows.source).toMatchObject({ cursor: {} });
  });

  it('refuses to re-claim a queued job whose sync run is already terminal', async () => {
    const pair = await createdPair();
    await knowledge.claimJob(db, pair.job.id);
    await knowledge.finishJob(db, pair.job.id, { status: 'cancelled', error: 'cancelled' });
    // 人为把 job 退回 queued：认领必须拒绝复活终态 run，并回滚 job 状态。
    await pool.query("update knowledge_jobs set status = 'queued' where id = $1", [pair.job.id]);

    await expect(knowledge.claimJob(db, pair.job.id)).rejects.toThrow('not active');
    const rows = await rowsOf(sourceId);
    expect(rows.job).toMatchObject({ status: 'queued', attempts: 1 });
    expect(rows.run).toMatchObject({ status: 'cancelled', error: 'cancelled' });
    expect(rows.source).toMatchObject({ cursor: {}, lastSyncStatus: 'cancelled' });
  });

  it('persists probe results and object names without changing source sync state', async () => {
    const job = await knowledge.createJob(db, {
      type: 'source_probe',
      baseId,
      documentId: null,
      sourceId,
      payload: { type: 'source_probe', sourceId },
    });
    const result = { ok: true, checks: [{ rangeId: 'range-probe', ok: true }] };
    await knowledge.claimJob(db, job.id);
    const finished = await knowledge.finishJob(db, job.id, {
      status: 'succeeded',
      probeResult: result,
    });
    expect(finished).toMatchObject({ status: 'succeeded', result });
    const summary = (await knowledge.listJobs(db, { baseId })).items.find(
      (row) => row.id === job.id,
    );
    expect(summary).toMatchObject({
      documentId: null,
      sourceId,
      sourceName: expect.any(String),
      result,
    });
    expect(await knowledge.getSource(db, sourceId)).toMatchObject({
      cursor: {},
      lastSyncStatus: null,
    });
    expect((await knowledge.listSyncRuns(db, sourceId)).items).toHaveLength(0);
    expect(
      await knowledge.finishJob(db, job.id, {
        status: 'failed',
        probeResult: { ok: false, checks: [] },
      }),
    ).toBeNull();
    expect((await knowledge.getJob(db, job.id))?.result).toEqual(result);
  });

  it('leaves non-sync jobs as a single-row terminal update', async () => {
    const job = await knowledge.createJob(db, {
      type: 'cleanup',
      baseId: null,
      documentId: null,
      sourceId: null,
      payload: { type: 'cleanup' },
    });
    await knowledge.claimJob(db, job.id);
    const finished = await knowledge.finishJob(db, job.id, { status: 'succeeded' });
    expect(finished).toMatchObject({ status: 'succeeded' });
    expect((await knowledge.getJob(db, job.id))?.status).toBe('succeeded');
  });
});
