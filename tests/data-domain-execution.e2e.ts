import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import {
  DATA_DOMAIN_SQL,
  DATA_DOMAIN_TOOL_MARKER,
  OUTPUT_WRITE_MARKER,
  requireExecutionStack,
} from './support/execution-stack.js';

/**
 * M4 真实执行栈验收：同一专家、同一数据域、同一条 SQL，两个真实登录用户的 run
 * 在 Docker 沙盒里真实调用 data_domain 的 run_sql；API 从 run 发起人身份注入
 * session properties，真实 WrenEngine 的 RLAC/CLAC 让两人得到不同行与列。
 *
 * 入口：E2E_WREN_RUNTIME_PYTHON=<venv python> bun run e2e:channel:execution
 */
const contract = await requireExecutionStack();
const appReady = contract.wrenRuntimeUrl !== undefined && contract.duckdbDir !== undefined;

const WREN_PROJECT_FILES: Record<string, string> = {
  'wren_project.yml': `schema_version: 2
name: e2e-data-domain
version: '1.0'
catalog: wren
schema: public
data_source: duckdb
`,
  'models/employees/metadata.yml': `name: employees
table_reference:
  catalog: warehouse
  schema: main
  table: employees
primary_key: id
columns:
  - name: id
    type: INTEGER
  - name: name
    type: VARCHAR
  - name: department
    type: VARCHAR
  - name: salary
    type: INTEGER
    column_level_access_control:
      name: salary_clearance
      required_properties:
        - name: clearance
          required: true
      operator: GREATER_THAN_OR_EQUALS
      threshold: "3"
  - name: region
    type: VARCHAR
row_level_access_controls:
  - name: dept_filter
    required_properties:
      - name: department
        required: true
    condition: "department = @department"
`,
};

interface RunEvent {
  type: string;
  content?: unknown;
  status?: string;
  [key: string]: unknown;
}

interface RunDetail {
  run: {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    error: string | null;
  };
  steps: Array<{
    kind: 'user' | 'assistant' | 'tool';
    name?: string | null;
    content?: unknown;
    result?: unknown;
  }>;
}

interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${contract.appUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .filter((value): value is string => value !== undefined && value !== '')
    .join('; ');
  if (response.status !== 200 || !cookie.includes('agentport_token=')) {
    throw new Error(`登录 ${username} 失败：HTTP ${response.status}`);
  }
  return cookie;
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await browserFetch(browser, method, path, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${path} 返回 ${response.status}：${response.text}`);
  }
  return (response.text === '' ? null : JSON.parse(response.text)) as T;
}

async function api<T>(cookie: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${contract.appUrl}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${path} 返回 ${response.status}：${text}`);
  }
  return (text === '' ? null : JSON.parse(text)) as T;
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(
    `等待超时（${timeoutMs}ms）：${label}${lastError === undefined ? '' : `；最后错误：${String(lastError)}`}`,
  );
}

async function collectRunEvents(cookie: string, runId: string): Promise<RunEvent[]> {
  const response = await fetch(`${contract.appUrl}/api/chat/${runId}/events`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new Error(`订阅 run 事件失败：HTTP ${response.status}`);
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice(6)) as RunEvent];
      } catch {
        return [];
      }
    });
}

function parseQueryResult(value: unknown): QueryResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const parsed = JSON.parse(text) as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) {
    throw new Error(`工具结果不是 columns/rows 结构：${text.slice(0, 500)}`);
  }
  return { columns: parsed.columns as string[], rows: parsed.rows as unknown[][] };
}

function toolInputOf(step: RunDetail['steps'][number]): Record<string, unknown> {
  return typeof step.content === 'string'
    ? (JSON.parse(step.content) as Record<string, unknown>)
    : ((step.content ?? {}) as Record<string, unknown>);
}

async function runOnce(
  cookie: string,
  agentId: string,
  message: string,
  conversationId?: string,
): Promise<{ runId: string; conversationId: string; events: RunEvent[]; detail: RunDetail }> {
  // 202 的 HTTP 响应体就是 oRPC detailed 输出里的 body。
  const started = await api<{ runId: string; conversationId: string }>(
    cookie,
    'POST',
    '/api/chat',
    {
      agentId,
      message,
      ...(conversationId === undefined ? {} : { conversationId }),
    },
  );
  const runId = started.runId;
  // 立刻订阅实时事件，避免跑完后只剩终态回放。
  const events = collectRunEvents(cookie, runId);
  const detail = await waitFor('run 到达终态', 240_000, async () => {
    const current = await api<RunDetail>(cookie, 'GET', `/api/runs/${runId}`);
    return current.run.status === 'queued' || current.run.status === 'running' ? null : current;
  });
  return { runId, conversationId: started.conversationId, events: await events, detail };
}

type RunOnce = Awaited<ReturnType<typeof runOnce>>;

function assertRunWithTool(outcome: RunOnce) {
  const warnings = outcome.events
    .filter((event) => event.type === 'run_warning')
    .map((event) => String(event.message));
  if (outcome.detail.run.status !== 'succeeded') {
    throw new Error(
      `run 未成功：${JSON.stringify(outcome.detail.run)}；warnings=${JSON.stringify(warnings)}`,
    );
  }
  const finished = outcome.events.find((event) => event.type === 'run_finished');
  if (finished?.status !== 'succeeded') {
    throw new Error(`实时事件终态不是 succeeded：${JSON.stringify(finished)}`);
  }
  const steps = outcome.detail.steps.filter(
    (step) =>
      step.kind === 'tool' &&
      typeof step.name === 'string' &&
      step.name.endsWith('__run_sql') &&
      step.result !== undefined,
  );
  if (steps.length !== 1) {
    throw new Error(
      `run 里应恰好有一条 run_sql 工具结果，实际 ${steps.length} 条；warnings=${JSON.stringify(
        warnings,
      )}；steps=${JSON.stringify(
        outcome.detail.steps.map((item) => ({ kind: item.kind, name: item.name })),
      )}`,
    );
  }
  const step = steps[0];
  if (step === undefined) throw new Error('run_sql 工具步骤缺失');
  const input = toolInputOf(step);
  if (input.sql !== DATA_DOMAIN_SQL) {
    throw new Error(`模型传入的 SQL 不是约定值：${JSON.stringify(input)}`);
  }
  if ('properties' in input || 'sessionProperties' in input) {
    throw new Error(`模型不应也不能传 session properties：${JSON.stringify(input)}`);
  }
  const persisted = parseQueryResult(step.result);
  const event = outcome.events.find(
    (candidate) =>
      candidate.type === 'tool_result' &&
      typeof candidate.content === 'string' &&
      candidate.content.includes('"columns"'),
  );
  if (event?.content === undefined) throw new Error('实时事件里没有 run_sql 的 tool_result');
  const live = parseQueryResult(event.content);
  if (JSON.stringify(live) !== JSON.stringify(persisted)) {
    throw new Error(
      `实时事件与持久化工具结果不一致：live=${JSON.stringify(live)} persisted=${JSON.stringify(persisted)}`,
    );
  }
  return { toolName: step.name, persisted };
}

test('the same SQL yields identity-scoped rows and columns for two real users', {
  session: 'admin',
  timeout: 600_000,
}, async ({ app, screen, browser }) => {
  test.skip(
    !appReady,
    '需要 E2E_WREN_RUNTIME_PYTHON（或 WREN_RUNTIME_TEST_PYTHON）启动真实 Wren 运行时',
  );
  await app.open('/');
  const duckdbDir = contract.duckdbDir ?? '';
  const suffix = randomUUID().slice(0, 8);

  const domain = await apiJson<{ id: string; slug: string }>(browser, 'POST', '/api/data-domains', {
    name: `E2E 数据域 ${suffix}`,
    slug: `e2e-dd-${suffix}`,
    datasource: 'duckdb',
    connection: { url: duckdbDir, format: 'duckdb' },
  });
  const queued = await apiJson<{ id: string; status: string }>(
    browser,
    'POST',
    `/api/data-domains/${domain.id}/versions`,
    { projectFiles: WREN_PROJECT_FILES },
  );
  const version = await waitFor('数据域版本构建', 240_000, async () => {
    const versions = await apiJson<Array<{ id: string; status: string }>>(
      browser,
      'GET',
      `/api/data-domains/${domain.id}/versions`,
    );
    const row = versions.find((candidate) => candidate.id === queued.id);
    return row !== undefined && (row.status === 'ready' || row.status === 'failed') ? row : null;
  });
  if (version.status !== 'ready') {
    const detail = await apiJson<{ logTail: string }>(
      browser,
      'GET',
      `/api/data-domains/${domain.id}/versions/${queued.id}`,
    );
    throw new Error(`数据域构建失败：${detail.logTail.slice(-2000)}`);
  }
  await apiJson(browser, 'PUT', `/api/data-domains/${domain.id}/online-version`, {
    versionId: version.id,
  });

  const servers = await apiJson<Array<{ id: string; name: string; kind: string }>>(
    browser,
    'GET',
    '/api/servers',
  );
  const server = servers.find(
    (candidate) => candidate.kind === 'data_domain' && candidate.name === `dd-${domain.slug}`,
  );
  if (server === undefined) throw new Error(`找不到数据域托管 MCP：dd-${domain.slug}`);
  const toolName = `mcp__dd-${domain.slug}__run_sql`;

  const accountSuffix = randomUUID().slice(0, 8);
  const userA = {
    businessId: `e2e-dd-hr-${accountSuffix}`,
    username: `e2e_dd_hr_${accountSuffix}`,
    password: `E2e-dd-hr-${accountSuffix}`,
  };
  const userB = {
    businessId: `e2e-dd-sales-${accountSuffix}`,
    username: `e2e_dd_sales_${accountSuffix}`,
    password: `E2e-dd-sales-${accountSuffix}`,
  };
  for (const user of [userA, userB]) {
    await apiJson(browser, 'POST', '/api/accounts', {
      businessId: user.businessId,
      username: user.username,
      name: `E2E ${user.username}`,
      password: user.password,
    });
  }

  const agent = await apiJson<{ id: string; serverIds?: string[] }>(
    browser,
    'POST',
    '/api/agents',
    {
      slug: `e2e-dd-agent-${suffix}`,
      name: `E2E 数据域专家 ${suffix}`,
      serverIds: [server.id],
    },
  );
  if (!agent.serverIds?.includes(server.id)) {
    throw new Error(`专家未绑定数据域 MCP：${JSON.stringify(agent)}`);
  }
  const workspace = await apiJson<{ mcpJson: string }>(
    browser,
    'GET',
    `/api/agents/${agent.id}/files?reveal=1`,
  );
  if (!workspace.mcpJson.includes(`"dd-${domain.slug}"`)) {
    throw new Error(`工作区 .mcp.json 未包含数据域 MCP：${workspace.mcpJson}`);
  }
  for (const user of [userA, userB]) {
    await apiJson(browser, 'PUT', `/api/agents/${agent.id}/members/${user.businessId}`, {
      canUse: true,
      canMaintain: false,
    });
  }

  await apiJson(browser, 'PUT', `/api/data-domains/${domain.id}/identities/${userA.businessId}`, {
    properties: { department: "'HR'", clearance: '5' },
  });
  await apiJson(browser, 'PUT', `/api/data-domains/${domain.id}/identities/${userB.businessId}`, {
    properties: { department: "'Sales'", clearance: '1' },
  });

  const cookieA = await login(userA.username, userA.password);
  const cookieB = await login(userB.username, userB.password);
  const message = `${DATA_DOMAIN_TOOL_MARKER} ${OUTPUT_WRITE_MARKER} ${toolName} 请查询员工名单`;
  const outcomeA = await runOnce(cookieA, agent.id, message);
  const a = assertRunWithTool(outcomeA);
  const outcomeB = await runOnce(cookieB, agent.id, message);
  const b = assertRunWithTool(outcomeB);
  const runIdA = outcomeA.runId;
  const runIdB = outcomeB.runId;

  if (a.toolName !== toolName || b.toolName !== toolName) {
    throw new Error(`工具名不符：${a.toolName} / ${b.toolName}`);
  }
  const expectedA = [
    [1, 'Alice', 'HR', 90000, 'north'],
    [2, 'Bob', 'HR', 80000, 'south'],
  ];
  const expectedB = [
    [3, 'Carol', 'Sales', 'north'],
    [4, 'Dave', 'Sales', 'south'],
    [5, 'Eve', 'Sales', 'north'],
  ];
  if (JSON.stringify(a.persisted.rows) !== JSON.stringify(expectedA)) {
    throw new Error(`HR 用户返回的行不符：${JSON.stringify(a.persisted.rows)}`);
  }
  if (JSON.stringify(b.persisted.rows) !== JSON.stringify(expectedB)) {
    throw new Error(`Sales 用户返回的行不符：${JSON.stringify(b.persisted.rows)}`);
  }
  if (!a.persisted.columns.includes('salary')) {
    throw new Error(`高 clearance 用户应看到 salary 列：${JSON.stringify(a.persisted.columns)}`);
  }
  if (b.persisted.columns.includes('salary')) {
    throw new Error(`低 clearance 用户不应看到 salary 列：${JSON.stringify(b.persisted.columns)}`);
  }
  if (JSON.stringify(a.persisted.rows) === JSON.stringify(b.persisted.rows)) {
    throw new Error('两个用户得到了相同行，身份隔离未生效');
  }

  const logsA = await apiJson<{
    items: Array<{ runId: string; actorBusinessId: string | null; status: string }>;
  }>(
    browser,
    'GET',
    `/api/data-domains/${domain.id}/query-logs?runId=${encodeURIComponent(runIdA)}`,
  );
  const logsB = await apiJson<{
    items: Array<{ runId: string; actorBusinessId: string | null; status: string }>;
  }>(
    browser,
    'GET',
    `/api/data-domains/${domain.id}/query-logs?runId=${encodeURIComponent(runIdB)}`,
  );
  if (
    logsA.items.length === 0 ||
    logsA.items.some((item) => item.actorBusinessId !== userA.businessId)
  ) {
    throw new Error(`HR 用户的查询日志身份不符：${JSON.stringify(logsA.items)}`);
  }
  if (
    logsB.items.length === 0 ||
    logsB.items.some((item) => item.actorBusinessId !== userB.businessId)
  ) {
    throw new Error(`Sales 用户的查询日志身份不符：${JSON.stringify(logsB.items)}`);
  }
  if (
    logsA.items.some((item) => item.status !== 'ok') ||
    logsB.items.some((item) => item.status !== 'ok')
  ) {
    throw new Error(`查询日志状态不是 ok：${JSON.stringify([logsA.items, logsB.items])}`);
  }

  const artifactPath = 'dd-report.md';
  const outputsUrl = `/api/conversations/${outcomeA.conversationId}/outputs`;
  const outputsA = await api<{ items: Array<{ runId: string; path: string }> }>(
    cookieA,
    'GET',
    outputsUrl,
  );
  if (!outputsA.items.some((item) => item.runId === runIdA && item.path === artifactPath)) {
    throw new Error(`A 的成果列表里没有 ${artifactPath}：${JSON.stringify(outputsA.items)}`);
  }
  const downloadUrl = `${outputsUrl}/${runIdA}/download?path=${encodeURIComponent(artifactPath)}`;
  const ownDownload = await fetch(`${contract.appUrl}${downloadUrl}`, {
    headers: { cookie: cookieA },
  });
  const ownText = await ownDownload.text();
  if (ownDownload.status !== 200 || !ownText.includes('Alice') || ownText.includes('Carol')) {
    throw new Error(
      `A 读取自身数据域成果不符：HTTP ${ownDownload.status} ${ownText.slice(0, 500)}`,
    );
  }
  const foreignDownload = await fetch(`${contract.appUrl}${downloadUrl}`, {
    headers: { cookie: cookieB },
  });
  if (foreignDownload.status !== 404) {
    throw new Error(`B 读取 A 的数据域成果应 404，实际 ${foreignDownload.status}`);
  }
  const foreignList = await fetch(`${contract.appUrl}${outputsUrl}`, {
    headers: { cookie: cookieB },
  });
  if (foreignList.status !== 404) {
    throw new Error(`B 列出 A 的成果应 404，实际 ${foreignList.status}`);
  }

  const shareUrl = `/api/conversations/${outcomeA.conversationId}/output-shares`;
  const deniedShare = await fetch(`${contract.appUrl}${shareUrl}`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json' },
    body: JSON.stringify({ runId: runIdA, path: artifactPath }),
  });
  const deniedBody = (await deniedShare.json()) as { code?: string };
  if (deniedShare.status !== 403 || deniedBody.code !== 'FORBIDDEN') {
    throw new Error(
      `数据域成果公开分享应被拒绝，实际 HTTP ${deniedShare.status}：${JSON.stringify(deniedBody)}`,
    );
  }

  const followup = await runOnce(
    cookieA,
    agent.id,
    `${OUTPUT_WRITE_MARKER} 在同一个会话里再写一份后续报告`,
    outcomeA.conversationId,
  );
  if (followup.detail.run.status !== 'succeeded') {
    throw new Error(`同一会话的后续 run 未成功：${JSON.stringify(followup.detail.run)}`);
  }
  const followupRunSql = followup.detail.steps.filter(
    (step) =>
      step.kind === 'tool' && typeof step.name === 'string' && step.name.endsWith('__run_sql'),
  );
  if (followupRunSql.length > 0) {
    throw new Error(`后续 run 不应再调用 run_sql，实际 ${followupRunSql.length} 次`);
  }
  const inheritedDownload = await fetch(
    `${contract.appUrl}${outputsUrl}/${followup.runId}/download?path=${encodeURIComponent(artifactPath)}`,
    { headers: { cookie: cookieA } },
  );
  const inheritedText = await inheritedDownload.text();
  if (
    inheritedDownload.status !== 200 ||
    !inheritedText.includes('Alice') ||
    inheritedText.includes('Carol')
  ) {
    throw new Error(
      `后续 run 继承的数据域成果读取不符：HTTP ${inheritedDownload.status} ${inheritedText.slice(0, 500)}`,
    );
  }
  const inheritedShare = await fetch(`${contract.appUrl}${shareUrl}`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json' },
    body: JSON.stringify({ runId: followup.runId, path: artifactPath }),
  });
  const inheritedBody = (await inheritedShare.json()) as { code?: string };
  if (inheritedShare.status !== 403 || inheritedBody.code !== 'FORBIDDEN') {
    throw new Error(
      `后续 run 继承成果的公开分享应被拒绝，实际 HTTP ${inheritedShare.status}：${JSON.stringify(inheritedBody)}`,
    );
  }

  const plainAgent = await apiJson<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-plain-agent-${suffix}`,
    name: `E2E 普通专家 ${suffix}`,
  });
  await apiJson(browser, 'PUT', `/api/agents/${plainAgent.id}/members/${userA.businessId}`, {
    canUse: true,
    canMaintain: false,
  });
  const plainOutcome = await runOnce(
    cookieA,
    plainAgent.id,
    `${OUTPUT_WRITE_MARKER} 写一份普通报告`,
  );
  if (plainOutcome.detail.run.status !== 'succeeded') {
    throw new Error(`普通 run 未成功：${JSON.stringify(plainOutcome.detail.run)}`);
  }
  const plainOutputsUrl = `/api/conversations/${plainOutcome.conversationId}/outputs`;
  const plainOutputs = await api<{ items: Array<{ runId: string; path: string }> }>(
    cookieA,
    'GET',
    plainOutputsUrl,
  );
  const plainArtifact = plainOutputs.items.find(
    (item) => item.runId === plainOutcome.runId && item.path === 'normal-report.md',
  );
  if (plainArtifact === undefined) {
    throw new Error(
      `普通 run 的成果列表里没有 normal-report.md：${JSON.stringify(plainOutputs.items)}`,
    );
  }
  const plainShareUrl = `/api/conversations/${plainOutcome.conversationId}/output-shares`;
  const plainShare = await fetch(`${contract.appUrl}${plainShareUrl}`, {
    method: 'POST',
    headers: { cookie: cookieA, 'content-type': 'application/json' },
    body: JSON.stringify({ runId: plainOutcome.runId, path: plainArtifact.path }),
  });
  const created = (await plainShare.json()) as { id?: string; urlPath?: string };
  if (plainShare.status !== 201 || created.id === undefined || created.urlPath === undefined) {
    throw new Error(
      `普通成果分享应创建成功，实际 HTTP ${plainShare.status}：${JSON.stringify(created)}`,
    );
  }
  const publicToken = created.urlPath.split('#')[1] ?? '';
  const publicMeta = await fetch(`${contract.appUrl}/api/public/output-shares/${created.id}`, {
    headers: { authorization: `Bearer ${publicToken}` },
  });
  if (publicMeta.status !== 200) {
    throw new Error(`普通成果公开页应可读，实际 HTTP ${publicMeta.status}`);
  }
  const publicContent = await fetch(
    `${contract.appUrl}/api/public/output-shares/${created.id}/content`,
    { headers: { authorization: `Bearer ${publicToken}` } },
  );
  const publicContentBody = (await publicContent.json()) as { content?: string };
  if (publicContent.status !== 200 || !publicContentBody.content?.includes('E2E normal output')) {
    throw new Error(
      `普通成果公开正文应可读，实际 HTTP ${publicContent.status}：${JSON.stringify(publicContentBody)}`,
    );
  }

  // 历史重载直接读取真实 run 的持久化工具结果，用 M2c 表格/图表呈现。
  await app.open(`/chat?conversation=${outcomeA.conversationId}`);
  await expect(screen.getByText('执行过程').first()).toBeVisible({ timeout: 60_000 });
  await screen.getByText('执行过程').first().tap();
  await expect(screen.getByText(toolName)).toBeVisible({ timeout: 60_000 });
  await screen.getByText(toolName).tap();
  await expect(screen.getByText('Alice')).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByText('salary')).toBeVisible();
  await screen.getByRole('tab', { name: '图表' }).tap();
  await expect(screen.getByText('聚合请在查询 SQL 中完成')).toBeVisible({ timeout: 30_000 });

  console.log(
    JSON.stringify({
      dataDomainRun: {
        domainId: domain.id,
        agentId: agent.id,
        runA: { runId: runIdA, businessId: userA.businessId, ...a.persisted },
        runB: { runId: runIdB, businessId: userB.businessId, ...b.persisted },
      },
    }),
  );
});
