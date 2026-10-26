import { newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getEvalQueue } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  infraReady,
  inject,
  loginCookie,
  queueIdle,
  startApp,
  unique,
} from './helpers.js';

// 提交评估会入队；有活跃 worker 时 job 会被立刻消费，断言只能看到原始用例。
const ready = (await infraReady) && (await queueIdle);

interface SnapshotCase {
  id: string;
  name: string;
  prompt: string;
  expectation: string;
}

interface EvalResultBody {
  caseId: string | null;
  name: string;
  prompt: string;
  expectation: string;
}

describe.skipIf(!ready)('eval run case snapshots', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const submittedRuns: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    for (const id of submittedRuns) {
      const job = await getEvalQueue().getJob(id);
      await job?.remove();
    }
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, {
        slug: unique('snapshot-agent'),
        track: createdAgents,
      })
    ).json<Agent>();

  async function createCase(agentId: string, name: string): Promise<SnapshotCase> {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/eval/cases',
      headers: { cookie },
      payload: {
        agentId,
        name,
        prompt: `${name} prompt`,
        expectation: `${name} expectation`,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<SnapshotCase>();
  }

  /** 只保留快照里的四个字段，响应里的 agentId/createdAt 不参与比较。 */
  function picked(row: SnapshotCase): SnapshotCase {
    return { id: row.id, name: row.name, prompt: row.prompt, expectation: row.expectation };
  }

  async function submitRun(agentId: string): Promise<string> {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/eval/runs',
      headers: { cookie },
      payload: { agentId },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { evalRunId } = res.json<{ evalRunId: string }>();
    submittedRuns.push(evalRunId);
    // 移除自己的 job：测试不跑批，worker 停着也不会被突发消费。
    const job = await getEvalQueue().getJob(evalRunId);
    if (!job) throw new Error('eval job was not enqueued');
    await job.remove();
    return evalRunId;
  }

  async function storedRun(evalRunId: string): Promise<{ total: number; cases: SnapshotCase[] }> {
    const { rows } = await app.pool.query<{ total: number; case_snapshot: SnapshotCase[] }>(
      'select total, case_snapshot from eval_runs where id = $1',
      [evalRunId],
    );
    const row = rows[0];
    if (!row) throw new Error('eval run disappeared');
    return { total: row.total, cases: row.case_snapshot };
  }

  it('freezes the admitted cases and total on the run', async () => {
    const agent = await newAgent();
    const alpha = await createCase(agent.id, 'alpha');
    const beta = await createCase(agent.id, 'beta');

    const runId = await submitRun(agent.id);
    const admitted = await storedRun(runId);
    expect(admitted.total).toBe(2);
    expect(admitted.cases).toEqual([picked(alpha), picked(beta)]);

    const edited = await inject(app, {
      method: 'PATCH',
      url: `/api/eval/cases/${alpha.id}`,
      headers: { cookie },
      payload: { name: 'alpha edited', prompt: 'changed prompt', expectation: 'changed' },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/eval/cases/${beta.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    await createCase(agent.id, 'gamma');

    const later = await storedRun(runId);
    expect(later.total).toBe(2);
    expect(later.cases).toEqual([picked(alpha), picked(beta)]);

    const list = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}`,
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    const page = list.json<{
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>();
    const [listed] = page.items;
    expect(page.nextCursor).toBeNull();
    expect(listed).not.toHaveProperty('caseSnapshot');
    expect(listed).not.toHaveProperty('claimedAt');
  });

  it('serves frozen case text even after the source cases are edited or deleted', async () => {
    const agent = await newAgent();
    const alpha = await createCase(agent.id, 'alpha');
    const beta = await createCase(agent.id, 'beta');
    const runId = await submitRun(agent.id);

    const edited = await inject(app, {
      method: 'PATCH',
      url: `/api/eval/cases/${alpha.id}`,
      headers: { cookie },
      payload: { name: 'alpha edited', prompt: 'changed prompt', expectation: 'changed' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/eval/cases/${beta.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    await repo.evalRepo.addResult(app.db, {
      id: newId('evalResult'),
      evalRunId: runId,
      caseId: alpha.id,
      runId: null,
      passed: true,
      output: 'ok',
      caseSnapshot: picked(alpha),
    });
    // 源用例已删除：外键置 NULL，快照独立保留。
    await repo.evalRepo.addResult(app.db, {
      id: newId('evalResult'),
      evalRunId: runId,
      caseId: beta.id,
      runId: null,
      passed: false,
      output: 'boom',
      caseSnapshot: picked(beta),
    });

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${runId}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json<{
      evalRun: { total: number } & Record<string, unknown>;
      results: EvalResultBody[];
    }>();
    expect(body.evalRun.total).toBe(2);
    expect(body.evalRun).not.toHaveProperty('caseSnapshot');
    expect(body.results.map(pickedResult)).toEqual([
      { caseId: alpha.id, name: alpha.name, prompt: alpha.prompt, expectation: alpha.expectation },
      { caseId: null, name: beta.name, prompt: beta.prompt, expectation: beta.expectation },
    ]);
  });

  it('falls back to the current case for legacy results without a snapshot', async () => {
    const agent = await newAgent();
    const current = await createCase(agent.id, 'legacy');
    const run = await repo.evalRepo.createEvalRun(app.db, {
      id: newId('evalRun'),
      agentId: agent.id,
      total: 1,
    });
    await repo.evalRepo.addResult(app.db, {
      id: newId('evalResult'),
      evalRunId: run.id,
      caseId: current.id,
      runId: null,
      passed: true,
      output: 'ok',
    });

    await app.pool.query('update eval_results set case_snapshot = null where eval_run_id = $1', [
      run.id,
    ]);
    const detail = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs/${run.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json<{ results: EvalResultBody[] }>();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      caseId: current.id,
      name: current.name,
      prompt: current.prompt,
      expectation: current.expectation,
    });
  });
});

function pickedResult(row: EvalResultBody): EvalResultBody {
  return {
    caseId: row.caseId,
    name: row.name,
    prompt: row.prompt,
    expectation: row.expectation,
  };
}
