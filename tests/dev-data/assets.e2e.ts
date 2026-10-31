import { rm } from 'node:fs/promises';
import { type Browser, test } from '@e2e-dev/web';
import { type App, expect, type Locator, type Screen } from 'e2e';
import {
  api,
  DATASET_ID,
  manifestExists,
  readManifest,
  writeManifest,
  writePluginZip,
} from '../support/business-dataset.js';
import { resolveOwnership } from '../support/dataset-ownership.js';

/**
 * 青禾演示资产组：连接器、工具、技能、本地插件与演示账户。
 * 只通过真实 UI 创建；API 仅用于同源读取、轮询和冲突判断。
 * 专项命令：pnpm dev:data / pnpm dev:data:verify（必须设置 E2E_APP_URL）。
 */

const DISPLAY = '【青禾演示】';
const USER_API_SERVER = 'devdata-qinghe-v1-users-api';
const LEGACY_SERVER = 'devdata-qinghe-v1-legacy-mcp';
const GET_USER_TOOL = 'devdata-qinghe-v1-get-user';
const GET_TODO_TOOL = 'devdata-qinghe-v1-get-todo';
const GET_ALBUM_TOOL = 'devdata-qinghe-v1-get-album';
const PLUGIN_SLUG = 'devdata-qinghe-v1-plugin';

const ID_SCHEMA = '{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}';

const usersServer = {
  name: USER_API_SERVER,
  kind: 'generated' as const,
  description: `${DISPLAY}采购公开只读查询（jsonplaceholder）`,
  url: 'https://jsonplaceholder.typicode.com',
};
const legacyServer = {
  name: LEGACY_SERVER,
  kind: 'http' as const,
  description: `${DISPLAY}故意失效的旧 CRM MCP（演示失败态）`,
  // 公开地址可达，但不是 MCP 端点：真实试连会失败，不引入假服务。
  url: 'https://jsonplaceholder.typicode.com/legacy-mcp',
};
const tools = [
  {
    name: GET_USER_TOOL,
    description: `${DISPLAY}按 ID 查询采购联系人`,
    method: 'GET',
    pathTemplate: '/users/{id}',
    paramsIn: 'query',
    schema: ID_SCHEMA,
    requiresApproval: false,
    enabled: true,
  },
  {
    name: GET_TODO_TOOL,
    description: `${DISPLAY}按 ID 查询采购待办，需人工批准`,
    method: 'GET',
    pathTemplate: '/todos/{id}',
    paramsIn: 'query',
    schema: ID_SCHEMA,
    requiresApproval: true,
    enabled: true,
  },
  {
    name: GET_ALBUM_TOOL,
    description: `${DISPLAY}已停用的附件查询示例`,
    method: 'GET',
    pathTemplate: '/albums/{id}',
    paramsIn: 'query',
    schema: ID_SCHEMA,
    requiresApproval: false,
    enabled: false,
  },
] as const;

const skills = [
  {
    slug: 'devdata-qinghe-v1-sourcing',
    name: `${DISPLAY}采购询价助手`,
    description: '按采购单整理供应商报价、交期与包装要求，输出可比价清单。',
    body: [
      '# 采购询价',
      '',
      '采购单 QH-PO-2026-001，供应商云杉包装，物料竹纤维随行杯。',
      '1. 读取采购单的物料、数量、交期与包装要求。',
      '2. 对每家供应商分别列出单价、起订量、交期和含税口径。',
      '3. 缺少报价或条款不一致的供应商单独标注，不做推测。',
      '4. 输出按总成本排序的比价表，并附上使用的假设。',
    ].join('\n'),
    files: [
      {
        path: 'references/procurement-checklist.md',
        content: [
          '# 采购核对清单',
          '',
          '- 采购单号、物料名称、数量与交期齐全。',
          '- 单价、税率、运费与付款条件口径一致。',
          '- 包装方式与客户备注一致。',
          '- 供应商报价有效期未过期。',
        ].join('\n'),
      },
    ],
  },
  {
    slug: 'devdata-qinghe-v1-after-sales',
    name: `${DISPLAY}售后工单助手`,
    description: '把客户反馈整理成可执行的售后工单，区分补发、退款与上门处理。',
    body: [
      '# 售后工单整理',
      '',
      '采购单 QH-PO-2026-001 的竹纤维随行杯售后反馈：',
      '1. 提取订单号、商品、问题现象与期望处理方式。',
      '2. 按补发、退款、维修三类给出建议，并写明依据。',
      '3. 信息不足时列出必须补充的问题，不替客户做决定。',
      '4. 输出给客服可直接粘贴的工单摘要。',
    ].join('\n'),
    files: [],
  },
] as const;

const pluginEntries = {
  '.claude-plugin/plugin.json': JSON.stringify(
    {
      name: PLUGIN_SLUG,
      version: '1.0.0',
      description: `${DISPLAY}采购协作插件`,
    },
    null,
    2,
  ),
  'skills/devdata-qinghe-v1-procurement-notes/SKILL.md': [
    '---',
    'name: devdata-qinghe-v1-procurement-notes',
    'description: 青禾演示采购备注模板。',
    '---',
    '',
    '# 采购备注',
    '',
    '统一记录采购单 QH-PO-2026-001、供应商云杉包装、物料竹纤维随行杯、承诺交期与下一次跟进时间。',
  ].join('\n'),
  'commands/devdata-qinghe-v1-brief.md': [
    '# 采购简报',
    '',
    '汇总采购单 QH-PO-2026-001（云杉包装 / 竹纤维随行杯）的待确认事项、供应商回复和风险。',
  ].join('\n'),
};
const pluginSkillCount = 1;

const accounts = [
  {
    businessId: 'devdata-qinghe-v1-buyer',
    username: 'devdata-qinghe-v1-buyer',
    name: `${DISPLAY}采购专员`,
    status: 'active' as const,
  },
  {
    businessId: 'devdata-qinghe-v1-support',
    username: 'devdata-qinghe-v1-support',
    name: `${DISPLAY}售后专员`,
    status: 'disabled' as const,
  },
] as const;
const demoPassword = 'QingheDemo-2026';

interface ApiServer {
  id: string;
  name: string;
  kind: string;
  description: string;
  baseUrl?: string;
  url?: string;
  lastTestOk?: boolean | null;
}

interface ApiTool {
  id: string;
  name: string;
  description: string;
  method: string;
  pathTemplate: string;
  paramsIn: string;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  enabled: boolean;
}

interface ApiSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  body: string;
}

interface ApiSkillFile {
  id: string;
  path: string;
  content: string;
}

interface ApiPlugin {
  id: string;
  slug: string;
  name: string;
  version: string;
  capabilities: { skills: string[]; agents: string[]; hasHooks: boolean; mcpServers: string[] };
  files: Array<{ path: string; content: string }>;
}

interface ApiAccount {
  businessId: string;
  username: string;
  name: string;
  status: 'active' | 'disabled';
}

interface AssetsManifest {
  dataset: string;
  section: 'assets';
  servers: Array<{ name: string; id: string; kind: string; ready: boolean }>;
  tools: Array<{ server: string; name: string; id: string; ready: boolean }>;
  skills: Array<{ slug: string; id: string; files: string[]; ready: boolean }>;
  plugin: { slug: string; id: string; ready: boolean } | null;
  accounts: Array<{ businessId: string; status: 'active' | 'disabled'; ready: boolean }>;
}

const emptyManifest: AssetsManifest = {
  dataset: DATASET_ID,
  section: 'assets',
  servers: [],
  tools: [],
  skills: [],
  plugin: null,
  accounts: [],
};

async function loadManifest(): Promise<AssetsManifest> {
  const manifest = await readManifest<AssetsManifest>('assets', emptyManifest);
  if (manifest.dataset !== DATASET_ID || manifest.section !== 'assets') {
    throw new Error(`assets.json 不属于 ${DATASET_ID}，停止以免覆盖其他数据集`);
  }
  return manifest;
}

async function saveManifest(manifest: AssetsManifest): Promise<void> {
  await writeManifest('assets', manifest);
}

async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** PostgreSQL jsonb 会重排键顺序，按规范化 JSON 比较结构。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameSchema(actual: Record<string, unknown>, text: string): boolean {
  return canonical(actual) === canonical(JSON.parse(text));
}

function fail(message: string): never {
  throw new Error(`${message}；不会覆盖现有数据`);
}

test('assets verify: read-only dataset check', { session: 'admin', tags: ['verify'] }, async ({
  app,
  browser,
}) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', '仅由 pnpm dev:data:verify 启用');
  await app.open('/');
  expect(await manifestExists('assets')).toBe(true);
  const manifest = await loadManifest();
  const recordFor = <T>(
    records: readonly T[],
    predicate: (item: T) => boolean,
    label: string,
  ): T => {
    const matches = records.filter(predicate);
    if (matches.length !== 1) throw new Error(`${label} 在 manifest 中应恰好一条`);
    return matches[0] as T;
  };

  const servers = await api<ApiServer[]>(browser, '/api/servers');
  for (const [spec, expectedOk] of [
    [usersServer, true],
    [legacyServer, false],
  ] as const) {
    const record = recordFor(
      manifest.servers,
      (item) => item.name === spec.name,
      `连接器 ${spec.name}`,
    );
    expect(record.ready).toBe(true);
    const matches = servers.filter((server) => server.name === spec.name);
    expect(matches).toHaveLength(1);
    const server = matches[0] as ApiServer;
    expect(server.id).toBe(record.id);
    expect(server.kind).toBe(spec.kind);
    expect(server.kind === 'generated' ? server.baseUrl : server.url).toBe(spec.url);
    expect(server.description).toBe(spec.description);
    expect(server.lastTestOk).toBe(expectedOk);
  }

  const usersServerRecord = recordFor(
    manifest.servers,
    (item) => item.name === usersServer.name,
    `连接器 ${usersServer.name}`,
  );
  const toolRows = await api<ApiTool[]>(browser, `/api/servers/${usersServerRecord.id}/tools`);
  expect(toolRows).toHaveLength(tools.length);
  for (const spec of tools) {
    const record = recordFor(
      manifest.tools,
      (item) => item.server === usersServer.name && item.name === spec.name,
      `工具 ${spec.name}`,
    );
    expect(record.ready).toBe(true);
    const matches = toolRows.filter((tool) => tool.name === spec.name);
    expect(matches).toHaveLength(1);
    const tool = matches[0] as ApiTool;
    expect(tool.id).toBe(record.id);
    expect(tool.method).toBe(spec.method);
    expect(tool.pathTemplate).toBe(spec.pathTemplate);
    expect(tool.paramsIn).toBe(spec.paramsIn);
    expect(tool.description).toBe(spec.description);
    expect(tool.requiresApproval).toBe(spec.requiresApproval);
    expect(tool.enabled).toBe(spec.enabled);
    expect(sameSchema(tool.inputSchema, spec.schema)).toBe(true);
  }

  const skillRows = await api<ApiSkill[]>(browser, '/api/skills');
  for (const spec of skills) {
    const record = recordFor(
      manifest.skills,
      (item) => item.slug === spec.slug,
      `技能 ${spec.slug}`,
    );
    expect(record.ready).toBe(true);
    const matches = skillRows.filter((skill) => skill.slug === spec.slug);
    expect(matches).toHaveLength(1);
    expect((matches[0] as ApiSkill).id).toBe(record.id);
    const skill = await api<ApiSkill>(browser, `/api/skills/${record.id}`);
    expect(skill.slug).toBe(spec.slug);
    expect(skill.name).toBe(spec.name);
    expect(skill.description).toBe(spec.description);
    expect(skill.body).toBe(spec.body);
    const files = await api<ApiSkillFile[]>(browser, `/api/skills/${record.id}/files`);
    expect(files).toHaveLength(spec.files.length);
    expect([...record.files].sort()).toEqual(spec.files.map((file) => file.path).sort());
    for (const file of spec.files) {
      const stored = files.filter((item) => item.path === file.path);
      expect(stored).toHaveLength(1);
      expect((stored[0] as ApiSkillFile).content).toBe(file.content);
    }
  }

  const pluginRecord = manifest.plugin;
  if (!pluginRecord) throw new Error('插件 manifest 记录缺失');
  expect(pluginRecord.ready).toBe(true);
  const plugins = await api<ApiPlugin[]>(browser, '/api/plugins');
  const pluginMatches = plugins.filter((plugin) => plugin.slug === PLUGIN_SLUG);
  expect(pluginMatches).toHaveLength(1);
  expect((pluginMatches[0] as ApiPlugin).id).toBe(pluginRecord.id);
  const pluginRow = await api<ApiPlugin>(browser, `/api/plugins/${pluginRecord.id}`);
  expect(pluginRow.name).toBe(PLUGIN_SLUG);
  expect(pluginRow.version).toBe('1.0.0');
  expect(pluginRow.capabilities.skills).toHaveLength(pluginSkillCount);
  expect(pluginRow.files).toHaveLength(Object.keys(pluginEntries).length);
  for (const [entryPath, content] of Object.entries(pluginEntries)) {
    const stored = pluginRow.files.find((file) => file.path === entryPath);
    expect(stored?.content).toBe(content);
  }

  for (const spec of accounts) {
    const record = recordFor(
      manifest.accounts,
      (item) => item.businessId === spec.businessId,
      `账户 ${spec.businessId}`,
    );
    expect(record.ready).toBe(true);
    expect(record.status).toBe(spec.status);
    const accountRows = await api<{ items: ApiAccount[]; total: number }>(
      browser,
      `/api/accounts?q=${encodeURIComponent(spec.businessId)}&limit=100&offset=0`,
    );
    const matches = accountRows.items.filter((account) => account.businessId === spec.businessId);
    expect(matches).toHaveLength(1);
    const account = matches[0] as ApiAccount;
    expect(account.username).toBe(spec.username);
    expect(account.name).toBe(spec.name);
    expect(account.status).toBe(spec.status);
  }
});

interface Ctx {
  app: App;
  screen: Screen;
  browser: Browser;
}

async function readServers(ctx: Ctx): Promise<ApiServer[]> {
  return api<ApiServer[]>(ctx.browser, '/api/servers');
}

async function readTools(ctx: Ctx, serverId: string): Promise<ApiTool[]> {
  return api<ApiTool[]>(ctx.browser, `/api/servers/${serverId}/tools`);
}

async function readSkills(ctx: Ctx): Promise<ApiSkill[]> {
  return api<ApiSkill[]>(ctx.browser, '/api/skills');
}

async function readSkillFiles(ctx: Ctx, skillId: string): Promise<ApiSkillFile[]> {
  return api<ApiSkillFile[]>(ctx.browser, `/api/skills/${skillId}/files`);
}

async function readPlugins(ctx: Ctx): Promise<ApiPlugin[]> {
  return api<ApiPlugin[]>(ctx.browser, '/api/plugins');
}

async function readAccounts(ctx: Ctx, businessId?: string): Promise<ApiAccount[]> {
  const query =
    businessId === undefined
      ? '?limit=100&offset=0'
      : `?q=${encodeURIComponent(businessId)}&limit=100&offset=0`;
  return (await api<{ items: ApiAccount[] }>(ctx.browser, `/api/accounts${query}`)).items;
}

async function createServerViaUi(
  ctx: Ctx,
  spec: { name: string; kind: 'generated' | 'http'; description: string; url: string },
): Promise<ApiServer> {
  await ctx.app.open('/servers');
  await ctx.screen.getByRole('button', '新建连接器').first().tap();
  await ctx.screen
    .getByRole('button', spec.kind === 'generated' ? 'HTTP API 转 MCP' : '远程 MCP', {
      exact: false,
    })
    .tap();
  await ctx.browser.locator('#server-name').fill(spec.name);
  await ctx.browser.locator('#server-desc').fill(spec.description);
  await ctx.browser.locator('#server-url').fill(spec.url);
  await ctx.screen.getByRole('button', '创建', { exact: true }).tap();
  const servers = await poll(
    () => readServers(ctx),
    (rows) => rows.some((server) => server.name === spec.name),
    `连接器 ${spec.name} 创建`,
  );
  return servers.find((server) => server.name === spec.name) as ApiServer;
}

function assertServerContent(
  server: ApiServer,
  spec: { kind: 'generated' | 'http'; description: string; url: string },
): void {
  const actualUrl = server.kind === 'generated' ? server.baseUrl : server.url;
  if (
    server.kind !== spec.kind ||
    actualUrl !== spec.url ||
    server.description !== spec.description
  ) {
    fail(`连接器 ${server.name} 的内容与数据集定义不一致`);
  }
}

async function ensureServer(
  ctx: Ctx,
  manifest: AssetsManifest,
  spec: { name: string; kind: 'generated' | 'http'; description: string; url: string },
): Promise<{ server: ApiServer; created: boolean }> {
  const servers = await readServers(ctx);
  const record = manifest.servers.find((item) => item.name === spec.name);
  const decision = resolveOwnership({
    dataset: DATASET_ID,
    label: `连接器 ${spec.name}`,
    hasRecord: record !== undefined,
    owned: record ? servers.find((server) => server.id === record.id) : undefined,
    named: servers.find((server) => server.name === spec.name),
    expectedName: spec.name,
    nameOf: (server) => server.name,
  });
  if (decision.kind === 'conflict') fail(decision.message);
  if (decision.kind === 'reuse') {
    assertServerContent(decision.entity, spec);
    return { server: decision.entity, created: false };
  }
  const created = await createServerViaUi(ctx, spec);
  manifest.servers.push({ name: spec.name, id: created.id, kind: created.kind, ready: false });
  await saveManifest(manifest);
  return { server: created, created: true };
}

async function ensureConnectionState(
  ctx: Ctx,
  manifest: AssetsManifest,
  spec: { name: string },
  expected: boolean,
): Promise<void> {
  const record = manifest.servers.find((item) => item.name === spec.name);
  if (!record) throw new Error(`连接器 ${spec.name} 缺少 manifest 记录`);
  const current = (await readServers(ctx)).find((server) => server.id === record.id);
  if (!current) fail(`连接器 ${spec.name} 已被删除`);
  if (current.lastTestOk === expected) {
    if (!record.ready) {
      record.ready = true;
      await saveManifest(manifest);
    }
    return;
  }
  // 只补本数据集刚创建、还没有试连结果的连接器；已有终态被改动时停止，不覆盖。
  if (current.lastTestOk !== null && current.lastTestOk !== undefined) {
    fail(`连接器 ${spec.name} 的试连结果已被改为 ${current.lastTestOk}，不覆盖`);
  }
  if (record.ready) fail(`连接器 ${spec.name} 已标记完成但缺少试连结果`);

  await ctx.app.open('/servers');
  const card = ctx.browser
    .locator('[data-slot="server-card"]')
    .filter({ hasText: spec.name })
    .first();
  await card.getByRole('button', { name: `操作 ${spec.name}` }).tap();
  await ctx.screen.getByRole('menuitem', '测试连接').tap();
  if (expected) {
    await expect(ctx.screen.getByText('试连成功')).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(ctx.screen.getByText(`没有连上 ${spec.name}`, { exact: false })).toBeVisible({
      timeout: 30_000,
    });
  }
  await poll(
    () => readServers(ctx),
    (rows) => rows.find((server) => server.id === record.id)?.lastTestOk === expected,
    `连接器 ${spec.name} 的试连状态`,
    30_000,
  );
  record.ready = true;
  await saveManifest(manifest);
}

function toolDialog(ctx: Ctx): Locator {
  return ctx.browser.locator('[role="dialog"]');
}

async function openToolDialog(ctx: Ctx, serverName: string): Promise<Locator> {
  await ctx.app.open('/servers');
  const card = ctx.browser
    .locator('[data-slot="server-card"]')
    .filter({ hasText: serverName })
    .first();
  await card.getByRole('button', { name: `操作 ${serverName}` }).tap();
  await ctx.screen.getByRole('menuitem', '工具定义').tap();
  const dialog = toolDialog(ctx);
  await dialog.getByRole('heading', { name: `工具定义「${serverName}」` }).waitFor();
  return dialog;
}

async function addToolViaUi(
  ctx: Ctx,
  dialog: Locator,
  spec: (typeof tools)[number],
): Promise<void> {
  await ctx.browser.locator('input[id^="tool-name-"]').fill(spec.name);
  await ctx.browser.locator('input[id^="tool-path-"]').fill(spec.pathTemplate);
  await ctx.browser.locator('input[id^="tool-desc-"]').fill(spec.description);
  const schema = dialog.getByLabel('inputSchema (JSON)');
  await schema.focus();
  await schema.press('ControlOrMeta+a');
  await schema.pressSequentially(spec.schema);
  await dialog.getByRole('button', { name: '添加', exact: true }).tap();
  // 连续添加时旧 toast 仍在，按工具行断言，避免取到上一条“工具已添加”。
  await expect(
    dialog.getByRole('checkbox', `启用工具 ${spec.name}`, { exact: true }),
  ).toBeVisible();
}

function assertToolContent(tool: ApiTool, spec: (typeof tools)[number]): void {
  if (
    tool.description !== spec.description ||
    tool.method !== spec.method ||
    tool.pathTemplate !== spec.pathTemplate ||
    tool.paramsIn !== spec.paramsIn ||
    !sameSchema(tool.inputSchema, spec.schema)
  ) {
    fail(`工具 ${tool.name} 的内容与数据集定义不一致`);
  }
}

async function ensureTools(
  ctx: Ctx,
  manifest: AssetsManifest,
  server: ApiServer,
  alreadyOpen: boolean,
): Promise<void> {
  let list = await readTools(ctx, server.id);
  let dialog: Locator | null = alreadyOpen ? toolDialog(ctx) : null;
  let dialogOpen = alreadyOpen;

  const openDialog = async (): Promise<Locator> => {
    if (dialog) return dialog;
    dialog = await openToolDialog(ctx, server.name);
    dialogOpen = true;
    return dialog;
  };

  const recordFor = (name: string) =>
    manifest.tools.find((item) => item.server === server.name && item.name === name);

  for (const spec of tools) {
    const record = recordFor(spec.name);
    const decision = resolveOwnership({
      dataset: DATASET_ID,
      label: `工具 ${spec.name}`,
      hasRecord: record !== undefined,
      owned: record === undefined ? undefined : list.find((tool) => tool.id === record.id),
      named: list.find((tool) => tool.name === spec.name),
      expectedName: spec.name,
      nameOf: (tool) => tool.name,
    });
    if (decision.kind === 'conflict') fail(decision.message);
    if (decision.kind === 'reuse') {
      assertToolContent(decision.entity, spec);
      continue;
    }
    const active = await openDialog();
    await addToolViaUi(ctx, active, spec);
    list = await poll(
      () => readTools(ctx, server.id),
      (rows) => rows.some((tool) => tool.name === spec.name),
      `工具 ${spec.name} 创建`,
    );
    manifest.tools.push({
      server: server.name,
      name: spec.name,
      id: (list.find((tool) => tool.name === spec.name) as ApiTool).id,
      ready: false,
    });
    await saveManifest(manifest);
  }

  const incomplete = tools.filter((spec) => {
    const record = recordFor(spec.name);
    return record !== undefined && !record.ready;
  });
  list = await readTools(ctx, server.id);
  if (incomplete.length > 0) {
    const active = await openDialog();
    for (const spec of incomplete) {
      const record = recordFor(spec.name);
      if (!record) continue;
      const tool = list.find((item) => item.id === record.id);
      if (!tool) fail(`工具 ${spec.name} 已被删除`);
      assertToolContent(tool, spec);
      if (tool.requiresApproval !== spec.requiresApproval) {
        await active.getByRole('checkbox', `批准工具 ${spec.name}`, { exact: true }).tap();
        await poll(
          () => readTools(ctx, server.id),
          (rows) =>
            rows.find((item) => item.id === record.id)?.requiresApproval === spec.requiresApproval,
          `工具 ${spec.name} 审批开关`,
        );
      }
      if (tool.enabled !== spec.enabled) {
        await active.getByRole('checkbox', `启用工具 ${spec.name}`, { exact: true }).tap();
        await poll(
          () => readTools(ctx, server.id),
          (rows) => rows.find((item) => item.id === record.id)?.enabled === spec.enabled,
          `工具 ${spec.name} 启用开关`,
        );
      }
      record.ready = true;
      await saveManifest(manifest);
    }
  }

  if (dialogOpen && dialog) {
    await dialog.getByRole('button', { name: '关闭', exact: true }).tap();
  }

  list = await readTools(ctx, server.id);
  for (const spec of tools) {
    const matches = list.filter((tool) => tool.name === spec.name);
    if (matches.length !== 1) throw new Error(`工具 ${spec.name} 应恰好存在一个`);
    const tool = matches[0] as ApiTool;
    const record = recordFor(spec.name);
    assertToolContent(tool, spec);
    if (!record?.ready) throw new Error(`工具 ${spec.name} 尚未完成数据集构建`);
    if (tool.id !== record.id) fail(`工具 ${spec.name} 的 ID 与 manifest 不一致`);
    if (tool.requiresApproval !== spec.requiresApproval || tool.enabled !== spec.enabled) {
      fail(`工具 ${spec.name} 的审批或启用状态已被修改`);
    }
  }
}

async function createSkillViaUi(ctx: Ctx, spec: (typeof skills)[number]): Promise<void> {
  await ctx.app.open('/skills');
  await ctx.screen.getByRole('button', '新建技能').first().tap();
  await ctx.browser.locator('#skill-name').fill(spec.name);
  await ctx.browser.locator('#skill-slug').fill(spec.slug);
  await ctx.browser.locator('#skill-desc').fill(spec.description);
  const body = ctx.screen.getByLabel('步骤');
  // CodeMirror 的 Markdown 会在 Enter 后自动续号，逐字输入会改坏列表；fill 一次写入保持原文。
  await body.fill(spec.body);
  await ctx.browser
    .locator('[role="dialog"]')
    .getByRole('button', { name: '保存', exact: true })
    .tap();
  await poll(
    () => readSkills(ctx),
    (rows) => rows.some((skill) => skill.slug === spec.slug),
    `技能 ${spec.slug} 创建`,
  );
}

async function addSkillFilesViaUi(
  ctx: Ctx,
  spec: (typeof skills)[number],
  missing: Array<{ path: string; content: string }>,
): Promise<void> {
  await ctx.app.open('/skills');
  await ctx.screen.getByRole('button', { name: `编辑 ${spec.name}`, exact: true }).tap();
  const dialog = ctx.browser.locator('[role="dialog"]');
  for (const file of missing) {
    await ctx.browser.locator('#skill-file-path').fill(file.path);
    const editor = ctx.screen.getByLabel('文件内容');
    await editor.fill(file.content);
    await dialog.getByRole('button', { name: '添加文件', exact: true }).tap();
    await expect(ctx.screen.getByText('已添加支持文件')).toBeVisible();
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).tap();
}

async function ensureSkill(
  ctx: Ctx,
  manifest: AssetsManifest,
  spec: (typeof skills)[number],
): Promise<void> {
  const rows = await readSkills(ctx);
  const found = manifest.skills.find((item) => item.slug === spec.slug);
  let record = found;
  const decision = resolveOwnership({
    dataset: DATASET_ID,
    label: `技能 ${spec.slug}`,
    hasRecord: found !== undefined,
    owned: found === undefined ? undefined : rows.find((skill) => skill.id === found.id),
    named: rows.find((skill) => skill.slug === spec.slug),
    expectedName: spec.slug,
    nameOf: (skill) => skill.slug,
  });
  if (decision.kind === 'conflict') fail(decision.message);
  if (decision.kind === 'create') {
    await createSkillViaUi(ctx, spec);
    const created = (
      await poll(
        () => readSkills(ctx),
        (skills) => skills.some((skill) => skill.slug === spec.slug),
        `技能 ${spec.slug} 创建`,
      )
    ).find((skill) => skill.slug === spec.slug) as ApiSkill;
    record = { slug: spec.slug, id: created.id, files: [], ready: false };
    manifest.skills.push(record);
    await saveManifest(manifest);
  }
  if (!record) throw new Error(`技能 ${spec.slug} 缺少 manifest 记录`);

  const detail = await api<ApiSkill>(ctx.browser, `/api/skills/${record.id}`);
  if (
    detail.slug !== spec.slug ||
    detail.name !== spec.name ||
    detail.description !== spec.description ||
    detail.body !== spec.body
  ) {
    // 已归属技能的任何正文差异都视为开发者修改，停止且不重写。
    fail(`技能 ${spec.slug} 的内容与数据集定义不一致`);
  }

  const files = await readSkillFiles(ctx, record.id);
  const expectedPaths: string[] = spec.files.map((file) => file.path);
  for (const file of files) {
    if (!expectedPaths.includes(file.path)) {
      fail(`技能 ${spec.slug} 含有数据集之外的支持文件 ${file.path}`);
    }
    const expected = spec.files.find((item) => item.path === file.path);
    if (expected && file.content !== expected.content) {
      fail(`技能 ${spec.slug} 的支持文件 ${file.path} 已被修改`);
    }
  }
  const missing = spec.files.filter((file) => !files.some((stored) => stored.path === file.path));
  if (missing.length > 0) {
    if (record.ready) {
      fail(`技能 ${spec.slug} 缺少支持文件 ${missing.map((file) => file.path).join('、')}`);
    }
    await addSkillFilesViaUi(ctx, spec, missing);
    await poll(
      () => readSkillFiles(ctx, record.id),
      (stored) => missing.every((file) => stored.some((item) => item.path === file.path)),
      `技能 ${spec.slug} 的支持文件`,
    );
  }
  record.files = expectedPaths;
  record.ready = true;
  await saveManifest(manifest);
}

async function importPluginViaUi(ctx: Ctx): Promise<void> {
  const zip = await writePluginZip(pluginEntries);
  try {
    await ctx.app.open('/plugins');
    await ctx.browser.locator('input[type="file"]').setInputFiles(zip.file);
    await poll(
      () => readPlugins(ctx),
      (plugins) => plugins.some((plugin) => plugin.slug === PLUGIN_SLUG),
      `插件 ${PLUGIN_SLUG} 导入`,
      30_000,
    );
  } finally {
    await rm(zip.dir, { recursive: true, force: true });
  }
}

async function ensurePlugin(ctx: Ctx, manifest: AssetsManifest): Promise<void> {
  const plugins = await readPlugins(ctx);
  const found = manifest.plugin;
  let record = found;
  const decision = resolveOwnership({
    dataset: DATASET_ID,
    label: `插件 ${PLUGIN_SLUG}`,
    hasRecord: found !== null,
    owned: found === null ? undefined : plugins.find((plugin) => plugin.id === found.id),
    named: plugins.find((plugin) => plugin.slug === PLUGIN_SLUG),
    expectedName: PLUGIN_SLUG,
    nameOf: (plugin) => plugin.slug,
  });
  if (decision.kind === 'conflict') fail(decision.message);
  if (decision.kind === 'create') {
    await importPluginViaUi(ctx);
    const created = (
      await poll(
        () => readPlugins(ctx),
        (rows) => rows.some((plugin) => plugin.slug === PLUGIN_SLUG),
        `插件 ${PLUGIN_SLUG} 导入`,
        30_000,
      )
    ).find((plugin) => plugin.slug === PLUGIN_SLUG) as ApiPlugin;
    record = { slug: PLUGIN_SLUG, id: created.id, ready: true };
    manifest.plugin = record;
    await saveManifest(manifest);
  }
  if (!record) throw new Error(`插件 ${PLUGIN_SLUG} 缺少 manifest 记录`);

  const detail = await api<ApiPlugin>(ctx.browser, `/api/plugins/${record.id}`);
  if (detail.name !== PLUGIN_SLUG || detail.version !== '1.0.0') {
    fail(`插件 ${PLUGIN_SLUG} 的名称或版本已被修改`);
  }
  if (detail.capabilities.skills.length !== pluginSkillCount) {
    fail(`插件 ${PLUGIN_SLUG} 的技能数量与数据集定义不一致`);
  }
  const entryPaths = Object.keys(pluginEntries);
  if (detail.files.length !== entryPaths.length) {
    fail(`插件 ${PLUGIN_SLUG} 的文件数量与数据集定义不一致`);
  }
  for (const [filePath, content] of Object.entries(pluginEntries)) {
    const stored = detail.files.find((file) => file.path === filePath);
    if (!stored) fail(`插件 ${PLUGIN_SLUG} 缺少文件 ${filePath}`);
    if (stored.content !== content) fail(`插件 ${PLUGIN_SLUG} 的文件 ${filePath} 已被修改`);
  }
}

async function createAccountViaUi(ctx: Ctx, spec: (typeof accounts)[number]): Promise<void> {
  await ctx.app.open('/accounts');
  await ctx.screen.getByRole('button', '新建账户').first().tap();
  await ctx.browser.locator('#account-business-id').fill(spec.businessId);
  await ctx.browser.locator('#account-username').fill(spec.username);
  await ctx.browser.locator('#account-name').fill(spec.name);
  await ctx.browser.locator('#account-password').fill(demoPassword);
  await ctx.screen.getByRole('button', { name: '创建账户', exact: true }).tap();
  await poll(
    () => readAccounts(ctx, spec.businessId),
    (rows) => rows.some((account) => account.businessId === spec.businessId),
    `账户 ${spec.businessId} 创建`,
  );
}

async function setAccountStatus(
  ctx: Ctx,
  businessId: string,
  status: 'active' | 'disabled',
): Promise<void> {
  await ctx.app.open('/accounts');
  const row = ctx.browser.locator('tr').filter({ hasText: businessId }).first();
  if (status === 'disabled') {
    await row.getByRole('button', { name: '停用', exact: true }).tap();
    await ctx.browser
      .locator('[role="dialog"]')
      .getByRole('button', { name: '停用', exact: true })
      .tap();
  } else {
    await row.getByRole('button', { name: '启用', exact: true }).tap();
  }
  await poll(
    () => readAccounts(ctx, businessId),
    (rows) => rows.find((account) => account.businessId === businessId)?.status === status,
    `账户 ${businessId} 状态`,
  );
}

async function ensureAccount(
  ctx: Ctx,
  manifest: AssetsManifest,
  spec: (typeof accounts)[number],
): Promise<void> {
  let rows = await readAccounts(ctx, spec.businessId);
  let existing = rows.find((account) => account.businessId === spec.businessId);
  let record = manifest.accounts.find((item) => item.businessId === spec.businessId);
  if (!existing) {
    // 已归属账户被删除后重建会进入 better-auth 的恢复分支，需要人工确认，不自动处理。
    if (record) fail(`账户 ${spec.businessId} 已被删除或认证资料被移除`);
    await createAccountViaUi(ctx, spec);
    rows = await poll(
      () => readAccounts(ctx, spec.businessId),
      (items) => items.some((account) => account.businessId === spec.businessId),
      `账户 ${spec.businessId} 创建`,
    );
    existing = rows.find((account) => account.businessId === spec.businessId) as ApiAccount;
    record = { businessId: spec.businessId, status: 'active', ready: false };
    manifest.accounts.push(record);
    await saveManifest(manifest);
  }
  if (!record) throw new Error(`账户 ${spec.businessId} 缺少 manifest 记录`);
  if (existing.username !== spec.username || existing.name !== spec.name) {
    fail(`账户 ${spec.businessId} 的用户名或姓名已被修改`);
  }
  if (record.ready) {
    if (existing.status !== spec.status) fail(`账户 ${spec.businessId} 的状态已被修改`);
    return;
  }
  if (existing.status !== spec.status) {
    await setAccountStatus(ctx, spec.businessId, spec.status);
  }
  record.status = spec.status;
  record.ready = true;
  await saveManifest(manifest);
}

test('assets build: connectors, tools, skills, plugin, accounts', {
  session: 'admin',
  tags: ['build'],
}, async ({ app, screen, browser }) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', '仅由 pnpm dev:data 启用');
  // 同源 API 读取走 browser.evaluate，必须先打开页面，不能只靠后面的 app.open。
  await app.open('/');
  const ctx: Ctx = { app, screen, browser };
  const manifest = await loadManifest();

  const users = await ensureServer(ctx, manifest, usersServer);
  await ensureTools(ctx, manifest, users.server, users.created);
  await ensureConnectionState(ctx, manifest, usersServer, true);

  await ensureServer(ctx, manifest, legacyServer);
  await ensureConnectionState(ctx, manifest, legacyServer, false);

  for (const spec of skills) await ensureSkill(ctx, manifest, spec);
  await ensurePlugin(ctx, manifest);
  for (const spec of accounts) await ensureAccount(ctx, manifest, spec);
});
