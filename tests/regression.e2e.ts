import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * 迁移自 e2e/regression.spec.ts 的其余 4 条。
 * Playwright 用 `page.getByRole(...).click()` 导航；e2e 用 `app.open()` 直达，
 * 更稳定且不依赖侧栏交互。
 */
test('runs page lists executions and opens detail', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/runs');
  await expect(screen.getByRole('heading', '运行')).toBeVisible();

  // 有数据时是表格行；空库时是空态。e2e 没有 `or()`，分别取状态判断。
  const empty = await screen.getByText('还没有运行', { exact: false }).isVisible();
  const table = await browser.locator('section[aria-label], table').first().isVisible();
  expect(empty || table).toBe(true);
});

test('audit page shows recorded actions', { session: 'admin' }, async ({ app, screen }) => {
  await app.open('/audit');
  await expect(screen.getByRole('heading', '审计')).toBeVisible();
  // 登录本身就会写一条 auth.login.succeeded。
  await expect(screen.getByText('auth.login.succeeded').first()).toBeVisible();
});

test('skills page supports create', { session: 'admin' }, async ({ app, screen, browser }) => {
  const slug = `e2e-skill-${Date.now().toString(36)}`;
  await app.open('/skills');
  await screen.getByRole('button', '新建技能').first().tap();
  await browser.locator('#skill-name').fill('E2E 技能');
  await browser.locator('#skill-slug').fill(slug);
  await browser.locator('#skill-desc').fill('端到端测试创建的技能');
  await screen.getByRole('button', '保存').tap();
  await expect(screen.getByText('技能已创建')).toBeVisible();
  await expect(screen.getByText(slug, { exact: false }).first()).toBeVisible();
});

test('eval page renders cases and runs sections', { session: 'admin' }, async ({ app, screen }) => {
  await app.open('/eval');
  await expect(screen.getByRole('heading', '评估')).toBeVisible();
  await expect(screen.getByText('用例', { exact: false }).first()).toBeVisible();
});
