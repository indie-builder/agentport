import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

interface Fixture {
  agentId: string;
  conversationId: string;
  runId: string;
}

const created: Fixture[] = [];

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

async function cancelRequested(runId: string): Promise<boolean> {
  return runFixture('run-cancel', 'cancelRequested', runId);
}

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
  await expect(screen.getByRole('button', '重跑')).toHaveCount(0);
  const cancel = screen.getByRole('button', '取消运行');
  await expect(cancel).toBeVisible();

  await cancel.tap();
  await expect(screen.getByText('已请求取消运行')).toBeVisible();
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

test('cancel a running run only signals the worker', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  const fixture = await seedRun('running');
  await app.open(`/runs/${fixture.runId}`);

  await expect(screen.getByText('运行中', { exact: true })).toBeVisible();
  const cancel = screen.getByRole('button', '取消运行');
  await expect(cancel).toBeVisible();

  await cancel.tap();
  await expect(screen.getByText('已请求取消运行')).toBeVisible();
  await expect.poll(() => cancelRequested(fixture.runId), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => runStatus(fixture.runId), { timeout: 5_000 }).toBe('running');
  await expect(screen.getByText('运行中', { exact: true })).toBeVisible();
  expect(await navigationType(browser)).toBe('navigate');
});
