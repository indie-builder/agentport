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
    // RBAC NOT NULL：夹具归属首次初始化的 bootstrap 管理员业务身份。
    await database.db.insert(agents).values({
      id: agentId,
      slug: `regression-${agentId}`,
      name: 'Run navigation fixture',
      model: 'test-model',
      createdBy: 'bootstrap-admin',
      ownerBusinessId: 'bootstrap-admin',
    });
    await database.db
      .insert(conversations)
      .values({ id: conversationId, agentId, createdBy: 'bootstrap-admin' });
    await database.db.insert(agentRuns).values({
      id: runId,
      agentId,
      conversationId,
      status: 'succeeded',
      subjectKind: 'user',
      initiatedBy: 'bootstrap-admin',
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
    const empty = await screen.getByText('没有匹配的运行', { exact: false }).isVisible();
    const table = await browser.locator('section[aria-label], table').first().isVisible();
    expect(empty || table).toBe(true);
    await row.tap();
    await expect(browser).toHaveURL(new RegExp(`/runs/${runId}(?:\\?.*)?$`));
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
  // 资源中心只剩技能/连接器/插件/知识库；专家独立为业务入口，不再混在资源页签里。
  await app.open('/servers');
  const resourceNav = browser.locator('nav[aria-label="资源类型"]');
  await expect(resourceNav.getByRole('link', '技能', { exact: true })).toBeVisible();
  await expect(resourceNav.getByRole('link', '专家', { exact: true })).toHaveCount(0);
  await resourceNav.getByRole('link', '技能', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/skills$/);
  await screen.getByRole('searchbox', '搜索技能').fill('resource-no-match');
  await expect(browser).toHaveURL(/\/skills\?q=resource-no-match$/);
  await expect(screen.getByText('没有匹配的技能', { exact: true })).toBeVisible();
  await screen.getByRole('button', '清除：搜索技能').tap();
  await expect(browser).toHaveURL(/\/skills$/);
  await resourceNav.getByRole('link', '连接器', { exact: true }).tap();
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
  // 业务导航：找专家是入口，运维收在底部独立入口，进入后使用独立导航。
  await app.open('/agents');
  for (const label of ['找专家', '对话', '定时任务', '资源', '评估']) {
    await expect(screen.getByRole('link', label, { exact: true })).toBeVisible();
  }
  await screen.getByRole('link', '运维', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/operations$/);
  await expect(screen.getByRole('link', '返回工作区', { exact: true })).toBeVisible();
  for (const label of ['概况', '运行', '运行环境', '健康', '审计']) {
    await expect(screen.getByRole('link', label, { exact: true })).toBeVisible();
  }

  const routes = [
    ['/', '找专家'],
    ['/agents', '找专家'],
    ['/schedules', '定时任务'],
    ['/skills', '技能'],
    ['/servers', '连接器'],
    ['/eval', '评估'],
    ['/operations', '概况'],
    ['/runs', '运行'],
    ['/status', '健康'],
    ['/audit', '审计'],
    ['/unknown-layout-check', '页面不存在'],
  ] as const;
  for (const [path, title] of routes) {
    await app.open(path);
    // 默认入口 / 重定向到找专家。
    if (path === '/') await expect(browser).toHaveURL(/\/agents$/);
    await expect(screen.getByRole('heading', title, { exact: true })).toBeVisible();
    await expect(browser.locator('[data-slot="page"]')).toBeVisible();
  }
});

test('eval page renders cases and runs sections', { session: 'admin' }, async ({ app, screen }) => {
  await app.open('/eval');
  await expect(screen.getByRole('heading', '评估')).toBeVisible();
  await expect(screen.getByText('用例', { exact: false }).first()).toBeVisible();
});

test('personal module opens as profile and exposes direct subpages', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/personal/profile');
  await expect(screen.getByRole('heading', '个人资料', { exact: true })).toHaveCount(1);
  // 个人上下文把六页放进主侧栏；用导航边界精确限定，避免与同名底部账号入口混淆。
  const personalNav = browser.locator('nav[aria-label="主导航"]');
  const personalLinks = ['个人记忆', '记忆提案', '我的分享', '使用记录', '个人资料', '账号安全'];
  await expect(personalNav.getByRole('link', { exact: true })).toHaveCount(personalLinks.length);
  for (const label of personalLinks) {
    await expect(personalNav.getByRole('link', label, { exact: true })).toBeVisible();
  }
  await expect(personalNav.getByRole('link', '个人资料', { exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const accountEntryCurrent = await browser.evaluate(() =>
    [...document.querySelectorAll('a[aria-label="个人资料"]')].some(
      (entry) => entry.closest('nav') === null && entry.getAttribute('aria-current') === 'page',
    ),
  );
  expect(accountEntryCurrent).toBe(true);
  await expect(screen.getByRole('link', '返回工作区', { exact: true })).toBeVisible();

  await app.open('/personal/memory');
  await expect(screen.getByRole('heading', '个人记忆', { exact: true })).toHaveCount(1);
  await expect(personalNav.getByRole('link', '个人记忆', { exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // 阅读态先说明这些内容会随每轮对话带入；编辑入口再进入源码编辑器。
  await expect(screen.getByText('每轮对话会带入这些长期信息。')).toBeVisible();
  const editEntry = screen.getByRole('button', '编辑', { exact: true });
  if ((await editEntry.count()) > 0) {
    await editEntry.tap();
  } else {
    await screen.getByRole('button', '自己填写', { exact: true }).tap();
  }
  await expect(screen.getByLabel('个人记忆内容（Markdown）')).toBeVisible();

  await app.open('/personal/reviews');
  await expect(screen.getByRole('heading', '记忆提案', { exact: true })).toHaveCount(1);
  await expect(personalNav.getByRole('link', '记忆提案', { exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const overflows = await browser.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});
