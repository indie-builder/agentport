import { recentUtcDays, utcWindowStart } from '@agentport/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';

const DAY_MS = 86_400_000;

/** 固定到当前 UTC 自然日，避免用例在午夜附近跨天。 */
function utcMidnight(offsetDays = 0): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * DAY_MS,
  );
}

// 每次创建一次性数据库：概览是全表聚合，既不读其他用例数据，也不能清空共享测试库。
const isolated = await createIsolatedDatabase('api_overview', process.env.DATABASE_URL ?? '');
if (isolated) process.env.DATABASE_URL = isolated.url;

// helpers 在模块求值时读取 DATABASE_URL，必须等库准备好再加载。
const helpers = await import('./helpers.js');
const { createAgent, createTestAccount, inject, loginCookie, setAgentMember, startApp, unique } =
  helpers;
const ready = await helpers.infraReady;
// skipIf 的 describe 不跑 hook；Redis 缺失时这里回收自己刚建的库。
if (!ready && isolated) await isolated.close();

describe.skipIf(!(ready && isolated))('overview aggregates', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
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

  async function seedAgent(): Promise<string> {
    const id = unique('overview-agent');
    await app.pool.query(
      "insert into agents (id, slug, name, model, created_by, owner_business_id) values ($1, $1, $1, 'm', $2, $2)",
      [id, helpers.ADMIN_BUSINESS_ID],
    );
    return id;
  }

  async function seedRun(
    agentId: string,
    status: string,
    startedAt: Date | null,
    tokens: { input: number | null; output: number | null } | null,
    latencyMs: number | null = 100,
  ): Promise<void> {
    const conversationId = unique('overview-conv');
    await app.pool.query(
      'insert into conversations (id, agent_id, created_by) values ($1, $2, $3)',
      [conversationId, agentId, helpers.ADMIN_BUSINESS_ID],
    );
    await app.pool.query(
      `insert into agent_runs
        (id, conversation_id, agent_id, status, subject_kind, initiated_by, started_at, ended_at, latency_ms, cost_usd, input_tokens, output_tokens)
       values ($1, $2, $3, $4, 'user', $9, $5, $5, $8, 0.25, $6, $7)`,
      [
        unique('overview-run'),
        conversationId,
        agentId,
        status,
        startedAt,
        tokens?.input ?? null,
        tokens?.output ?? null,
        latencyMs,
        helpers.ADMIN_BUSINESS_ID,
      ],
    );
  }

  interface OverviewBody {
    window: { days: number; since: string };
    counts: Record<string, number | null>;
    agents: {
      agentId: string;
      totalTokens: number;
      createdAt: string;
      lastRunStartTime: string | null;
      latencyP50: number | null;
      latencyP99: number | null;
      runCount: number;
    }[];
    recent: { agentId: string; startedAt: string | null; endedAt: string | null }[];
  }

  interface TrendPoint {
    date: string;
    runs: number;
    failed: number;
    costUsd: number;
    tokens: number;
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

  function timeseries(days?: number): Promise<TrendPoint[]> {
    const url =
      days === undefined ? '/api/overview/timeseries' : `/api/overview/timeseries?days=${days}`;
    return inject(app, { method: 'GET', url, headers: { cookie } }).then((res) => {
      expect(res.statusCode, res.body).toBe(200);
      return res.json<TrendPoint[]>();
    });
  }

  it('reports zero aggregates for an empty database', async () => {
    const result = await overview(1);
    expect(result.counts).toEqual({
      servers: 0,
      agents: 0,
      runs: 0,
      running: 0,
      failed: 0,
      tokens: 0,
      costUsd: 0,
      avgLatencyMs: null,
    });
    expect(result.agents).toEqual([]);
    expect(result.recent).toEqual([]);
  });

  it('keeps NULL latency and ISO dates when only the narrow window contains a run', async () => {
    const agentId = await seedAgent();
    const startedAt = new Date(utcMidnight().getTime() + 60_000);
    await seedRun(agentId, 'succeeded', startedAt, { input: null, output: 5 }, null);
    const result = await overview(1);
    expect(result.counts).toMatchObject({ runs: 1, tokens: 5, costUsd: 0.25, avgLatencyMs: null });
    expect(result.agents.find((agent) => agent.agentId === agentId)).toMatchObject({
      lastRunStartTime: startedAt.toISOString(),
      latencyP50: null,
      latencyP99: null,
    });
    const createdAt = result.agents.find((agent) => agent.agentId === agentId)?.createdAt;
    expect(new Date(createdAt as string).toISOString()).toBe(createdAt);
    expect(result.recent.find((run) => run.agentId === agentId)).toMatchObject({
      startedAt: startedAt.toISOString(),
      endedAt: startedAt.toISOString(),
    });
    expect(new Date(result.window.since).toISOString()).toBe(result.window.since);
    // Keep later window fixtures independent of this run without clearing shared data.
    await app.pool.query('delete from agents where id = $1', [agentId]);
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

    // running 是全局数量，包含窗口外以及尚无 started_at 的运行。
    await seedRun(agentId, 'running', new Date(Date.now() - 8 * 86_400_000), {
      input: 100,
      output: 100,
    });
    await seedRun(agentId, 'running', null, null);
    await app.pool.query(
      "insert into servers (id, name, kind, config) values ($1, $1, 'http', '{}')",
      [unique('overview-server')],
    );

    const result = await counts(7);
    expect(result).toMatchObject({
      servers: 1,
      agents: 1,
      runs: 3,
      running: 2,
      failed: 2,
      tokens: 20,
      costUsd: 0.75,
      avgLatencyMs: 100,
    });
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

  it('counts only user-manageable servers, matching the server list', async () => {
    await app.pool.query(
      "insert into servers (id, name, kind, config) values ($1, $1, 'http', '{}')",
      [unique('overview-server-list')],
    );
    await app.pool.query(
      "insert into servers (id, name, kind, config) values ($1, $1, 'knowledge', '{}')",
      [unique('overview-knowledge')],
    );

    const [body, list] = await Promise.all([
      overview(7),
      inject(app, { method: 'GET', url: '/api/servers', headers: { cookie } }),
    ]);
    expect(list.statusCode, list.body).toBe(200);
    expect(body.counts.servers).toBe(list.json<unknown[]>().length);
  });

  it('uses UTC natural days for the window boundary', async () => {
    const agentId = await seedAgent();
    const since = utcWindowStart(2);
    const before = await counts(2);
    // 窗口起点那一毫秒计入，再早一毫秒就不计入。
    await seedRun(agentId, 'succeeded', since, { input: 1, output: 0 });
    await seedRun(agentId, 'failed', new Date(since.getTime() - 1), { input: 1, output: 0 });

    const result = await overview(2);
    expect(new Date(result.window.since).getTime()).toBe(since.getTime());
    expect(result.counts.runs).toBe((before.runs as number) + 1);
    expect(result.counts.failed).toBe(before.failed);
  });

  it('defaults both overview endpoints to the same 7 UTC days', async () => {
    const [body, points] = await Promise.all([
      inject(app, { method: 'GET', url: '/api/overview', headers: { cookie } }).then((res) => {
        expect(res.statusCode, res.body).toBe(200);
        return res.json<OverviewBody>();
      }),
      timeseries(),
    ]);
    expect(body.window.days).toBe(7);
    expect(points.map((point) => point.date)).toEqual(recentUtcDays(7));
  });

  it('returns exactly N UTC dates and groups runs by UTC day across a month boundary', async () => {
    const agentId = await seedAgent();
    const today = utcMidnight();
    // 32 天必然跨月：最长月份只有 31 天；31 天在 10/31、12/31 恰好落在同一个月。
    const expected = recentUtcDays(32);
    const before = await timeseries(32);

    await seedRun(agentId, 'succeeded', new Date(today.getTime() + 60_000), {
      input: 2,
      output: 3,
    });
    await seedRun(agentId, 'succeeded', new Date(today.getTime() - 86_340_000), {
      input: 1,
      output: 1,
    });

    const points = await timeseries(32);
    expect(points.map((point) => point.date)).toEqual(expected);
    // 跨月点也必须连续补 0。
    expect(new Set(expected.map((date) => date.slice(0, 7))).size).toBeGreaterThan(1);

    const runsOn = (list: TrendPoint[], date: string) =>
      list.find((point) => point.date === date)?.runs ?? 0;
    expect(runsOn(points, expected.at(-1) as string)).toBe(
      runsOn(before, expected.at(-1) as string) + 1,
    );
    expect(runsOn(points, expected.at(-2) as string)).toBe(
      runsOn(before, expected.at(-2) as string) + 1,
    );
  });

  it('matches overview aggregates over the same window and sources', async () => {
    const [body, points] = await Promise.all([overview(7), timeseries(7)]);
    expect(points).toHaveLength(7);
    const sums = points.reduce(
      (total, point) => ({
        runs: total.runs + point.runs,
        failed: total.failed + point.failed,
        tokens: total.tokens + point.tokens,
        costUsd: total.costUsd + point.costUsd,
      }),
      { runs: 0, failed: 0, tokens: 0, costUsd: 0 },
    );
    expect(sums.runs).toBe(body.counts.runs);
    expect(sums.failed).toBe(body.counts.failed);
    expect(sums.tokens).toBe(body.counts.tokens);
    expect(sums.costUsd).toBeCloseTo(body.counts.costUsd as number, 6);
    // 专家行与汇总共用同一个窗口与数据源。
    expect(body.agents.reduce((total, agent) => total + agent.runCount, 0)).toBe(body.counts.runs);
  });

  it('scopes expert cost and tokens to the viewer own runs', async () => {
    const admin = cookie;
    const userA = await createTestAccount(app, admin, { systemKeys: ['owner'] });
    const userB = await createTestAccount(app, admin, { systemKeys: ['user'] });
    // A 拥有专家，B 被授权在同一个专家上运行。
    const created = await createAgent(app, userA.cookie);
    const agentId = created.json<{ id: string }>().id;
    // 另一个本人专家没有任何运行：JOIN 范围过滤不能把它整行过滤掉。
    const emptyAgentId = (await createAgent(app, userA.cookie)).json<{ id: string }>().id;
    await setAgentMember(app, admin, agentId, userB.businessId, {
      canUse: true,
      canMaintain: false,
    });

    const seedOwnRun = async (
      initiatedBy: string,
      input: number,
      output: number,
      costUsd: number,
    ): Promise<void> => {
      const conversationId = unique('scope-conv');
      await app.pool.query(
        'insert into conversations (id, agent_id, created_by) values ($1, $2, $3)',
        [conversationId, agentId, initiatedBy],
      );
      await app.pool.query(
        `insert into agent_runs
          (id, conversation_id, agent_id, status, subject_kind, initiated_by, started_at, ended_at, latency_ms, cost_usd, input_tokens, output_tokens)
         values ($1, $2, $3, 'succeeded', 'user', $4, now(), now(), 100, $5, $6, $7)`,
        [unique('scope-run'), conversationId, agentId, initiatedBy, costUsd, input, output],
      );
    };
    await seedOwnRun(userA.businessId, 10, 5, 0.25);
    await seedOwnRun(userB.businessId, 100, 50, 2.5);

    const overviewAs = async (headerCookie: string): Promise<OverviewBody> => {
      const res = await inject(app, {
        method: 'GET',
        url: '/api/overview?days=1',
        headers: { cookie: headerCookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<OverviewBody>();
    };

    const aBody = await overviewAs(userA.cookie);
    expect(aBody.counts).toMatchObject({ runs: 1, tokens: 15, costUsd: 0.25 });
    expect(aBody.agents.find((agent) => agent.agentId === agentId)).toMatchObject({
      runCount: 1,
      totalTokens: 15,
      totalCost: 0.25,
    });
    expect(aBody.agents.find((agent) => agent.agentId === emptyAgentId)).toMatchObject({
      runCount: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    const bBody = await overviewAs(userB.cookie);
    expect(bBody.counts).toMatchObject({ runs: 1, tokens: 150, costUsd: 2.5 });
    // B 不是专家创建者：专家列表不出现 A 的专家，统计也不串。
    expect(bBody.agents.find((agent) => agent.agentId === agentId)).toBeUndefined();

    await app.pool.query('delete from agents where id = any($1::text[])', [
      [agentId, emptyAgentId],
    ]);
  });
});
