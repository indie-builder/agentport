import { newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

// 直接落库构造已收口的跑批：不入队，就不需要 worker 空闲。
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

interface ComparisonRow {
  key: string;
  status: string;
  base: ResultBody | null;
  head: ResultBody | null;
}

describe.skipIf(!ready)('eval run comparison', () => {
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
      await createAgent(app, cookie, { slug: unique('compare'), track: createdAgents })
    ).json<Agent>();

  async function newCase(
    agentId: string,
    name: string,
    prompt = `${name} prompt`,
    expectation = `${name} expectation`,
  ): Promise<Snapshot> {
    const row = await repo.evalRepo.createCase(app.db, newId('evalCase'), {
      agentId,
      name,
      prompt,
      expectation,
    });
    return { id: row.id, name, prompt, expectation };
  }

  /** 已收口的跑批；status 只允许终态，running 留给专门的拒绝用例。 */
  async function newRun(
    agentId: string,
    options: { status?: 'succeeded' | 'failed'; cases?: Snapshot[] } = {},
  ): Promise<string> {
    const cases = options.cases ?? [];
    const run = await repo.evalRepo.createEvalRun(app.db, {
      id: newId('evalRun'),
      agentId,
      total: cases.length,
      caseSnapshot: cases,
    });
    const status = options.status ?? 'succeeded';
    await repo.evalRepo.finishEvalRun(app.db, run.id, { status, passed: 0 });
    return run.id;
  }

  async function record(
    evalRunId: string,
    options: { caseId: string | null; snapshot?: Snapshot; passed: boolean; output?: string },
  ): Promise<void> {
    if (options.caseId === null) {
      await app.pool.query(
        'insert into eval_results (id, eval_run_id, passed, output) values ($1, $2, $3, $4)',
        [newId('evalResult'), evalRunId, options.passed, options.output ?? ''],
      );
      return;
    }
    await repo.evalRepo.addResult(app.db, {
      id: newId('evalResult'),
      evalRunId,
      caseId: options.caseId,
      ...(options.snapshot ? { caseSnapshot: options.snapshot } : {}),
      runId: null,
      passed: options.passed,
      output: options.output ?? '',
    });
  }

  const compare = (base: string, head: string, headers: Record<string, string> = { cookie }) =>
    inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${base}/compare?head=${head}`,
      headers,
    });

  async function comparison(base: string, head: string) {
    const res = await compare(base, head);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ baseRun: { id: string }; headRun: { id: string }; rows: ComparisonRow[] }>();
  }

  /** 一条用例、两侧各一个结果的最小对比。 */
  async function pair(options: {
    basePassed: boolean;
    headPassed: boolean;
    headPrompt?: string;
    headExpectation?: string;
  }): Promise<{ base: string; head: string; key: string }> {
    const agent = await newAgent();
    const kase = await newCase(agent.id, 'greeting');
    const base = await newRun(agent.id, { cases: [kase] });
    const head = await newRun(agent.id, { cases: [kase] });
    await record(base, { caseId: kase.id, snapshot: kase, passed: options.basePassed });
    const headSnapshot = {
      ...kase,
      prompt: options.headPrompt ?? kase.prompt,
      expectation: options.headExpectation ?? kase.expectation,
    };
    await record(head, {
      caseId: kase.id,
      snapshot: headSnapshot,
      passed: options.headPassed,
    });
    return { base, head, key: kase.id };
  }

  it('requires authentication', async () => {
    const agent = await newAgent();
    const base = await newRun(agent.id);
    const head = await newRun(agent.id);
    const res = await compare(base, head, {});
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('returns 404 when either run is unknown', async () => {
    const agent = await newAgent();
    const known = await newRun(agent.id);
    const unknown = newId('evalRun');

    expectProblem(await compare(unknown, known), 'NOT_FOUND');
    expectProblem(await compare(known, unknown), 'NOT_FOUND');
  });

  it('rejects comparing a run with itself', async () => {
    const agent = await newAgent();
    const run = await newRun(agent.id);
    expectProblem(await compare(run, run), 'INVALID_INPUT');
  });

  it('rejects runs from different agents', async () => {
    const first = await newAgent();
    const second = await newAgent();
    const base = await newRun(first.id);
    const head = await newRun(second.id);
    expectProblem(await compare(base, head), 'INVALID_INPUT');
  });

  it('rejects comparison while either run is still running', async () => {
    const agent = await newAgent();
    const finished = await newRun(agent.id);
    const running = await newRun(agent.id, { status: 'succeeded' });
    await app.pool.query(
      "update eval_runs set status = 'running', finished_at = null where id = $1",
      [running],
    );

    expectProblem(await compare(finished, running), 'EVAL_RUN_IN_PROGRESS');
    expectProblem(await compare(running, finished), 'EVAL_RUN_IN_PROGRESS');
  });

  it('classifies regressed, improved and unchanged outcomes', async () => {
    for (const [basePassed, headPassed, status] of [
      [true, false, 'regressed'],
      [false, true, 'improved'],
      [true, true, 'unchanged'],
      [false, false, 'unchanged'],
    ] as const) {
      const { base, head, key } = await pair({ basePassed, headPassed });
      const body = await comparison(base, head);
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]).toMatchObject({ key, status });
    }
  });

  it('reports changed inputs instead of an outcome when prompt or expectation moved', async () => {
    const promptChanged = await pair({
      basePassed: true,
      headPassed: true,
      headPrompt: 'different prompt',
    });
    const promptBody = await comparison(promptChanged.base, promptChanged.head);
    expect(promptBody.rows[0]).toMatchObject({ key: promptChanged.key, status: 'changed_inputs' });

    const expectationChanged = await pair({
      basePassed: false,
      headPassed: true,
      headExpectation: 'different expectation',
    });
    const expectationBody = await comparison(expectationChanged.base, expectationChanged.head);
    expect(expectationBody.rows[0]).toMatchObject({
      key: expectationChanged.key,
      status: 'changed_inputs',
    });
  });

  it('aligns deleted source cases by their frozen snapshot id', async () => {
    const agent = await newAgent();
    const kase = await newCase(agent.id, 'deleted-later');
    const base = await newRun(agent.id, { cases: [kase] });
    const head = await newRun(agent.id, { cases: [kase] });
    await record(base, { caseId: kase.id, snapshot: kase, passed: false });
    await record(head, { caseId: kase.id, snapshot: kase, passed: true });

    // 删源用例后两个结果的 case_id 都置空，快照里的 id 仍能把它们对齐。
    await repo.evalRepo.deleteCase(app.db, kase.id);
    const body = await comparison(base, head);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      key: kase.id,
      status: 'improved',
      base: { caseId: null },
      head: { caseId: null },
    });
  });

  it('marks legacy results without snapshots as unverified', async () => {
    const agent = await newAgent();
    const kase = await newCase(agent.id, 'legacy');
    const base = await newRun(agent.id);
    const head = await newRun(agent.id);
    await record(base, { caseId: kase.id, passed: true });
    await record(head, { caseId: kase.id, passed: false });

    const body = await comparison(base, head);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      key: kase.id,
      status: 'unverified',
      base: { passed: true },
      head: { passed: false },
    });
  });

  it('never merges identity-less results by matching names', async () => {
    const agent = await newAgent();
    const base = await newRun(agent.id);
    const head = await newRun(agent.id);
    await record(base, { caseId: null, passed: true });
    await record(head, { caseId: null, passed: true });

    const body = await comparison(base, head);
    expect(body.rows).toHaveLength(2);
    expect(body.rows.map((row) => row.status)).toEqual(['unverified', 'unverified']);
    expect(body.rows[0]?.base).not.toBeNull();
    expect(body.rows[0]?.head).toBeNull();
    expect(body.rows[1]?.head).not.toBeNull();
    expect(body.rows[1]?.base).toBeNull();
  });

  it('reports cases present on only one side', async () => {
    const agent = await newAgent();
    const kept = await newCase(agent.id, 'kept');
    const dropped = await newCase(agent.id, 'dropped');
    const added = await newCase(agent.id, 'added');
    const base = await newRun(agent.id, { cases: [kept, dropped] });
    const head = await newRun(agent.id, { cases: [kept, added] });
    await record(base, { caseId: kept.id, snapshot: kept, passed: true });
    await record(base, { caseId: dropped.id, snapshot: dropped, passed: true });
    await record(head, { caseId: kept.id, snapshot: kept, passed: true });
    await record(head, { caseId: added.id, snapshot: added, passed: false });

    const body = await comparison(base, head);
    const byKey = new Map(body.rows.map((row) => [row.key, row]));
    expect(byKey.get(kept.id)?.status).toBe('unchanged');
    expect(byKey.get(dropped.id)?.status).toBe('base_only');
    expect(byKey.get(added.id)?.status).toBe('head_only');
  });

  it('marks duplicated stable keys as unverified instead of overwriting them', async () => {
    const agent = await newAgent();
    const kase = await newCase(agent.id, 'duplicated');
    const base = await newRun(agent.id);
    const head = await newRun(agent.id);
    await record(base, { caseId: kase.id, snapshot: kase, passed: true });
    // case_id 为空的重复结果不受唯一键约束，快照 id 却相同。
    for (const passed of [true, false]) {
      await app.pool.query(
        'insert into eval_results (id, eval_run_id, case_snapshot, passed, output) values ($1, $2, $3, $4, $5)',
        [newId('evalResult'), head, kase, passed, ''],
      );
    }

    const body = await comparison(base, head);
    expect(body.rows).toHaveLength(3);
    expect(body.rows.every((row) => row.status === 'unverified')).toBe(true);
    expect(new Set(body.rows.map((row) => row.key)).size).toBe(3);
  });

  it('does not mutate either run', async () => {
    const { base, head } = await pair({ basePassed: false, headPassed: true });
    const snapshot = async () => {
      const runs = await app.pool.query(
        'select * from eval_runs where id = any($1::text[]) order by id',
        [[base, head]],
      );
      const results = await app.pool.query(
        'select * from eval_results where eval_run_id = any($1::text[]) order by id',
        [[base, head]],
      );
      return { runs: runs.rows, results: results.rows };
    };

    const before = await snapshot();
    await comparison(base, head);
    expect(await snapshot()).toEqual(before);
  });
});
