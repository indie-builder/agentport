import { randomUUID } from 'node:crypto';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createDb, newId } from '../packages/db/dist/index.js';

/**
 * 会话历史搜索：真实页面、真实 API、数据库直写 fixture，不经过队列或模型。
 * DATABASE_URL 必须显式给出（无默认值），且与页面背后 API 指向同一个库。
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for chat history fixtures`);
  return value;
}
const DATABASE_URL = requiredEnv('DATABASE_URL');

let dbPromise: ReturnType<typeof createDb> | undefined;
function pool(): ReturnType<typeof createDb>['pool'] {
  dbPromise ??= createDb(DATABASE_URL);
  return dbPromise.pool;
}

test.afterAll(async () => {
  const current = await dbPromise;
  await current?.pool.end();
});

const TITLES = {
  alpha: 'Alpha 项目',
  beta: 'Beta 计划',
  gamma: 'Gamma 话题',
} as const;

interface Fixture {
  agents: string[];
  names: string[];
  conversations: string[];
}

/** 两个 agent 各带自己的会话：搜索必须只作用于当前列表，不能带出另一个 agent 的会话。 */
async function seed(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    agents: [newId('agent'), newId('agent')],
    names: [`E2E 过滤 A ${suffix}`, `E2E 过滤 B ${suffix}`],
    conversations: [newId('conversation'), newId('conversation'), newId('conversation')],
  };
  const [agentA, agentB] = fixture.agents as [string, string];
  const [alpha, beta, gamma] = fixture.conversations as [string, string, string];
  const client = pool();
  await client.query(
    `insert into agents (id, slug, name, model) values
       ($1, $3, $5, 'test-model'), ($2, $4, $6, 'test-model')`,
    [
      agentA,
      agentB,
      `e2e-filter-a-${suffix}`,
      `e2e-filter-b-${suffix}`,
      fixture.names[0],
      fixture.names[1],
    ],
  );
  await client.query(
    `insert into conversations (id, agent_id, title) values
       ($1, $4, $5), ($2, $4, $6), ($3, $7, $8)`,
    [alpha, beta, gamma, agentA, TITLES.alpha, TITLES.beta, agentB, TITLES.gamma],
  );
  return fixture;
}

/** 只删自己建的 agent：会话与消息随 agent 级联删除；审计行按自己的 id 另删。 */
async function cleanup(fixture: Fixture): Promise<void> {
  const client = pool();
  await client.query('delete from audit_log where target = any($1::text[])', [
    [...fixture.agents, ...fixture.conversations],
  ]);
  await client.query('delete from agents where id = any($1::text[])', [fixture.agents]);
}

test('history search narrows to matching titles and clears back to the full list', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    await app.open(`/chat?agent=${fixture.agents[0]}`);

    const aside = browser.locator('aside[aria-label="会话历史"]');
    await expect(screen.getByRole('complementary', '会话历史')).toBeVisible();
    await expect(aside.getByText(TITLES.alpha, { exact: true })).toBeVisible();
    await expect(aside.getByText(TITLES.beta, { exact: true })).toBeVisible();

    const search = aside.getByRole('searchbox', '搜索会话');
    await search.fill('alpha');
    await expect(aside.getByText(TITLES.alpha, { exact: true })).toBeVisible();
    await expect(aside.getByText(TITLES.beta, { exact: true })).toHaveCount(0);

    await aside.getByRole('button', '清除搜索').tap();
    await expect(search).toHaveValue('');
    await expect(aside.getByText(TITLES.alpha, { exact: true })).toBeVisible();
    await expect(aside.getByText(TITLES.beta, { exact: true })).toBeVisible();
  } finally {
    if (fixture) await cleanup(fixture);
  }
});

test('history search with no match shows the empty text and no conversation rows', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    await app.open(`/chat?agent=${fixture.agents[0]}`);

    const aside = browser.locator('aside[aria-label="会话历史"]');
    await aside.getByRole('searchbox', '搜索会话').fill('不存在x');
    await expect(aside.getByText('没有匹配的会话', { exact: true })).toBeVisible();
    await expect(aside.getByText(TITLES.alpha, { exact: true })).toHaveCount(0);
    await expect(aside.getByText(TITLES.beta, { exact: true })).toHaveCount(0);
    // 搜索框与新建按钮不受空结果影响。
    await expect(screen.getByRole('searchbox', '搜索会话')).toBeVisible();
  } finally {
    if (fixture) await cleanup(fixture);
  }
});

test('history search stays scoped to the agent after switching agents', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    await app.open(`/chat?agent=${fixture.agents[0]}`);
    const aside = browser.locator('aside[aria-label="会话历史"]');
    await expect(aside.getByText(TITLES.beta, { exact: true })).toBeVisible();
    await aside.getByRole('searchbox', '搜索会话').fill('alpha');
    await expect(aside.getByText(TITLES.beta, { exact: true })).toHaveCount(0);

    // 用页面内的切换器换 agent：HistoryPanel 不卸载，过滤状态会留下来。
    await screen.getByRole('combobox', '选择智能体').tap();
    await screen.getByRole('option', fixture.names[1] ?? '').tap();
    await expect(browser).toHaveURL(new RegExp(`/chat\\?agent=${fixture.agents[1]}$`));

    // 过滤若保留，只作用于当前 agent 的列表（Gamma 被过滤掉）；若重置，则直接看到 Gamma。
    const gamma = aside.getByText(TITLES.gamma, { exact: true });
    const empty = aside.getByText('没有匹配的会话', { exact: true });
    await expect
      .poll(async () => (await gamma.isVisible()) || (await empty.isVisible()), {
        timeout: 5_000,
        message: '切换 agent 后历史列表既没有 Gamma 也没有空结果提示',
      })
      .toBe(true);
    if (!(await gamma.isVisible())) {
      await aside.getByRole('button', '清除搜索').tap();
    }
    await expect(gamma).toBeVisible();
    // 另一个 agent 的会话在任何情况下都不出现在当前列表里。
    await expect(aside.getByText(TITLES.beta, { exact: true })).toHaveCount(0);
    await expect(aside.getByText(TITLES.alpha, { exact: true })).toHaveCount(0);
  } finally {
    if (fixture) await cleanup(fixture);
  }
});
