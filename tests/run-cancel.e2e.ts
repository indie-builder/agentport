import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

/**
 * 运行详情页取消：真实页面、真实 API、真实库。fixture 直写 queued / running / succeeded，
 * 不建 BullMQ job、不调模型；取消端点对不存在的 job 走正常分支（job 缺失不影响终态）。
 * E2E_DATABASE_URL 必须显式给出，且与 3010 上 API 指向同一个库。
 */
interface Fixture {
  agentId: string;
  conversationId: string;
  runId: string;
}

const created: Fixture[] = [];

/** 只删本文件建的 agent；会话、run、审批、消息随 agent 级联删除。 */
test.afterEach(async () => {
  await runFixture('run-cancel', 'cleanup', created);
  created.length = 0;
});

async function seedRun(status: 'queued' | 'running' | 'succeeded'): Promise<Fixture> {
  const value = await runFixture('run-cancel', 'seedRun', status);
  created.push(value);
  return value;
}

async function runStatus(runId: string): Promise<string | undefined> {
  return runFixture('run-cancel', 'runStatus', runId);
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

  await expect(screen.getByText('排队中', { exact: true })).toBeVisible();
  // 没有用户消息就没有可重发的内容，重跑按钮应当缺省。
  await expect(screen.getByRole('button', '重跑')).toHaveCount(0);
  const cancel = screen.getByRole('button', '取消运行');
  await expect(cancel).toBeVisible();

  await cancel.tap();
  await expect(screen.getByText('已请求取消运行')).toBeVisible();
  // 详情轮询把状态刷成终态，不整页刷新。
  await expect(screen.getByText('已取消', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => runStatus(fixture.runId), { timeout: 15_000 }).toBe('cancelled');
  await expect(screen.getByRole('button', '取消运行')).toHaveCount(0);
  expect(await navigationType(browser)).toBe('navigate');
});

test('a succeeded run offers no cancel button', { session: 'admin' }, async ({ app, screen }) => {
  const fixture = await seedRun('succeeded');
  await app.open(`/runs/${fixture.runId}`);

  await expect(screen.getByText('成功', { exact: true })).toBeVisible();
  await expect(screen.getByRole('button', '取消运行')).toHaveCount(0);
});

test('cancel a running run from the detail page and poll to cancelled', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seedRun('running');
  await app.open(`/runs/${fixture.runId}`);

  await expect(screen.getByText('运行中', { exact: true })).toBeVisible();
  const cancel = screen.getByRole('button', '取消运行');
  await expect(cancel).toBeVisible();

  await cancel.tap();
  await expect(screen.getByText('已请求取消运行')).toBeVisible();
  await expect(screen.getByText('已取消', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => runStatus(fixture.runId), { timeout: 15_000 }).toBe('cancelled');
  await expect(screen.getByRole('button', '取消运行')).toHaveCount(0);
  expect(await navigationType(browser)).toBe('navigate');
});
