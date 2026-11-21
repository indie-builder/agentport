import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { fixture } from './support/fixture.js';

const SLOW_MARKER = 'E2E-CHANNEL-SLOW';
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);

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

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待超时：${label}`);
}

interface AgentOptions {
  timeoutMs?: number;
  monthlyBudgetUsd?: number;
  budgetAlertRatio?: number;
  serverIds?: string[];
}

const created: { agentIds: string[]; serverIds: string[] } = { agentIds: [], serverIds: [] };

test.afterEach(async () => {
  await fixture('notifications-worker', 'cleanup', {
    agentIds: created.agentIds,
    serverIds: created.serverIds,
  });
  created.agentIds.length = 0;
  created.serverIds.length = 0;
});

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
  const serverName = `e2e-approval-${tag}-${suffix}`;
  const server = await apiJson<{ id: string }>(browser, 'POST', '/api/servers', {
    kind: 'generated',
    name: serverName,
    baseUrl: `${fakeModelUrl()}/__e2e_upstream`,
  });
  assert(server.status === 201 && server.json !== null, `创建服务器失败：${server.status}`);
  created.serverIds.push(server.json.id);
  const tool = await apiJson(browser, 'POST', `/api/servers/${server.json.id}/tools`, {
    name: 'approval-echo',
    method: 'POST',
    pathTemplate: '/approval-echo',
    approvalMode: 'allow',
    inputSchema: { type: 'object', properties: {} },
  });
  assert(tool.status === 201, `创建审批工具失败：${tool.status}`);
  const policy = await apiJson(browser, 'POST', '/api/security/tool-policies', {
    serverId: server.json.id,
    approvalMode: 'ask',
    httpMethod: 'POST',
    role: 'agent:owner',
  });
  assert(policy.status === 201, `创建审批策略失败：${policy.status}`);
  return { serverId: server.json.id, serverName };
}

async function createAgent(
  browser: Browser,
  tag: string,
  options: AgentOptions = {},
): Promise<string> {
  const suffix = uniqueSuffix();
  const result = await apiJson<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-notify-worker-${tag}-${suffix}`,
    name: `E2E 通知 Worker ${tag} ${suffix}`,
    systemPrompt: '你是通知验证智能体。收到消息后直接回复内容。',
    ...options,
  });
  assert(result.status === 201 && result.json !== null, `创建智能体失败：${result.status}`);
  created.agentIds.push(result.json.id);
  return result.json.id;
}

test('notifies the initiator when a real sandbox run times out', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await app.open('/agents');
  const businessId = await currentBusinessId(browser);
  const agentId = await createAgent(browser, 'timeout', { timeoutMs: 2_000 });
  await app.open(`/chat?agent=${agentId}`);
  await screen.getByRole('textbox', '消息').fill(`${SLOW_MARKER} 超时通知 ${uniqueSuffix()}`);
  await screen.getByRole('button', { name: '发送消息' }).tap();

  const run = await waitFor('run 进入终态', 90_000, async () => {
    const state = await fixture('notifications-worker', 'latestRun', agentId);
    return state !== null && TERMINAL_STATUSES.has(state.status) ? state : null;
  });
  expect(run.status).toBe('timeout');
  expect(run.error_kind).toBe('timeout');
  expect(run.sandbox_id).not.toBeNull();

  const sourceId = `run-failed:${run.id}`;
  const notification = await waitFor('运行超时通知', 15_000, () =>
    fixture('notifications-worker', 'notification', sourceId, businessId),
  );
  expect(notification).toMatchObject({
    business_id: businessId,
    kind: 'run_failed',
    title: '运行超时',
    link: `/runs/${run.id}`,
    source_id: sourceId,
  });
  expect(notification.body).toContain('超时');
});

test('runs an ask tool after the approver approves the sandbox hook request', {
  session: 'admin',
  timeout: 240_000,
}, async ({ app, screen, browser }) => {
  await app.open('/agents');
  const businessId = await currentBusinessId(browser);
  const { serverId, serverName } = await createApprovalServer(browser, 'hook');
  const agentId = await createAgent(browser, 'approval', { serverIds: [serverId] });
  const fullToolName = `mcp__${serverName}__approval-echo`;
  const hitsBefore = await approvalEchoHits();
  await app.open(`/chat?agent=${agentId}`);
  await screen
    .getByRole('textbox', '消息')
    .fill(`E2E-APPROVAL-TOOL ${fullToolName} ${uniqueSuffix()}`);
  await screen.getByRole('button', { name: '发送消息' }).tap();

  const approval = await waitFor('沙盒审批请求落库', 120_000, () =>
    fixture('notifications-worker', 'latestApproval', agentId),
  );
  expect(approval).toMatchObject({ server_id: serverId, tool_name: 'approval-echo' });
  expect(approval.approved_at).toBeNull();
  expect(approval.denied_at).toBeNull();
  const runId = approval.run_id;

  const sourceId = `approval:${runId}:${approval.id}`;
  const notification = await waitFor('审批通知', 15_000, () =>
    fixture('notifications-worker', 'notification', sourceId, businessId),
  );
  expect(notification).toMatchObject({
    business_id: businessId,
    kind: 'approval',
    link: `/runs/${runId}`,
    source_id: sourceId,
  });
  expect(await approvalEchoHits()).toBe(hitsBefore);

  const approved = await apiJson(browser, 'POST', `/api/runs/${runId}/approve`, {
    approvalId: approval.id,
  });
  expect(approved.status).toBe(200);

  const run = await waitFor('run 成功', 120_000, async () => {
    const state = await fixture('notifications-worker', 'runState', runId);
    return state !== null && TERMINAL_STATUSES.has(state.status) ? state : null;
  });
  expect(run.status).toBe('succeeded');
  expect(run.sandbox_id).not.toBeNull();

  expect(await approvalEchoHits()).toBeGreaterThan(hitsBefore);

  const results = await fixture('notifications-worker', 'toolResults', runId);
  const echoResult = results.find(
    (result) => typeof result.name === 'string' && result.name.endsWith('__approval-echo'),
  );
  assert(echoResult !== undefined, 'run 缺少 approval-echo 工具结果');
  const resultText =
    typeof echoResult.content === 'string'
      ? echoResult.content
      : JSON.stringify(echoResult.content);
  expect(resultText).toContain('"ok":true');
  expect(resultText).toContain('"echo":"approval"');
});

test('notifies the owner when a real run crosses the monthly budget', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await app.open('/agents');
  const businessId = await currentBusinessId(browser);
  const agentId = await createAgent(browser, 'budget', {
    monthlyBudgetUsd: 0.01,
    budgetAlertRatio: 0.001,
  });
  await app.open(`/chat?agent=${agentId}`);
  await screen.getByRole('textbox', '消息').fill(`${SLOW_MARKER} hello ${uniqueSuffix()}`);
  await screen.getByRole('button', { name: '发送消息' }).tap();

  const admitted = await waitFor('run 已准入', 30_000, () =>
    fixture('notifications-worker', 'latestRun', agentId),
  );
  await fixture('notifications-worker', 'seedSpentRun', agentId, businessId, '0.01');

  const run = await waitFor('run 成功', 90_000, async () => {
    const state = await fixture('notifications-worker', 'runState', admitted.id);
    return state !== null && TERMINAL_STATUSES.has(state.status) ? state : null;
  });
  expect(run.status).toBe('succeeded');

  const month = new Date().toISOString().slice(0, 7);
  const sourceId = `budget:${agentId}:${month}:exceeded`;
  const notification = await waitFor('预算超支通知', 15_000, () =>
    fixture('notifications-worker', 'notification', sourceId, businessId),
  );
  expect(notification).toMatchObject({
    business_id: businessId,
    kind: 'budget_alert',
    link: `/agents/${agentId}`,
    source_id: sourceId,
  });
  expect(notification.body).toContain('超过');
  expect(notification.body).toContain('月度预算');
  expect(notification.body).toContain('$0.01');
});
