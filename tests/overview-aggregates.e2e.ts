import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

interface Fixture {
  agentId: string;
  conversationId: string;
}

const created: Fixture[] = [];

test.afterEach(async () => {
  await runFixture('overview-aggregates', 'cleanup', created);
  created.length = 0;
});

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
  expect(after.failed - before.failed).toBe(4);
  expect(after.tokens - before.tokens).toBe(335);
});

test('overview page shows failed and token hints from the aggregates', {
  session: 'admin',
}, async ({ app, browser, screen }) => {
  await seed();
  await app.open('/operations');

  await expect(screen.getByRole('heading', '概况')).toBeVisible();
  await expect(browser).toHaveTitle('概况 · PACE');
  await expect(browser.locator('main [role="alert"]')).toHaveCount(0);

  await expect(screen.getByText('最近 7 天', { exact: true })).toBeVisible();
  await expect(screen.getByText(/^\d+ 次失败$/)).toBeVisible();
  await expect(screen.getByText(/^[\d.]+[kM]? tokens$/)).toBeVisible();
});
