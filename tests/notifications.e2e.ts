import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { fixture } from './support/fixture.js';
import type { SeededNotification } from './support/fixtures/notifications.js';
import type {
  ApprovalProducer,
  ApprovalProducerSeed,
} from './support/fixtures/notifications-producers.js';

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

const producers: ApprovalProducer[] = [];

test.afterEach(async () => {
  await fixture('notifications-producers', 'cleanup', {
    serverIds: producers.map((producer) => producer.serverId),
    agentIds: producers.map((producer) => producer.agentId),
    runIds: producers.map((producer) => producer.runId),
    businessIds: created.accounts,
  });
  producers.length = 0;
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

async function addMember(
  browser: Browser,
  channelId: string,
  businessId: string,
  role: 'admin' | 'member',
): Promise<void> {
  const result = await apiJson(browser, 'POST', `/api/channels/${channelId}/members`, {
    businessId,
    role,
  });
  assert(result.status === 201, `添加频道成员失败：${result.status}`);
}

async function seedProducer(input: ApprovalProducerSeed): Promise<ApprovalProducer> {
  const producer = await fixture('notifications-producers', 'seed', input);
  producers.push(producer);
  return producer;
}

function readProducerState(runId: string, businessIds: readonly string[]) {
  return fixture('notifications-producers', 'approvalState', runId, [...businessIds]);
}

async function callApprovalTool(
  browser: Browser,
  producer: ApprovalProducer,
): Promise<{ status: number; body: string }> {
  return browser.evaluate(
    async (input: { serverId: string; runToken: string; runId: string; toolName: string }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetch(`/mcp/${input.serverId}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${input.runToken}`,
            'x-agentport-run-id': input.runId,
            'mcp-protocol-version': '2025-11-25',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: input.toolName, arguments: { id: 1 } },
          }),
          signal: controller.signal,
        });
        const body = await response.text().catch(() => '');
        return { status: response.status, body };
      } catch (error) {
        return { status: 0, body: String(error) };
      } finally {
        clearTimeout(timer);
      }
    },
    {
      serverId: producer.serverId,
      runToken: producer.runToken,
      runId: producer.runId,
      toolName: producer.toolName,
    },
  );
}

async function notificationLinks(browser: Browser): Promise<string[]> {
  const result = await apiJson<{ items: { link: string }[] }>(
    browser,
    'GET',
    '/api/notifications?limit=50',
  );
  assert(result.status === 200 && result.json !== null, '读取通知列表失败');
  return result.json.items.map((item) => item.link);
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

test('creates a private run approval notification through the MCP endpoint', {
  session: 'admin',
}, async ({ app, browser }) => {
  await app.open('/notifications');
  const initiator = await createAccount(browser, 'notify-private');
  await loginAs(browser, initiator);
  const suffix = uniqueSuffix();
  const producer = await seedProducer({
    serverName: `E2E 私有通知服务 ${suffix}`,
    toolName: `e2e-private-tool-${suffix}`,
    initiatedBy: initiator.businessId,
    trigger: 'chat',
  });
  const before = await readProducerState(producer.runId, [initiator.businessId]);
  assert(before.approval === null && before.notifications.length === 0, '触发前不应有审批或通知');

  const called = await callApprovalTool(browser, producer);

  await expect
    .poll(
      async () =>
        (await readProducerState(producer.runId, [initiator.businessId])).notifications.length,
      { timeout: 15_000 },
    )
    .toBe(1);

  const state = await readProducerState(producer.runId, [initiator.businessId]);
  const notification = state.notifications[0];
  assert(
    state.approval !== null && notification !== undefined,
    `审批或通知没有落库（调用 ${called.status}：${called.body}）`,
  );
  expect(state.approval).toMatchObject({
    channel_id: null,
    tool_name: producer.toolName,
    run_id: producer.runId,
  });
  expect(notification).toMatchObject({
    business_id: initiator.businessId,
    kind: 'approval',
    link: `/runs/${producer.runId}`,
    source_id: `approval:${producer.runId}:${producer.serverId}:${producer.toolName}`,
  });

  const list = await apiJson<{ items: { id: string; kind: string; link: string }[] }>(
    browser,
    'GET',
    '/api/notifications?limit=50',
  );
  assert(list.status === 200 && list.json !== null, '读取通知列表失败');
  expect(list.json.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: notification.id,
        kind: 'approval',
        link: `/runs/${producer.runId}`,
      }),
    ]),
  );
});

test('notifies channel owners and admins for a channel run approval', {
  session: 'admin',
}, async ({ app, browser }) => {
  await app.open('/channels');
  const owner = await createAccount(browser, 'notify-channel-owner');
  const channelAdmin = await createAccount(browser, 'notify-channel-admin');
  const member = await createAccount(browser, 'notify-channel-member');
  await loginAs(browser, owner);
  const channel = await createChannel(browser, 'approval');
  await addMember(browser, channel.id, channelAdmin.businessId, 'admin');
  await addMember(browser, channel.id, member.businessId, 'member');
  const suffix = uniqueSuffix();
  const producer = await seedProducer({
    serverName: `E2E 频道通知服务 ${suffix}`,
    toolName: `e2e-channel-tool-${suffix}`,
    initiatedBy: member.businessId,
    channelId: channel.id,
    trigger: 'channel',
  });
  const recipients = [owner.businessId, channelAdmin.businessId, member.businessId];
  const before = await readProducerState(producer.runId, recipients);
  assert(before.approval === null && before.notifications.length === 0, '触发前不应有审批或通知');

  const called = await callApprovalTool(browser, producer);

  await expect
    .poll(async () => (await readProducerState(producer.runId, recipients)).notifications.length, {
      timeout: 15_000,
    })
    .toBe(2);

  const state = await readProducerState(producer.runId, recipients);
  const approval = state.approval;
  assert(approval !== null, `频道审批没有落库（调用 ${called.status}：${called.body}）`);
  expect(approval).toMatchObject({
    channel_id: channel.id,
    tool_name: producer.toolName,
    run_id: producer.runId,
  });
  expect(state.notifications.map((item) => item.business_id).sort()).toEqual(
    [owner.businessId, channelAdmin.businessId].sort(),
  );
  for (const notification of state.notifications) {
    expect(notification).toMatchObject({
      kind: 'approval',
      link: `/channels/${channel.id}`,
      source_id: `channel-approval:${approval.id}`,
    });
  }

  await loginAs(browser, owner);
  expect(await notificationLinks(browser)).toContain(`/channels/${channel.id}`);
  await loginAs(browser, channelAdmin);
  expect(await notificationLinks(browser)).toContain(`/channels/${channel.id}`);
  await loginAs(browser, member);
  expect(await notificationLinks(browser)).not.toContain(`/channels/${channel.id}`);
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
