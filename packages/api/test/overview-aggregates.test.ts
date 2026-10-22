import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from '@agentport/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 每次创建一次性数据库：概览是全表聚合，既不读其他用例数据，也不能清空共享测试库。
const ADMIN_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://agentport:agentport@localhost:5432/agentport';
const ISOLATED_DB_NAME = `agentport_overview_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ISOLATED_DATABASE_URL = (() => {
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${ISOLATED_DB_NAME}`;
  return url.toString();
})();
process.env.DATABASE_URL = ISOLATED_DATABASE_URL;

async function prepareIsolatedDatabase(): Promise<boolean> {
  try {
    const admin = createDb(ADMIN_DATABASE_URL);
    try {
      await admin.pool.query(`create database "${ISOLATED_DB_NAME}"`);
    } catch (error) {
      // 42P04：并发重试已创建，复用即可。
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
const { inject, loginCookie, startApp, unique } = helpers;
const ready = await helpers.infraReady;

describe.skipIf(!(ready && isolated))('overview aggregates', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
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

  async function seedAgent(): Promise<string> {
    const id = unique('overview-agent');
    await app.pool.query("insert into agents (id, slug, name, model) values ($1, $1, $1, 'm')", [
      id,
    ]);
    return id;
  }

  async function seedRun(
    agentId: string,
    status: string,
    startedAt: Date,
    tokens: { input: number | null; output: number | null } | null,
  ): Promise<void> {
    const conversationId = unique('overview-conv');
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      conversationId,
      agentId,
    ]);
    await app.pool.query(
      `insert into agent_runs
        (id, conversation_id, agent_id, status, started_at, ended_at, latency_ms, cost_usd, input_tokens, output_tokens)
       values ($1, $2, $3, $4, $5, $5, 100, 0.25, $6, $7)`,
      [
        unique('overview-run'),
        conversationId,
        agentId,
        status,
        startedAt,
        tokens?.input ?? null,
        tokens?.output ?? null,
      ],
    );
  }

  interface OverviewBody {
    counts: Record<string, number | null>;
    agents: { agentId: string; totalTokens: number }[];
  }

  function overview(days: number): Promise<OverviewBody> {
    return inject(app, {
      method: 'GET',
      url: `/api/overview?days=${days}`,
      headers: { cookie },
    }).then((res) => {
      expect(res.statusCode, res.body).toBe(200);
      return res.json<OverviewBody>();
    });
  }

  function counts(days: number): Promise<Record<string, number | null>> {
    return overview(days).then((body) => body.counts);
  }

  it('reports zero aggregates for an empty window', async () => {
    await seedAgent();
    const result = await counts(1);
    expect(result).toMatchObject({
      runs: 0,
      running: 0,
      failed: 0,
      tokens: 0,
      costUsd: 0,
      avgLatencyMs: null,
    });
  });

  it('counts failed/timeout runs and input+output tokens inside the window only', async () => {
    const agentId = await seedAgent();
    await seedRun(agentId, 'succeeded', new Date(Date.now() - 3_600_000), {
      input: 10,
      output: 5,
    });
    await seedRun(agentId, 'failed', new Date(Date.now() - 7_200_000), { input: 3, output: 2 });
    await seedRun(agentId, 'timeout', new Date(Date.now() - 10_800_000), null);
    // 窗口外：7 天窗口的下界之外，任何计数都不应包含它。
    await seedRun(agentId, 'failed', new Date(Date.now() - 8 * 86_400_000), {
      input: 100,
      output: 0,
    });

    const result = await counts(7);
    expect(result).toMatchObject({ runs: 3, running: 0, failed: 2, tokens: 20 });
  });

  it('keeps a single row whose token sum exceeds int4 range', async () => {
    const agentId = await seedAgent();
    const before = await overview(7);
    const tokensBefore = before.counts.tokens as number;
    const agentBefore = before.agents.find((a) => a.agentId === agentId);
    expect(agentBefore?.totalTokens).toBe(0);

    // 两列各自都在 int4 内，但相加 2_500_000_000 越界。
    await seedRun(agentId, 'succeeded', new Date(Date.now() - 60_000), {
      input: 1_500_000_000,
      output: 1_000_000_000,
    });

    const after = await overview(7);
    expect(typeof after.counts.tokens).toBe('number');
    expect(after.counts.tokens as number).toBe(tokensBefore + 2_500_000_000);
    expect(after.agents.find((a) => a.agentId === agentId)?.totalTokens).toBe(2_500_000_000);
  });

  it('keeps a total token sum across rows exceeding int4 range', async () => {
    const agentId = await seedAgent();
    const before = await overview(7);
    const tokensBefore = before.counts.tokens as number;

    // 每行 1_500_000_000 在 int4 内，两行合计 3_000_000_000 越界。
    await seedRun(agentId, 'succeeded', new Date(Date.now() - 120_000), {
      input: 1_500_000_000,
      output: 0,
    });
    await seedRun(agentId, 'succeeded', new Date(Date.now() - 180_000), {
      input: 1_500_000_000,
      output: 0,
    });

    const after = await overview(7);
    expect(typeof after.counts.tokens).toBe('number');
    expect(after.counts.tokens as number).toBe(tokensBefore + 3_000_000_000);
    expect(after.agents.find((a) => a.agentId === agentId)?.totalTokens).toBe(3_000_000_000);
  });
});
