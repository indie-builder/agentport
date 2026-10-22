import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import {
  agentRuns,
  agents,
  conversations,
  createDb,
  messages,
  newId,
} from '../packages/db/dist/index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for regression fixtures');
const database = createDb(databaseUrl);
test.afterAll(() => database.pool.end());

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
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const runId = newId('run');
  try {
    await database.db.insert(agents).values({
      id: agentId,
      slug: `regression-${agentId}`,
      name: 'Run navigation fixture',
      model: 'test-model',
    });
    await database.db.insert(conversations).values({ id: conversationId, agentId });
    await database.db.insert(agentRuns).values({
      id: runId,
      agentId,
      conversationId,
      status: 'succeeded',
      prompt: 'Run navigation fixture',
      startedAt: new Date(),
      endedAt: new Date(),
    });
    await database.db.insert(messages).values({
      id: newId('message'),
      conversationId,
      runId,
      role: 'user',
      content: { type: 'text', text: 'Run navigation fixture' },
    });

    await app.open(`/runs?agent=${agentId}`);
    await expect(screen.getByRole('heading', '运行')).toBeVisible();
    const row = browser.locator('button[data-row]').first();
    await expect(row).toBeVisible();
    await row.tap();
    await expect(browser).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expect(screen.getByRole('button', '重跑')).toBeVisible();
  } finally {
    await database.pool.query('delete from agents where id = $1', [agentId]);
  }
});

test('runs status filter selects and resets', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/runs');
  const filter = screen.getByRole('combobox', '按状态筛选');
  await filter.tap();
  await screen.getByRole('option', '失败', { exact: true }).tap();
  await expect(filter).toHaveText('失败');
  await expect(browser).toHaveURL(/\/runs\?status=failed$/);
  await filter.tap();
  await screen.getByRole('option', '全部状态', { exact: true }).tap();
  await expect(filter).toHaveText('全部状态');
  await expect(browser).toHaveURL(/\/runs$/);
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

test('skill cancel preserves unsaved form until discard is confirmed', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await app.open('/skills');
  await screen.getByRole('button', '新建技能').first().tap();
  await browser.locator('#skill-name').fill('Unsaved skill draft');
  await screen.getByRole('button', '取消', { exact: true }).tap();
  await expect(screen.getByRole('heading', '放弃未保存的更改？')).toBeVisible();
  await screen.getByRole('button', '取消', { exact: true }).last().tap();
  await expect(browser.locator('#skill-name')).toHaveValue('Unsaved skill draft');
  await browser.keyboard.press('Escape');
  await screen.getByRole('button', '放弃并关闭').tap();
  await expect(screen.getByRole('button', '新建技能').first()).toBeVisible();
});

test('resource tabs preserve navigation and searchable URL state', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/agents');
  await expect(screen.getByRole('link', '专家·技能·连接器')).toBeVisible();
  await screen.getByRole('tab', '技能', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/skills$/);
  await screen.getByRole('searchbox', '搜索技能').fill('resource-no-match');
  await expect(browser).toHaveURL(/\/skills\?q=resource-no-match$/);
  await expect(screen.getByText('没有匹配的技能', { exact: true })).toBeVisible();
  await screen.getByRole('button', '清除搜索').tap();
  await expect(browser).toHaveURL(/\/skills$/);
  await screen.getByRole('tab', '连接器', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/servers$/);
  await screen.getByRole('combobox', '按来源筛选').tap();
  await screen.getByRole('option', '本地命令', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/servers\?kind=stdio$/);
  await app.open('/servers?kind=stdio');
  await expect(screen.getByRole('combobox', '按来源筛选')).toHaveText('本地命令');
});

test('all workspaces render the shared page shell', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  const routes = [
    ['/', '工作台'],
    ['/runs', '运行'],
    ['/agents', '专家'],
    ['/skills', '技能'],
    ['/servers', '连接器'],
    ['/status', '健康'],
    ['/audit', '审计'],
    ['/eval', '评估'],
    ['/unknown-layout-check', '页面不存在'],
  ] as const;
  for (const [path, title] of routes) {
    await app.open(path);
    await expect(screen.getByRole('heading', title, { exact: true })).toBeVisible();
    await expect(browser.locator('[data-slot="page"]')).toBeVisible();
  }
});

test('eval page renders cases and runs sections', { session: 'admin' }, async ({ app, screen }) => {
  await app.open('/eval');
  await expect(screen.getByRole('heading', '评估')).toBeVisible();
  await expect(screen.getByText('用例', { exact: false }).first()).toBeVisible();
});
