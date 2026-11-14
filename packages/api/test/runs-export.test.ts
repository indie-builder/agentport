import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';

// 一次性库：导出是整表读，不能把共享测试库里的其他用例数据卷进来。
const isolated = await createIsolatedDatabase('api_runs_export', process.env.DATABASE_URL ?? '');
if (isolated) process.env.DATABASE_URL = isolated.url;

// helpers 在模块求值时读取 DATABASE_URL，必须等库准备好再加载。
const helpers = await import('./helpers.js');
const { ADMIN_BUSINESS_ID, expectProblem, request, loginCookie, startApp, unique } = helpers;

import type { TestApp } from './helpers.js';

const ready = await helpers.infraReady;
// skipIf 的 describe 不跑 hook；Redis 缺失时这里回收自己刚建的库。
if (!ready && isolated) await isolated.close();

interface ExportedItem {
  id: string;
  agentId: string;
  agentName: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  latencyMs: number | null;
  costUsd: string | null;
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

interface ExportBody {
  format: string;
  exportedAt: string;
  items: ExportedItem[];
}

describe.skipIf(!(ready && isolated))('runs export', () => {
  let app: TestApp;
  let cookie: string;

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      await isolated?.close();
    }
  });

  const exportRuns = (query = '', withCookie = true) =>
    request(app, {
      method: 'GET',
      url: `/api/runs/export${query}`,
      headers: withCookie ? { cookie } : {},
    });

  const exportRunTrajectory = (id: string, withCookie = true) =>
    request(app, {
      method: 'GET',
      url: `/api/runs/${id}/export`,
      headers: withCookie ? { cookie } : {},
    });

  async function seedAgent(): Promise<{ id: string; name: string }> {
    const id = unique('runs-export-agent');
    const name = `Agent ${id}`;
    await app.client.unsafe(
      'insert into agents (id, slug, name, model, created_by, owner_business_id) values ($1, $1, $2, $3, $4, $4)',
      [id, name, 'm', ADMIN_BUSINESS_ID],
    );
    return { id, name };
  }

  async function seedRun(options: {
    agentId: string;
    status: string;
    trigger?: string;
    startedAt?: Date | null;
    endedAt?: Date | null;
    latencyMs?: number | null;
    costUsd?: string | null;
    turns?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    error?: string | null;
    id?: string;
  }): Promise<string> {
    const id = options.id ?? unique('runs-export-run');
    const conversationId = unique('runs-export-conv');
    await app.client.unsafe(
      'insert into conversations (id, agent_id, created_by) values ($1, $2, $3)',
      [conversationId, options.agentId, ADMIN_BUSINESS_ID],
    );
    await app.client.unsafe(
      `insert into agent_runs
        (id, conversation_id, agent_id, status, trigger, subject_kind, initiated_by, started_at, ended_at, latency_ms, cost_usd, turns, input_tokens, output_tokens, error)
       values ($1, $2, $3, $4, $5, 'user', $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        conversationId,
        options.agentId,
        options.status,
        options.trigger ?? 'chat',
        ADMIN_BUSINESS_ID,
        options.startedAt?.toISOString() ?? null,
        options.endedAt?.toISOString() ?? null,
        options.latencyMs ?? null,
        options.costUsd ?? null,
        options.turns ?? null,
        options.inputTokens ?? null,
        options.outputTokens ?? null,
        options.error ?? null,
      ],
    );
    return id;
  }

  it('requires authentication', async () => {
    expectProblem(await exportRuns('', false), 'UNAUTHORIZED');
  });

  it('exports a single run trajectory to its owner', async () => {
    const agent = await seedAgent();
    const id = await seedRun({ agentId: agent.id, status: 'succeeded' });
    const [runRow] = await app.client.unsafe<{ conversation_id: string }[]>(
      'select conversation_id from agent_runs where id = $1',
      [id],
    );
    const conversationId = runRow.conversation_id;
    await app.client.unsafe(
      `insert into messages (id, conversation_id, role, content, run_id, created_at)
       values ($1, $2, 'user', $3::jsonb, $4, now()),
              ($5, $2, 'assistant', $6::jsonb, $4, now() + interval '1 second')`,
      [
        unique('msg'),
        conversationId,
        JSON.stringify({ text: '请总结这份报告' }),
        id,
        unique('msg'),
        JSON.stringify({ type: 'text', text: '这是总结。' }),
      ],
    );

    const res = await exportRunTrajectory(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="run-${id}.json"`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const body = res.json<{
      format: string;
      run: { id: string };
      conversation: { id: string };
      steps: Array<{ kind: string; text?: string }>;
    }>();
    expect(body.format).toBe('agentport/run-trajectory@1');
    expect(body.run.id).toBe(id);
    expect(body.conversation.id).toBe(conversationId);
    const userSteps = body.steps.filter((step) => step.kind === 'user');
    const assistantSteps = body.steps.filter((step) => step.kind === 'assistant');
    expect(userSteps.some((step) => step.text === '请总结这份报告')).toBe(true);
    expect(assistantSteps.some((step) => step.text === '这是总结。')).toBe(true);
  });

  it('rejects unauthenticated and unknown runs', async () => {
    expectProblem(await exportRunTrajectory(unique('runs-export-run'), false), 'UNAUTHORIZED');
    expectProblem(await exportRunTrajectory('run-does-not-exist'), 'RUN_NOT_FOUND');
  });

  it('filters by agent and status exactly', async () => {
    const own = await seedAgent();
    const other = await seedAgent();
    const failed = await seedRun({ agentId: own.id, status: 'failed' });
    const succeeded = await seedRun({ agentId: own.id, status: 'succeeded' });
    const foreign = await seedRun({ agentId: other.id, status: 'failed' });

    const res = await exportRuns(`?agentId=${encodeURIComponent(own.id)}&status=failed`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = res.json<ExportBody>().items.map((item) => item.id);
    expect(ids).toEqual([failed]);
    expect(ids).not.toContain(succeeded);
    expect(ids).not.toContain(foreign);
  });

  it('filters by trigger exactly', async () => {
    const agent = await seedAgent();
    const chat = await seedRun({ agentId: agent.id, status: 'succeeded', trigger: 'chat' });
    const scheduled = await seedRun({
      agentId: agent.id,
      status: 'succeeded',
      trigger: 'schedule',
    });

    const res = await exportRuns(`?agentId=${encodeURIComponent(agent.id)}&trigger=schedule`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = res.json<ExportBody>().items.map((item) => item.id);
    expect(ids).toEqual([scheduled]);
    expect(ids).not.toContain(chat);
  });

  it.each(['/api/runs', '/api/runs/export'])(
    'filters %s by startedAt since inclusively',
    async (url) => {
      const agent = await seedAgent();
      await seedRun({
        agentId: agent.id,
        status: 'succeeded',
        startedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      await seedRun({ agentId: agent.id, status: 'queued' });
      const since = '2026-10-15T00:00:00.000Z';
      const recent = await seedRun({
        agentId: agent.id,
        status: 'succeeded',
        startedAt: new Date('2026-10-20T00:00:00.000Z'),
      });
      const boundary = await seedRun({
        agentId: agent.id,
        status: 'succeeded',
        startedAt: new Date(since),
      });

      const res = await request(app, {
        method: 'GET',
        url: `${url}?${new URLSearchParams({ agentId: agent.id, since })}`,
        headers: { cookie },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ items: ExportedItem[] }>().items.map((item) => item.id)).toEqual([
        recent,
        boundary,
      ]);
    },
  );

  it('returns RunListItem fields with ISO dates and no steps or messages', async () => {
    const agent = await seedAgent();
    const startedAt = new Date('2026-10-22T01:02:03.000Z');
    const endedAt = new Date('2026-10-22T01:02:04.500Z');
    const id = await seedRun({
      agentId: agent.id,
      status: 'succeeded',
      startedAt,
      endedAt,
      latencyMs: 1500,
      costUsd: '0.2500',
      turns: 3,
      inputTokens: 12,
      outputTokens: 34,
    });

    const res = await exportRuns(`?agentId=${encodeURIComponent(agent.id)}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="runs.json"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = res.json<ExportBody>();
    expect(Object.keys(body).sort()).toEqual(['exportedAt', 'format', 'items']);
    expect(body.format).toBe('agentport/runs@1');
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    expect(body.items).toEqual([
      {
        id,
        agentId: agent.id,
        agentName: agent.name,
        status: 'succeeded',
        trigger: 'chat',
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        latencyMs: 1500,
        costUsd: '0.2500',
        turns: 3,
        inputTokens: 12,
        outputTokens: 34,
        error: null,
        agentVersion: null,
      },
    ]);
    expect(res.body).not.toContain('steps');
    expect(res.body).not.toContain('messages');
    expect(res.body).not.toContain('prompt');
  });

  it('rejects more than 1000 rows instead of truncating', async () => {
    const agent = await seedAgent();
    const conversationId = unique('runs-export-conv');
    await app.client.unsafe(
      "insert into conversations (id, agent_id, created_by) values ($1, $2, 'bootstrap-admin')",
      [conversationId, agent.id],
    );
    await app.client.unsafe(
      `insert into agent_runs (id, conversation_id, agent_id, status, subject_kind, initiated_by)
       select $1 || '-' || g, $2, $3, 'succeeded', 'user', 'bootstrap-admin' from generate_series(1, 1001) g`,
      [unique('runs-export-bulk'), conversationId, agent.id],
    );

    expectProblem(await exportRuns(`?agentId=${encodeURIComponent(agent.id)}`), 'CONFLICT');
    expectProblem(
      await exportRuns(`?agentId=${encodeURIComponent(agent.id)}&limit=1001`),
      'INVALID_INPUT',
    );
  });

  it('exports exactly 1000 rows', async () => {
    const agent = await seedAgent();
    const conversationId = unique('runs-export-conv');
    await app.client.unsafe(
      "insert into conversations (id, agent_id, created_by) values ($1, $2, 'bootstrap-admin')",
      [conversationId, agent.id],
    );
    await app.client.unsafe(
      `insert into agent_runs (id, conversation_id, agent_id, status, subject_kind, initiated_by)
       select $1 || '-' || g, $2, $3, 'timeout', 'user', 'bootstrap-admin' from generate_series(1, 1000) g`,
      [unique('runs-export-exact'), conversationId, agent.id],
    );

    const res = await exportRuns(`?agentId=${encodeURIComponent(agent.id)}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ExportBody>().items).toHaveLength(1000);
  });

  it('does not mutate stored runs', async () => {
    const agent = await seedAgent();
    const id = await seedRun({ agentId: agent.id, status: 'failed', error: 'boom' });
    const row = async () =>
      (
        await app.client.unsafe(
          'select id, status, started_at, ended_at, latency_ms, cost_usd, turns, input_tokens, output_tokens, error from agent_runs where id = $1',
          [id],
        )
      )[0];
    const before = await row();

    expect((await exportRuns(`?agentId=${encodeURIComponent(agent.id)}`)).statusCode).toBe(200);

    expect(await row()).toEqual(before);
  });
});
