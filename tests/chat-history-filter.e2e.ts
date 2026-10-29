import { randomUUID } from 'node:crypto';
import { test } from '@e2e-dev/web';
import { expect, type Locator, type Screen } from 'e2e';
import { createDb, newId } from '../packages/db/dist/index.js';

/**
 * 会话历史搜索：真实页面、真实 API、数据库直写 fixture，不经过队列或模型。
 * DATABASE_URL 必须显式给出（无默认值），且与页面背后 API 指向同一个库。
 * 历史侧栏默认折叠；搜索是跨全部专家的浮层入口「搜索全部会话」，不再按当前专家过滤。
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

interface Fixture {
  agents: [string, string];
  names: [string, string];
  conversations: { alpha: string; beta: string; gamma: string };
  titles: { alpha: string; beta: string; gamma: string };
  bodies: { alpha: string; beta: string; gamma: string };
}

/**
 * 两个 agent 各带自己的会话：历史列表仍只列当前专家，
 * 搜索浮层必须能同时找到标题与消息正文，并跨到另一位专家。
 */
async function seed(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    agents: [newId('agent'), newId('agent')],
    names: [`E2E 过滤 A ${suffix}`, `E2E 过滤 B ${suffix}`],
    conversations: {
      alpha: newId('conversation'),
      beta: newId('conversation'),
      gamma: newId('conversation'),
    },
    titles: {
      alpha: `Alpha 项目 ${suffix}`,
      beta: `Beta 计划 ${suffix}`,
      gamma: `Gamma 话题 ${suffix}`,
    },
    bodies: {
      alpha: `Alpha 正文关键词 ${suffix}`,
      beta: `Beta 正文关键词 ${suffix}`,
      gamma: `Gamma 正文关键词 ${suffix}`,
    },
  };
  const [agentA, agentB] = fixture.agents;
  const { alpha, beta, gamma } = fixture.conversations;
  // seed 中途失败时调用方拿不到 fixture，cleanup 不会执行；用事务保证半成品不落库。
  const client = await pool().connect();
  try {
    await client.query('begin');
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
      [
        alpha,
        beta,
        gamma,
        agentA,
        fixture.titles.alpha,
        fixture.titles.beta,
        agentB,
        fixture.titles.gamma,
      ],
    );
    await client.query(
      `insert into messages (id, conversation_id, role, content) values
         ($1, $4, 'user', jsonb_build_object('type', 'text', 'text', $7::text)),
         ($2, $5, 'user', jsonb_build_object('type', 'text', 'text', $8::text)),
         ($3, $6, 'user', jsonb_build_object('type', 'text', 'text', $9::text))`,
      [
        newId('message'),
        newId('message'),
        newId('message'),
        alpha,
        beta,
        gamma,
        fixture.bodies.alpha,
        fixture.bodies.beta,
        fixture.bodies.gamma,
      ],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return fixture;
}

/** 只删自己建的 agent：会话与消息随 agent 级联删除；审计行按自己的 id 另删。 */
async function cleanup(fixture: Fixture): Promise<void> {
  const client = pool();
  await client.query('delete from audit_log where target = any($1::text[])', [
    [...fixture.agents, ...Object.values(fixture.conversations)],
  ]);
  await client.query('delete from agents where id = any($1::text[])', [fixture.agents]);
}

/** 历史默认折叠：所有依赖历史列表的操作都先经过真实开关展开。 */
async function showHistory(screen: Screen): Promise<void> {
  await screen.getByRole('button', '显示会话历史').tap();
}

/** 打开跨专家搜索浮层并等输入框可用。 */
async function openSearch(screen: Screen): Promise<Locator> {
  await screen.getByRole('button', '搜索全部会话').tap();
  const dialog = screen.getByRole('dialog', '搜索会话');
  const input = dialog.getByRole('combobox', '搜索会话');
  await expect(input).toBeVisible();
  return dialog;
}

test('history search finds titles and message bodies across experts and clears back', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    await app.open(`/chat?agent=${fixture.agents[0]}`);
    await showHistory(screen);

    // 历史列表仍只属于当前专家；跨专家结果只出现在搜索浮层里。
    const aside = browser.locator('aside[aria-label="会话历史"]');
    await expect(aside.getByText(fixture.titles.alpha, { exact: true })).toBeVisible();
    await expect(aside.getByText(fixture.titles.beta, { exact: true })).toBeVisible();
    await expect(aside.getByText(fixture.titles.gamma, { exact: true })).toHaveCount(0);

    const dialog = await openSearch(screen);
    const input = dialog.getByRole('combobox', '搜索会话');

    // 标题命中另一位专家：结果同时给出标题与专家名。
    await input.fill(fixture.titles.gamma);
    await expect(dialog.getByText(fixture.titles.gamma, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.names[1], { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.titles.alpha, { exact: true })).toHaveCount(0);

    // 正文命中：标题不含关键词，结果摘要来自消息正文。
    await input.fill(fixture.bodies.alpha);
    await expect(dialog.getByText(fixture.titles.alpha, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.bodies.alpha, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.titles.gamma, { exact: true })).toHaveCount(0);

    // 清除查询回到跨专家的最近会话。
    await dialog.getByRole('button', '清除搜索').tap();
    await expect(input).toHaveValue('');
    await expect(dialog.getByText(fixture.titles.alpha, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.titles.gamma, { exact: true })).toBeVisible();
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
    await showHistory(screen);

    const dialog = await openSearch(screen);
    await dialog.getByRole('combobox', '搜索会话').fill(`不存在-${randomUUID().slice(0, 8)}`);
    await expect(dialog.getByText('没有匹配的会话', { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.titles.alpha, { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(fixture.titles.gamma, { exact: true })).toHaveCount(0);
    // 搜索框与空态里的清除入口不受空结果影响。
    await expect(dialog.getByRole('combobox', '搜索会话')).toBeVisible();
    await expect(dialog.getByText('清除搜索', { exact: true })).toBeVisible();
  } finally {
    if (fixture) await cleanup(fixture);
  }
});

test('opening a cross-expert result keeps the unsent draft on its original conversation', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    const [agentA, agentB] = fixture.agents;
    const draft = `未发送草稿 ${randomUUID().slice(0, 8)}`;
    await app.open(`/chat?agent=${agentA}&conversation=${fixture.conversations.alpha}`);
    await screen.getByRole('textbox', '消息').fill(draft);

    await showHistory(screen);
    const dialog = await openSearch(screen);
    await dialog.getByRole('combobox', '搜索会话').fill(fixture.titles.gamma);
    await dialog.getByRole('option', new RegExp(fixture.titles.gamma)).tap();

    // 一次导航同时切到目标专家与目标会话，并显示它的历史消息。
    await expect(browser).toHaveURL(new RegExp(`agent=${agentB}`));
    await expect(browser).toHaveURL(new RegExp(`conversation=${fixture.conversations.gamma}`));
    await expect(screen.getByText(fixture.bodies.gamma, { exact: true })).toBeVisible();

    // 草稿按会话隔离保存：回到原会话时恢复，没有被搜索跳转清掉。
    await app.open(`/chat?agent=${agentA}&conversation=${fixture.conversations.alpha}`);
    await expect(screen.getByRole('textbox', '消息')).toHaveValue(draft);
  } finally {
    if (fixture) await cleanup(fixture);
  }
});

test('search stays cross-expert after switching experts in the history header', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    const [agentA, agentB] = fixture.agents;
    await app.open(`/chat?agent=${agentA}`);
    await showHistory(screen);

    // 在历史头部换到另一位专家：列表只刷新到该专家，不保留上一位的会话。
    await screen.getByRole('combobox', new RegExp(`选择专家：${fixture.names[0]}`)).tap();
    await screen.getByRole('option', new RegExp(fixture.names[1])).tap();
    await expect(browser).toHaveURL(new RegExp(`agent=${agentB}$`));
    const aside = browser.locator('aside[aria-label="会话历史"]');
    await expect(aside.getByText(fixture.titles.gamma, { exact: true })).toBeVisible();
    await expect(aside.getByText(fixture.titles.alpha, { exact: true })).toHaveCount(0);

    // 搜索仍跨全部专家：当前在 B，也能找到 A 的会话并跳转。
    const dialog = await openSearch(screen);
    await dialog.getByRole('combobox', '搜索会话').fill(fixture.titles.alpha);
    const result = dialog.getByRole('option', new RegExp(fixture.titles.alpha));
    // 等防抖检索收敛到唯一命中再核对专家名：未过滤时 A 的最近两条会同时带出专家名。
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await expect(result.getByText(fixture.names[0], { exact: true })).toBeVisible();
    await result.tap();
    await expect(browser).toHaveURL(new RegExp(`agent=${agentA}`));
    await expect(browser).toHaveURL(new RegExp(`conversation=${fixture.conversations.alpha}`));
  } finally {
    if (fixture) await cleanup(fixture);
  }
});
