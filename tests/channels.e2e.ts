import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { createDb, newId } from '../packages/db/dist/index.js';

/**
 * 频道模式浏览器回归：真实页面、真实 API/worker/Docker 沙盒，模型端点由
 * `scripts/e2e-channel.ts` 的本地假 SSE 承接。数据经 UI 或同源 API 创建，
 * 需要精确时间线的场景（审批）直写 fixture，与 run-cancel 用例一致。
 *
 * 入口：`pnpm e2e:channel:ui`（起隔离栈 → 跑本文件 → 清理）。
 */
const DATABASE_URL = process.env.DATABASE_URL;
const REPLY_PREFIX = 'E2E-CHANNEL-REPLY';
const SLOW_MARKER = 'E2E-CHANNEL-SLOW';
const SLOW_PARTIAL = 'E2E-CHANNEL-SLOW-PARTIAL';

function dbUrl(): string {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for channel e2e fixtures');
  return DATABASE_URL;
}

let dbPromise: ReturnType<typeof createDb> | undefined;
function db() {
  dbPromise ??= createDb(dbUrl());
  return dbPromise;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { pool } = await db();
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

interface Created {
  channels: string[];
  agents: string[];
  accounts: string[];
  servers: string[];
}

const created: Created = { channels: [], agents: [], accounts: [], servers: [] };

/** 只删本文件建的频道/智能体/账户/连接器；成员、绑定、消息、run、审批随外键级联。 */
test.afterEach(async () => {
  if (
    created.channels.length === 0 &&
    created.agents.length === 0 &&
    created.accounts.length === 0 &&
    created.servers.length === 0
  ) {
    return;
  }
  const { pool } = await db();
  const targets = [...created.channels, ...created.agents, ...created.servers];
  if (targets.length > 0) {
    await pool.query('delete from audit_log where target = any($1::text[])', [targets]);
  }
  if (created.servers.length > 0) {
    await pool.query('delete from servers where id = any($1::text[])', [created.servers]);
  }
  if (created.channels.length > 0) {
    await pool.query('delete from channels where id = any($1::text[])', [created.channels]);
  }
  if (created.agents.length > 0) {
    await pool.query('delete from agents where id = any($1::text[])', [created.agents]);
  }
  if (created.accounts.length > 0) {
    await pool.query('delete from "user" where business_id = any($1::text[])', [created.accounts]);
  }
  created.channels.length = 0;
  created.agents.length = 0;
  created.accounts.length = 0;
  created.servers.length = 0;
});

test.afterAll(async () => {
  const current = await dbPromise;
  await current?.pool.end();
});

interface ApiResponse {
  status: number;
  text: string;
}

/** 同源请求：复用浏览器里的登录 cookie，行为和页面自己的 fetch 一致。 */
async function apiRaw(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  return browser.evaluate(
    async (input: { method: string; path: string; body: string | null }) => {
      const response = await fetch(input.path, {
        method: input.method,
        ...(input.body === null
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: input.body }),
      });
      return { status: response.status, text: await response.text() };
    },
    { method, path, body: body === undefined ? null : JSON.stringify(body) },
  );
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const response = await apiRaw(browser, method, path, body);
  let json: T | null = null;
  try {
    json = response.text === '' ? null : (JSON.parse(response.text) as T);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function createChannel(browser: Browser, tag: string): Promise<{ id: string; name: string }> {
  const name = `E2E 频道 ${tag} ${uniqueSuffix()}`;
  const result = await apiJson<{ id: string }>(browser, 'POST', '/api/channels', { name });
  assert(result.status === 201 && result.json !== null, `创建频道失败：${result.status}`);
  created.channels.push(result.json.id);
  return { id: result.json.id, name };
}

async function createAgent(browser: Browser, tag: string): Promise<{ id: string; name: string }> {
  const suffix = uniqueSuffix();
  const name = `E2E 智能体 ${tag} ${suffix}`;
  const result = await apiJson<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-channel-${tag}-${suffix}`,
    name,
    systemPrompt: '你是频道验证智能体。收到消息后直接回复内容。',
  });
  assert(result.status === 201 && result.json !== null, `创建智能体失败：${result.status}`);
  created.agents.push(result.json.id);
  return { id: result.json.id, name };
}

async function bindAgent(browser: Browser, channelId: string, agentId: string): Promise<void> {
  const result = await apiJson(browser, 'POST', `/api/channels/${channelId}/agents`, { agentId });
  assert(result.status === 201, `绑定智能体失败：${result.status}`);
}

interface TestAccount {
  businessId: string;
  username: string;
  password: string;
}

async function createAccount(browser: Browser, tag: string): Promise<TestAccount> {
  const suffix = uniqueSuffix();
  const account: TestAccount = {
    businessId: `e2e-${tag}-${suffix}`,
    username: `e2e_${tag}_${suffix}`,
    password: `E2e-${suffix}-pass`,
  };
  const result = await apiJson(browser, 'POST', '/api/accounts', {
    businessId: account.businessId,
    username: account.username,
    name: `E2E ${tag} ${suffix}`,
    password: account.password,
  });
  assert(result.status === 201, `创建账户失败：${result.status}`);
  created.accounts.push(account.businessId);
  return account;
}

async function addMember(
  browser: Browser,
  channelId: string,
  businessId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
): Promise<void> {
  const result = await apiJson(browser, 'POST', `/api/channels/${channelId}/members`, {
    businessId,
    role,
  });
  assert(result.status === 201, `加入频道失败：${result.status}`);
}

async function loginAs(browser: Browser, account: TestAccount): Promise<void> {
  const result = await apiRaw(browser, 'POST', '/api/auth/login', {
    username: account.username,
    password: account.password,
  });
  assert(result.status === 200, `登录 ${account.username} 失败：${result.status}`);
}

function channelIdFromUrl(url: string): string {
  const id = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  if (!id) throw new Error(`URL 里没有频道 ID：${url}`);
  return id;
}

/** 输入 @ 后从补全菜单选中智能体，再把正文追加到提及后面并发送。 */
async function sendMention(screen: Screen, agentName: string, text: string): Promise<void> {
  const composer = screen.getByRole('textbox', '消息');
  await composer.fill('@');
  await screen.getByRole('listbox', '提及智能体').getByRole('option', { name: agentName }).tap();
  await composer.focus();
  await composer.press('End');
  await composer.pressSequentially(text);
  await expect(composer).toHaveValue(`@${agentName} ${text}`);
  await screen.getByRole('button', '发送消息').tap();
}

async function waitForReply(screen: Screen, expected: string): Promise<void> {
  await expect(screen.getByText(expected, { exact: false })).toBeVisible({ timeout: 120_000 });
  await expect(screen.getByText('空闲').first()).toBeVisible({ timeout: 60_000 });
}

async function latestRunStatus(channelId: string): Promise<string | undefined> {
  const rows = await query<{ status: string }>(
    `select status from agent_runs where channel_id = $1 order by created_at desc, id desc limit 1`,
    [channelId],
  );
  return rows[0]?.status;
}

test('creates a channel from the list and opens its detail', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const name = `E2E 建频道 ${uniqueSuffix()}`;

  await screen.getByRole('button', '新建频道').first().tap();
  await screen.getByLabel('名称').fill(name);
  await screen.getByRole('button', '创建频道').tap();

  await expect(screen.getByRole('heading', { name, level: 1 })).toBeVisible();
  created.channels.push(channelIdFromUrl(await browser.url()));

  await app.open('/channels');
  const row = screen.getByRole('link', { name: new RegExp(escapeRegExp(name)) });
  await expect(row).toBeVisible();
  await row.tap();
  await expect(screen.getByRole('heading', { name, level: 1 })).toBeVisible();
});

test('binds an agent to a channel and shows it in the detail', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'bind');
  const channel = await createChannel(browser, 'bind');

  await app.open(`/channels/${channel.id}`);
  await expect(screen.getByText('尚未绑定智能体')).toBeVisible();

  await screen.getByLabel('选择要绑定的智能体').tap();
  await screen.getByRole('option', { name: agent.name }).tap();
  await screen.getByRole('button', '绑定智能体').tap();

  await expect(screen.getByText('智能体已加入频道')).toBeVisible();
  await expect(screen.getByText(agent.name).first()).toBeVisible();
  const rows = await query<{ count: string }>(
    'select count(*)::text as count from channel_agent_bindings where channel_id = $1 and agent_id = $2',
    [channel.id, agent.id],
  );
  expect(rows[0]?.count).toBe('1');
});

test('a message without @ does not wake an agent', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'no-wake');
  const channel = await createChannel(browser, 'no-wake');
  await bindAgent(browser, channel.id, agent.id);

  await app.open(`/channels/${channel.id}`);
  const body = `E2E 无唤醒消息 ${uniqueSuffix()}`;
  await screen.getByRole('textbox', '消息').fill(body);
  await screen.getByRole('button', '发送消息').tap();

  await expect(screen.getByText(body)).toBeVisible();
  // 给可能的误入队留出窗口，再确认没有 run。
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const rows = await query<{ count: string }>(
    'select count(*)::text as count from agent_runs where channel_id = $1',
    [channel.id],
  );
  expect(rows[0]?.count).toBe('0');
  await expect(screen.getByText('运行中')).toHaveCount(0);
});

test('@ mentions an agent, streams a reply and returns to idle', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'mention');
  const channel = await createChannel(browser, 'mention');
  await bindAgent(browser, channel.id, agent.id);

  await app.open(`/channels/${channel.id}`);
  const text = `E2E 主路径 ${uniqueSuffix()}`;
  await sendMention(screen, agent.name, text);

  await expect(screen.getByText('运行中').first()).toBeVisible({ timeout: 60_000 });
  await waitForReply(screen, `${REPLY_PREFIX} @${agent.name} ${text}`);
  await expect(screen.getByText('空闲').first()).toBeVisible({ timeout: 60_000 });
});

test('a second @ reuses the same channel lane', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'lane');
  const channel = await createChannel(browser, 'lane');
  await bindAgent(browser, channel.id, agent.id);

  await app.open(`/channels/${channel.id}`);
  const first = `E2E 复用第一条 ${uniqueSuffix()}`;
  await sendMention(screen, agent.name, first);
  await waitForReply(screen, `${REPLY_PREFIX} @${agent.name} ${first}`);

  const second = `E2E 复用第二条 ${uniqueSuffix()}`;
  await sendMention(screen, agent.name, second);
  await waitForReply(screen, `${REPLY_PREFIX} @${agent.name} ${second}`);

  const runs = await query<{ conversation_id: string; status: string }>(
    `select conversation_id, status from agent_runs where channel_id = $1 order by created_at asc`,
    [channel.id],
  );
  expect(runs.length).toBe(2);
  expect(new Set(runs.map((run) => run.conversation_id)).size).toBe(1);
  expect(runs.map((run) => run.status).join(',')).toBe('succeeded,succeeded');
  const lanes = await query<{ count: string }>(
    'select count(*)::text as count from conversations where channel_id = $1 and agent_id = $2',
    [channel.id, agent.id],
  );
  expect(lanes[0]?.count).toBe('1');
});

test('stops a running channel run', { session: 'admin' }, async ({ app, screen, browser }) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'stop');
  const channel = await createChannel(browser, 'stop');
  await bindAgent(browser, channel.id, agent.id);

  await app.open(`/channels/${channel.id}`);
  await sendMention(screen, agent.name, `${SLOW_MARKER} 停止运行 ${uniqueSuffix()}`);

  const stop = screen.getByRole('button', '停止').first();
  await expect(stop).toBeVisible({ timeout: 90_000 });
  await stop.tap();

  await expect(screen.getByText('运行已停止。')).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => latestRunStatus(channel.id), { timeout: 60_000 }).toBe('cancelled');
});

test('approves a pending tool approval from the channel', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'approve');
  const channel = await createChannel(browser, 'approve');
  await bindAgent(browser, channel.id, agent.id);

  const channelRows = await query<{ created_by: string }>(
    'select created_by from channels where id = $1',
    [channel.id],
  );
  const adminBusinessId = channelRows[0]?.created_by;
  assert(adminBusinessId !== undefined, '频道缺少创建者');
  const conversationId = newId('conversation');
  const runId = newId('run');
  const serverId = newId('server');
  const approvalId = newId('approval');
  const serverName = `E2E 审批服务 ${uniqueSuffix()}`;
  created.servers.push(serverId);

  await query(
    `insert into conversations (id, agent_id, channel_id, created_by)
       values ($1, $2, $3, $4)`,
    [conversationId, agent.id, channel.id, adminBusinessId],
  );
  await query(
    `insert into agent_runs
         (id, conversation_id, agent_id, channel_id, status, trigger, subject_kind, initiated_by, started_at)
       values ($1, $2, $3, $4, 'running', 'channel', 'user', $5, now())`,
    [runId, conversationId, agent.id, channel.id, adminBusinessId],
  );
  await query(`insert into servers (id, name, kind, config) values ($1, $2, 'http', '{}'::jsonb)`, [
    serverId,
    serverName,
  ]);
  await query(
    `insert into approval_requests (id, run_id, channel_id, server_id, tool_name)
       values ($1, $2, $3, $4, 'e2e_tool')`,
    [approvalId, runId, channel.id, serverId],
  );

  await app.open(`/channels/${channel.id}`);
  await expect(screen.getByText(/需要批准：/)).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByText(serverName, { exact: false })).toBeVisible();
  await screen.getByRole('button', '批准').tap();

  await expect(screen.getByText('已批准')).toBeVisible();
  await expect
    .poll(
      async () => {
        const rows = await query<{ approved_at: Date | null }>(
          'select approved_at from approval_requests where id = $1',
          [approvalId],
        );
        return rows[0]?.approved_at != null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(screen.getByRole('button', '批准')).toHaveCount(0);
});

test('reloads a running channel and recovers the streamed content', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'reload');
  const channel = await createChannel(browser, 'reload');
  await bindAgent(browser, channel.id, agent.id);

  await app.open(`/channels/${channel.id}`);
  const text = `${SLOW_MARKER} 刷新恢复 ${uniqueSuffix()}`;
  await sendMention(screen, agent.name, text);

  await expect(screen.getByText(SLOW_PARTIAL).first()).toBeVisible({ timeout: 120_000 });
  await browser.reload();

  await expect(screen.getByText(`@${agent.name} ${text}`)).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText(SLOW_PARTIAL).first()).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText(REPLY_PREFIX, { exact: false }).first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(screen.getByText('空闲').first()).toBeVisible({ timeout: 60_000 });
});

test('shows unread from another member and clears it after reading', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const adminCookies = await browser.cookies();
  const channel = await createChannel(browser, 'unread');
  const member = await createAccount(browser, 'unread');
  await addMember(browser, channel.id, member.businessId, 'member');

  await loginAs(browser, member);
  const posted = await apiJson(browser, 'POST', `/api/channels/${channel.id}/messages`, {
    body: `E2E 未读消息 ${uniqueSuffix()}`,
  });
  assert(posted.status === 201, `成员发消息失败：${posted.status}`);

  await browser.setCookies(adminCookies);
  await app.open('/channels');
  const row = screen.getByRole('link', { name: new RegExp(escapeRegExp(channel.name)) });
  await expect(row.getByLabel('1 条未读')).toBeVisible({ timeout: 30_000 });

  await row.tap();
  await expect(screen.getByText(/E2E 未读消息/)).toBeVisible({ timeout: 30_000 });
  // 已读游标靠可见消息列表推进（频道设 scrollPreviousItemPeek=0），这里等它归零。
  await expect
    .poll(
      async () => {
        const list = await apiJson<Array<{ id: string; unreadCount: number }>>(
          browser,
          'GET',
          '/api/channels',
        );
        return list.json?.find((item) => item.id === channel.id)?.unreadCount ?? -1;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
});

test('a viewer can read the channel but cannot post', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const channel = await createChannel(browser, 'viewer');
  const viewer = await createAccount(browser, 'viewer');
  await addMember(browser, channel.id, viewer.businessId, 'viewer');
  const seeded = await apiJson(browser, 'POST', `/api/channels/${channel.id}/messages`, {
    body: `E2E 只读频道消息 ${uniqueSuffix()}`,
  });
  assert(seeded.status === 201, `预置消息失败：${seeded.status}`);

  await loginAs(browser, viewer);
  await app.open(`/channels/${channel.id}`);

  await expect(screen.getByRole('heading', { name: channel.name, level: 1 })).toBeVisible();
  await expect(screen.getByText(/E2E 只读频道消息/)).toBeVisible();

  const denied = await apiJson(browser, 'POST', `/api/channels/${channel.id}/messages`, {
    body: 'viewer 尝试发送',
  });
  assert(denied.status === 403, `viewer 发消息应当 403（实际 ${denied.status}）`);
});
