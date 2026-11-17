import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { fixture } from './support/fixture.js';
import type { SeededNotification } from './support/fixtures/notifications.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const response = await browserFetch(browser, method, path, body);
  let json: T | null = null;
  try {
    json = response.text === '' ? null : (JSON.parse(response.text) as T);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function currentBusinessId(browser: Browser): Promise<string> {
  const me = await apiJson<{ authenticated: boolean; user?: { businessId: string } }>(
    browser,
    'GET',
    '/api/auth/me',
  );
  assert(me.status === 200 && me.json?.authenticated === true, '读取当前账户失败');
  const businessId = me.json.user?.businessId;
  assert(typeof businessId === 'string' && businessId.length > 0, '当前账户缺少 businessId');
  return businessId;
}

interface Created {
  notificationIds: string[];
  channels: string[];
  agents: string[];
  accounts: string[];
  servers: string[];
}

const created: Created = {
  notificationIds: [],
  channels: [],
  agents: [],
  accounts: [],
  servers: [],
};

test.afterEach(async () => {
  await fixture('notifications', 'cleanup', { ids: created.notificationIds });
  await fixture('channels', 'cleanup', {
    channels: created.channels,
    agents: created.agents,
    accounts: created.accounts,
    servers: created.servers,
  });
  created.notificationIds.length = 0;
  created.channels.length = 0;
  created.agents.length = 0;
  created.accounts.length = 0;
  created.servers.length = 0;
});

async function seedNotifications(
  businessId: string,
  items: readonly SeededNotification[],
): Promise<string[]> {
  const ids = await fixture('notifications', 'seed', businessId, [...items]);
  created.notificationIds.push(...ids);
  assert(ids.length === items.length, '通知 seed 数量不符');
  return ids;
}

function readState(id: string): Promise<Date | null> {
  return fixture('notifications', 'readState', id);
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

async function loginAs(browser: Browser, account: TestAccount): Promise<void> {
  const result = await browserFetch(browser, 'POST', '/api/auth/login', {
    username: account.username,
    password: account.password,
  });
  assert(result.status === 200, `登录 ${account.username} 失败：${result.status}`);
}

async function createChannel(browser: Browser, tag: string): Promise<{ id: string; name: string }> {
  const name = `E2E 通知频道 ${tag} ${uniqueSuffix()}`;
  const result = await apiJson<{ id: string }>(browser, 'POST', '/api/channels', { name });
  assert(result.status === 201 && result.json !== null, `创建频道失败：${result.status}`);
  created.channels.push(result.json.id);
  return { id: result.json.id, name };
}

async function createAgent(browser: Browser, tag: string): Promise<{ id: string; name: string }> {
  const suffix = uniqueSuffix();
  const name = `E2E 通知智能体 ${tag} ${suffix}`;
  const result = await apiJson<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-notifications-${tag}-${suffix}`,
    name,
    systemPrompt: '你是通知验证智能体。',
  });
  assert(result.status === 201 && result.json !== null, `创建智能体失败：${result.status}`);
  created.agents.push(result.json.id);
  return { id: result.json.id, name };
}

async function bindAgent(browser: Browser, channelId: string, agentId: string): Promise<void> {
  const result = await apiJson(browser, 'POST', `/api/channels/${channelId}/agents`, { agentId });
  assert(result.status === 201, `绑定智能体失败：${result.status}`);
}

test('shows the signed-in account its own notifications only', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/notifications');
  const businessId = await currentBusinessId(browser);
  const adminTitle = `E2E 管理员通知 ${uniqueSuffix()}`;
  const foreignTitle = `E2E 其他账号通知 ${uniqueSuffix()}`;
  const [adminId] = await seedNotifications(businessId, [{ kind: 'approval', title: adminTitle }]);
  const [foreignId] = await seedNotifications(`e2e-foreign-${uniqueSuffix()}`, [
    { kind: 'run_failed', title: foreignTitle },
  ]);
  assert(adminId !== undefined && foreignId !== undefined, '通知 seed 缺少 ID');

  await browser.reload();
  await expect(screen.getByRole('heading', { name: '通知与待办', level: 1 })).toBeVisible();
  await expect(screen.getByText(adminTitle)).toBeVisible();
  await expect(screen.getByText(foreignTitle)).toHaveCount(0);
});

test('marks one notification and then all notifications read', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/notifications');
  const account = await createAccount(browser, 'notify-read');
  await loginAs(browser, account);
  const firstTitle = `E2E 单条已读 ${uniqueSuffix()}`;
  const secondTitle = `E2E 全部已读 ${uniqueSuffix()}`;
  const [firstId, secondId] = await seedNotifications(account.businessId, [
    { kind: 'question', title: firstTitle },
    { kind: 'run_failed', title: secondTitle },
  ]);
  assert(firstId !== undefined && secondId !== undefined, '通知 seed 缺少 ID');

  await browser.reload();
  await expect(screen.getByRole('heading', { name: '通知与待办', level: 1 })).toBeVisible();
  await expect(screen.getByText('2 条待办')).toBeVisible();
  await expect(screen.getByRole('link', { name: '通知，2 条未读' })).toBeVisible();

  await screen.getByRole('button', { name: `标为已读：${firstTitle}` }).tap();
  await expect.poll(() => readState(firstId), { timeout: 15_000 }).not.toBeNull();
  await expect(screen.getByText('1 条待办')).toBeVisible();
  await expect(screen.getByRole('link', { name: '通知，1 条未读' })).toBeVisible();

  await screen.getByRole('button', { name: '全部已读' }).tap();
  await expect.poll(() => readState(secondId), { timeout: 15_000 }).not.toBeNull();
  await expect(screen.getByRole('link', { name: '通知', exact: true })).toBeVisible();
  await expect(screen.getByText('条待办', { exact: false })).toHaveCount(0);
  await expect(screen.getByRole('button', { name: '全部已读' })).toHaveCount(0);
});

test('keeps paging after the cursor anchor is marked read', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/notifications');
  const account = await createAccount(browser, 'notify-pages');
  await loginAs(browser, account);
  const suffix = uniqueSuffix();
  const titles = Array.from({ length: 25 }, (_, index) => `E2E 分页通知 ${index} ${suffix}`);
  const ids = await seedNotifications(
    account.businessId,
    titles.map((title) => ({ kind: 'budget_alert' as const, title })),
  );
  const firstTitle = titles[0];
  const lastTitle = titles.at(-1);
  const anchorId = ids[19];
  assert(
    firstTitle !== undefined && lastTitle !== undefined && anchorId !== undefined,
    '分页夹具不完整',
  );

  const firstPage = await apiJson<{ items: { id: string }[]; nextCursor: string | null }>(
    browser,
    'GET',
    '/api/notifications?unreadOnly=true&limit=20',
  );
  assert(firstPage.status === 200 && firstPage.json !== null, '读取首屏通知失败');
  assert(firstPage.json.nextCursor === anchorId, '游标锚点不是第 20 条未读通知');
  const marked = await apiJson(browser, 'POST', `/api/notifications/${anchorId}/read`);
  assert(marked.status === 200, `标记游标锚点已读失败：${marked.status}`);
  const nextPage = await apiJson<{ items: { id: string }[]; nextCursor: string | null }>(
    browser,
    'GET',
    `/api/notifications?unreadOnly=true&limit=20&cursor=${encodeURIComponent(anchorId)}`,
  );
  assert(nextPage.status === 200 && nextPage.json !== null, '已读锚点后的未读分页失败');
  assert(
    nextPage.json.items.length === 5 && nextPage.json.items.at(-1)?.id === ids[24],
    `已读锚点后的分页应返回末尾 5 条（实际 ${nextPage.json.items.length} 条）`,
  );

  await browser.reload();
  await expect(screen.getByRole('heading', { name: '通知与待办', level: 1 })).toBeVisible();
  await expect(screen.getByText(firstTitle)).toBeVisible();
  await expect(screen.getByText(lastTitle)).toHaveCount(0);

  await screen.getByRole('button', { name: `标为已读：${firstTitle}` }).tap();
  const firstId = ids[0];
  assert(firstId !== undefined, '分页夹具缺少首条通知');
  await expect.poll(() => readState(firstId), { timeout: 15_000 }).not.toBeNull();
  await expect(screen.getByRole('button', { name: `标为已读：${firstTitle}` })).toHaveCount(0);
  await screen.getByRole('button', { name: '加载更多' }).tap();

  await expect(screen.getByText(lastTitle)).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByRole('list', { name: '通知列表' }).getByRole('listitem')).toHaveCount(
    25,
  );
  await expect(screen.getByText('更多通知没有加载出来')).toHaveCount(0);
  await expect(screen.getByText('内容没有加载出来')).toHaveCount(0);
});

test('denies a pending channel approval', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'deny');
  const channel = await createChannel(browser, 'deny');
  await bindAgent(browser, channel.id, agent.id);
  const serverName = `E2E 拒绝审批服务 ${uniqueSuffix()}`;
  const { serverId, approvalId } = await fixture(
    'channels',
    'pendingApproval',
    channel.id,
    agent.id,
    serverName,
  );
  created.servers.push(serverId);

  await app.open(`/channels/${channel.id}`);
  await expect(screen.getByText(/需要批准：/)).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByText(serverName, { exact: false })).toBeVisible();

  await screen.getByRole('button', { name: '拒绝' }).tap();
  await expect(screen.getByText('已拒绝')).toBeVisible();
  await expect
    .poll(
      async () => {
        const rows = await fixture('channels', 'approval', approvalId);
        return rows[0]?.denied_at != null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(screen.getByRole('button', { name: '拒绝' })).toHaveCount(0);
  await expect(screen.getByText(serverName, { exact: false })).toHaveCount(0);
});
