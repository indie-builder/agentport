import { inspect } from 'node:util';
import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getEvalQueue } from '../src/queue/producer.js';

import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  testConfig,
  unique,
} from './helpers.js';

const ready = await infraReady;

const DOWN = 'redis://:hunter2-secret@127.0.0.1:6379 refused';
const FIXED_ERROR = '评估入队失败，请稍后重试';

describe.skipIf(!ready)('eval enqueue failure', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const loggedErrors: unknown[] = [];

  beforeAll(async () => {
    app = await buildApp(testConfig());
    app.addHook('onRequest', async (request) => {
      request.log.error = (...args: unknown[]) => {
        loggedErrors.push(args);
      };
    });
    await app.ready();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    // 评估审计的目标是 run id，级联删除带不走。
    if (agentSlugs.length > 0) {
      await app.pool.query(
        `delete from audit_log where target in (
           select id from eval_runs where agent_id in (
             select id from agents where slug = any($1::text[])
           )
         )`,
        [agentSlugs],
      );
    }
    await cleanup(app, { agentSlugs });
    await app.close();
  });

  const newAgentWithCase = async (): Promise<{ id: string; caseId: string }> => {
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('eval-enqueue'),
        track: agentSlugs,
      })
    ).json<{ id: string }>();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/eval/cases',
      headers: { cookie },
      payload: { agentId: agent.id, name: 'hello', prompt: 'say hello', expectation: 'hello' },
    });
    expect(created.statusCode).toBe(201);
    return { id: agent.id, caseId: created.json<{ id: string }>().id };
  };

  const startRun = (agentId: string) =>
    inject(app, {
      method: 'POST',
      url: '/api/eval/runs',
      headers: { cookie },
      payload: { agentId },
    });

  const runsOf = async (agentId: string): Promise<string[]> =>
    (
      await app.pool.query<{ id: string }>(
        'select id from eval_runs where agent_id = $1 order by id',
        [agentId],
      )
    ).rows.map((row) => row.id);

  const requestedAudits = async (target: string): Promise<number> =>
    (
      await app.pool.query<{ count: number }>(
        "select count(*)::int as count from audit_log where action = 'eval.run.requested' and target = $1",
        [target],
      )
    ).rows[0]?.count ?? 0;

  it('fails an unclaimed run, returns 503, and admits the next run', async () => {
    const agent = await newAgentWithCase();
    const queue = getEvalQueue();
    const add = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error(DOWN));
    const getJob = vi.spyOn(queue, 'getJob');
    let res: Awaited<ReturnType<typeof startRun>>;
    try {
      res = await startRun(agent.id);
    } finally {
      add.mockRestore();
    }
    expectProblem(res, 'SERVICE_UNAVAILABLE');
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('redis://');
    expect(loggedErrors.length).toBeGreaterThan(0);
    expect(inspect(loggedErrors, { depth: null })).not.toContain('hunter2');
    expect(inspect(loggedErrors, { depth: null })).not.toContain('redis://');
    // 未认领的失败行没有 job，CAS 赢家才尝试清理。
    expect(getJob).toHaveBeenCalledTimes(1);
    getJob.mockRestore();

    const [runId] = await runsOf(agent.id);
    if (!runId) throw new Error('eval run was not created');
    const row = await repo.evalRepo.getEvalRun(app.db, runId);
    expect(row).toMatchObject({ status: 'failed', error: FIXED_ERROR });
    expect(row?.claimedAt).toBeNull();
    expect(row?.finishedAt).not.toBeNull();
    expect(await requestedAudits(runId)).toBe(0);

    // 失败行已收口，同一 agent 可以重新发起（不是 409）。
    const retry = vi.spyOn(queue, 'add').mockResolvedValueOnce({ id: 'synthetic' } as never);
    try {
      const next = await startRun(agent.id);
      expect(next.statusCode).toBe(202);
    } finally {
      retry.mockRestore();
    }
  });

  it('leaves a run the worker already claimed untouched', async () => {
    const agent = await newAgentWithCase();
    const queue = getEvalQueue();
    const add = vi.spyOn(queue, 'add').mockImplementationOnce(async (_name, data) => {
      expect(await repo.evalRepo.claimEvalRun(app.db, data.evalRunId)).toBe(true);
      throw new Error(DOWN);
    });
    const getJob = vi.spyOn(queue, 'getJob');
    let res: Awaited<ReturnType<typeof startRun>>;
    try {
      res = await startRun(agent.id);
    } finally {
      add.mockRestore();
    }
    expectProblem(res, 'SERVICE_UNAVAILABLE');
    expect(getJob).not.toHaveBeenCalled();
    getJob.mockRestore();

    const [runId] = await runsOf(agent.id);
    if (!runId) throw new Error('eval run was not created');
    const row = await repo.evalRepo.getEvalRun(app.db, runId);
    expect(row?.status).toBe('running');
    expect(row?.claimedAt).not.toBeNull();
    expect(row?.finishedAt).toBeNull();
    expect(row?.error).toBeNull();
  });

  it.each(['succeeded', 'cancelled'] as const)(
    'preserves a %s run finished before the rejection',
    async (terminal) => {
      const agent = await newAgentWithCase();
      const queue = getEvalQueue();
      const add = vi.spyOn(queue, 'add').mockImplementationOnce(async (_name, data) => {
        if (terminal === 'succeeded') {
          await repo.evalRepo.finishEvalRun(app.db, data.evalRunId, {
            status: 'succeeded',
            passed: 1,
          });
        } else {
          await repo.evalRepo.cancelEvalRun(app.db, data.evalRunId);
        }
        await app.pool.query(
          'insert into eval_results (id, eval_run_id, passed) values ($1, $2, true)',
          [unique('eval-result'), data.evalRunId],
        );
        throw new Error(DOWN);
      });
      const getJob = vi.spyOn(queue, 'getJob');
      try {
        const res = await startRun(agent.id);
        expectProblem(res, 'SERVICE_UNAVAILABLE');
        expect(getJob).not.toHaveBeenCalled();
      } finally {
        add.mockRestore();
        getJob.mockRestore();
      }

      const [runId] = await runsOf(agent.id);
      if (!runId) throw new Error('eval run was not created');
      const row = await repo.evalRepo.getEvalRun(app.db, runId);
      expect(row?.status).toBe(terminal);
      expect(row?.finishedAt).not.toBeNull();
      expect(row?.error).toBeNull();
      expect(row?.passed).toBe(terminal === 'succeeded' ? 1 : 0);
      const results = await app.pool.query('select id from eval_results where eval_run_id = $1', [
        runId,
      ]);
      expect(results.rows).toHaveLength(1);
    },
  );

  it.each(['getJob rejects', 'remove rejects'] as const)(
    'returns the fixed 503 and keeps the failed row when cleanup %s',
    async (mode) => {
      const agent = await newAgentWithCase();
      const queue = getEvalQueue();
      const add = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error(DOWN));
      const getJob = vi.spyOn(queue, 'getJob').mockImplementation(async () => {
        if (mode === 'getJob rejects') throw new Error(DOWN);
        return {
          remove: async () => {
            throw new Error(DOWN);
          },
        } as never;
      });
      try {
        const res = await startRun(agent.id);
        expectProblem(res, 'SERVICE_UNAVAILABLE');
        expect(res.body).not.toContain('hunter2');
      } finally {
        add.mockRestore();
        getJob.mockRestore();
      }

      const [runId] = await runsOf(agent.id);
      if (!runId) throw new Error('eval run was not created');
      const row = await repo.evalRepo.getEvalRun(app.db, runId);
      expect(row?.status).toBe('failed');
      expect(row?.error).toBe(FIXED_ERROR);
      expect(row?.finishedAt).not.toBeNull();
    },
  );
});
