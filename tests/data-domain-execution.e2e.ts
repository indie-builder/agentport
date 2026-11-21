import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect, type Locator } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import {
  DATA_DOMAIN_SQL,
  DATA_DOMAIN_TOOL_MARKER,
  OUTPUT_WRITE_MARKER,
  requireExecutionStack,
} from './support/execution-stack.js';

const contract = await requireExecutionStack();
const appReady = contract.wrenRuntimeUrl !== undefined && contract.duckdbDir !== undefined;
const SHOT_DIR = '/tmp/agentport-e2e-data-domain-charts';

function keepShot(directory: string, source: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const target = join(directory, name);
  copyFileSync(source, target);
  return target;
}

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
  - name: bonus
    type: INTEGER
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
    initiatedBy: string | null;
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

interface QueryLogItem {
  id: string;
  dataDomainId: string;
  versionId: string | null;
  serverId: string;
  runId: string;
  actorBusinessId: string | null;
  sqlSummary: string;
  rowCount: number | null;
  status: 'ok' | 'error';
  durationMs: number;
  createdAt: string;
}

interface AuditItem {
  id: string;
  actor: string;
  actorKind: string;
  subjectBusinessId: string | null;
  action: string;
  target: string | null;
  status: string;
  durationMs: number | null;
  requestId: string | null;
  inputDigest: string | null;
  createdAt: string;
}

const CREDENTIAL_SENTINELS = [
  'password',
  'connectionEncrypted',
  'connection_encrypted',
  'APP_SECRET',
  'postgres://',
  'postgresql://',
  'duckdb://',
  'profiles.yml',
  'warehouse.duckdb',
];

const A_SIDE_NAMES = ['Alice', 'Bob'];
const B_SIDE_NAMES = ['Carol', 'Dave', 'Eve'];
const A_SIDE_SALARIES = [90000, 80000];
const B_SIDE_SALARIES = [70000, 60000, 95000];

function assertNoSentinels(label: string, text: string, sentinels: string[]): string[] {
  const checked = sentinels.filter((value) => value.length > 0);
  const hits = checked.filter((value) => text.includes(value));
  if (hits.length > 0) throw new Error(`${label} 出现禁用哨兵：${JSON.stringify(hits)}`);
  return checked;
}

function assertNoSecretLeak(label: string, text: string, secrets: string[]): number {
  const hits = secrets.filter((value) => value.length > 0 && text.includes(value));
  if (hits.length > 0) throw new Error(`${label} 命中账户口令 ${hits.length} 处`);
  return secrets.length;
}

function assertNoNumbers(label: string, text: string, numbers: number[]): number[] {
  const hits = numbers.filter((value) =>
    new RegExp(`(?<![0-9A-Za-z])${value}(?![0-9A-Za-z])`).test(text),
  );
  if (hits.length > 0) throw new Error(`${label} 出现跨身份数值：${JSON.stringify(hits)}`);
  return numbers;
}

function resultJsonOf(text: string): QueryResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`下载内容里没有 JSON 结果：${text.slice(0, 300)}`);
  return parseQueryResult(text.slice(start, end + 1));
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
    [1, 'Alice', 'HR', 90000, 'north', 5000],
    [2, 'Bob', 'HR', 80000, 'south', 4000],
  ];
  const expectedB = [
    [3, 'Carol', 'Sales', 'north', 3000],
    [4, 'Dave', 'Sales', 'south', 2000],
    [5, 'Eve', 'Sales', 'north', 1000],
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
  if (!a.persisted.columns.includes('bonus') || !b.persisted.columns.includes('bonus')) {
    throw new Error(
      `公开数值列 bonus 应对两个用户都可见：A=${JSON.stringify(a.persisted.columns)} B=${JSON.stringify(b.persisted.columns)}`,
    );
  }
  if (JSON.stringify(a.persisted.rows) === JSON.stringify(b.persisted.rows)) {
    throw new Error('两个用户得到了相同行，身份隔离未生效');
  }

  const logsA = await apiJson<{ items: QueryLogItem[] }>(
    browser,
    'GET',
    `/api/data-domains/${domain.id}/query-logs?runId=${encodeURIComponent(runIdA)}`,
  );
  const logsB = await apiJson<{ items: QueryLogItem[] }>(
    browser,
    'GET',
    `/api/data-domains/${domain.id}/query-logs?runId=${encodeURIComponent(runIdB)}`,
  );
  const verifyLog = (
    label: string,
    items: QueryLogItem[],
    businessId: string,
    runId: string,
    expectedRows: number,
  ): QueryLogItem => {
    if (items.length !== 1) {
      throw new Error(`${label} 用户的查询日志应恰好 1 条：${JSON.stringify(items)}`);
    }
    const item = items[0];
    if (item === undefined) throw new Error(`${label} 用户的查询日志缺失`);
    if (
      item.dataDomainId !== domain.id ||
      item.serverId !== server.id ||
      item.runId !== runId ||
      item.actorBusinessId !== businessId
    ) {
      throw new Error(`${label} 用户的查询日志归属不符：${JSON.stringify(item)}`);
    }
    if (item.versionId !== version.id) {
      throw new Error(
        `${label} 用户的查询日志版本不是在线版本 ${version.id}：${JSON.stringify(item)}`,
      );
    }
    if (item.rowCount !== expectedRows || item.status !== 'ok') {
      throw new Error(`${label} 用户的查询日志行数或状态不符：${JSON.stringify(item)}`);
    }
    if (item.sqlSummary !== DATA_DOMAIN_SQL) {
      throw new Error(`${label} 用户的查询日志 SQL 摘要不符：${JSON.stringify(item.sqlSummary)}`);
    }
    return item;
  };
  const logA = verifyLog('HR', logsA.items, userA.businessId, runIdA, expectedA.length);
  const logB = verifyLog('Sales', logsB.items, userB.businessId, runIdB, expectedB.length);

  const artifactPath = 'dd-report.md';
  const outputsUrl = `/api/conversations/${outcomeA.conversationId}/outputs`;
  const outputsA = await api<{
    items: Array<{ runId: string; path: string; size: number; sha256: string }>;
  }>(cookieA, 'GET', outputsUrl);
  const artifactA = outputsA.items.find(
    (item) => item.runId === runIdA && item.path === artifactPath,
  );
  if (artifactA === undefined) {
    throw new Error(`A 的成果列表里没有 ${artifactPath}：${JSON.stringify(outputsA.items)}`);
  }
  const verifyDownload = (
    label: string,
    item: { size: number; sha256: string },
    bytes: Buffer,
    expectedColumns: string[],
    expectedRows: unknown[][],
  ) => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== item.sha256 || bytes.length !== item.size) {
      throw new Error(
        `${label} 下载字节与成果清单元数据不符：sha=${digest}/${item.sha256} size=${bytes.length}/${item.size}`,
      );
    }
    const text = bytes.toString('utf8');
    const result = resultJsonOf(text);
    if (
      JSON.stringify(result.columns) !== JSON.stringify(expectedColumns) ||
      JSON.stringify(result.rows) !== JSON.stringify(expectedRows)
    ) {
      throw new Error(`${label} 下载正文不是被授权过滤后的结果：${text.slice(0, 500)}`);
    }
    return { digest, size: bytes.length, text, result };
  };
  const downloadUrl = `${outputsUrl}/${runIdA}/download?path=${encodeURIComponent(artifactPath)}`;
  const ownDownload = await fetch(`${contract.appUrl}${downloadUrl}`, {
    headers: { cookie: cookieA },
  });
  const ownBytes = Buffer.from(await ownDownload.arrayBuffer());
  if (ownDownload.status !== 200) {
    throw new Error(`A 下载自身数据域成果失败：HTTP ${ownDownload.status}`);
  }
  const ownArtifact = verifyDownload('A', artifactA, ownBytes, a.persisted.columns, expectedA);
  const ownText = ownArtifact.text;
  if (!ownText.includes('Alice') || ownText.includes('Carol')) {
    throw new Error(`A 的下载正文身份过滤不符：${ownText.slice(0, 500)}`);
  }
  const preview = await api<{ file: { sha256: string; size: number }; content: string }>(
    cookieA,
    'GET',
    `${outputsUrl}/${runIdA}/content?path=${encodeURIComponent(artifactPath)}`,
  );
  if (
    preview.file.sha256 !== artifactA.sha256 ||
    preview.file.size !== artifactA.size ||
    preview.content !== ownText
  ) {
    throw new Error(
      `A 的内容预览与下载不同源：preview=${JSON.stringify({ sha: preview.file.sha256, size: preview.file.size, length: preview.content.length })} download=${JSON.stringify({ sha: artifactA.sha256, size: artifactA.size, length: ownText.length })}`,
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

  const outputsBUrl = `/api/conversations/${outcomeB.conversationId}/outputs`;
  const outputsB = await api<{
    items: Array<{ runId: string; path: string; size: number; sha256: string }>;
  }>(cookieB, 'GET', outputsBUrl);
  const artifactB = outputsB.items.find(
    (item) => item.runId === runIdB && item.path === artifactPath,
  );
  if (artifactB === undefined) {
    throw new Error(`B 的成果列表里没有 ${artifactPath}：${JSON.stringify(outputsB.items)}`);
  }
  const downloadB = await fetch(
    `${contract.appUrl}${outputsBUrl}/${runIdB}/download?path=${encodeURIComponent(artifactPath)}`,
    { headers: { cookie: cookieB } },
  );
  const bytesB = Buffer.from(await downloadB.arrayBuffer());
  if (downloadB.status !== 200) {
    throw new Error(`B 下载自身数据域成果失败：HTTP ${downloadB.status}`);
  }
  const ownArtifactB = verifyDownload('B', artifactB, bytesB, b.persisted.columns, expectedB);
  if (!ownArtifactB.text.includes('Carol') || ownArtifactB.text.includes('Alice')) {
    throw new Error(`B 的下载正文身份过滤不符：${ownArtifactB.text.slice(0, 500)}`);
  }

  const runDetailA = await api<RunDetail>(cookieA, 'GET', `/api/runs/${runIdA}`);
  const runDetailB = await api<RunDetail>(cookieB, 'GET', `/api/runs/${runIdB}`);
  if (runDetailA.run.initiatedBy !== userA.businessId) {
    throw new Error(`A 的 run 发起人不符：${JSON.stringify(runDetailA.run)}`);
  }
  if (runDetailB.run.initiatedBy !== userB.businessId) {
    throw new Error(`B 的 run 发起人不符：${JSON.stringify(runDetailB.run)}`);
  }
  if (
    runDetailA.run.initiatedBy !== logA.actorBusinessId ||
    runDetailB.run.initiatedBy !== logB.actorBusinessId
  ) {
    throw new Error('run 发起人与 query-log 身份不一致');
  }

  const auditFilter = `action=${encodeURIComponent('data_domain.query')}&target=${encodeURIComponent(server.id)}`;
  const audit = await apiJson<{ items: AuditItem[]; nextCursor: string | null }>(
    browser,
    'GET',
    `/api/audit?${auditFilter}&limit=200`,
  );
  const auditA = audit.items.find((item) => item.actor === runIdA);
  const auditB = audit.items.find((item) => item.actor === runIdB);
  if (audit.items.length !== 2 || audit.nextCursor !== null) {
    throw new Error(`审计列表应恰好两条且无后续页：${JSON.stringify(audit)}`);
  }
  if (auditA === undefined || auditB === undefined) {
    throw new Error(`审计列表缺少两个 run 的 data_domain.query：${JSON.stringify(audit.items)}`);
  }
  const expectedDigest = (rowCount: number) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          dataDomainId: domain.id,
          versionId: version.id,
          sql: DATA_DOMAIN_SQL,
          rowCount,
          status: 'success',
        }),
      )
      .digest('hex')
      .slice(0, 32);
  for (const [label, item, rowCount, runId] of [
    ['A', auditA, expectedA.length, runIdA],
    ['B', auditB, expectedB.length, runIdB],
  ] as const) {
    if (
      item.action !== 'data_domain.query' ||
      item.actorKind !== 'agent' ||
      item.target !== server.id ||
      item.status !== 'ok' ||
      item.inputDigest !== expectedDigest(rowCount)
    ) {
      throw new Error(
        `${label} 的审计摘要与 query-log 不一致：${JSON.stringify(item)} expectedDigest=${expectedDigest(rowCount)}`,
      );
    }
    if (item.actor !== runId) throw new Error(`${label} 的审计 actor 不是 runId：${item.actor}`);
  }

  const verified = await apiJson<{
    ok: boolean;
    checked: number;
    brokenSeq: string | null;
    nextAfterSeq: number | null;
    complete: boolean;
  }>(browser, 'GET', '/api/audit/verify?limit=5000');
  if (
    !verified.ok ||
    verified.brokenSeq !== null ||
    verified.checked === 0 ||
    !verified.complete ||
    verified.nextAfterSeq !== null
  ) {
    throw new Error(`审计哈希链校验未通过：${JSON.stringify(verified)}`);
  }

  const exportResponse = await browserFetch(
    browser,
    'GET',
    `/api/audit/export?${auditFilter}&limit=200`,
  );
  if (exportResponse.status !== 200) {
    throw new Error(`审计导出失败：HTTP ${exportResponse.status} ${exportResponse.text}`);
  }
  const exportBody = JSON.parse(exportResponse.text) as {
    format: string;
    exportedAt: string;
    items: AuditItem[];
  };
  if (
    exportBody.format !== 'agentport/audit@1' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(exportBody.exportedAt)
  ) {
    throw new Error(`审计导出格式不符：${JSON.stringify(exportBody).slice(0, 300)}`);
  }
  const listIds = audit.items.map((item) => item.id).sort();
  const exportIds = exportBody.items.map((item) => item.id).sort();
  if (
    new Set(exportIds).size !== exportIds.length ||
    JSON.stringify(exportIds) !== JSON.stringify(listIds)
  ) {
    throw new Error(
      `审计导出与列表不一一对应：list=${JSON.stringify(listIds)} export=${JSON.stringify(exportIds)}`,
    );
  }
  const allowedExportKeys = [
    'action',
    'actor',
    'actorKind',
    'createdAt',
    'detail',
    'detailType',
    'durationMs',
    'id',
    'inputDigest',
    'requestId',
    'status',
    'subjectBusinessId',
    'target',
  ];
  const listById = new Map(audit.items.map((item) => [item.id, item]));
  for (const item of exportBody.items) {
    const keys = Object.keys(item).sort();
    if (JSON.stringify(keys) !== JSON.stringify(allowedExportKeys)) {
      throw new Error(`审计导出条目字段超出清单：${JSON.stringify(keys)}`);
    }
    if (![runIdA, runIdB].includes(item.actor)) {
      throw new Error(`审计导出出现无关 actor：${item.actor}`);
    }
    const listed = listById.get(item.id);
    if (listed === undefined || JSON.stringify(item) !== JSON.stringify(listed)) {
      throw new Error(`审计导出条目与列表不一致：${JSON.stringify({ exported: item, listed })}`);
    }
  }

  const credentialSentinels = CREDENTIAL_SENTINELS;
  const accountSecrets = [userA.password, userB.password];
  const logsAJson = JSON.stringify(logsA);
  const logsBJson = JSON.stringify(logsB);
  const sentinelEvidence = {
    downloadA: {
      credentials: assertNoSentinels('A 下载字节', ownText, credentialSentinels),
      accountPasswords: assertNoSecretLeak('A 下载字节', ownText, accountSecrets),
      foreignNames: assertNoSentinels('A 下载字节', ownText, B_SIDE_NAMES),
      foreignSalaries: assertNoNumbers('A 下载字节', ownText, B_SIDE_SALARIES),
    },
    downloadB: {
      credentials: assertNoSentinels('B 下载字节', ownArtifactB.text, credentialSentinels),
      accountPasswords: assertNoSecretLeak('B 下载字节', ownArtifactB.text, accountSecrets),
      foreignNames: assertNoSentinels('B 下载字节', ownArtifactB.text, A_SIDE_NAMES),
      foreignSalaries: assertNoNumbers('B 下载字节', ownArtifactB.text, A_SIDE_SALARIES),
      ownSalaries: assertNoNumbers('B 下载字节', ownArtifactB.text, B_SIDE_SALARIES),
      restrictedColumns: assertNoSentinels('B 下载字节', ownArtifactB.text, ['salary']),
    },
    queryLogsA: {
      credentials: assertNoSentinels('A query-logs', logsAJson, credentialSentinels),
      accountPasswords: assertNoSecretLeak('A query-logs', logsAJson, accountSecrets),
      foreignNames: assertNoSentinels('A query-logs', logsAJson, B_SIDE_NAMES),
      foreignSalaries: assertNoNumbers('A query-logs', logsAJson, B_SIDE_SALARIES),
    },
    queryLogsB: {
      credentials: assertNoSentinels('B query-logs', logsBJson, credentialSentinels),
      accountPasswords: assertNoSecretLeak('B query-logs', logsBJson, accountSecrets),
      foreignNames: assertNoSentinels('B query-logs', logsBJson, A_SIDE_NAMES),
      foreignSalaries: assertNoNumbers('B query-logs', logsBJson, A_SIDE_SALARIES),
      restrictedColumns: assertNoSentinels('B query-logs', logsBJson, ['salary']),
    },
    auditExport: {
      credentials: assertNoSentinels('审计导出', exportResponse.text, credentialSentinels),
      accountPasswords: assertNoSecretLeak('审计导出', exportResponse.text, accountSecrets),
      names: assertNoSentinels('审计导出', exportResponse.text, [...A_SIDE_NAMES, ...B_SIDE_NAMES]),
      salaries: assertNoNumbers('审计导出', exportResponse.text, [
        ...A_SIDE_SALARIES,
        ...B_SIDE_SALARIES,
      ]),
      restrictedColumns: assertNoSentinels('审计导出', exportResponse.text, ['salary']),
      rawSql: assertNoSentinels('审计导出', exportResponse.text, [DATA_DOMAIN_SQL]),
    },
  };

  console.log(
    JSON.stringify({
      m5Evidence: {
        download: {
          sha256A: { artifact: artifactA.sha256, actual: ownArtifact.digest },
          sizeA: { artifact: artifactA.size, actual: ownArtifact.size },
          previewMatchesDownload: preview.content === ownText,
          rowsA: ownArtifact.result.rows,
          sha256B: { artifact: artifactB.sha256, actual: ownArtifactB.digest },
          sizeB: { artifact: artifactB.size, actual: ownArtifactB.size },
          rowsB: ownArtifactB.result.rows,
        },
        trace: {
          runA: { runId: runIdA, initiatedBy: runDetailA.run.initiatedBy },
          runB: { runId: runIdB, initiatedBy: runDetailB.run.initiatedBy },
          queryLogA: {
            actorBusinessId: logA.actorBusinessId,
            versionId: logA.versionId,
            rowCount: logA.rowCount,
            status: logA.status,
          },
          queryLogB: {
            actorBusinessId: logB.actorBusinessId,
            versionId: logB.versionId,
            rowCount: logB.rowCount,
            status: logB.status,
          },
          auditA: { id: auditA.id, inputDigest: auditA.inputDigest, status: auditA.status },
          auditB: { id: auditB.id, inputDigest: auditB.inputDigest, status: auditB.status },
          chain: verified,
        },
        export: { format: exportBody.format, ids: exportIds, listIds },
        sentinels: sentinelEvidence,
      },
    }),
  );

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

  await app.open(`/chat?conversation=${outcomeA.conversationId}`);
  await expect(screen.getByText('执行过程').first()).toBeVisible({ timeout: 60_000 });
  await screen.getByText('执行过程').first().tap();
  await expect(screen.getByText(toolName)).toBeVisible({ timeout: 60_000 });
  await screen.getByText(toolName).tap();
  await expect(screen.getByText('Alice')).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByText('salary')).toBeVisible();
  await expect(screen.getByText('bonus')).toBeVisible();
  await screen.getByRole('tab', { name: '图表' }).tap();
  await expect(screen.getByText('不聚合：每行一个数据点。')).toBeVisible({ timeout: 30_000 });

  const dimensionSelect = screen.getByRole('combobox', { name: '图表维度' });
  const aggregationSelect = screen.getByRole('combobox', { name: '图表聚合方式' });
  const typeSelect = screen.getByRole('combobox', { name: '图表类型' });
  const chooseOption = async (control: Locator, option: string) => {
    await control.tap();
    await screen.getByRole('option', { name: option }).tap();
    await screen.getByRole('option', { name: option }).waitFor({ state: 'hidden' });
  };
  const countOf = async (selector: string) =>
    (await browser.evaluate(
      `document.querySelectorAll(${JSON.stringify(selector)}).length`,
    )) as number;
  const focusedLabel = async () =>
    (await browser.evaluate("document.activeElement?.getAttribute('aria-label') ?? ''")) as string;
  const chartTable = async () =>
    (await browser.evaluate(
      `(() => {
        const table = document.querySelector('table.sr-only');
        if (table === null) return null;
        return {
          caption: table.querySelector('caption')?.textContent ?? '',
          rows: Array.from(table.querySelectorAll('tbody tr')).map((row) => ({
            label: row.querySelector('th')?.textContent ?? '',
            value: row.querySelector('td')?.textContent ?? '',
          })),
        };
      })()`,
    )) as { caption: string; rows: Array<{ label: string; value: string }> } | null;

  await chooseOption(dimensionSelect, 'department');
  await expect(typeSelect).toHaveText('柱状图', { timeout: 30_000 });
  await browser.locator('.recharts-bar-rectangle path').first().waitFor();
  const rawBars = await countOf('.recharts-bar-rectangle path');
  if (rawBars !== expectedA.length) {
    throw new Error(`不聚合时应为每行一个柱（${expectedA.length} 个），实际 ${rawBars} 个`);
  }

  await chooseOption(aggregationSelect, '求和');
  await expect(screen.getByText('按 department 求和。')).toBeVisible({ timeout: 30_000 });
  const aggregatedBars = await countOf('.recharts-bar-rectangle path');
  if (aggregatedBars !== 1) {
    throw new Error(`按 department 求和后应只剩 1 根柱，实际 ${aggregatedBars} 根`);
  }
  const sumTable = await chartTable();
  if (sumTable === null) throw new Error('求和后缺少 sr-only 数据表');
  if (!sumTable.caption.includes('salary') || !sumTable.caption.includes('求和')) {
    throw new Error(`sr-only 表格 caption 未说明度量与聚合：${sumTable.caption}`);
  }
  const hrSum = sumTable.rows.find((row) => row.label === 'HR');
  if (hrSum?.value !== '170000') {
    throw new Error(`HR 组求和应为 170000，实际：${JSON.stringify(sumTable.rows)}`);
  }

  await chooseOption(dimensionSelect, 'bonus');
  await expect(typeSelect).toHaveText('散点图', { timeout: 30_000 });
  await expect(screen.getByText('X：bonus，Y：salary。')).toBeVisible();
  await expect(aggregationSelect).toBeDisabled();
  await expect(screen.getByText('散点不聚合')).toBeVisible();
  await browser.locator('.recharts-scatter-symbol').first().waitFor();
  const scatterSymbols = await countOf('.recharts-scatter-symbol');
  if (scatterSymbols !== expectedA.length) {
    throw new Error(
      `散点应每个数值行一个符号（${expectedA.length} 个），实际 ${scatterSymbols} 个`,
    );
  }
  const scatterTable = await chartTable();
  if (
    scatterTable === null ||
    !scatterTable.caption.includes('散点图') ||
    !scatterTable.caption.includes('bonus') ||
    !scatterTable.caption.includes('salary') ||
    !scatterTable.caption.includes('散点不聚合')
  ) {
    throw new Error(`散点图的 sr-only 表格说明不符：${JSON.stringify(scatterTable)}`);
  }
  if (
    scatterTable.rows[0]?.label !== '5000' ||
    scatterTable.rows[0]?.value !== '90000' ||
    scatterTable.rows[1]?.label !== '4000' ||
    scatterTable.rows[1]?.value !== '80000'
  ) {
    throw new Error(`散点 X/Y 数据不符：${JSON.stringify(scatterTable.rows)}`);
  }

  await chooseOption(dimensionSelect, 'department');
  await expect(typeSelect).toHaveText('柱状图', { timeout: 30_000 });
  await chooseOption(aggregationSelect, '不聚合');
  await expect(screen.getByText('不聚合：每行一个数据点。')).toBeVisible({ timeout: 30_000 });

  await aggregationSelect.focus();
  await browser.keyboard.press('Tab');
  if ((await focusedLabel()) !== '图表类型') {
    throw new Error(`Tab 后焦点应在图表类型上，实际 ${await focusedLabel()}`);
  }
  await browser.keyboard.press('ArrowDown');
  await expect(typeSelect).toHaveAttribute('aria-expanded', 'true');
  await expect(screen.getByRole('option', { name: '折线图' })).toBeVisible();
  await browser.keyboard.press('ArrowDown');
  await browser.keyboard.press('Enter');
  await expect(typeSelect).toHaveText('折线图', { timeout: 30_000 });
  await expect(typeSelect).toHaveAttribute('aria-expanded', 'false');
  if ((await focusedLabel()) !== '图表类型') {
    throw new Error(`选择后焦点应回到图表类型，实际 ${await focusedLabel()}`);
  }
  await browser.locator('.recharts-line-curve').first().waitFor();
  const lineCount = await countOf('.recharts-line-curve');
  if (lineCount !== 1) throw new Error(`折线图应渲染 1 条折线，实际 ${lineCount} 条`);
  await browser.keyboard.press('ArrowDown');
  await expect(typeSelect).toHaveAttribute('aria-expanded', 'true');
  await browser.keyboard.press('Escape');
  await expect(typeSelect).toHaveAttribute('aria-expanded', 'false');
  await expect(typeSelect).toHaveText('折线图');

  const shotDir = join(SHOT_DIR, randomUUID().slice(0, 8));
  const fullPageShot = async (width: number, label: string) => {
    await browser.setViewport({ width, height: 900 });
    await delay(200);
    const documentHeight = (await browser.evaluate(
      'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)',
    )) as number;
    const height = Math.min(Math.max(documentHeight, 1600), 2400);
    await browser.setViewport({ width, height });
    await delay(200);
    await browser.evaluate(
      "document.querySelector('.recharts-wrapper')?.scrollIntoView({ block: 'center' })",
    );
    await delay(200);
    const overflow = (await browser.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    )) as number;
    if (overflow > 0) throw new Error(`${width}px 视口出现 ${overflow}px 横向溢出`);
    return keepShot(shotDir, await app.screenshot(label), `${label}.png`);
  };
  const wideShot = await fullPageShot(1280, 'data-domain-chart-full-1280');
  const narrowShot = await fullPageShot(1024, 'data-domain-chart-full-1024');

  await aggregationSelect.focus();
  await browser.keyboard.press('ArrowDown');
  await expect(aggregationSelect).toHaveAttribute('aria-expanded', 'true');
  await browser.keyboard.press('ArrowDown');
  await browser.keyboard.press('ArrowDown');
  await browser.keyboard.press('Enter');
  await expect(screen.getByText('按 department 平均。')).toBeVisible({ timeout: 30_000 });
  if ((await focusedLabel()) !== '图表聚合方式') {
    throw new Error(`键盘选择后焦点应回到聚合方式，实际 ${await focusedLabel()}`);
  }
  const avgTable = await chartTable();
  if (avgTable === null || !avgTable.caption.includes('平均')) {
    throw new Error(`平均聚合的 sr-only 表格 caption 不符：${JSON.stringify(avgTable)}`);
  }
  const hrAvg = avgTable.rows.find((row) => row.label === 'HR');
  if (hrAvg?.value !== '85000') {
    throw new Error(`HR 组平均应为 85000，实际：${JSON.stringify(avgTable.rows)}`);
  }

  const resultTabs = screen.getByRole('tablist', { name: '结果视图' });
  const tableTab = resultTabs.getByRole('tab', { name: '表格' });
  const chartTab = resultTabs.getByRole('tab', { name: '图表' });
  await expect(resultTabs).toBeVisible();
  await expect(tableTab).toHaveCount(1);
  await expect(chartTab).toHaveCount(1);
  await expect(chartTab).toHaveAttribute('aria-selected', 'true');
  await expect(tableTab).toHaveAttribute('aria-selected', 'false');
  await chartTab.focus();
  await expect(chartTab).toBeFocused();
  await browser.keyboard.press('ArrowLeft');
  await expect(tableTab).toBeFocused();
  await expect(tableTab).toHaveAttribute('aria-selected', 'true');
  await expect(chartTab).toHaveAttribute('aria-selected', 'false');
  await expect(screen.getByRole('table', { name: '查询结果' })).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText('Alice')).toBeVisible();
  await browser.keyboard.press('ArrowRight');
  await expect(chartTab).toBeFocused();
  await expect(chartTab).toHaveAttribute('aria-selected', 'true');
  await expect(tableTab).toHaveAttribute('aria-selected', 'false');
  await expect(screen.getByRole('combobox', { name: '图表维度' })).toBeVisible({ timeout: 30_000 });
  const keyboardTable = await chartTable();
  if (keyboardTable === null || keyboardTable.caption.trim() === '') {
    throw new Error(`图表视图缺少带 caption 的 sr-only 数据表：${JSON.stringify(keyboardTable)}`);
  }
  await expect(screen.getByRole('table', { name: keyboardTable.caption })).toBeVisible();

  console.log(
    JSON.stringify({
      chartEvidence: {
        rawBars,
        aggregatedBars,
        scatterSymbols,
        lineCount,
        sumTable: { caption: sumTable.caption, rows: sumTable.rows },
        scatterTable: { caption: scatterTable.caption, rows: scatterTable.rows },
        avgTable: { caption: avgTable.caption, rows: avgTable.rows },
        keyboard: { tabFocus: '图表类型', typeAfterEnter: '折线图', aggregationAfterEnter: '平均' },
        viewports: [1280, 1024],
        shots: { wideShot, narrowShot },
      },
    }),
  );

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
