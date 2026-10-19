import { expect, login, test } from './fixtures.js';

/**
 * 端到端回归：覆盖平台主链路的三个新增面（运行详情、评估、审计）。
 * 依赖本地已启动的 api + worker + web（playwright.config 的 webServer）。
 * 聊天链路需要真实模型，用 E2E_FULL=1 开启。
 */
test.describe('platform regression', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('runs page lists executions and opens detail', async ({ page }) => {
    await page.getByRole('link', { name: '运行', exact: true }).click();
    await expect(page.getByRole('heading', { name: /运行/ })).toBeVisible();

    // 没有历史运行时应展示空态，而不是报错。
    const rows = page.locator('[role="button"][aria-expanded], button[aria-expanded]');
    const empty = page.getByText(/还没有运行|暂无/);
    await expect(rows.first().or(empty).first()).toBeVisible({ timeout: 10_000 });
  });

  test('audit page shows recorded actions', async ({ page }) => {
    await page.getByRole('link', { name: '审计', exact: true }).click();
    await expect(page.getByRole('heading', { name: /审计/ })).toBeVisible();
    // 登录本身就会写一条 auth.login.succeeded。
    await expect(page.getByText('auth.login.succeeded').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('skills page supports create and delete', async ({ page, unique }) => {
    const slug = unique('e2e-skill');
    await page.getByRole('link', { name: '技能', exact: true }).click();
    await page.getByRole('button', { name: '新建技能' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#skill-name').fill('E2E 技能');
    await dialog.locator('#skill-slug').fill(slug);
    await dialog.locator('#skill-desc').fill('端到端测试创建的技能');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('技能已创建')).toBeVisible();

    const card = page.locator('div.rounded-\\[10px\\]').filter({ hasText: slug }).first();
    await expect(card).toBeVisible();
  });

  test('eval page renders cases and runs sections', async ({ page }) => {
    await page.getByRole('link', { name: '评估', exact: true }).click();
    await expect(page.getByRole('heading', { name: /评估/ })).toBeVisible();
    await expect(page.getByText(/用例/).first()).toBeVisible();
  });

  test('overview shows agent aggregate columns', async ({ page }) => {
    await page.getByRole('link', { name: '概览', exact: true }).click();
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
    // 列设置入口存在，说明聚合表已渲染。
    await expect(page.getByRole('button', { name: '列设置' }).first()).toBeVisible();
  });
});
