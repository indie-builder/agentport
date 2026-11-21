import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect, type Screen } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { OUTPUT_WRITE_MARKER } from './support/execution-stack.js';
import { fixture as runFixture } from './support/fixture.js';

const REPLY_PREFIX = 'E2E-CHANNEL-REPLY';
const SLOW_MARKER = 'E2E-CHANNEL-SLOW';
const SLOW_PARTIAL = 'E2E-CHANNEL-SLOW-PARTIAL';
const ATTACH_MARKER = 'E2E-CHANNEL-ATTACH';
const STEER_MARKER = 'E2E-CHANNEL-STEER';
const APPROVAL_TOOL_MARKER = 'E2E-APPROVAL-TOOL';
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Created {
  channels: string[];
  agents: string[];
  accounts: string[];
  servers: string[];
}

const created: Created = { channels: [], agents: [], accounts: [], servers: [] };

test.afterEach(async () => {
  await runFixture('channels', 'cleanup', created);
  created.channels.length = 0;
  created.agents.length = 0;
  created.accounts.length = 0;
  created.servers.length = 0;
});

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

async function createChannel(browser: Browser, tag: string): Promise<{ id: string; name: string }> {
  const name = `E2E 频道 ${tag} ${uniqueSuffix()}`;
  const result = await apiJson<{ id: string }>(browser, 'POST', '/api/channels', { name });
  assert(result.status === 201 && result.json !== null, `创建频道失败：${result.status}`);
  created.channels.push(result.json.id);
  return { id: result.json.id, name };
}

async function createAgent(
  browser: Browser,
  tag: string,
  options: { serverIds?: string[] } = {},
): Promise<{ id: string; name: string }> {
  const suffix = uniqueSuffix();
  const name = `E2E 智能体 ${tag} ${suffix}`;
  const result = await apiJson<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-channel-${tag}-${suffix}`,
    name,
    systemPrompt: '你是频道验证智能体。收到消息后直接回复内容。',
    ...options,
  });
  assert(result.status === 201 && result.json !== null, `创建智能体失败：${result.status}`);
  created.agents.push(result.json.id);
  return { id: result.json.id, name };
}

function fakeModelUrl(): string {
  return (process.env.E2E_FAKE_MODEL_URL ?? 'http://127.0.0.1:4318').replace(/\/+$/, '');
}

async function approvalEchoHits(): Promise<number> {
  const response = await fetch(`${fakeModelUrl()}/__e2e_upstream/hits`);
  assert(response.ok, `读取假模型上游命中数失败：${response.status}`);
  const body = (await response.json()) as { approvalEcho?: unknown };
  assert(typeof body.approvalEcho === 'number', '假模型上游命中数格式不符');
  return body.approvalEcho;
}

async function createApprovalServer(
  browser: Browser,
  tag: string,
): Promise<{ serverId: string; serverName: string }> {
  const suffix = uniqueSuffix();
  const serverName = `e2e-channel-approval-${tag}-${suffix}`;
  const server = await apiJson<{ id: string }>(browser, 'POST', '/api/servers', {
    kind: 'generated',
    name: serverName,
    baseUrl: `${fakeModelUrl()}/__e2e_upstream`,
  });
  assert(server.status === 201 && server.json !== null, `创建服务器失败：${server.status}`);
  created.servers.push(server.json.id);
  const tool = await apiJson(browser, 'POST', `/api/servers/${server.json.id}/tools`, {
    name: 'approval-echo',
    method: 'GET',
    pathTemplate: '/approval-echo',
    approvalMode: 'ask',
    inputSchema: { type: 'object', properties: {} },
  });
  assert(tool.status === 201, `创建审批工具失败：${tool.status}`);
  return { serverId: server.json.id, serverName };
}

async function terminalRunStatus(channelId: string, runId: string): Promise<string | null> {
  const rows = await runFixture('channels', 'runs', channelId);
  const status = rows.find((run) => run.id === runId)?.status;
  return status !== undefined && TERMINAL_STATUSES.has(status) ? status : null;
}

async function bindAgent(
  browser: Browser,
  channelId: string,
  agentId: string,
  autoWakeOnAll?: boolean,
): Promise<void> {
  const result = await apiJson(browser, 'POST', `/api/channels/${channelId}/agents`, {
    agentId,
    ...(autoWakeOnAll === undefined ? {} : { autoWakeOnAll }),
  });
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
  const result = await browserFetch(browser, 'POST', '/api/auth/login', {
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

async function sendMentionViaKeyboard(
  screen: Screen,
  agentName: string,
  text: string,
): Promise<void> {
  const composer = screen.getByRole('textbox', '消息');
  await composer.fill('@');
  await screen.getByRole('listbox', '提及智能体').waitFor();
  await composer.press('Enter');
  await expect(composer).toHaveValue(`@${agentName} `);
  await composer.pressSequentially(text);
  await expect(composer).toHaveValue(`@${agentName} ${text}`);
  await screen.getByRole('button', '发送消息').tap();
}

function channelReplyLocator(browser: Browser, promptLine: string) {
  return browser
    .locator('[data-message-id]')
    .filter({ hasText: REPLY_PREFIX })
    .filter({ hasText: promptLine });
}

async function waitForReply(screen: Screen, browser: Browser, promptLine: string): Promise<void> {
  const reply = channelReplyLocator(browser, promptLine);
  await expect(reply).toHaveCount(1, { timeout: 120_000 });
  await expect(reply).toBeVisible({ timeout: 120_000 });
  await expect(screen.getByText('空闲', { visible: true })).toBeVisible({ timeout: 60_000 });
}

async function latestRunStatus(channelId: string): Promise<string | undefined> {
  return runFixture('channels', 'latestRunStatus', channelId);
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
  await expect(screen.getByRole('heading', { name: /智能体\s*0/ })).toBeVisible();

  await screen.getByRole('button', '频道设置').tap();
  const settings = screen.getByRole('dialog', '频道设置');
  await expect(settings).toBeVisible();
  await settings.getByLabel('选择要绑定的智能体').tap();
  await screen.getByRole('option', { name: agent.name, exact: false }).tap();
  await settings.getByRole('button', '绑定智能体').tap();
  await expect(screen.getByText('智能体已绑定')).toBeVisible();
  await settings.getByRole('button', '关闭').tap();
  await expect(settings).toBeHidden();

  const sidebar = screen.getByRole('complementary');
  await expect(sidebar.getByText(agent.name, { visible: true })).toBeVisible();
  await expect(sidebar.getByText('空闲', { visible: true })).toBeVisible();
  const rows = await runFixture('channels', 'bindingCount', channel.id, agent.id);
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
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const rows = await runFixture('channels', 'runCount', channel.id);
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
  const text = `${SLOW_MARKER} E2E 主路径 ${uniqueSuffix()}`;
  await sendMention(screen, agent.name, text);

  await expect(screen.getByText('运行中', { visible: true })).toBeVisible({ timeout: 60_000 });
  await waitForReply(screen, browser, `@${agent.name} ${text}`);
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
  await waitForReply(screen, browser, `@${agent.name} ${first}`);

  const second = `E2E 复用第二条 ${uniqueSuffix()}`;
  await sendMention(screen, agent.name, second);
  await waitForReply(screen, browser, `@${agent.name} ${second}`);

  await expect
    .poll(
      async () => {
        const runs = await runFixture('channels', 'runs', channel.id);
        return {
          count: runs.length,
          lanes: new Set(runs.map((run) => run.conversation_id)).size,
          statuses: runs.map((run) => run.status).join(','),
        };
      },
      { timeout: 60_000 },
    )
    .toEqual({ count: 2, lanes: 1, statuses: 'succeeded,succeeded' });
  const lanes = await runFixture('channels', 'laneCount', channel.id, agent.id);
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

  await expect(screen.getByText('运行已停止，打开运行详情查看状态。')).toBeVisible({
    timeout: 90_000,
  });
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

  const serverName = `E2E 审批服务 ${uniqueSuffix()}`;
  const { serverId, approvalId } = await runFixture(
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
  await screen.getByRole('button', '批准').tap();

  await expect(screen.getByText('已批准')).toBeVisible();
  await expect
    .poll(
      async () => {
        const rows = await runFixture('channels', 'approval', approvalId);
        return rows[0]?.approved_at != null;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(screen.getByRole('button', '批准')).toHaveCount(0);
});

test('attaches a file to a channel message, reads it in the sandbox and limits download to members', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, screen, browser }) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'attach');
  const channel = await createChannel(browser, 'attach');
  await bindAgent(browser, channel.id, agent.id);

  await app.open(`/channels/${channel.id}`);
  const suffix = uniqueSuffix();
  const filename = `e2e-attach-${suffix}.txt`;
  const content = `E2E-ATTACH-CONTENT-${suffix}`;
  const filePath = join(tmpdir(), filename);
  writeFileSync(filePath, content, 'utf8');

  await browser.locator('input[aria-label="选择资料文件"]').setInputFiles(filePath);
  await expect(screen.getByRole('button', { name: `移除 ${filename}`, exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const text = `${ATTACH_MARKER} 请读取附件 ${suffix}`;
  await sendMention(screen, agent.name, text);
  await waitForReply(screen, browser, `@${agent.name} ${text}`);
  await expect(screen.getByText(content, { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    screen.getByRole('link', { name: new RegExp(`下载 ${escapeRegExp(filename)}`) }).first(),
  ).toBeVisible({ timeout: 30_000 });

  const messages = await apiJson<
    Array<{
      id: string;
      kind: string;
      agentId: string | null;
      body: string;
      attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
    }>
  >(browser, 'GET', `/api/channels/${channel.id}/messages`);
  assert(messages.status === 200 && messages.json !== null, `读取频道消息失败：${messages.status}`);
  const attached = messages.json.find(
    (message) => message.kind === 'human' && message.body.includes(text),
  );
  assert(attached !== undefined, '频道消息列表缺少带附件的消息');
  const attachment = attached.attachments.find((item) => item.filename === filename);
  assert(attachment !== undefined, `频道消息缺少附件 ${filename}`);

  const downloadUrl = `/api/channels/${channel.id}/messages/${attached.id}/attachments/${attachment.id}/download`;
  const download = await browserFetch(browser, 'GET', downloadUrl);
  assert(download.status === 200, `成员下载附件失败：${download.status}`);
  assert(download.text === content, `下载内容不符：${download.text}`);

  const attachOnlyFilename = `e2e-attach-only-${suffix}.txt`;
  const attachOnlyContent = `E2E-ATTACH-ONLY-CONTENT-${suffix}`;
  const attachOnlyFilePath = join(tmpdir(), attachOnlyFilename);
  writeFileSync(attachOnlyFilePath, attachOnlyContent, 'utf8');

  await browser.locator('input[aria-label="选择资料文件"]').setInputFiles(attachOnlyFilePath);
  await expect(
    screen.getByRole('button', { name: `移除 ${attachOnlyFilename}`, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await screen.getByRole('button', { name: '发送消息' }).tap();
  await expect(
    screen
      .getByRole('link', { name: new RegExp(`下载 ${escapeRegExp(attachOnlyFilename)}`) })
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  await app.open(`/channels/${channel.id}`);
  await expect(
    screen
      .getByRole('link', { name: new RegExp(`下载 ${escapeRegExp(attachOnlyFilename)}`) })
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  const attachOnlyMessages = await apiJson<
    Array<{
      id: string;
      kind: string;
      body: string;
      attachments: Array<{ id: string; filename: string }>;
    }>
  >(browser, 'GET', `/api/channels/${channel.id}/messages`);
  assert(
    attachOnlyMessages.status === 200 && attachOnlyMessages.json !== null,
    `读取频道消息失败：${attachOnlyMessages.status}`,
  );
  const attachOnly = attachOnlyMessages.json.find(
    (message) =>
      message.kind === 'human' &&
      message.body === '' &&
      message.attachments.some((item) => item.filename === attachOnlyFilename),
  );
  assert(attachOnly !== undefined, '频道消息列表缺少纯附件消息');
  const attachOnlyAttachment = attachOnly.attachments.find(
    (item) => item.filename === attachOnlyFilename,
  );
  assert(attachOnlyAttachment !== undefined, `纯附件消息缺少附件 ${attachOnlyFilename}`);
  const attachOnlyDownload = await browserFetch(
    browser,
    'GET',
    `/api/channels/${channel.id}/messages/${attachOnly.id}/attachments/${attachOnlyAttachment.id}/download`,
  );
  assert(attachOnlyDownload.status === 200, `纯附件下载失败：${attachOnlyDownload.status}`);
  assert(
    attachOnlyDownload.text === attachOnlyContent,
    `纯附件内容不符：${attachOnlyDownload.text}`,
  );

  const largeFilename = `e2e-attach-large-${suffix}.txt`;
  const largeContent = 'A'.repeat(900 * 1024);
  const largeFilePath = join(tmpdir(), largeFilename);
  writeFileSync(largeFilePath, largeContent, 'utf8');

  await browser.locator('input[aria-label="选择资料文件"]').setInputFiles(largeFilePath);
  await expect(
    screen.getByRole('button', { name: `移除 ${largeFilename}`, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await screen.getByRole('button', { name: '发送消息' }).tap();
  await expect(
    screen.getByRole('link', { name: new RegExp(`下载 ${escapeRegExp(largeFilename)}`) }).first(),
  ).toBeVisible({ timeout: 60_000 });

  const largeMessages = await apiJson<
    Array<{
      id: string;
      kind: string;
      body: string;
      attachments: Array<{ id: string; filename: string }>;
    }>
  >(browser, 'GET', `/api/channels/${channel.id}/messages`);
  assert(
    largeMessages.status === 200 && largeMessages.json !== null,
    `读取频道消息失败：${largeMessages.status}`,
  );
  const large = largeMessages.json.find(
    (message) =>
      message.kind === 'human' &&
      message.body === '' &&
      message.attachments.some((item) => item.filename === largeFilename),
  );
  assert(large !== undefined, '频道消息列表缺少大附件消息');
  const largeAttachment = large.attachments.find((item) => item.filename === largeFilename);
  assert(largeAttachment !== undefined, `大附件消息缺少附件 ${largeFilename}`);
  const largeDownload = await browserFetch(
    browser,
    'GET',
    `/api/channels/${channel.id}/messages/${large.id}/attachments/${largeAttachment.id}/download`,
  );
  assert(largeDownload.status === 200, `大附件下载失败：${largeDownload.status}`);
  assert(
    largeDownload.text.length === largeContent.length,
    `大附件长度不符：${largeDownload.text.length}`,
  );
  assert(largeDownload.text === largeContent, '大附件内容不符');

  const outsider = await createAccount(browser, 'attach-outsider');
  await loginAs(browser, outsider);
  const denied = await browserFetch(browser, 'GET', downloadUrl);
  assert(denied.status === 404, `非成员下载附件应当 404（实际 ${denied.status}）`);
});

test('denying a channel approval leaves no upstream side effect', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, screen, browser }) => {
  await app.open('/channels');
  const { serverId, serverName } = await createApprovalServer(browser, 'channel');
  const agent = await createAgent(browser, 'approval', { serverIds: [serverId] });
  const channel = await createChannel(browser, 'approval');
  await bindAgent(browser, channel.id, agent.id);
  const hitsBefore = await approvalEchoHits();

  await app.open(`/channels/${channel.id}`);
  const text = `${APPROVAL_TOOL_MARKER} mcp__${serverName}__approval-echo ${uniqueSuffix()}`;
  await sendMention(screen, agent.name, text);

  await expect(screen.getByText(/需要批准：/)).toBeVisible({ timeout: 120_000 });
  await expect(screen.getByText(serverName, { exact: false }).first()).toBeVisible();
  await expect
    .poll(
      async () => (await runFixture('channels', 'latestApprovalByChannel', channel.id)).length > 0,
      { timeout: 60_000 },
    )
    .toBe(true);

  const [approval] = await runFixture('channels', 'latestApprovalByChannel', channel.id);
  assert(approval !== undefined && approval.run_id !== null, '审批缺少所属运行');
  assert(approval.server_id === serverId, `审批服务器不符：${approval.server_id}`);
  assert(approval.tool_name === 'approval-echo', `审批工具不符：${approval.tool_name}`);

  await screen.getByRole('button', '拒绝').tap();
  await expect(screen.getByText('已拒绝')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const rows = await runFixture('channels', 'latestApprovalByChannel', channel.id);
        return {
          approved: rows[0]?.approved_at != null,
          denied: rows[0]?.denied_at != null,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ approved: false, denied: true });

  await expect
    .poll(
      async () => (await terminalRunStatus(channel.id, approval.run_id as string)) ?? 'pending',
      {
        timeout: 180_000,
      },
    )
    .not.toBe('pending');
  expect(await terminalRunStatus(channel.id, approval.run_id)).toBe('succeeded');
  expect(await approvalEchoHits()).toBe(hitsBefore);
  await expect(screen.getByRole('button', '拒绝')).toHaveCount(0);
});

test('hands off a finished channel run to another agent with an output attachment', {
  session: 'admin',
  timeout: 420_000,
}, async ({ app, screen, browser }) => {
  await app.open('/channels');
  const source = await createAgent(browser, 'handoff-source');
  const target = await createAgent(browser, 'handoff-target');
  const channel = await createChannel(browser, 'handoff');
  await bindAgent(browser, channel.id, source.id);
  await bindAgent(browser, channel.id, target.id);

  await app.open(`/channels/${channel.id}`);
  const suffix = uniqueSuffix();
  const sourceText = `${OUTPUT_WRITE_MARKER} 交接来源 ${suffix}`;
  await sendMention(screen, source.name, sourceText);
  await waitForReply(screen, browser, `@${source.name} ${sourceText}`);

  const sourceRun = await runFixture('channels', 'runs', channel.id).then((rows) =>
    rows.find((run) => run.agent_id === source.id),
  );
  assert(sourceRun !== undefined, '交接来源运行不存在');
  await expect
    .poll(async () => (await terminalRunStatus(channel.id, sourceRun.id)) ?? 'pending', {
      timeout: 120_000,
    })
    .not.toBe('pending');
  expect(await terminalRunStatus(channel.id, sourceRun.id)).toBe('succeeded');

  await expect
    .poll(
      async () => {
        const outputs = await apiJson<{ items: Array<{ path: string }> }>(
          browser,
          'GET',
          `/api/channels/${channel.id}/runs/${sourceRun.id}/outputs`,
        );
        return outputs.json?.items.some((item) => item.path === 'normal-report.md') ?? false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect(screen.getByRole('button', { name: '交接', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
  await screen.getByRole('button', { name: '交接', exact: true }).first().tap();
  const dialog = screen.getByRole('dialog', '交接运行');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel('目标智能体').tap();
  await screen.getByRole('option', { name: target.name, exact: false }).tap();
  const note = `E2E 交接备注 ${suffix}`;
  await dialog.getByLabel('备注').fill(note);
  await dialog.getByRole('button', { name: '确认交接', exact: true }).tap();
  await expect(screen.getByText('已交接')).toBeVisible({ timeout: 60_000 });

  const listMessages = () =>
    apiJson<
      Array<{
        id: string;
        kind: string;
        agentId: string | null;
        body: string;
        attachments: Array<{ id: string; filename: string }>;
      }>
    >(browser, 'GET', `/api/channels/${channel.id}/messages`);

  const messages = await listMessages();
  assert(messages.status === 200 && messages.json !== null, `读取频道消息失败：${messages.status}`);
  const handoff = messages.json.find(
    (message) => message.kind === 'human' && message.body.includes('【运行交接】'),
  );
  assert(handoff !== undefined, '频道消息列表缺少交接消息');
  assert(handoff.body.includes(`来自智能体「${source.name}」`), '交接消息缺少来源智能体');
  assert(handoff.body.includes(sourceRun.id), '交接消息缺少来源运行 ID');
  assert(
    (handoff.body.split('最近回复：')[0] ?? '').includes(sourceText),
    '交接消息的原任务段缺少来源任务正文',
  );
  assert(handoff.body.includes('normal-report.md'), '交接消息缺少成果路径');
  assert(handoff.body.includes(note), '交接消息缺少备注');
  const handoffAttachment = handoff.attachments.find(
    (attachment) => attachment.filename === 'normal-report.md',
  );
  assert(handoffAttachment !== undefined, '交接消息缺少 normal-report.md 附件');

  const download = await browserFetch(
    browser,
    'GET',
    `/api/channels/${channel.id}/messages/${handoff.id}/attachments/${handoffAttachment.id}/download`,
  );
  assert(download.status === 200, `交接附件下载失败：${download.status}`);
  assert(download.text.includes('# 普通成果'), '交接附件缺少标题');
  assert(download.text.includes('E2E normal output'), '交接附件缺少成果正文');

  await expect
    .poll(
      async () => {
        const targetRun = (await runFixture('channels', 'runs', channel.id)).find(
          (run) => run.agent_id === target.id,
        );
        return targetRun !== undefined && TERMINAL_STATUSES.has(targetRun.status)
          ? targetRun.status
          : 'pending';
      },
      { timeout: 240_000 },
    )
    .toBe('succeeded');

  const runs = await runFixture('channels', 'runs', channel.id);
  expect(runs.length).toBeGreaterThanOrEqual(2);
  expect(runs.find((run) => run.id === sourceRun.id)?.status).toBe('succeeded');

  const after = await listMessages();
  assert(after.status === 200 && after.json !== null, `读取频道消息失败：${after.status}`);
  assert(
    after.json.some(
      (message) =>
        message.kind === 'agent' &&
        message.agentId === target.id &&
        message.body.includes(`请「${target.name}」基于以上上下文继续推进。`),
    ),
    '目标智能体没有基于交接上下文回复',
  );
});

test('steers a running channel run without creating a second run', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, screen, browser }) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'steer');
  const channel = await createChannel(browser, 'steer');
  await bindAgent(browser, channel.id, agent.id);

  await app.open(`/channels/${channel.id}`);
  const suffix = uniqueSuffix();
  await sendMention(screen, agent.name, `${SLOW_MARKER} 运行中追加 ${suffix}`);
  await expect
    .poll(async () => (await latestRunStatus(channel.id)) ?? 'missing', { timeout: 90_000 })
    .toBe('running');

  const steer = `${STEER_MARKER} ${suffix}`;
  await sendMentionViaKeyboard(screen, agent.name, steer);

  await expect
    .poll(
      async () => {
        const rows = await runFixture('channels', 'runs', channel.id);
        return rows.length === 1 && TERMINAL_STATUSES.has(rows[0]?.status ?? '')
          ? rows[0]?.status
          : 'pending';
      },
      { timeout: 240_000 },
    )
    .toBe('succeeded');

  await expect
    .poll(
      async () => {
        const instructions = await runFixture('channels', 'runInstructions', channel.id);
        return instructions.some(
          (instruction) => instruction.body.includes(steer) && instruction.delivered_at !== null,
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  const instructions = await runFixture('channels', 'runInstructions', channel.id);
  expect(instructions).toHaveLength(1);
  expect(instructions[0]?.body).toContain(steer);
  expect(instructions[0]?.delivered_at).not.toBeNull();
  const runs = await runFixture('channels', 'runCount', channel.id);
  expect(runs[0]?.count).toBe('1');

  const messages = await apiJson<Array<{ kind: string; body: string }>>(
    browser,
    'GET',
    `/api/channels/${channel.id}/messages`,
  );
  assert(messages.status === 200 && messages.json !== null, `读取频道消息失败：${messages.status}`);
  assert(
    messages.json.some(
      (message) =>
        message.kind === 'agent' &&
        message.body.includes(REPLY_PREFIX) &&
        message.body.includes(STEER_MARKER),
    ),
    '运行中追加的指令没有得到回复',
  );

  await expect(screen.getByText('空闲', { visible: true })).toBeVisible({ timeout: 60_000 });
  await expect(
    screen.getByText('当前智能体正在处理上一轮消息，本条已保存；请等它结束后再 @ 继续。'),
  ).toHaveCount(0);
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
  await expect(screen.getByText('空闲', { visible: true })).toBeVisible({ timeout: 60_000 });
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

test('@all requires explicit opt-in and a send confirmation', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const first = await createAgent(browser, 'all-first');
  const second = await createAgent(browser, 'all-second');
  const channel = await createChannel(browser, 'all');
  await bindAgent(browser, channel.id, first.id);
  await bindAgent(browser, channel.id, second.id);

  await app.open(`/channels/${channel.id}`);
  await expect(screen.getByRole('heading', { name: channel.name, level: 1 })).toBeVisible();
  await expect(screen.getByText(first.name, { visible: true })).toBeVisible();
  await expect(screen.getByText(second.name, { visible: true })).toBeVisible();
  await expect(screen.getByRole('button', { name: /通知全部/ })).toHaveCount(0);

  await screen.getByRole('button', '频道设置').tap();
  const settings = screen.getByRole('dialog', '频道设置');
  await expect(settings).toBeVisible();
  await screen.getByRole('switch', `${first.name} 响应 @all`).tap();
  await expect(screen.getByText(`已开启「${first.name}」的 @all 响应`)).toBeVisible();
  await settings.getByRole('button', '关闭').tap();
  await expect(settings).toBeHidden();

  const notify = screen.getByRole('button', '通知全部（1）');
  await expect(notify).toBeVisible({ timeout: 30_000 });
  await notify.tap();
  await expect(screen.getByText('将唤醒 1 个智能体')).toBeVisible();

  const body = `E2E 通知全部 ${uniqueSuffix()}`;
  await screen.getByRole('textbox', '消息').fill(body);
  await screen.getByRole('button', '发送消息').tap();

  const confirm = screen.getByRole('dialog', '发送通知全部？');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`将唤醒 1 个智能体：${first.name}。`);
  await expect(confirm).not.toContainText(second.name);
  await confirm.getByRole('button', '发送').tap();

  const reply = channelReplyLocator(browser, body);
  await expect(reply).toHaveCount(1, { timeout: 120_000 });
  await expect(reply).toBeVisible({ timeout: 120_000 });
  await expect(screen.getByRole('listitem').filter({ hasText: first.name })).toContainText('空闲', {
    timeout: 60_000,
  });

  const firstLanes = await runFixture('channels', 'laneCount', channel.id, first.id);
  expect(firstLanes[0]?.count).toBe('1');
  const secondLanes = await runFixture('channels', 'laneCount', channel.id, second.id);
  expect(secondLanes[0]?.count).toBe('0');
  const runs = await runFixture('channels', 'runCount', channel.id);
  expect(runs[0]?.count).toBe('1');
});

test('@all above the wake limit rejects the message without persisting it', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await app.open('/channels');
  const channel = await createChannel(browser, 'all-limit');
  for (let index = 0; index < 6; index += 1) {
    const agent = await createAgent(browser, `all-limit-${index}`);
    await bindAgent(browser, channel.id, agent.id, true);
  }

  await app.open(`/channels/${channel.id}`);
  await expect(screen.getByRole('button', '通知全部（6）')).toBeDisabled({ timeout: 30_000 });
  await expect(screen.getByText('超过单次上限 5 个，请在频道设置中调整')).toBeVisible();

  const body = `E2E 超限通知全部 ${uniqueSuffix()}`;
  const posted = await apiJson<{ code: string }>(
    browser,
    'POST',
    `/api/channels/${channel.id}/messages`,
    { body, mentionAll: true },
  );
  assert(posted.status === 400, `超限 @all 应当 400（实际 ${posted.status}）`);
  assert(
    posted.json?.code === 'INVALID_INPUT',
    `超限 @all 错误码应为 INVALID_INPUT（实际 ${posted.json?.code}）`,
  );

  const messages = await apiJson<Array<{ body: string }>>(
    browser,
    'GET',
    `/api/channels/${channel.id}/messages`,
  );
  assert(messages.status === 200 && messages.json !== null, `读取消息失败：${messages.status}`);
  assert(!messages.json.some((message) => message.body === body), '超限 @all 的正文不应落库');
  const runs = await runFixture('channels', 'runCount', channel.id);
  expect(runs[0]?.count).toBe('0');
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

test('records agent audits and hides channel runs from non-members', { session: 'admin' }, async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/channels');
  const agent = await createAgent(browser, 'identity');
  const channel = await createChannel(browser, 'identity');
  await bindAgent(browser, channel.id, agent.id);

  await app.open(`/channels/${channel.id}`);
  const text = `E2E 审计与授权 ${uniqueSuffix()}`;
  await sendMention(screen, agent.name, text);
  await waitForReply(screen, browser, `@${agent.name} ${text}`);

  const runs = await runFixture('channels', 'runs', channel.id);
  const run = runs[0];
  assert(run !== undefined, `频道应当产生运行（实际 ${runs.length} 条）`);
  const audits = await runFixture('channels', 'channelMessageAudits', channel.id);
  assert(
    audits.some(
      (audit) => audit.actor_kind === 'agent' && audit.action === 'channel.message.posted',
    ),
    `频道智能体消息应当写入审计（实际 ${audits.length} 条）`,
  );
  assert(
    audits.some(
      (audit) =>
        audit.actor === agent.id &&
        audit.actor_kind === 'agent' &&
        audit.action === 'channel.message.posted',
    ),
    `审计应记录智能体主体：${JSON.stringify(audits)}`,
  );
  const agentMessage = audits.find((audit) => audit.actor === agent.id);
  assert(agentMessage !== undefined, '智能体消息审计缺少目标消息');
  const auditList = await apiJson<{
    items: Array<{ actor: string; actorKind: string; action: string }>;
  }>(
    browser,
    'GET',
    `/api/audit?action=channel.message.posted&target=${encodeURIComponent(agentMessage.target)}`,
  );
  assert(auditList.status === 200 && auditList.json !== null, `读取审计失败：${auditList.status}`);
  assert(
    auditList.json.items.some(
      (item) =>
        item.actor === agent.id &&
        item.actorKind === 'agent' &&
        item.action === 'channel.message.posted',
    ),
    `审计接口应返回智能体主体：${JSON.stringify(auditList.json.items)}`,
  );

  const conversation = await apiJson<{ code: string; resource?: string }>(
    browser,
    'GET',
    `/api/conversations/${run.conversation_id}`,
  );
  assert(
    conversation.status === 404 &&
      conversation.json?.code === 'NOT_FOUND' &&
      conversation.json?.resource === 'conversation',
    `频道会话不应从私有会话入口读取（实际 ${conversation.status} ${conversation.json?.code} ${conversation.json?.resource}）`,
  );
  const chat = await apiJson<{ code: string; resource?: string }>(browser, 'POST', '/api/chat', {
    agentId: agent.id,
    conversationId: run.conversation_id,
    message: '管理员尝试从私有聊天入口进入频道会话',
  });
  assert(
    chat.status === 404 &&
      chat.json?.code === 'NOT_FOUND' &&
      chat.json?.resource === 'conversation',
    `频道会话不应从私有聊天入口进入（实际 ${chat.status} ${chat.json?.code} ${chat.json?.resource}）`,
  );

  const outsider = await createAccount(browser, 'outsider');
  await loginAs(browser, outsider);
  const deniedRequests: Array<{
    method: string;
    path: string;
    body?: unknown;
    code?: string;
    resource?: string;
    message?: string;
  }> = [
    { method: 'GET', path: `/api/channels/${channel.id}` },
    { method: 'GET', path: `/api/channels/${channel.id}/messages` },
    { method: 'GET', path: `/api/channels/${channel.id}/runs` },
    { method: 'GET', path: `/api/channels/${channel.id}/runs/${run.id}` },
    { method: 'GET', path: `/api/runs/${run.id}`, code: 'NOT_FOUND', resource: 'run' },
    { method: 'GET', path: `/api/channels/${channel.id}/runs/${run.id}/outputs` },
    { method: 'GET', path: `/api/channels/${channel.id}/runs/${run.id}/questions` },
    {
      method: 'GET',
      path: `/api/channels/${channel.id}/runs/${run.id}/outputs/content?path=report.md`,
      message: '运行不存在或不属于该频道',
    },
    {
      method: 'GET',
      path: `/api/channels/${channel.id}/runs/${run.id}/outputs/download?path=report.md`,
      message: '运行不存在或不属于该频道',
    },
    { method: 'POST', path: `/api/channels/${channel.id}/runs/${run.id}/stop` },
    {
      method: 'POST',
      path: `/api/channels/${channel.id}/messages`,
      body: { body: '非成员尝试发送频道消息' },
    },
  ];
  for (const request of deniedRequests) {
    const result = await apiJson<{ code: string; resource?: string; message: string }>(
      browser,
      request.method,
      request.path,
      request.body,
    );
    assert(
      result.status === 404,
      `${request.method} ${request.path} 对非成员应当 404（实际 ${result.status}）`,
    );
    assert(
      result.json?.code === (request.code ?? 'NOT_FOUND'),
      `${request.method} ${request.path} 错误码应为 ${request.code ?? 'NOT_FOUND'}（实际 ${result.json?.code}）`,
    );
    if (request.resource !== undefined) {
      assert(
        result.json?.resource === request.resource,
        `${request.method} ${request.path} 资源应为 ${request.resource}（实际 ${result.json?.resource}）`,
      );
    }
    assert(
      !(result.json?.message ?? '').startsWith('Route '),
      `${request.method} ${request.path} 不应落到全局 404（实际 ${result.json?.message}）`,
    );
    if (request.message !== undefined) {
      assert(
        result.json?.message === request.message,
        `${request.method} ${request.path} 错误信息应为 ${request.message}（实际 ${result.json?.message}）`,
      );
    }
  }
});

test('shows run feedback in the channel run sheet with member write and viewer read-only', {
  session: 'admin',
  timeout: 600_000,
}, async ({ app, screen, browser }) => {
  const suffix = uniqueSuffix();
  const shots = join('/tmp/channel-run-feedback-shots', suffix);
  const shot = async (label: string): Promise<string> => {
    mkdirSync(shots, { recursive: true });
    const source = await app.screenshot(label);
    const target = join(shots, `${label}.png`);
    copyFileSync(source, target);
    return target;
  };

  await app.open('/channels');
  const agent = await createAgent(browser, 'feedback');
  const channel = await createChannel(browser, 'feedback');
  await bindAgent(browser, channel.id, agent.id);
  const member = await createAccount(browser, 'feedback-member');
  const viewer = await createAccount(browser, 'feedback-viewer');
  await addMember(browser, channel.id, member.businessId, 'member');
  await addMember(browser, channel.id, viewer.businessId, 'viewer');

  await app.open(`/channels/${channel.id}`);
  const text = `${OUTPUT_WRITE_MARKER} 交付验收 ${suffix}`;
  await sendMention(screen, agent.name, text);
  await waitForReply(screen, browser, `@${agent.name} ${text}`);

  await expect
    .poll(async () => (await runFixture('channels', 'runs', channel.id)).at(-1)?.status, {
      timeout: 60_000,
    })
    .toBe('succeeded');
  const runs = await runFixture('channels', 'runs', channel.id);
  const runId = runs.at(-1)?.id;
  assert(runId !== undefined, '频道应当产生运行');

  const openRunSheet = async () => {
    await screen
      .getByRole('button', { name: /查看运行/ })
      .first()
      .tap();
    const sheet = screen.getByRole('dialog', '运行详情');
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    return sheet;
  };

  const sheet = await openRunSheet();
  await expect(sheet.getByText('交付验收', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByRole('button', { name: '退回', exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: '采纳', exact: true })).toBeVisible();

  const output = sheet.getByRole('button', { name: 'normal-report.md', exact: true });
  await expect(output).toBeVisible({ timeout: 30_000 });
  await output.tap();
  await sheet.getByRole('button', { name: '退回', exact: true }).tap();
  const rejectDialog = screen.getByRole('dialog', '退回本次成果');
  await expect(rejectDialog).toBeVisible({ timeout: 15_000 });
  await expect(rejectDialog.getByLabel('验收对象')).toContainText('normal-report.md');
  await rejectDialog.getByRole('button', { name: '取消', exact: true }).tap();
  await expect(rejectDialog).toHaveCount(0);
  await expect(sheet.getByText('E2E normal output')).toBeVisible({ timeout: 30_000 });

  await browser.setViewport({ width: 1440, height: 900 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const wideShot = await shot('channel-run-feedback-1440');
  assert(existsSync(wideShot), '1440 截图未生成');

  await browser.setViewport({ width: 1200, height: 900 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const narrowShot = await shot('channel-run-feedback-1200');
  assert(existsSync(narrowShot), '1200 截图未生成');

  await loginAs(browser, member);
  await app.open(`/channels/${channel.id}`);
  const memberSheet = await openRunSheet();
  await expect(memberSheet.getByText('交付验收', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(memberSheet.getByRole('button', { name: '退回', exact: true })).toBeVisible();
  await expect(memberSheet.getByRole('button', { name: '采纳', exact: true })).toBeVisible();

  await loginAs(browser, viewer);
  await app.open(`/channels/${channel.id}`);
  const viewerSheet = await openRunSheet();
  await expect(viewerSheet.getByText('交付验收', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(viewerSheet.getByRole('button', { name: '退回', exact: true })).toHaveCount(0);
  await expect(viewerSheet.getByRole('button', { name: '采纳', exact: true })).toHaveCount(0);
});
