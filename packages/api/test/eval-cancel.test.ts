import { newId, repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
  ADMIN_BUSINESS_ID,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('eval run cancellation', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const evalRunIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    // 审计没有外键，目标行随 agent 级联删除后仍需显式清理。
    if (evalRunIds.length > 0) {
      await app.pool.query('delete from audit_log where target = any($1::text[])', [evalRunIds]);
    }
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  /** 直接落一条 running 跑批，不入队：没有 job，worker 不会消费。 */
  const seedRun = async () => {
    const agent = (
      await createAgent(app, cookie, { slug: unique('eval-cancel'), track: createdAgents })
    ).json<{ id: string }>();
    const evalCase = await repo.evalRepo.createCase(app.db, newId('evalCase'), {
      agentId: agent.id,
      name: 'hello',
      prompt: 'say hello',
      expectation: 'hello',
      createdBy: ADMIN_BUSINESS_ID,
    });
    const caseSnapshot = [
      { id: evalCase.id, name: 'hello', prompt: 'say hello', expectation: 'hello' },
    ];
    const run = await repo.evalRepo.createEvalRun(app.db, {
      id: newId('evalRun'),
      agentId: agent.id,
      total: 1,
      createdBy: ADMIN_BUSINESS_ID,
      caseSnapshot,
    });
    evalRunIds.push(run.id);
    return { agent, evalCase, caseSnapshot, run };
  };

  const cancel = (id: string, withCookie = true) =>
    inject(app, {
      method: 'POST',
      url: `/api/eval/runs/${id}/cancel`,
      headers: withCookie ? { cookie } : {},
    });

  const cancelAudits = async (target: string) =>
    (
      await app.pool.query(
        "select input_digest from audit_log where action = 'eval.run.cancelled' and target = $1",
        [target],
      )
    ).rows;

  it('requires auth', async () => {
    const res = await cancel(newId('evalRun'), false);
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('returns 404 for an unknown run', async () => {
    const res = await cancel(newId('evalRun'));
    expectProblem(res, 'NOT_FOUND');
  });

  it('checks run existence with an id-only query', async () => {
    const { run } = await seedRun();
    const query = vi.spyOn(app.pool, 'query');
    const res = await cancel(run.id);
    const calls = [...query.mock.calls];
    query.mockRestore();
    expect(res.statusCode).toBe(202);
    const evalRunSelects = calls
      .map(([statement]) => {
        if (typeof statement === 'string') return statement;
        const text = (statement as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .filter((text) => /^select .* from "eval_runs"/i.test(text));
    expect(evalRunSelects).toHaveLength(1);
    // 存在性 + 授权只需要主键与 agentId；大字段 case_snapshot 不读。
    expect(evalRunSelects[0]).toMatch(/^select "id", "agent_id" from "eval_runs"/i);
    expect(evalRunSelects[0]).not.toMatch(/case_snapshot/i);
  });

  it('cancels a running run and records one audit row without inputs', async () => {
    const { run } = await seedRun();

    const res = await cancel(run.id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });

    const row = await repo.evalRepo.getEvalRun(app.db, run.id);
    expect(row).toMatchObject({ status: 'cancelled' });
    expect(row?.finishedAt).not.toBeNull();

    const audits = await cancelAudits(run.id);
    expect(audits).toHaveLength(1);
    // 审计不落用例提示词：只有摘要位，且本次没有 input。
    expect(audits[0]).toMatchObject({ input_digest: null });
  });

  it('accepts a concurrent double cancel but only transitions and audits once', async () => {
    const { run } = await seedRun();

    const [first, second] = await Promise.all([cancel(run.id), cancel(run.id)]);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);

    expect((await repo.evalRepo.getEvalRun(app.db, run.id))?.status).toBe('cancelled');
    expect(await cancelAudits(run.id)).toHaveLength(1);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'leaves a %s run unchanged and writes no audit',
    async (status) => {
      const { run } = await seedRun();
      const passed = status === 'succeeded' ? 1 : 0;
      if (status === 'cancelled') {
        expect(await repo.evalRepo.cancelEvalRun(app.db, run.id)).toBe(true);
      } else {
        await repo.evalRepo.finishEvalRun(app.db, run.id, { status, passed });
      }
      const finished = await repo.evalRepo.getEvalRun(app.db, run.id);

      const res = await cancel(run.id);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });

      const row = await repo.evalRepo.getEvalRun(app.db, run.id);
      expect(row).toMatchObject({ status, passed });
      expect(row?.finishedAt).toEqual(finished?.finishedAt);
      expect(await cancelAudits(run.id)).toHaveLength(0);
    },
  );

  it('keeps result counts consistent when recording races with cancellation', async () => {
    const { run, evalCase, caseSnapshot } = await seedRun();
    await Promise.all([
      cancel(run.id),
      repo.evalRepo.addResult(
        app.db,
        {
          id: newId('evalResult'),
          evalRunId: run.id,
          caseId: evalCase.id,
          caseSnapshot: caseSnapshot[0],
          runId: null,
          passed: true,
          output: 'concurrent answer',
        },
        { recordProgress: true },
      ),
    ]);
    const detail = await repo.evalRepo.getRunDetail(app.db, run.id);
    expect(detail?.evalRun.status).toBe('cancelled');
    expect(detail?.evalRun.passed).toBe(detail?.results.filter((result) => result.passed).length);
    const before = detail?.results;
    await repo.evalRepo.addResult(
      app.db,
      {
        id: newId('evalResult'),
        evalRunId: run.id,
        caseId: evalCase.id,
        runId: null,
        passed: true,
        output: 'late duplicate',
      },
      { recordProgress: true },
    );
    expect((await repo.evalRepo.getRunDetail(app.db, run.id))?.results).toEqual(before);
  });

  it('rejects a worker result after cancellation without changing the count', async () => {
    const { run, evalCase, caseSnapshot } = await seedRun();
    await cancel(run.id);
    await repo.evalRepo.addResult(
      app.db,
      {
        id: newId('evalResult'),
        evalRunId: run.id,
        caseId: evalCase.id,
        caseSnapshot: caseSnapshot[0],
        runId: null,
        passed: true,
        output: 'late answer',
      },
      { recordProgress: true },
    );
    const detail = await repo.evalRepo.getRunDetail(app.db, run.id);
    expect(detail?.results).toEqual([]);
    expect(detail?.evalRun).toMatchObject({ status: 'cancelled', passed: 0 });
  });

  it('ignores late finish, progress and claim while keeping recorded results', async () => {
    const { run, evalCase, caseSnapshot } = await seedRun();
    // 取消前已写下的结果属于这次跑批，取消不该抹掉它。
    await repo.evalRepo.addResult(
      app.db,
      {
        id: newId('evalResult'),
        evalRunId: run.id,
        caseId: evalCase.id,
        caseSnapshot: caseSnapshot[0],
        runId: null,
        passed: true,
        output: 'answer hello',
      },
      { recordProgress: true },
    );

    expect((await cancel(run.id)).statusCode).toBe(202);

    // worker 晚到的收口与进度写入都必须被 running 条件挡住。
    await repo.evalRepo.finishEvalRun(app.db, run.id, { status: 'failed', passed: 0 });
    await repo.evalRepo.updateProgress(app.db, run.id, 9);
    expect(await repo.evalRepo.claimEvalRun(app.db, run.id)).toBe(false);

    const row = await repo.evalRepo.getEvalRun(app.db, run.id);
    expect(row).toMatchObject({ status: 'cancelled', passed: 1 });
    expect(row?.claimedAt).toBeNull();

    const detail = await repo.evalRepo.getRunDetail(app.db, run.id);
    expect(detail?.results).toHaveLength(1);
    expect(detail?.results[0]).toMatchObject({ passed: true, output: 'answer hello' });
  });
});
