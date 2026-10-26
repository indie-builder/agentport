import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from '@agentport/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 一次性库：导出是整表读，不能把共享测试库里的其他用例数据卷进来。
const ADMIN_DATABASE_URL = process.env.DATABASE_URL ?? '';
const ISOLATED_DB_NAME = `agentport_runs_export_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ISOLATED_DATABASE_URL = (() => {
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${ISOLATED_DB_NAME}`;
  return url.toString();
})();
if (ADMIN_DATABASE_URL !== '') process.env.DATABASE_URL = ISOLATED_DATABASE_URL;

async function prepareIsolatedDatabase(): Promise<boolean> {
  if (ADMIN_DATABASE_URL === '') return false;
  try {
    const admin = createDb(ADMIN_DATABASE_URL);
    try {
      await admin.pool.query(`create database "${ISOLATED_DB_NAME}"`);
    } catch (error) {
      // 42P04：已有同名库，复用。
      if ((error as { code?: string }).code !== '42P04') throw error;
    } finally {
      await admin.pool.end();
    }
    const target = createDb(ISOLATED_DATABASE_URL);
    try {
      await migrate(target.db, {
        migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
      });
    } finally {
      await target.pool.end();
    }
    return true;
  } catch {
    return false;
  }
}

const isolated = await prepareIsolatedDatabase();
// helpers 在模块求值时读取 DATABASE_URL，必须等库准备好再加载。
const helpers = await import('./helpers.js');
const { expectProblem, inject, loginCookie, startApp, unique } = helpers;
const ready = await helpers.infraReady;

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
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await app.close();
    const admin = createDb(ADMIN_DATABASE_URL);
    try {
      await admin.pool.query(`drop database if exists "${ISOLATED_DB_NAME}" with (force)`);
    } finally {
      await admin.pool.end();
    }
  });

  const exportRuns = (query = '', withCookie = true) =>
    inject(app, {
      method: 'GET',
      url: `/api/runs/export${query}`,
      headers: withCookie ? { cookie } : {},
    });

  async function seedAgent(): Promise<{ id: string; name: string }> {
    const id = unique('runs-export-agent');
    const name = `Agent ${id}`;
    await app.pool.query('insert into agents (id, slug, name, model) values ($1, $1, $2, $3)', [
      id,
      name,
      'm',
    ]);
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
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      conversationId,
      options.agentId,
    ]);
    await app.pool.query(
      `insert into agent_runs
        (id, conversation_id, agent_id, status, trigger, started_at, ended_at, latency_ms, cost_usd, turns, input_tokens, output_tokens, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        conversationId,
        options.agentId,
        options.status,
        options.trigger ?? 'chat',
        options.startedAt ?? null,
        options.endedAt ?? null,
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
    expect(res.headers['content-disposition']).toBe('attachment; filename="runs.json"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('application/json');

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
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      conversationId,
      agent.id,
    ]);
    await app.pool.query(
      `insert into agent_runs (id, conversation_id, agent_id, status)
       select $1 || '-' || g, $2, $3, 'succeeded' from generate_series(1, 1001) g`,
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
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      conversationId,
      agent.id,
    ]);
    await app.pool.query(
      `insert into agent_runs (id, conversation_id, agent_id, status)
       select $1 || '-' || g, $2, $3, 'timeout' from generate_series(1, 1000) g`,
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
        await app.pool.query(
          'select id, status, started_at, ended_at, latency_ms, cost_usd, turns, input_tokens, output_tokens, error from agent_runs where id = $1',
          [id],
        )
      ).rows[0];
    const before = await row();

    expect((await exportRuns(`?agentId=${encodeURIComponent(agent.id)}`)).statusCode).toBe(200);

    expect(await row()).toEqual(before);
  });
});
