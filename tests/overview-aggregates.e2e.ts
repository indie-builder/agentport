import { randomUUID } from 'node:crypto';
import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createDb, newId } from '../packages/db/dist/index.js';

/**
 * 概览的失败数与 tokens：真实 API + 真实页面 + 数据库直写 fixture。
 * 概览是全库聚合，其他行会让绝对总数不可预测，所以 API 断言用「种子前后增量」。
 * DATABASE_URL 必须显式给出，且与 3010 上 API 指向同一个库。
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for overview fixtures`);
  return value;
}
const DATABASE_URL = requiredEnv('DATABASE_URL');

let dbPromise: ReturnType<typeof createDb> | undefined;
function db() {
  dbPromise ??= createDb(DATABASE_URL);
  return dbPromise;
}

test.afterAll(async () => {
  const current = await dbPromise;
  await current?.pool.end();
});

interface Fixture {
  agentId: string;
  conversationId: string;
}

const created: Fixture[] = [];

test.afterEach(async () => {
  const { pool } = await db();
  const targets = created.flatMap((fixture) => [fixture.agentId, fixture.conversationId]);
  if (targets.length > 0) {
    await pool.query('delete from audit_log where target = any($1::text[])', [targets]);
    await pool.query('delete from agents where id = any($1::text[])', [
      created.map((fixture) => fixture.agentId),
    ]);
  }
  created.length = 0;
});

interface RunSeed {
  status: 'succeeded' | 'failed';
  startedAt: Date;
  input: number;
  output: number;
  error: string | null;
}

/**
 * 21 条近 7 天成功（2 小时前起，1 分钟一条）+ 4 条窗口内失败（5–8 小时前）
 * + 1 条 8 天前失败（窗口外）。所有时间都早于 2 小时，避免与正在收尾的运行混淆。
 */
async function seed(): Promise<Fixture> {
  const { pool } = await db();
  const suffix = randomUUID().slice(0, 8);
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const newest = Date.now() - 2 * 3_600_000;

  await pool.query("insert into agents (id, slug, name, model) values ($1, $2, $3, 'test-model')", [
    agentId,
    `e2e-overview-${suffix}`,
    `E2E 概览 ${suffix}`,
  ]);
  await pool.query('insert into conversations (id, agent_id, title) values ($1, $2, $3)', [
    conversationId,
    agentId,
    'E2E 概览',
  ]);

  const runs: RunSeed[] = [
    ...Array.from(
      { length: 21 },
      (_, index): RunSeed => ({
        status: 'succeeded',
        startedAt: new Date(newest - index * 60_000),
        input: 10,
        output: 5,
        error: null,
      }),
    ),
    ...Array.from(
      { length: 4 },
      (_, index): RunSeed => ({
        status: 'failed',
        startedAt: new Date(newest - (3 + index) * 3_600_000),
        input: 3,
        output: 2,
        error: 'overview fixture failure',
      }),
    ),
    {
      status: 'failed',
      startedAt: new Date(newest - 8 * 86_400_000),
      input: 100,
      output: 0,
      error: 'overview fixture out of window',
    },
  ];

  for (const run of runs) {
    await pool.query(
      `insert into agent_runs
         (id, conversation_id, agent_id, status, started_at, ended_at, latency_ms, cost_usd,
          input_tokens, output_tokens, error)
       values ($1, $2, $3, $4, $5, $5, 100, 0.01, $6, $7, $8)`,
      [
        newId('run'),
        conversationId,
        agentId,
        run.status,
        run.startedAt,
        run.input,
        run.output,
        run.error,
      ],
    );
  }

  const fixture: Fixture = { agentId, conversationId };
  created.push(fixture);
  return fixture;
}

interface Counts {
  failed: number;
  tokens: number;
}

async function readCounts(browser: Browser): Promise<Counts> {
  return browser.evaluate(async () => {
    const res = await fetch('/api/overview?days=7');
    const body = (await res.json()) as {
      counts: { failed: number; tokens: number };
    };
    if (!res.ok) throw new Error(`GET /api/overview ${res.status}`);
    return { failed: body.counts.failed, tokens: body.counts.tokens };
  });
}

test('overview API counts failed runs and tokens as numbers, window only', {
  session: 'admin',
}, async ({ app, browser }) => {
  await app.open('/operations');
  const before = await readCounts(browser);
  await seed();
  const after = await readCounts(browser);

  expect(typeof after.failed).toBe('number');
  expect(typeof after.tokens).toBe('number');
  // 窗口内新增 4 条失败（8 天前那条不计）；成功 21×(10+5) + 失败 4×(3+2)。
  expect(after.failed - before.failed).toBe(4);
  expect(after.tokens - before.tokens).toBe(335);
});

test('overview page shows failed and token hints from the aggregates', {
  session: 'admin',
}, async ({ app, browser, screen }) => {
  await seed();
  await app.open('/operations');

  // 概况迁入运维后复用 OverviewPage，h1 与路由名称一致。
  await expect(screen.getByRole('heading', '概况')).toBeVisible();
  await expect(browser).toHaveTitle('概况 · PACE');
  await expect(browser.locator('[role="alert"]')).toHaveCount(0);

  await expect(screen.getByText('最近 7 天', { exact: true })).toBeVisible();
  await expect(screen.getByText(/^\d+ 次失败$/)).toBeVisible();
  await expect(screen.getByText(/^[\d.]+[kM]? tokens$/)).toBeVisible();
});
