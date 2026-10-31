import { newId } from '@agentport/db';
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
  ADMIN_BUSINESS_ID,
} from './helpers.js';

const ready = await infraReady;

interface EvalRunBody {
  id: string;
  agentId: string;
  status: string;
  total: number;
  passed: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface EvalRunPageBody {
  items: EvalRunBody[];
  nextCursor: string | null;
}

describe.skipIf(!ready)('eval run list pagination', () => {
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
      await createAgent(app, cookie, { slug: unique('eval-page'), track: createdAgents })
    ).json<Agent>();

  // 直接落已收口的跑批：同一智能体只允许一个 running，且原始 SQL 才能控制微秒时间。
  const seedRun = async (agentId: string, createdAt: string, total: number, error?: string) => {
    const id = newId('evalRun');
    await app.pool.query(
      `insert into eval_runs
         (id, agent_id, created_by, status, total, passed, error, created_at, claimed_at, case_snapshot)
       values ($1, $2, $3, 'succeeded', $4, 0, $5, $6, now(), $7)`,
      [
        id,
        agentId,
        ADMIN_BUSINESS_ID,
        total,
        error ?? null,
        createdAt,
        JSON.stringify([{ id: 'case-1', name: 'snapshot', prompt: 'prompt', expectation: 'ok' }]),
      ],
    );
    return id;
  };

  it('returns a summary envelope and paginates newest first', async () => {
    const agent = await newAgent();
    const older = await seedRun(agent.id, '2026-02-01T00:00:00.100001Z', 1);
    const newer = await seedRun(agent.id, '2026-02-01T00:00:00.100002Z', 2, 'boom');

    const first = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}&limit=1`,
      headers: { cookie },
    });
    expect(first.statusCode, first.body).toBe(200);
    const firstPage = first.json<EvalRunPageBody>();
    expect(firstPage.items.map((run) => run.id)).toEqual([newer]);
    expect(firstPage.items[0]?.total).toBe(2);
    expect(firstPage.items[0]?.error).toBe('boom');
    expect(firstPage.nextCursor).toBe(newer);
    expect(Object.keys(firstPage.items[0] ?? {}).sort()).toEqual([
      'agentId',
      'createdAt',
      'error',
      'finishedAt',
      'id',
      'passed',
      'status',
      'total',
    ]);

    const second = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}&limit=1&cursor=${newer}`,
      headers: { cookie },
    });
    expect(second.statusCode, second.body).toBe(200);
    const secondPage = second.json<EvalRunPageBody>();
    expect(secondPage.items.map((run) => run.id)).toEqual([older]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('rejects missing, cross-agent, and out-of-range cursors', async () => {
    const agent = await newAgent();
    const other = await newAgent();
    const run = await seedRun(agent.id, '2026-02-02T00:00:00.000001Z', 1);
    const otherRun = await seedRun(other.id, '2026-02-02T00:00:00.000002Z', 1);

    const missing = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}&cursor=evalRun_missing`,
      headers: { cookie },
    });
    expectProblem(missing, 'INVALID_INPUT');

    const crossAgent = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}&cursor=${otherRun}`,
      headers: { cookie },
    });
    expectProblem(crossAgent, 'INVALID_INPUT');

    const tooLarge = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}&limit=101`,
      headers: { cookie },
    });
    expectProblem(tooLarge, 'INVALID_INPUT');

    const zero = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}&limit=0`,
      headers: { cookie },
    });
    expectProblem(zero, 'INVALID_INPUT');

    // 没有 agent 筛选时，别的智能体的游标也是合法游标。
    const unfiltered = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?cursor=${otherRun}&limit=100`,
      headers: { cookie },
    });
    expect(unfiltered.statusCode, unfiltered.body).toBe(200);
    const body = unfiltered.json<EvalRunPageBody>();
    expect(body.items.some((item) => item.id === otherRun)).toBe(false);
    expect(body.items.some((item) => item.id === run)).toBe(true);
  });

  it('keeps the agent filter when following a cursor', async () => {
    const agent = await newAgent();
    const other = await newAgent();
    const first = await seedRun(agent.id, '2026-02-03T00:00:00.000001Z', 1);
    const second = await seedRun(agent.id, '2026-02-03T00:00:00.000002Z', 2);
    await seedRun(other.id, '2026-02-03T00:00:00.000003Z', 3);

    const page = await inject(app, {
      method: 'GET',
      url: `/api/eval/runs?agentId=${agent.id}&cursor=${second}&limit=50`,
      headers: { cookie },
    });
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json<EvalRunPageBody>();
    expect(body.items.map((item) => item.id)).toEqual([first]);
    expect(body.nextCursor).toBeNull();
  });
});
