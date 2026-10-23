import { randomUUID } from 'node:crypto';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { agentRuns, agents, conversations, createDb, newId } from '../packages/db/dist/index.js';

/**
 * 运行详情页取消：真实页面、真实 API、真实库。fixture 直写 queued / running / succeeded，
 * 不建 BullMQ job、不调模型；取消端点对不存在的 job 走正常分支（job 缺失不影响终态）。
 * DATABASE_URL 必须显式给出，且与 3010 上 API 指向同一个库。
 */
const DATABASE_URL = process.env.DATABASE_URL;
function dbUrl(): string {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for run cancel fixtures');
  return DATABASE_URL;
}

let dbPromise: ReturnType<typeof createDb> | undefined;
function db() {
  dbPromise ??= createDb(dbUrl());
  return dbPromise;
}

test.afterAll(async () => {
  const current = await dbPromise;
  await current?.pool.end();
});

interface Fixture {
  agentId: string;
  conversationId: string;
  runId: string;
}

const created: Fixture[] = [];

/** 只删本文件建的 agent；会话、run、审批、消息随 agent 级联删除。 */
test.afterEach(async () => {
  const current = await db();
  const agentIds = created.map((fixture) => fixture.agentId);
  const targets = created.flatMap((fixture) => [
    fixture.agentId,
    fixture.conversationId,
    fixture.runId,
  ]);
  if (targets.length > 0) {
    await current.pool.query('delete from audit_log where target = any($1::text[])', [targets]);
  }
  if (agentIds.length > 0) {
    await current.pool.query('delete from agents where id = any($1::text[])', [agentIds]);
  }
  created.length = 0;
});

async function seedRun(status: 'queued' | 'running' | 'succeeded'): Promise<Fixture> {
  const { db: client } = await db();
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    agentId: newId('agent'),
    conversationId: newId('conversation'),
    runId: newId('run'),
  };
  await client.insert(agents).values({
    id: fixture.agentId,
    slug: `e2e-run-cancel-${suffix}`,
    name: `E2E 取消运行 ${suffix}`,
    model: 'test-model',
  });
  await client
    .insert(conversations)
    .values({ id: fixture.conversationId, agentId: fixture.agentId, title: 'E2E 取消运行' });
  await client.insert(agentRuns).values({
    id: fixture.runId,
    conversationId: fixture.conversationId,
    agentId: fixture.agentId,
    status,
    ...(status === 'running' ? { startedAt: new Date() } : {}),
    ...(status === 'succeeded' ? { startedAt: new Date(), endedAt: new Date() } : {}),
  });
  created.push(fixture);
  return fixture;
}

async function runStatus(runId: string): Promise<string | undefined> {
  const { pool } = await db();
  const { rows } = await pool.query<{ status: string }>(
    'select status from agent_runs where id = $1',
    [runId],
  );
  return rows[0]?.status;
}

/**
 * 轮询更新靠 TanStack Query，整页不重载：reload 会把 navigation type 改成 reload。
 * 用字符串表达式读，避免测试文件依赖 DOM 类型。
 */
async function navigationType(browser: { evaluate(value: string): Promise<unknown> }) {
  return (await browser.evaluate(
    "performance.getEntriesByType('navigation')[0]?.type ?? 'navigate'",
  )) as string;
}

test('cancel a queued run from the detail page and poll to cancelled', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seedRun('queued');
  await app.open(`/runs/${fixture.runId}`);

  await expect(screen.getByRole('heading', /· 排队中/)).toBeVisible();
  // 没有用户消息就没有可重发的内容，重跑按钮应当缺省。
  await expect(screen.getByRole('button', '重跑')).toHaveCount(0);
  const cancel = screen.getByRole('button', '取消运行');
  await expect(cancel).toBeVisible();

  await cancel.tap();
  await expect(screen.getByText('已请求取消运行')).toBeVisible();
  // 详情轮询把状态刷成终态，不整页刷新。
  await expect(screen.getByRole('heading', /· 已取消/)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => runStatus(fixture.runId), { timeout: 15_000 }).toBe('cancelled');
  await expect(screen.getByRole('button', '取消运行')).toHaveCount(0);
  expect(await navigationType(browser)).toBe('navigate');
});

test('a succeeded run offers no cancel button', { session: 'admin' }, async ({ app, screen }) => {
  const fixture = await seedRun('succeeded');
  await app.open(`/runs/${fixture.runId}`);

  await expect(screen.getByRole('heading', /· 成功/)).toBeVisible();
  await expect(screen.getByRole('button', '取消运行')).toHaveCount(0);
});

test('cancel a running run from the detail page and poll to cancelled', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seedRun('running');
  await app.open(`/runs/${fixture.runId}`);

  await expect(screen.getByRole('heading', /· 运行中/)).toBeVisible();
  const cancel = screen.getByRole('button', '取消运行');
  await expect(cancel).toBeVisible();

  await cancel.tap();
  await expect(screen.getByText('已请求取消运行')).toBeVisible();
  await expect(screen.getByRole('heading', /· 已取消/)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => runStatus(fixture.runId), { timeout: 15_000 }).toBe('cancelled');
  await expect(screen.getByRole('button', '取消运行')).toHaveCount(0);
  expect(await navigationType(browser)).toBe('navigate');
});
