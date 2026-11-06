import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

/**
 * 概览的失败数与 tokens：真实 API + 真实页面 + 数据库直写 fixture。
 * 概览是全库聚合，其他行会让绝对总数不可预测，所以 API 断言用「种子前后增量」。
 * E2E_DATABASE_URL 必须显式给出，且与 3010 上 API 指向同一个库。
 */
interface Fixture {
  agentId: string;
  conversationId: string;
}

const created: Fixture[] = [];

test.afterEach(async () => {
  await runFixture('overview-aggregates', 'cleanup', created);
  created.length = 0;
});

/**
 * 21 条近 7 天成功（2 小时前起，1 分钟一条）+ 4 条窗口内失败（5–8 小时前）
 * + 1 条 8 天前失败（窗口外）。所有时间都早于 2 小时，避免与正在收尾的运行混淆。
 */
async function seed(): Promise<Fixture> {
  const value = await runFixture('overview-aggregates', 'seed');
  created.push(value);
  return value;
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
