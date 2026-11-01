import { newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

// 直接落库构造已收口的跑批：不入队，不需要 worker 空闲。
const ready = await infraReady;

interface Snapshot {
  id: string;
  name: string;
  prompt: string;
  expectation: string;
}

interface ResultBody {
  caseId: string | null;
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
  runId: string | null;
}

interface ExportBody {
  format: string;
  exportedAt: string;
  configurationPinned: boolean;
  evalRun: Record<string, unknown>;
  results: ResultBody[];
}

const SEEDED_RUN_ID = 'evalRun-export-bulk';

describe.skipIf(!ready)('eval result export', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('eval-export'), track: createdAgents })
    ).json<Agent>();

  async function newRun(
    agentId: string,
    status: 'running' | 'succeeded' | 'failed' | 'cancelled' = 'succeeded',
  ): Promise<string> {
    const run = await repo.evalRepo.createEvalRun(app.db, {
      id: newId('evalRun'),
      agentId,
      total: 0,
      createdBy: ADMIN_BUSINESS_ID,
    });
    if (status === 'cancelled') await repo.evalRepo.cancelEvalRun(app.db, run.id);
    else if (status !== 'running') {
      await repo.evalRepo.finishEvalRun(app.db, run.id, { status, passed: 0 });
    }
    return run.id;
  }

  async function newCase(agentId: string, name: string): Promise<Snapshot> {
    const row = await repo.evalRepo.createCase(app.db, newId('evalCase'), {
      agentId,
      name,
      prompt: `${name} prompt`,
      expectation: `${name} expectation`,
      createdBy: ADMIN_BUSINESS_ID,
    });
    return { id: row.id, name, prompt: row.prompt, expectation: row.expectation };
  }

  const record = (
    evalRunId: string,
    options: { caseId: string; snapshot?: Snapshot; passed: boolean; output: string },
  ) =>
    repo.evalRepo.addResult(app.db, {
      id: newId('evalResult'),
      evalRunId,
      caseId: options.caseId,
      caseSnapshot: options.snapshot,
      runId: null,
      passed: options.passed,
      output: options.output,
    });

  const exportRun = (id: string, withCookie = true) =>
    inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${id}/export`,
      headers: withCookie ? { cookie } : {},
    });

  const exported = async (id: string): Promise<ExportBody> => {
    const res = await exportRun(id);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ExportBody>();
  };

  it('requires authentication', async () => {
    const agent = await newAgent();
    const run = await newRun(agent.id);
    expectProblem(await exportRun(run, false), 'UNAUTHORIZED');
  });

  it('returns 404 for an unknown run', async () => {
    expectProblem(await exportRun(newId('evalRun')), 'NOT_FOUND');
  });

  it('rejects a running run', async () => {
    const agent = await newAgent();
    const running = await newRun(agent.id, 'running');
    expectProblem(await exportRun(running), 'EVAL_RUN_IN_PROGRESS');
  });

  it('exports terminal runs of every status', async () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      const agent = await newAgent();
      const run = await newRun(agent.id, status);
      const body = await exported(run);
      expect(body.evalRun).toMatchObject({ id: run, agentId: agent.id, status });
    }
  });

  it('wraps the run and its results in a pinned-free envelope with safe headers', async () => {
    const agent = await newAgent();
    const snapshot = await newCase(agent.id, '问候-✨');
    const other = await newCase(agent.id, 'plain');
    const run = await newRun(agent.id);
    await record(run, { caseId: snapshot.id, snapshot, passed: true, output: 'ok' });
    await record(run, { caseId: other.id, snapshot: other, passed: false, output: 'boom' });

    const res = await exportRun(run);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="eval-result.json"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('application/json');

    const body = res.json<ExportBody>();
    expect(Object.keys(body).sort()).toEqual([
      'configurationPinned',
      'evalRun',
      'exportedAt',
      'format',
      'results',
    ]);
    expect(body.format).toBe('agentport/eval-run@1');
    expect(body.configurationPinned).toBe(false);
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    expect(Object.keys(body.evalRun).sort()).toEqual([
      'agentId',
      'createdAt',
      'error',
      'finishedAt',
      'id',
      'passed',
      'status',
      'total',
    ]);
    expect(body.evalRun).not.toHaveProperty('claimedAt');
    expect(body.evalRun).not.toHaveProperty('caseSnapshot');
    expect(Object.keys(body.results[0] ?? {}).sort()).toEqual([
      'caseId',
      'expectation',
      'name',
      'output',
      'passed',
      'prompt',
      'runId',
    ]);
    expect(body.results).toHaveLength(2);
    expect(res.body).not.toContain('caseSnapshot');
  });

  it('preserves unicode, newlines and control characters byte for byte', async () => {
    const agent = await newAgent();
    const name = `问候-${unique('name')}`;
    const prompt = '第一行\n第二行 with ✨';
    const expectation = '期望\u0001结果\tend';
    const output = '输出\n\u0001\u001f结尾';
    const created = await repo.evalRepo.createCase(app.db, newId('evalCase'), {
      agentId: agent.id,
      name,
      prompt,
      expectation,
      createdBy: ADMIN_BUSINESS_ID,
    });
    const snapshot = { id: created.id, name, prompt, expectation };

    const run = await newRun(agent.id);
    await record(run, { caseId: created.id, snapshot, passed: true, output });

    const body = await exported(run);
    expect(body.results[0]).toMatchObject({ name, prompt, expectation, output });
    expect(body.results[0]?.output).toBe(output);
    expect(body.results[0]?.expectation).toBe(expectation);
  });

  it('serves frozen snapshot text after the source case is deleted', async () => {
    const agent = await newAgent();
    const snapshot = await newCase(agent.id, 'deleted-later');
    const run = await newRun(agent.id);
    await record(run, { caseId: snapshot.id, snapshot, passed: true, output: 'ok' });

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/eval/cases/${snapshot.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    const body = await exported(run);
    expect(body.results[0]).toMatchObject({
      caseId: null,
      name: snapshot.name,
      prompt: snapshot.prompt,
      expectation: snapshot.expectation,
    });
  });

  it('exports only the requested run and never mutates stored rows', async () => {
    const agent = await newAgent();
    const own = await newRun(agent.id);
    const other = await newRun(agent.id);
    const first = await newCase(agent.id, 'first');
    const second = await newCase(agent.id, 'second');
    await record(own, { caseId: first.id, snapshot: first, passed: true, output: 'own-result' });
    await record(other, {
      caseId: second.id,
      snapshot: second,
      passed: true,
      output: 'other-run-result',
    });

    const rows = async () =>
      (
        await app.pool.query(
          'select id, eval_run_id, case_id, passed, output from eval_results where eval_run_id = any($1::text[]) order by id',
          [[own, other]],
        )
      ).rows;
    const runRow = async () =>
      (
        await app.pool.query(
          'select status, total, passed, error, claimed_at, finished_at from eval_runs where id = $1',
          [own],
        )
      ).rows;
    const before = { results: await rows(), run: await runRow() };

    const body = await exported(own);
    const ids = body.results.map((row) => row.output);
    expect(ids).toEqual(['own-result']);
    expect(JSON.stringify(body)).not.toContain('other-run-result');

    expect(await rows()).toEqual(before.results);
    expect(await runRow()).toEqual(before.run);
  });

  it('refuses more than 500 results instead of truncating', async () => {
    const agent = await newAgent();
    await app.pool.query(
      `insert into eval_runs (id, agent_id, created_by, status, total)
       values ($1, $2, $3, 'succeeded', 501)`,
      [SEEDED_RUN_ID, agent.id, ADMIN_BUSINESS_ID],
    );
    await app.pool.query(
      `insert into eval_results (id, eval_run_id, passed, output)
       select $1 || '-r-' || lpad(g::text, 4, '0'), $1, true, 'ok'
       from generate_series(1, 501) g`,
      [SEEDED_RUN_ID],
    );

    expectProblem(await exportRun(SEEDED_RUN_ID), 'CONFLICT');
    // 501 条结果里没有一条是截断后发出的。
    const { rows } = await app.pool.query<{ n: number }>(
      'select count(*)::int as n from eval_results where eval_run_id = $1',
      [SEEDED_RUN_ID],
    );
    expect(rows[0]?.n).toBe(501);
  });

  it('exports exactly 500 results', async () => {
    const agent = await newAgent();
    const run = await newRun(agent.id);
    await app.pool.query(
      `insert into eval_results (id, eval_run_id, passed, output)
       select $1 || '-r-' || lpad(g::text, 4, '0'), $1, g % 2 = 0, 'ok'
       from generate_series(1, 500) g`,
      [run],
    );

    const body = await exported(run);
    expect(body.results).toHaveLength(500);
  });

  it('refuses exports larger than 1 MiB instead of truncating', async () => {
    const agent = await newAgent();
    const run = await newRun(agent.id);
    await app.pool.query(
      `insert into eval_results (id, eval_run_id, passed, output) values ($1, $2, true, $3)`,
      [newId('evalResult'), run, 'x'.repeat(1_100_000)],
    );

    expectProblem(await exportRun(run), 'CONFLICT');
  });
});
