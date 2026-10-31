/**
 * 青禾采购与售后协作演示数据集（业务分片）。
 *
 * - 只由本文件负责：5 个专家、专家绑定/规则/风格/记忆、聊天/审批/停止/成果/分享、
 *   评估、定时任务、记忆审核。资产、知识库、运行环境由其他分片构建，这里按固定
 *   dataset 身份从 API 定位，不依赖未定的分片键。
 * - build：E2E_DEV_DATA=1 且 E2E_DEV_DATA_VERIFY!=1，真实 UI/业务 API 产生数据；固定 slug 与
 *   场景标记保证重跑复用，已发起的有成本运行不重发。
 * - verify：E2E_DEV_DATA=1 且 E2E_DEV_DATA_VERIFY=1，严格只读，不调模型、不启动评估、不同步调度、
 *   不测试连接。发现缺口直接失败，不用 catch 把缺口变成全绿。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { api, DATASET_ID, datasetPath } from '../support/business-dataset.js';

interface AgentRef {
  id: string;
  slug: string;
  name: string;
}

/** `/api/agents` 列表摘要含身份与委派关系；不含提示词、绑定、限制或密钥。 */
interface AgentSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdBy: string;
  ownerBusinessId: string;
  slug: string;
  role: string;
  model: string;
  uiFormat: 'markdown' | 'openui';
  parentId: string | null;
  createdAt: string;
}

interface AgentDetail extends AgentSummary {
  slug: string;
  model: string;
  systemPrompt: string;
  uiFormat: 'markdown' | 'openui';
  runtimeEnvironmentId: string | null;
  serverIds: string[];
  skillIds: string[];
  subAgentIds: string[];
  pluginBindings: Array<{ pluginId: string }>;
  timeoutMs: number;
}

interface ConnectorRef {
  id: string;
  name: string;
  tools: Array<{ name: string; method: string; requiresApproval: boolean; enabled: boolean }>;
}

interface ScenarioState {
  status: 'pending' | 'starting' | 'running' | 'done' | 'failed' | 'blocked';
  marker: string;
  agentId?: string;
  conversationId?: string;
  runId?: string;
  messageId?: string;
  detail?: string;
}

interface BusinessManifest {
  datasetId: string;
  version: 1;
  origin: string | null;
  actor: { businessId: string | null; username: string | null };
  models: Record<'main' | 'sub' | 'openui' | 'fault', string> & { gatewayVerified: boolean };
  entities: {
    agents: Partial<Record<AgentKey, AgentRef>>;
    skills: Array<{ id: string; slug: string; name: string }>;
    plugin: { id: string; slug: string; name: string } | null;
    readOnlyConnector: ConnectorRef | null;
    approvalConnector: ConnectorRef | null;
    knowledge: { baseId: string; slug: string; serverId: string | null } | null;
    runtimeEnvironment: { id: string; name: string; onlineVersionId: string | null } | null;
  };
  relations: {
    mainSubAgentIds: string[];
    mainSkillIds: string[];
    mainPluginIds: string[];
    mainServerIds: string[];
    mainRuntimeEnvironmentId: string | null;
    mainRules: string[];
    mainOutputStyles: string[];
    mainMemoryFiles: string[];
  };
  initialization: Partial<
    Record<AgentKey, { status: 'creating' | 'configuring' | 'complete'; id?: string }>
  >;
  timeoutOverride: { agentId: string; original: number; dirty: boolean } | null;
  schedules: Array<{ id: string; marker: string; runId: string | null }>;
  scenarios: Partial<Record<ScenarioKey, ScenarioState>>;
  eval: {
    status: 'pending' | 'starting' | 'recorded';
    caseIds: string[];
    runId: string | null;
    expectedStatus: 'failed';
    expectedPassed: 1;
    expectedTotal: 2;
  };
  memoryReview: {
    key: string;
    runId: string | null;
    appliedChangeId: string | null;
    appliedContent?: string;
  } | null;
  shares: { conversationId: string | null; runId: string | null; path: string | null };
  gaps: string[];
  status: 'partial' | 'complete';
  updatedAt: string;
}

type AgentKey = 'main' | 'sub' | 'openui' | 'disabled' | 'fault';
type ScenarioKey =
  | 'purchase-success'
  | 'openui-board'
  | 'approval-approved'
  | 'approval-cancel'
  | 'stop'
  | 'timeout'
  | 'failed'
  | 'schedule-trigger';

const AGENT_DEFS: Record<
  AgentKey,
  { slug: string; name: string; role: string; model: string; prompt: string; enabled: boolean }
> = {
  main: {
    slug: `${DATASET_ID}-main`,
    name: '【青禾演示】采购主专家',
    role: '通用助手',
    model: 'group/sonnet',
    prompt:
      '你是青禾商贸的采购主专家。围绕虚构采购单 QH-PO-2026-001（云杉包装、竹纤维随行杯）做采购评审、交付跟踪和售后协作。' +
      '需要查下游联系人时调用已绑定的只读工具；交付结论写入 /mnt/outputs/ 下的 Markdown 文件。只处理虚构演示数据。',
    enabled: true,
  },
  sub: {
    slug: `${DATASET_ID}-supplier-analyst`,
    name: '【青禾演示】供应商分析子专家',
    role: '数据分析师',
    model: 'group/flash',
    prompt:
      '你是供应商分析子专家。比较云杉包装的报价、交期与质量约定，输出简短、可核对的结论。不要编造真实公司信息。',
    enabled: true,
  },
  openui: {
    slug: `${DATASET_ID}-openui-board`,
    name: '【青禾演示】OpenUI 售后看板',
    role: '数据分析师',
    model: 'group/sonnet',
    prompt:
      '你负责生成售后处理看板。使用 OpenUI Lang 输出一个包含指标卡和表格的看板，标题固定为「售后处理看板」。',
    enabled: true,
  },
  disabled: {
    slug: `${DATASET_ID}-legacy-service`,
    name: '【青禾演示】旧客服（已停用）',
    role: '群聊答疑专员',
    model: 'group/flash',
    prompt: '这是已停用的旧客服专家，只作为停用状态演示。',
    enabled: false,
  },
  fault: {
    slug: `${DATASET_ID}-fault-drill`,
    name: '【青禾演示】故障演练',
    role: '测试工程师',
    model: 'devdata-qinghe-v1-invalid-model',
    prompt: '故障演练专家；配置了不存在的模型，用于验证真实失败结果。',
    enabled: true,
  },
};

const MAIN_MODEL = AGENT_DEFS.main.model;
const SUB_MODEL = AGENT_DEFS.sub.model;
const OPENUI_MODEL = AGENT_DEFS.openui.model;
const FAULT_MODEL = AGENT_DEFS.fault.model;

const PURCHASE_ATTACHMENT = `tests/fixtures/dev-data/业务附件/${'QH-PO-2026-001'}-采购单.md`;

const MEMORY_INDEX = `# 青禾采购主专家记忆索引\n\n- [采购策略](procurement-strategy.md)：虚构采购单 QH-PO-2026-001 的验收、交付与售后要点。\n`;
const MEMORY_THEME = `# 采购策略\n\n- 供应商：云杉包装（虚构）。\n- 物料：竹纤维随行杯、杯垫、牛皮纸外箱。\n- 首件样品 2026-03-12 前确认；大货分两批，间隔 2 天。\n- 抽检 5%，密封性与容量偏差超 3% 整批退回。\n- 延迟交付按未交付金额每日 0.5% 计违约金，上限 10%。\n`;
const RULE_CONTENT = `# 采购评审规则\n\n- 所有金额、数量与交期必须能追溯到采购单 QH-PO-2026-001 或附件。\n- 不得引入真实公司、真实联系人或真实报价。\n- 交付结论必须给出下一步责任人和时间点。\n`;
const STYLE_BODY = `采购简报输出风格：\n\n- 先给一句结论，再列风险与下一步。\n- 数字保留两位小数，金额使用人民币。\n- 不写客套话，不复述附件全文。\n`;

function manifestPath(): string {
  return resolve(process.cwd(), datasetPath('business'));
}

function emptyManifest(origin: string | null): BusinessManifest {
  return {
    datasetId: DATASET_ID,
    version: 1,
    origin,
    actor: { businessId: null, username: null },
    models: {
      main: MAIN_MODEL,
      sub: SUB_MODEL,
      openui: OPENUI_MODEL,
      fault: FAULT_MODEL,
      gatewayVerified: false,
    },
    entities: {
      agents: {},
      skills: [],
      plugin: null,
      readOnlyConnector: null,
      approvalConnector: null,
      knowledge: null,
      runtimeEnvironment: null,
    },
    relations: {
      mainSubAgentIds: [],
      mainSkillIds: [],
      mainPluginIds: [],
      mainServerIds: [],
      mainRuntimeEnvironmentId: null,
      mainRules: [],
      mainOutputStyles: [],
      mainMemoryFiles: [],
    },
    initialization: {},
    timeoutOverride: null,
    schedules: [],
    scenarios: {},
    eval: {
      status: 'pending',
      caseIds: [],
      runId: null,
      expectedStatus: 'failed',
      expectedPassed: 1,
      expectedTotal: 2,
    },
    memoryReview: null,
    shares: { conversationId: null, runId: null, path: null },
    gaps: [],
    status: 'partial',
    updatedAt: new Date().toISOString(),
  };
}

function readManifest(): BusinessManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath(), 'utf8')) as BusinessManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function saveManifest(manifest: BusinessManifest): void {
  manifest.updatedAt = new Date().toISOString();
  mkdirSync(dirname(manifestPath()), { recursive: true });
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  const value = content as { text?: unknown; attachments?: unknown } | null;
  if (value && typeof value.text === 'string') return value.text;
  return JSON.stringify(content);
}

function isTerminal(status: string): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'timeout'
  );
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

interface RunDetail {
  run: {
    id: string;
    agentId: string;
    status: string;
    trigger: string;
    error: string | null;
    errorKind: string | null;
  };
  conversation: { id: string } | null;
}

interface ConversationDetail {
  conversation: { id: string; agentId: string; title: string };
  messages: Array<{
    id: string;
    role: string;
    content: unknown;
    runId: string | null;
    uiFormat: 'markdown' | 'openui';
    uiProgram: string | null;
  }>;
}

interface ApprovalItem {
  id: string;
  serverId: string;
  serverName: string | null;
  toolName: string;
  approvedAt: string | null;
  waiting: boolean;
}

interface OutputFile {
  runId: string;
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
  createdAt: string;
}

interface ScheduleItem {
  id: string;
  agentId: string;
  agentName: string | null;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextDueAt: string | null;
}

interface ShareItem {
  id: string;
  runId: string;
  path: string;
  revokedAt: string | null;
  urlPath: string;
}

interface EvalCaseItem {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
}

interface EvalRunDetail {
  evalRun: {
    id: string;
    agentId: string;
    status: string;
    total: number;
    passed: number;
    error: string | null;
  };
  results: Array<{
    name: string;
    prompt: string;
    expectation: string;
    passed: boolean;
    output: string;
    runId: string | null;
  }>;
}

interface MemoryReviewDetail {
  runId: string;
  modelAgentId: string;
  target: Record<string, unknown>;
  status: string;
  decision: 'pending' | 'applied' | 'rejected';
  proposal: unknown;
  appliedChangeId: string | null;
  error: string | null;
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(
    `${label} 未在 ${Math.round(timeoutMs / 1000)}s 内达到预期：${JSON.stringify(last)}`,
  );
}

/** 列表摘要含身份与 parentId；提示词、绑定等配置仍只在详情里。 */
function agentDetail(browser: Parameters<typeof api>[0], id: string): Promise<AgentDetail> {
  return api<AgentDetail>(browser, `/api/agents/${id}`);
}

/** 只返回精确同名候选；调用方仍需逐个核对详情后才能认领，不盲接管。 */
async function agentCandidates(
  browser: Parameters<typeof api>[0],
  name: string,
): Promise<AgentDetail[]> {
  const summaries = await api<AgentSummary[]>(browser, '/api/agents');
  const candidates: AgentDetail[] = [];
  for (const summary of summaries.filter((item) => item.name === name)) {
    candidates.push(await agentDetail(browser, summary.id));
  }
  return candidates;
}

async function waitForTerminalRun(
  browser: Parameters<typeof api>[0],
  runId: string,
  timeoutMs = 10 * 60_000,
): Promise<RunDetail> {
  return waitFor(
    () => api<RunDetail>(browser, `/api/runs/${runId}`),
    (detail) => isTerminal(detail.run.status),
    `运行 ${runId} 进入终态`,
    timeoutMs,
    3_000,
  );
}

async function findConversationByMarker(
  browser: Parameters<typeof api>[0],
  agentId: string,
  marker: string,
): Promise<{ conversationId: string; messageId: string; runId: string | null } | null> {
  const search = await api<{ items: Array<{ id: string }> }>(
    browser,
    `/api/conversations/search?q=${encodeURIComponent(marker)}&agentId=${encodeURIComponent(agentId)}&limit=50`,
  );
  for (const item of search.items) {
    // 历史默认只取最近 50 条；标记是首条用户消息，长会话必须按 before 回溯。
    let before: string | undefined;
    for (;;) {
      const detail = await api<ConversationDetail>(
        browser,
        `/api/conversations/${item.id}?limit=100${
          before === undefined ? '' : `&before=${encodeURIComponent(before)}`
        }`,
      );
      const message = detail.messages.find(
        (entry) => entry.role === 'user' && textOf(entry.content).includes(marker),
      );
      if (message) {
        return {
          conversationId: item.id,
          messageId: message.id,
          runId: message.runId,
        };
      }
      if (detail.messages.length < 100) break;
      before = detail.messages[0]?.id;
      if (!before) break;
    }
  }
  return null;
}

async function fetchModels(): Promise<{ ok: boolean; ids: string[] }> {
  const base = process.env.ANTHROPIC_BASE_URL;
  if (!base) return { ok: false, ids: [] };
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/v1/models`, {
      headers: {
        authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? ''}`,
      },
    });
    if (!response.ok) return { ok: false, ids: [] };
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return { ok: true, ids: (body.data ?? []).flatMap((item) => (item.id ? [item.id] : [])) };
  } catch {
    return { ok: false, ids: [] };
  }
}

async function evaluateFetch<T>(
  browser: Parameters<typeof api>[0],
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown },
): Promise<T> {
  const script = `(async () => {
    const response = await fetch(${JSON.stringify(path)}, ${JSON.stringify({
      method: init.method,
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })});
    const text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + text.slice(0, 300));
    return text ? JSON.parse(text) : null;
  })()`;
  return (await browser.evaluate(script)) as T;
}

function originOf(appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  try {
    return new URL(appUrl).origin;
  } catch {
    return null;
  }
}

// 仅在付费调度前启动；IPC 断开也会执行，避免测试进程被杀后持续触发。
const SCHEDULE_PAUSE_GUARD = `
let stopping = false;
process.on('disconnect', () => { stopping = true; });
process.on('message', async (input) => {
  if (input.stop) { stopping = true; return; }
  const { origin, cookie, id, lastRunAt } = input;
  const deadline = Date.now() + 75000;
  const request = async (path, init = {}) => {
    const response = await fetch(origin + path, {
      ...init, headers: { cookie, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('调度暂停守护 HTTP ' + response.status);
    return response.json();
  };
  let ready = false;
  for (;;) {
    try {
      const item = (await request('/api/schedules')).find((entry) => entry.id === id);
      if (!item) throw new Error('调度暂停守护找不到任务');
      if (!ready) { process.send?.({ ready: true }); ready = true; }
      if (stopping || Date.now() >= deadline || item.lastRunAt !== lastRunAt) {
        stopping = true;
        await request('/api/schedules/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
        const confirmed = (await request('/api/schedules')).find((entry) => entry.id === id);
        if (confirmed && !confirmed.enabled) process.exit(0);
      }
    } catch (error) { console.error(String(error)); if (!ready) process.exit(1); stopping = true; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
});
`;

test('business dataset build: five experts, chat/approval/stop/share, eval, schedules, memory review', {
  session: 'admin',
  timeout: 40 * 60_000,
}, async ({ app, screen, browser }) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', '专用数据构建：设置 E2E_DEV_DATA=1 才运行');
  test.skip(process.env.E2E_DEV_DATA_VERIFY === '1', 'E2E_DEV_DATA_VERIFY=1 只做只读验收');

  const origin = originOf(app.baseUrl);
  const manifest = readManifest() ?? emptyManifest(origin);
  if (manifest.datasetId !== DATASET_ID || manifest.origin !== origin)
    throw new Error('business manifest 身份或 origin 不一致');
  const gaps = new Set<string>();
  const save = (): void => saveManifest(manifest);

  await app.open('/agents');
  const me = await api<{ authenticated: boolean; user?: { businessId: string; username: string } }>(
    browser,
    '/api/auth/me',
  );
  if (!me.authenticated || !me.user) throw new Error('E2E 管理员会话未生效');
  if (manifest.actor.businessId && manifest.actor.businessId !== me.user.businessId)
    throw new Error('business manifest 主体与当前账户不一致');
  manifest.actor = { businessId: me.user.businessId, username: me.user.username };
  const interruptedSchedules = await api<ScheduleItem[]>(browser, '/api/schedules');
  for (const record of manifest.schedules) {
    const item = interruptedSchedules.find((schedule) => schedule.id === record.id);
    if (item?.enabled) {
      if (
        !item.prompt.includes(record.marker) ||
        item.agentId !== manifest.entities.agents.main?.id
      )
        throw new Error('中断调度身份冲突，未修改');
      await api(browser, `/api/schedules/${item.id}`, {
        method: 'PATCH',
        body: { enabled: false },
      });
      const current = (await api<ScheduleItem[]>(browser, '/api/schedules')).find(
        (schedule) => schedule.id === item.id,
      );
      if (!current || current.enabled) throw new Error('中断调度暂停未确认');
    }
  }

  const restoreTimeout = async (): Promise<void> => {
    const override = manifest.timeoutOverride;
    if (!override?.dirty) return;
    const current = await api<{ timeoutMs: number }>(browser, `/api/agents/${override.agentId}`);
    if (current.timeoutMs === 1) {
      await api(browser, `/api/agents/${override.agentId}`, {
        method: 'PATCH',
        body: { timeoutMs: override.original },
      });
    } else if (current.timeoutMs !== override.original) {
      throw new Error('timeout 临时修改恢复冲突：开发者已修改原值，未覆盖');
    }
    override.dirty = false;
    save();
  };
  await restoreTimeout();

  // 模型必须来自真实网关 /v1/models，不猜。
  const gateway = await fetchModels();
  manifest.models.gatewayVerified =
    gateway.ok &&
    [MAIN_MODEL, SUB_MODEL, OPENUI_MODEL].every((model) => gateway.ids.includes(model)) &&
    !gateway.ids.includes(FAULT_MODEL);
  if (!manifest.models.gatewayVerified) {
    gaps.add(
      `模型网关核对失败：${gateway.ok ? gateway.ids.join(',') : '无法读取 /v1/models'}；期望包含 ${MAIN_MODEL}/${SUB_MODEL}/${OPENUI_MODEL} 且不含 ${FAULT_MODEL}`,
    );
  }
  save();
  if (!manifest.models.gatewayVerified) {
    manifest.status = 'partial';
    manifest.gaps = [...gaps];
    save();
    throw new Error(`模型网关核对失败，未发起任何有成本运行：${[...gaps].join('；')}`);
  }

  // 定位其他分片构建的资产：按 dataset 身份过滤，不依赖未定分片键。
  const skills = (
    await api<Array<{ id: string; slug: string; name: string }>>(browser, '/api/skills')
  )
    .filter((item) => item.slug.startsWith(DATASET_ID))
    .slice(0, 2);
  const plugins = (
    await api<Array<{ id: string; slug: string; name: string }>>(browser, '/api/plugins')
  ).filter((item) => item.slug.startsWith(DATASET_ID));
  const servers = await api<
    Array<{ id: string; name: string; kind: string; config?: { knowledgeBaseId?: string } }>
  >(browser, '/api/servers');
  const datasetServers = servers.filter((item) =>
    `${item.name} ${'slug' in item ? String((item as { slug?: string }).slug ?? '') : ''}`.includes(
      DATASET_ID,
    ),
  );
  const generatedServers = datasetServers.filter((item) => item.kind === 'generated');
  const knowledgeBases = (
    await api<{ items: Array<{ id: string; slug: string; name: string }> }>(
      browser,
      '/api/knowledge/bases?limit=200',
    )
  ).items.filter((item) => item.slug.startsWith(DATASET_ID));
  const profiles = await api<Array<{ id: string; kind: string; enabled: boolean }>>(
    browser,
    '/api/knowledge/model-profiles',
  );
  const runtimeEnvironments = (
    await api<Array<{ id: string; name: string; onlineVersionId: string | null }>>(
      browser,
      '/api/runtime-environments',
    )
  ).filter((item) => item.name.includes(DATASET_ID) || item.name.includes('【青禾演示】'));
  const knowledgeBase = knowledgeBases[0] ?? null;
  const knowledgeServer =
    knowledgeBase === null
      ? null
      : (servers.find(
          (item) => item.kind === 'knowledge' && item.config?.knowledgeBaseId === knowledgeBase.id,
        ) ?? null);

  if (skills.length < 2) gaps.add(`缺少 2 个 ${DATASET_ID} 技能，实际 ${skills.length}`);
  if (plugins.length < 1) gaps.add(`缺少 ${DATASET_ID} 插件`);
  if (generatedServers.length < 1) gaps.add(`缺少 ${DATASET_ID} 生成连接器`);
  if (knowledgeBases.length < 1) gaps.add(`缺少 ${DATASET_ID} 知识库`);
  else if (!knowledgeServer) gaps.add('知识库存在但缺少对应的内置知识 server');
  if (!profiles.some((item) => item.kind === 'embedding' && item.enabled)) {
    gaps.add('知识链路缺口：没有启用的 embedding profile，知识库无法真实 ready');
  }
  if (runtimeEnvironments.length < 1) gaps.add(`缺少 ${DATASET_ID} 专用运行环境`);
  const runtimeManifest = JSON.parse(readFileSync(datasetPath('runtime'), 'utf8')) as {
    dataset: string;
    runtimeEnvironmentId: string;
    publishedVersionId: string | null;
  };
  const onlineEnvironment = must(
    runtimeEnvironments.find((item) => item.id === runtimeManifest.runtimeEnvironmentId),
    'runtime manifest 的专用环境不存在',
  );
  if (
    runtimeManifest.dataset !== DATASET_ID ||
    !runtimeManifest.publishedVersionId ||
    onlineEnvironment.onlineVersionId !== runtimeManifest.publishedVersionId
  ) {
    throw new Error('runtime manifest 与专用环境线上版本不一致');
  }
  const onlineVersion = await api<{ status: string }>(
    browser,
    `/api/runtime-environments/${onlineEnvironment.id}/versions/${runtimeManifest.publishedVersionId}`,
  );
  if (onlineVersion.status !== 'ready') throw new Error('专用环境线上版本不是 ready');

  let readOnlyConnector: ConnectorRef | null = null;
  let approvalConnector: ConnectorRef | null = null;
  for (const server of generatedServers) {
    const tools = await api<ConnectorRef['tools']>(browser, `/api/servers/${server.id}/tools`);
    const ref: ConnectorRef = { id: server.id, name: server.name, tools };
    if (tools.some((tool) => tool.enabled && tool.requiresApproval && tool.method === 'GET'))
      approvalConnector ??= ref;
    if (tools.some((tool) => tool.enabled && !tool.requiresApproval && tool.method === 'GET'))
      readOnlyConnector ??= ref;
  }
  if (!readOnlyConnector) gaps.add('没有可用的只读生成连接器工具（GET 且无需审批）');
  if (!approvalConnector) gaps.add('没有 requiresApproval 工具，无法产生真实审批场景');

  manifest.entities.skills = skills;
  manifest.entities.plugin = plugins[0] ?? null;
  manifest.entities.readOnlyConnector = readOnlyConnector;
  manifest.entities.approvalConnector = approvalConnector;
  manifest.entities.knowledge = knowledgeBase
    ? { baseId: knowledgeBase.id, slug: knowledgeBase.slug, serverId: knowledgeServer?.id ?? null }
    : null;
  manifest.entities.runtimeEnvironment = onlineEnvironment
    ? {
        id: onlineEnvironment.id,
        name: onlineEnvironment.name,
        onlineVersionId: onlineEnvironment.onlineVersionId,
      }
    : null;
  manifest.gaps = [...gaps];
  save();

  const missingAssets = [...gaps].filter((gap) => !gap.includes('知识'));
  if (missingAssets.length)
    throw new Error(`业务前置资产缺失，未初始化专家：${missingAssets.join('；')}`);

  // 主专家代表性链路必须先走 UI：创建。
  const conflict = (message: string): never => {
    throw new Error(`业务数据冲突（未覆盖）：${message}`);
  };
  const sameIds = (actual: string[], expected: string[]): boolean =>
    actual.length === expected.length && actual.every((id) => expected.includes(id));
  const mainIdentityMatches = (detail: AgentDetail): boolean =>
    detail.slug === AGENT_DEFS.main.slug &&
    detail.name === AGENT_DEFS.main.name &&
    detail.model === MAIN_MODEL &&
    detail.systemPrompt === AGENT_DEFS.main.prompt &&
    detail.enabled;
  // manifest 已有 ID 时以详情身份核对；没有 ID 时只认精确名称候选 + 详情，不盲接管。
  let mainAgent: AgentRef | null = null;
  if (manifest.entities.agents.main?.id) {
    const recorded = await agentDetail(browser, manifest.entities.agents.main.id);
    if (!mainIdentityMatches(recorded)) conflict('主专家身份或内容已变化');
    mainAgent = { id: recorded.id, slug: recorded.slug, name: recorded.name };
  } else {
    const matched = (await agentCandidates(browser, AGENT_DEFS.main.name)).filter(
      mainIdentityMatches,
    );
    if (matched.length > 1) conflict('按名称找到多个主专家候选');
    const found = matched[0];
    if (found) {
      mainAgent = { id: found.id, slug: found.slug, name: found.name };
      if (manifest.initialization.main?.status === 'creating') {
        manifest.initialization.main = { status: 'configuring', id: found.id };
        save();
      }
    }
  }
  if (!mainAgent) {
    if (manifest.initialization.main) conflict('主专家初始化已有记录但对象不存在');
    manifest.initialization.main = { status: 'creating' };
    save();
    await app.open('/agents');
    await screen.getByRole('button', '新建专家').first().tap();
    await browser.locator('#new-agent-name').fill(AGENT_DEFS.main.name);
    await browser.locator('#new-agent-role').click();
    await browser
      .locator('[role="option"]')
      .filter({ hasText: AGENT_DEFS.main.role })
      .first()
      .click();
    await browser.locator('#new-agent-prompt').fill(AGENT_DEFS.main.prompt);
    await screen.getByRole('button', '高级设置', { exact: true }).tap();
    await browser.locator('#new-agent-model').fill(MAIN_MODEL);
    await browser.locator('#new-agent-slug').fill(AGENT_DEFS.main.slug);
    await screen.getByRole('button', '创建', { exact: true }).tap();
    // 创建成功会跳转 /agents/<id>；从真实 URL 取 ID 并立刻登记，不按列表字段猜。
    const pathname = await waitFor(
      () => browser.evaluate<string>('new URL(location.href).pathname'),
      (value) => /^\/agents\/[^/]+$/.test(value),
      '主专家创建跳转',
      60_000,
      500,
    );
    const created = await agentDetail(
      browser,
      decodeURIComponent(must(pathname.split('/').pop(), '主专家创建后 URL 缺少 ID')),
    );
    if (!mainIdentityMatches(created)) conflict('主专家创建后身份不符');
    mainAgent = { id: created.id, slug: created.slug, name: created.name };
    manifest.initialization.main = { status: 'configuring', id: created.id };
    save();
  }
  if (manifest.entities.agents.main?.id && manifest.entities.agents.main.id !== mainAgent.id)
    conflict('主专家 ID 已变化');
  const main: AgentRef = mainAgent;
  manifest.entities.agents.main = main;
  save();

  // 其余专家是显式 fixture，走同一个鉴权业务 API；固定 slug 保证重跑复用。
  const ensureApiAgent = async (key: AgentKey): Promise<AgentRef> => {
    const def = AGENT_DEFS[key];
    const recordedId = manifest.entities.agents[key]?.id ?? manifest.initialization[key]?.id;
    let found: AgentDetail | null;
    if (recordedId) {
      found = await agentDetail(browser, recordedId);
      if (found.slug !== def.slug) conflict(`专家 ${def.slug} ID 已变化`);
    } else {
      const matched = (await agentCandidates(browser, def.name)).filter(
        (detail) => detail.slug === def.slug,
      );
      if (matched.length > 1) conflict(`专家 ${def.slug} 存在多个同名候选`);
      found = matched[0] ?? null;
    }
    if (found) {
      const expectedServers = key === 'sub' && approvalConnector ? [approvalConnector.id] : [];
      if (
        found.name !== def.name ||
        found.enabled !== def.enabled ||
        found.model !== def.model ||
        found.systemPrompt !== def.prompt ||
        found.runtimeEnvironmentId !== onlineEnvironment.id ||
        !sameIds(found.serverIds, expectedServers) ||
        found.uiFormat !== (key === 'openui' ? 'openui' : 'markdown')
      ) {
        conflict(`专家 ${def.slug} 身份、内容或绑定已变化`);
      }
      const initialization = manifest.initialization[key];
      if (initialization && initialization.status !== 'complete') {
        initialization.id = found.id;
        initialization.status = 'complete';
        save();
      }
      return { id: found.id, slug: found.slug, name: found.name };
    }
    if (manifest.initialization[key]) conflict(`专家 ${def.slug} 初始化已有记录但对象不存在`);
    manifest.initialization[key] = { status: 'creating' };
    save();
    const created = await api<{ id: string; slug: string; name: string }>(browser, '/api/agents', {
      method: 'POST',
      body: {
        slug: def.slug,
        name: def.name,
        role: def.role,
        description: '青禾演示数据集固定 fixture',
        runtimeEnvironmentId: onlineEnvironment.id,
        serverIds: key === 'sub' && approvalConnector ? [approvalConnector.id] : [],
        uiFormat: key === 'openui' ? 'openui' : 'markdown',
        model: def.model,
        systemPrompt: def.prompt,
        enabled: def.enabled,
        maxTurns: 8,
        maxBudgetUsd: 0.5,
        timeoutMs: 120_000,
      },
    });
    manifest.initialization[key] = { status: 'complete', id: created.id };
    manifest.entities.agents[key] = { id: created.id, slug: created.slug, name: created.name };
    save();
    return { id: created.id, slug: created.slug, name: created.name };
  };

  const sub = await ensureApiAgent('sub');
  const openui = await ensureApiAgent('openui');
  const disabled = await ensureApiAgent('disabled');
  const fault = await ensureApiAgent('fault');
  manifest.entities.agents = { main, sub, openui, disabled, fault };
  save();

  // 主专家绑定：代表性链路走 UI，包含子专家、技能、插件、连接器、知识库、运行环境。
  const initializingMain =
    manifest.initialization.main?.status === 'configuring' &&
    manifest.initialization.main.id === main.id;
  const preBindings = await api<{
    name: string;
    model: string;
    enabled: boolean;
    systemPrompt: string;
    uiFormat: string;
    serverIds: string[];
    skillIds: string[];
    subAgentIds: string[];
    pluginBindings: Array<{ pluginId: string }>;
    runtimeEnvironmentId: string | null;
  }>(browser, `/api/agents/${main.id}`);
  if (
    preBindings.name !== AGENT_DEFS.main.name ||
    preBindings.model !== MAIN_MODEL ||
    !preBindings.enabled ||
    preBindings.systemPrompt !== AGENT_DEFS.main.prompt ||
    preBindings.uiFormat !== 'markdown'
  ) {
    conflict('主专家身份或内容已变化');
  }
  const expectedMainServers = [
    ...new Set([
      ...(readOnlyConnector ? [readOnlyConnector.id] : []),
      ...(knowledgeServer ? [knowledgeServer.id] : []),
    ]),
  ];
  const expectedBindings = {
    serverIds: expectedMainServers,
    skillIds: skills.map((item) => item.id),
    subAgentIds: [sub.id],
    pluginIds: plugins[0] ? [plugins[0].id] : [],
  };
  for (const [actual, expected] of [
    [preBindings.serverIds, expectedBindings.serverIds],
    [preBindings.skillIds, expectedBindings.skillIds],
    [preBindings.subAgentIds, expectedBindings.subAgentIds],
    [preBindings.pluginBindings.map((item) => item.pluginId), expectedBindings.pluginIds],
  ] as const) {
    if (
      initializingMain ? actual.some((id) => !expected.includes(id)) : !sameIds(actual, expected)
    ) {
      conflict('主专家绑定与数据集契约不符');
    }
  }
  if (
    preBindings.runtimeEnvironmentId !== onlineEnvironment.id &&
    !(initializingMain && preBindings.runtimeEnvironmentId === null)
  )
    conflict('主专家运行环境已变化');
  if (initializingMain) {
    await app.open(`/agents/${main.id}`);
    await screen.getByRole('heading', { level: 1, name: main.name }).waitFor();
    await screen.getByRole('button', '能力', { exact: false }).tap();
    const pickComboboxOption = async (label: string, option: string): Promise<void> => {
      await screen.getByRole('combobox', label).tap();
      await browser.locator('[role="option"]').filter({ hasText: option }).first().click();
      await browser.keyboard.press('Escape');
    };
    for (const skill of skills) {
      if (!preBindings.skillIds.includes(skill.id)) await pickComboboxOption('技能', skill.name);
    }
    if (
      plugins[0] &&
      !preBindings.pluginBindings.some((item) => item.pluginId === plugins[0]?.id)
    ) {
      await pickComboboxOption('插件', plugins[0].name);
    }
    // 子智能体选择器依赖列表摘要里的 parentId；控件不渲染即真实缺陷，直接失败。
    const subCombobox = screen.getByRole('combobox', '子智能体');
    await subCombobox.waitFor();
    if (!preBindings.subAgentIds.includes(sub.id)) {
      await pickComboboxOption('子智能体', sub.name);
    } else {
      await screen.getByRole('button', { name: `移除 ${sub.name}` }).waitFor();
    }
    if (readOnlyConnector && !preBindings.serverIds.includes(readOnlyConnector.id)) {
      await pickComboboxOption('MCP Server', readOnlyConnector.name);
    }
    if (knowledgeServer && knowledgeBase && !preBindings.serverIds.includes(knowledgeServer.id)) {
      await pickComboboxOption('知识库', knowledgeBase.name);
    }
    if (onlineEnvironment && preBindings.runtimeEnvironmentId !== onlineEnvironment.id) {
      await screen.getByRole('button', '运行限制', { exact: true }).tap();
      await browser.locator('#agent-runtime-environment').click();
      await browser
        .locator('[role="option"]')
        .filter({ hasText: onlineEnvironment.name })
        .first()
        .click();
    }
    const saveButton = screen.getByRole('button', '保存更改').first();
    if (await saveButton.isEnabled()) {
      await saveButton.tap();
      await expect(screen.getByText('智能体已保存')).toBeVisible({ timeout: 30_000 });
    }
  }

  // 仅自己未完成的初始化允许补齐文件；完成后只核对。
  const existingRules = await api<Array<{ slug: string; content: string }>>(
    browser,
    `/api/agents/${main.id}/rules`,
  );
  const rule = existingRules.find((item) => item.slug === 'procurement-guard');
  if (!rule) {
    if (!initializingMain) conflict('采购规则缺失');
    await api(browser, `/api/agents/${main.id}/rules/procurement-guard`, {
      method: 'PUT',
      body: { content: RULE_CONTENT, globs: '**/*.md' },
    });
  } else if (rule.content !== RULE_CONTENT) {
    gaps.add(`规则 procurement-guard 已被修改，未覆盖`);
  }
  const existingStyles = await api<Array<{ slug: string; body: string; isSelected: boolean }>>(
    browser,
    `/api/agents/${main.id}/output-styles`,
  );
  const style = existingStyles.find((item) => item.slug === 'procurement-brief');
  if (!style) {
    if (!initializingMain || existingStyles.some((item) => item.isSelected))
      conflict('输出风格缺失或已选择其他风格');
    await api(browser, `/api/agents/${main.id}/output-styles/procurement-brief`, {
      method: 'PUT',
      body: { description: '青禾采购简报', keepCodingInstructions: false, body: STYLE_BODY },
    });
  } else if (style.body !== STYLE_BODY) {
    gaps.add('输出风格「采购简报」已被修改，未覆盖');
  } else if (!style.isSelected) {
    conflict('采购简报风格不再选中');
  }
  const memoryNames = new Set(
    (
      await api<{ files: Array<{ name: string }> }>(browser, `/api/agents/${main.id}/memory`)
    ).files.map((item) => item.name),
  );
  for (const [name, content] of [
    ['procurement-strategy.md', MEMORY_THEME],
    ['MEMORY.md', MEMORY_INDEX],
  ] as const) {
    if (!memoryNames.has(name)) {
      if (!initializingMain) conflict(`专家记忆 ${name} 缺失`);
      await api(browser, `/api/agents/${main.id}/memory/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: { content },
      });
      continue;
    }
    const current = await api<{ content: string }>(
      browser,
      `/api/agents/${main.id}/memory/${encodeURIComponent(name)}`,
    );
    const expectedContent =
      name === 'procurement-strategy.md'
        ? (manifest.memoryReview?.appliedContent ?? content)
        : content;
    if (current.content !== expectedContent) gaps.add(`专家记忆 ${name} 已被修改，未覆盖`);
  }

  const mainDetail = await api<{
    serverIds: string[];
    skillIds: string[];
    subAgentIds: string[];
    pluginBindings: Array<{ pluginId: string }>;
    runtimeEnvironmentId: string | null;
    model: string;
  }>(browser, `/api/agents/${main.id}`);
  if (
    !sameIds(mainDetail.serverIds, expectedBindings.serverIds) ||
    !sameIds(mainDetail.skillIds, expectedBindings.skillIds) ||
    !sameIds(mainDetail.subAgentIds, expectedBindings.subAgentIds) ||
    !sameIds(
      mainDetail.pluginBindings.map((item) => item.pluginId),
      expectedBindings.pluginIds,
    ) ||
    mainDetail.runtimeEnvironmentId !== onlineEnvironment.id
  )
    conflict('主专家保存后绑定未满足契约');
  if (gaps.size === 0 || [...gaps].every((gap) => gap.includes('知识'))) {
    if (initializingMain) manifest.initialization.main = { status: 'complete', id: main.id };
  }
  manifest.relations = {
    mainSubAgentIds: mainDetail.subAgentIds,
    mainSkillIds: mainDetail.skillIds,
    mainPluginIds: mainDetail.pluginBindings.map((item) => item.pluginId),
    mainServerIds: mainDetail.serverIds,
    mainRuntimeEnvironmentId: mainDetail.runtimeEnvironmentId,
    mainRules: ['procurement-guard'],
    mainOutputStyles: ['procurement-brief'],
    mainMemoryFiles: ['MEMORY.md', 'procurement-strategy.md'],
  };
  save();

  // 完整文件预览走 UI。
  await app.open(`/agents/${main.id}`);
  await screen.getByRole('tab', '完整文件', { exact: true }).tap();
  const files = await api<{
    mcpJson: string;
    claudeMd: string;
    agentMd: string;
    skills: Array<{ slug: string; files: Array<{ path: string }> }>;
    subAgents: Array<{ slug: string }>;
    rules: Array<{ slug: string }>;
    outputStyles: Array<{ slug: string }>;
    selectedOutputStyle: string | null;
    plugins: Array<{ slug: string }>;
  }>(browser, `/api/agents/${main.id}/files`);
  await expect(screen.getByRole('navigation', { name: '工作区文件' })).toBeVisible();
  await expect(screen.getByRole('button', { name: '.mcp.json', exact: true })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'agent md', exact: true })).toBeVisible();
  if (files.subAgents[0]) {
    await expect(
      screen.getByRole('button', { name: `agents/${files.subAgents[0].slug}.md`, exact: true }),
    ).toBeVisible();
  }
  if (files.skills[0]) {
    await expect(
      screen.getByRole('button', {
        name: `skills/${files.skills[0].slug}/SKILL.md`,
        exact: true,
      }),
    ).toBeVisible();
  }
  if (files.selectedOutputStyle) {
    await expect(
      screen.getByRole('button', {
        name: `output-styles/${files.selectedOutputStyle}.md`,
        exact: false,
      }),
    ).toBeVisible();
  }

  // 知识链路缺口只记录不断链；其余缺失会让代表链路失真，先失败且不发起有成本运行。
  const blockingGaps = [...gaps].filter((gap) => !gap.includes('知识'));
  if (blockingGaps.length > 0) {
    manifest.status = 'partial';
    manifest.gaps = [...gaps];
    save();
    throw new Error(`业务数据集前置资产不完整，未发起有成本运行：\n- ${blockingGaps.join('\n- ')}`);
  }

  // 场景执行器：先查 manifest，再从业务边界（会话标记）恢复，最后才发新请求。
  const scenario = (key: ScenarioKey): ScenarioState => {
    const next = manifest.scenarios[key] ?? { status: 'pending', marker: `[${DATASET_ID}:${key}]` };
    manifest.scenarios[key] = next;
    return next;
  };

  const resolveExistingScenario = async (
    state: ScenarioState,
    agentId: string,
  ): Promise<RunDetail | null> => {
    if (state.runId) return api<RunDetail>(browser, `/api/runs/${state.runId}`);
    const found = await findConversationByMarker(browser, agentId, state.marker);
    if (!found) return null;
    state.conversationId = found.conversationId;
    state.messageId = found.messageId;
    state.status = found.runId ? 'running' : 'failed';
    state.runId = found.runId ?? undefined;
    save();
    if (!found.runId) return null;
    return api<RunDetail>(browser, `/api/runs/${found.runId}`);
  };

  const saveFromMarker = async (state: ScenarioState, agentId: string): Promise<RunDetail> => {
    const found = await waitFor(
      () => findConversationByMarker(browser, agentId, state.marker),
      (value) => value !== null,
      `${state.marker} 会话落库`,
      90_000,
      2_000,
    );
    const hit = must(found, `${state.marker} 未找到会话`);
    state.conversationId = hit.conversationId;
    state.messageId = hit.messageId;
    if (!hit.runId) throw new Error(`${state.marker} 的会话没有关联运行`);
    state.runId = hit.runId;
    state.status = 'running';
    save();
    return api<RunDetail>(browser, `/api/runs/${hit.runId}`);
  };

  const sendUi = async (agent: AgentRef, message: string, attachment?: string): Promise<void> => {
    await app.open(`/chat?agent=${encodeURIComponent(agent.id)}`);
    const box = screen.getByRole('textbox', '消息');
    await box.waitFor();
    await box.fill(message);
    if (attachment) {
      await browser.locator('input[aria-label="选择资料文件"]').setInputFiles(attachment);
      await expect(screen.getByText('QH-PO-2026-001-采购单.md', { exact: false })).toBeVisible();
    }
    const send = screen.getByRole('button', '发送消息');
    await expect(send).toBeEnabled({ timeout: 30_000 });
    await send.tap();
  };

  const sendApi = async (
    agent: AgentRef,
    message: string,
    attachments?: Array<{ filename: string; dataBase64: string }>,
  ): Promise<{ runId: string; conversationId: string }> =>
    api<{ runId: string; conversationId: string }>(browser, '/api/chat', {
      method: 'POST',
      body: { agentId: agent.id, message, ...(attachments ? { attachments } : {}) },
    });

  const pendingApprovals = async (runId: string): Promise<ApprovalItem[]> =>
    (await api<{ items: ApprovalItem[] }>(browser, `/api/runs/${runId}/approvals`)).items.filter(
      (item) => item.approvedAt === null,
    );

  /** 等到出现待批工具调用或运行终态；可选批准在终态时直接放行。 */
  const waitApprovalOrTerminal = async (
    runId: string,
    timeoutMs = 8 * 60_000,
  ): Promise<
    { kind: 'approval'; items: ApprovalItem[] } | { kind: 'terminal'; run: RunDetail }
  > => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const detail = await api<RunDetail>(browser, `/api/runs/${runId}`);
      if (isTerminal(detail.run.status)) return { kind: 'terminal', run: detail };
      const items = await pendingApprovals(runId);
      if (items.length > 0) return { kind: 'approval', items };
      await sleep(2_000);
    }
    throw new Error(`运行 ${runId} 既没有进入终态，也没有产生审批请求`);
  };

  const ensureScenario = async (input: {
    key: ScenarioKey;
    agent: AgentRef;
    message: string;
    expected: string[];
    mode: 'ui' | 'api';
    attachment?: string;
    interaction?:
      | 'approve-optional'
      | 'approve-required'
      | 'cancel-at-approval'
      | 'stop-after-start';
  }): Promise<ScenarioState> => {
    const state = scenario(input.key);
    if (state.agentId && state.agentId !== input.agent.id)
      conflict(`场景 ${input.key} 的专家已变化`);
    let detail = await resolveExistingScenario(state, input.agent.id);

    if (detail) {
      if (isTerminal(detail.run.status)) {
        if (!input.expected.includes(detail.run.status)) {
          state.status = 'failed';
          state.detail = `运行 ${detail.run.id} 终态为 ${detail.run.status}，期望 ${input.expected.join('/')}`;
          save();
          throw new Error(state.detail);
        }
        state.status = 'done';
        save();
        return state;
      }
    } else {
      if (state.status !== 'pending') {
        throw new Error(`场景 ${input.key} 已标记失败，不自动重试：${state.detail ?? ''}`);
      }
      state.agentId = input.agent.id;
      state.status = 'pending';
      save();
      state.status = 'starting';
      save();
      if (input.mode === 'api') {
        const created = await sendApi(input.agent, `${input.message}\n\n${state.marker}`);
        state.conversationId = created.conversationId;
        state.runId = created.runId;
        state.status = 'running';
        save();
        detail = await api<RunDetail>(browser, `/api/runs/${created.runId}`);
      } else {
        await sendUi(input.agent, `${input.message}\n\n${state.marker}`, input.attachment);
        detail = await saveFromMarker(state, input.agent.id);
      }
    }

    const resolved = must(detail, `场景 ${input.key} 缺少运行详情`);
    if (input.interaction && !isTerminal(resolved.run.status)) {
      // 续跑或 API 发起时页面尚未打开；统一回到该会话再操作审批/停止。
      if (state.conversationId) {
        await app.open(`/chat?conversation=${encodeURIComponent(state.conversationId)}`);
      }
      if (input.interaction === 'stop-after-start') {
        await expect(screen.getByRole('button', '停止运行')).toBeVisible({ timeout: 60_000 });
        await screen.getByRole('button', '停止运行').tap();
      } else {
        const outcome = await waitApprovalOrTerminal(resolved.run.id);
        if (input.interaction === 'cancel-at-approval') {
          if (outcome.kind === 'terminal') {
            throw new Error(`场景 ${input.key} 在出现审批请求前已进入 ${outcome.run.run.status}`);
          }
          await expect(screen.getByRole('button', '停止运行')).toBeVisible({ timeout: 30_000 });
          await screen.getByRole('button', '停止运行').tap();
        } else if (outcome.kind === 'approval') {
          // 代表链路：审批在真实页面点击，不走 API。
          const button = browser.locator('[aria-label^="批准 "]').first();
          await expect(button).toBeVisible({ timeout: 30_000 });
          await button.click();
          await expect(screen.getByText('已批准', { exact: false })).toBeVisible({
            timeout: 30_000,
          });
        } else if (input.interaction === 'approve-required') {
          throw new Error(`场景 ${input.key} 没有产生审批请求就结束了：${outcome.run.run.status}`);
        }
      }
    }

    const terminal = await waitForTerminalRun(browser, resolved.run.id, 12 * 60_000);
    if (!input.expected.includes(terminal.run.status)) {
      state.status = 'failed';
      state.detail = `运行 ${terminal.run.id} 终态为 ${terminal.run.status}，期望 ${input.expected.join('/')}：${terminal.run.error ?? ''}`;
      save();
      throw new Error(state.detail);
    }
    state.status = 'done';
    save();
    return state;
  };

  const readTool = must(
    readOnlyConnector?.tools.find(
      (tool) => tool.enabled && !tool.requiresApproval && tool.method === 'GET',
    ),
    '缺少普通 GET 工具',
  );
  const approvalTool = must(
    approvalConnector?.tools.find(
      (tool) => tool.enabled && tool.requiresApproval && tool.method === 'GET',
    ),
    '缺少审批 GET 工具',
  );

  // 采购成功：真实读取附件、调用只读工具、产出 Markdown 成果。
  const purchase = await ensureScenario({
    key: 'purchase-success',
    agent: main,
    message:
      `请阅读附件采购单，核对云杉包装的竹纤维随行杯数量、单价、交期与验收条款；调用连接器「${readOnlyConnector?.name}」工具 ${readTool.name} 一次，参数为 {"id":1}（整数）。` +
      '然后把采购结论写入 /mnt/outputs/QH-PO-2026-001-采购评审.md，包含金额、分两批交付、抽检与售后风险，并在回复中用一段话总结。',
    expected: ['succeeded'],
    mode: 'ui',
    attachment: PURCHASE_ATTACHMENT,
    interaction: 'approve-optional',
  });

  // 采购成果必须真实发布后才可分享。
  const purchaseConversationId = must(purchase.conversationId, '采购成功场景缺少会话 ID');
  const purchaseRunId = must(purchase.runId, '采购成功场景缺少运行 ID');
  const purchaseOutputs = await waitFor(
    () =>
      api<{ items: OutputFile[] }>(
        browser,
        `/api/conversations/${purchaseConversationId}/outputs?limit=50`,
      ),
    (page) => page.items.some((item) => item.runId === purchaseRunId && item.path.endsWith('.md')),
    '采购 Markdown 成果发布',
    3 * 60_000,
    3_000,
  );
  const purchaseOutput = must(
    purchaseOutputs.items.find((item) => item.runId === purchaseRunId && item.path.endsWith('.md')),
    '采购运行没有 Markdown 成果',
  );
  const purchaseContent = await api<{ content: string }>(
    browser,
    `/api/conversations/${purchaseConversationId}/outputs/${purchaseRunId}/content?path=${encodeURIComponent(purchaseOutput.path)}`,
  );
  if (
    !purchaseContent.content.includes('QH-PO-2026-001') &&
    !purchaseContent.content.includes('云杉')
  ) {
    gaps.add('采购成果内容未引用采购单或供应商');
  }
  manifest.shares = {
    conversationId: purchaseConversationId,
    runId: purchaseRunId,
    path: purchaseOutput.path,
  };
  save();

  // 看板成功：OpenUI 回复由前端渲染。
  await ensureScenario({
    key: 'openui-board',
    agent: openui,
    message:
      '请用 OpenUI Lang 生成「售后处理看板」：顶部 3 个指标卡（待处理、处理中、已解决），下方一张表格列出 3 条虚构售后单（含采购单号 QH-PO-2026-001）。只输出看板。',
    expected: ['succeeded'],
    mode: 'ui',
  });

  // 审批批准 1：连接器工具 requiresApproval=true，批准后运行继续成功。
  if (approvalConnector) {
    await ensureScenario({
      key: 'approval-approved',
      agent: sub,
      message: `请调用连接器「${approvalConnector.name}」的 GET 工具 ${approvalTool.name} 一次，需要人工审批，参数为 {"id":1}（整数），然后复述工具返回结果。`,
      expected: ['succeeded'],
      mode: 'api',
      interaction: 'approve-required',
    });
  } else {
    scenario('approval-approved').status = 'blocked';
    scenario('approval-approved').detail = '缺少 requiresApproval 工具';
    save();
  }

  // 工具审批后取消：出现审批卡片后直接停止，审批不再等待。
  if (approvalConnector) {
    await ensureScenario({
      key: 'approval-cancel',
      agent: sub,
      message: `请再次调用连接器「${approvalConnector.name}」的 GET 工具 ${approvalTool.name}，参数为 {"id":1}（整数），需要人工审批，然后等待批准。`,
      expected: ['cancelled'],
      mode: 'api',
      interaction: 'cancel-at-approval',
    });
  } else {
    scenario('approval-cancel').status = 'blocked';
    scenario('approval-cancel').detail = '缺少 requiresApproval 工具';
  }

  // 停止：运行开始后立刻在输入框发送位点击停止。
  await ensureScenario({
    key: 'stop',
    agent: main,
    message:
      '请写一份 3000 字的采购交付分析，逐段展开供应商产能、物流排期、抽检方案和售后追溯，不要提前结束。',
    expected: ['cancelled'],
    mode: 'ui',
    interaction: 'stop-after-start',
  });

  // 临时修改先记录原值；异常退出后下一轮也只恢复自己留下的 1ms。
  if (scenario('timeout').status === 'pending') {
    const before = await api<{ timeoutMs: number }>(browser, `/api/agents/${main.id}`);
    if (before.timeoutMs === 1) conflict('主专家 timeoutMs 已是 1，不能认领开发者配置');
    manifest.timeoutOverride = { agentId: main.id, original: before.timeoutMs, dirty: true };
    save();
    try {
      await api(browser, `/api/agents/${main.id}`, { method: 'PATCH', body: { timeoutMs: 1 } });
      await ensureScenario({
        key: 'timeout',
        agent: main,
        message: '请统计采购单 QH-PO-2026-001 的全部金额构成。',
        expected: ['timeout'],
        mode: 'api',
      });
    } finally {
      await restoreTimeout();
    }
  } else {
    await ensureScenario({
      key: 'timeout',
      agent: main,
      message: '请统计采购单 QH-PO-2026-001 的全部金额构成。',
      expected: ['timeout'],
      mode: 'api',
    });
  }

  // 故障 failed：无效模型由网关真实返回失败。
  await ensureScenario({
    key: 'failed',
    agent: fault,
    message: '请汇报采购单 QH-PO-2026-001 的状态。',
    expected: ['failed'],
    mode: 'api',
  });

  // 成果分享：最终保留 1 个有效、1 个已撤销；全部在会话成果面板里操作。
  const shareUrl = `/chat?conversation=${purchaseConversationId}&outputRun=${purchaseRunId}&outputPath=${encodeURIComponent(purchaseOutput.path)}&outputMode=read`;
  const listShares = async (): Promise<ShareItem[]> =>
    (
      await api<{ items: ShareItem[] }>(
        browser,
        `/api/conversations/${purchaseConversationId}/output-shares?runId=${purchaseRunId}&path=${encodeURIComponent(purchaseOutput.path)}`,
      )
    ).items;
  let shares = await listShares();
  if (!shares.some((item) => item.revokedAt === null)) {
    await app.open(shareUrl);
    await screen.getByRole('button', '分享', { exact: true }).tap();
    await screen.getByRole('button', '创建分享链接').tap();
    await expect(screen.getByText('有效', { exact: true })).toBeVisible({ timeout: 30_000 });
    await screen.getByRole('button', '关闭', { exact: true }).tap();
    shares = await listShares();
  }
  if (!shares.some((item) => item.revokedAt !== null)) {
    await app.open(shareUrl);
    await screen.getByRole('button', '分享', { exact: true }).tap();
    await browser.locator('[aria-label^="撤销 "][aria-label$=" 的链接"]').first().click();
    await expect(screen.getByText('已撤销', { exact: true })).toBeVisible({ timeout: 30_000 });
    await screen.getByRole('button', '关闭', { exact: true }).tap();
    shares = await listShares();
  }
  if (!shares.some((item) => item.revokedAt === null)) {
    await app.open(shareUrl);
    await screen.getByRole('button', '分享', { exact: true }).tap();
    await screen.getByRole('button', '创建分享链接').tap();
    await expect(screen.getByText('有效', { exact: true })).toBeVisible({ timeout: 30_000 });
    await screen.getByRole('button', '关闭', { exact: true }).tap();
  }

  // 评估：两个用例，一过一不过；两条底层运行成功，评估批次最终 failed。
  const evalPassName = '【青禾演示】评估通过-短语';
  const evalFailName = '【青禾演示】评估失败-哨兵';
  const evalPassPrompt = '只回复这六个字：青禾采购评估通过。';
  const evalFailPrompt = '只回复这六个字：青禾采购评估通过。';
  const evalFailExpectation = '青禾演示-永不出现在输出中的哨兵-9F3A';
  const cases = await api<EvalCaseItem[]>(browser, `/api/eval/cases?agentId=${main.id}`);
  const ensureCaseUi = async (name: string, prompt: string, expectation: string): Promise<void> => {
    const existing = cases.filter((item) => item.name === name);
    if (
      existing.length > 1 ||
      existing.some((item) => item.prompt !== prompt || item.expectation !== expectation)
    )
      conflict(`评估用例 ${name} 已变化`);
    if (existing.length === 1) return;
    await app.open(`/eval?agent=${encodeURIComponent(main.id)}`);
    await screen.getByRole('button', '新建用例', { exact: true }).first().tap();
    await browser.locator('#eval-name').fill(name);
    await browser.locator('#eval-prompt').fill(prompt);
    if (expectation) await browser.locator('#eval-expectation').fill(expectation);
    await screen.getByRole('button', '保存', { exact: true }).tap();
    await expect(screen.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 });
    cases.push(
      ...(await api<EvalCaseItem[]>(browser, `/api/eval/cases?agentId=${main.id}`)).filter(
        (item) => item.name === name,
      ),
    );
  };
  await ensureCaseUi(evalPassName, evalPassPrompt, '青禾采购评估通过');
  await ensureCaseUi(evalFailName, evalFailPrompt, evalFailExpectation);
  manifest.eval.caseIds = (await api<EvalCaseItem[]>(browser, `/api/eval/cases?agentId=${main.id}`))
    .filter((item) => item.name === evalPassName || item.name === evalFailName)
    .map((item) => item.id);
  save();

  const exactCases = await api<EvalCaseItem[]>(browser, `/api/eval/cases?agentId=${main.id}`);
  if (
    exactCases.length !== 2 ||
    manifest.eval.caseIds.length !== 2 ||
    !exactCases.every(
      (item) =>
        manifest.eval.caseIds.includes(item.id) &&
        (item.name === evalPassName
          ? item.prompt === evalPassPrompt && item.expectation === '青禾采购评估通过'
          : item.name === evalFailName &&
            item.prompt === evalFailPrompt &&
            item.expectation === evalFailExpectation),
    )
  ) {
    conflict('评估用例集合或内容不再恰好是两个固定用例，禁止发起评估');
  }
  let evalRunId = manifest.eval.runId;
  if (!evalRunId) {
    const before = (
      await api<{ items: Array<{ id: string; status: string }>; nextCursor: string | null }>(
        browser,
        `/api/eval/runs?agentId=${main.id}&limit=100`,
      )
    ).items;
    if (before.length > 1) conflict('已有多个评估批次，需明确选择，未发起新批次');
    if (before[0]) {
      evalRunId = before[0].id;
    } else {
      if (manifest.eval.status !== 'pending') conflict('评估发起后未找到批次，不自动重试');
      manifest.eval.status = 'pending';
      save();
      await app.open(`/eval?agent=${encodeURIComponent(main.id)}`);
      const runButton = screen.getByRole('button', '运行评估');
      await expect(runButton).toBeEnabled({ timeout: 30_000 });
      const latestCases = await api<EvalCaseItem[]>(browser, `/api/eval/cases?agentId=${main.id}`);
      if (JSON.stringify(latestCases) !== JSON.stringify(exactCases))
        conflict('发起前评估用例已变化');
      manifest.eval.status = 'starting';
      save();
      await runButton.tap();
      const latest = await waitFor(
        () =>
          api<{ items: Array<{ id: string }> }>(
            browser,
            `/api/eval/runs?agentId=${main.id}&limit=100`,
          ),
        (page) => page.items.length > 0,
        '评估批次创建',
        60_000,
        2_000,
      );
      evalRunId = must(latest.items[0]?.id, '评估批次未创建');
    }
    manifest.eval.runId = evalRunId;
    manifest.eval.status = 'recorded';
    save();
  }
  const evalTerminal = await waitFor(
    () => api<EvalRunDetail>(browser, `/api/eval/runs/${evalRunId}`),
    (detail) => detail.evalRun.status !== 'running',
    '评估批次结束',
    20 * 60_000,
    5_000,
  );
  if (
    evalTerminal.evalRun.agentId !== main.id ||
    evalTerminal.results.length !== 2 ||
    !evalTerminal.results.some(
      (item) =>
        item.name === evalPassName &&
        item.prompt === evalPassPrompt &&
        item.expectation === '青禾采购评估通过',
    ) ||
    !evalTerminal.results.some(
      (item) =>
        item.name === evalFailName &&
        item.prompt === evalFailPrompt &&
        item.expectation === evalFailExpectation,
    ) ||
    evalTerminal.evalRun.status !== 'failed' ||
    evalTerminal.evalRun.passed !== 1 ||
    evalTerminal.evalRun.total !== 2
  ) {
    gaps.add(
      `评估结果不符合预期：status=${evalTerminal.evalRun.status} passed=${evalTerminal.evalRun.passed}/${evalTerminal.evalRun.total}`,
    );
  }

  // 创建时暂停；每个任务按自己的消息标记恢复、触发并记录运行。
  const scheduleNames = ['【青禾演示】采购状态巡检', '【青禾演示】供应商交期提醒'];
  const schedulePrompts = [
    '用一句话汇报采购单 QH-PO-2026-001 当前状态。',
    '用一句话提醒云杉包装下一批竹纤维随行杯的交付时间。',
  ];
  const listSchedules = (): Promise<ScheduleItem[]> => api(browser, '/api/schedules');
  for (let index = 0; index < scheduleNames.length; index += 1) {
    const name = must(scheduleNames[index], '缺少定时任务名');
    const marker = `[${DATASET_ID}:schedule-${index}]`;
    const prompt = `${schedulePrompts[index]}\n\n${marker}`;
    const matching = (await listSchedules()).filter((item) => item.name === name);
    if (matching.length > 1) conflict(`定时任务 ${name} 重复`);
    if (!matching[0]) {
      await app.open('/schedules');
      await screen.getByRole('button', '新建定时任务').tap();
      await browser.locator('#schedule-name').fill(name);
      await browser.locator('#schedule-prompt').fill(prompt);
      await browser.locator('#schedule-agent').click();
      await browser.locator('[role="option"]').filter({ hasText: main.name }).first().click();
      await browser.locator('#schedule-frequency').click();
      await browser.locator('[role="option"]').filter({ hasText: '自定义' }).first().click();
      await browser.locator('#schedule-cron').fill('* * * * *');
      // 开关默认开启；用键盘切换，避免吸顶标题栏拦截指针事件。
      await browser.locator('#schedule-enabled').focus();
      await browser.keyboard.press('Space');
      await expect(screen.getByRole('switch', '启用')).toBeChecked({ checked: false });
      await screen.getByRole('button', '创建任务').tap();
      await expect(screen.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 });
    }
    const schedule = must(
      (await listSchedules()).find((item) => item.name === name),
      `任务 ${name} 不存在`,
    );
    if (
      schedule.agentId !== main.id ||
      schedule.prompt !== prompt ||
      schedule.cron !== '* * * * *'
    ) {
      conflict(`定时任务 ${name} 内容或绑定已变化`);
    }
    let record = manifest.schedules.find((item) => item.marker === marker);
    if (record && record.id !== schedule.id) conflict(`定时任务 ${name} ID 已变化`);
    if (!record) {
      record = { id: schedule.id, marker, runId: null };
      manifest.schedules.push(record);
      save();
    }
    try {
      const found = await findConversationByMarker(browser, main.id, marker);
      if (found) {
        if (!found.runId) conflict(`定时任务 ${name} 已有消息但没有运行，未重发`);
        record.runId = found.runId;
        save();
      }
      if (!record.runId) {
        if (schedule.lastRunAt) conflict(`定时任务 ${name} 已触发但标记无法恢复，未重发`);
        // 守护独立于测试进程，触发后/75秒/父进程退出均暂停并回读确认。
        const cookies = await browser.cookies();
        const cookie = cookies
          .filter((item) => {
            const host = new URL(must(origin, '缺少 origin')).hostname;
            const domain = item.domain?.replace(/^\./, '') ?? host;
            return host === domain || host.endsWith(`.${domain}`);
          })
          .map((item) => `${item.name}=${item.value}`)
          .join('; ');
        const guard = spawn(
          process.execPath,
          ['--use-system-ca', '--input-type=module', '-e', SCHEDULE_PAUSE_GUARD],
          {
            detached: true,
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          },
        );
        await new Promise<void>((resolveGuard, rejectGuard) => {
          guard.once('error', rejectGuard);
          guard.once('exit', (code) => rejectGuard(new Error(`调度暂停守护提前退出 ${code}`)));
          guard.once('message', () => resolveGuard());
          guard.send({ origin, cookie, id: schedule.id, lastRunAt: schedule.lastRunAt });
        });
        guard.unref();
        guard.channel?.unref();
        try {
          await api(browser, `/api/schedules/${schedule.id}`, {
            method: 'PATCH',
            body: { enabled: true },
          });
          const triggered = await waitFor(
            () => findConversationByMarker(browser, main.id, marker),
            (value) => Boolean(value?.runId),
            `${name} 真实 cron 触发`,
            75_000,
            1_000,
          );
          record.runId = must(triggered?.runId, `任务 ${name} 没有关联运行`);
          save();
        } finally {
          await api(browser, `/api/schedules/${schedule.id}`, {
            method: 'PATCH',
            body: { enabled: false },
          });
          if (guard.connected) guard.disconnect();
        }
      }
    } finally {
      await api(browser, `/api/schedules/${schedule.id}`, {
        method: 'PATCH',
        body: { enabled: false },
      });
      const paused = must(
        (await listSchedules()).find((item) => item.id === schedule.id),
        '任务暂停后丢失',
      );
      must(!paused.enabled || null, `定时任务 ${name} 暂停失败`);
    }
    const terminal = await waitForTerminalRun(browser, must(record.runId, `任务 ${name} 缺少运行`));
    if (
      terminal.run.trigger !== 'schedule' ||
      terminal.run.agentId !== main.id ||
      terminal.run.status !== 'succeeded'
    ) {
      gaps.add(
        `定时任务 ${name} 运行不符：${terminal.run.id} ${terminal.run.trigger}/${terminal.run.status}`,
      );
    }
  }

  // 记忆审核：真实模型审核 + 采纳 1 次。
  const reviewTarget = {
    kind: 'agent_memory' as const,
    agentId: main.id,
    name: 'procurement-strategy.md',
  };
  const existingReviews = await api<{
    items: Array<{ runId: string; target: unknown; decision: string; status: string }>;
  }>(browser, `/api/memory-reviews?agentId=${encodeURIComponent(main.id)}&limit=50`);
  const reusable = existingReviews.items.find(
    (item) => JSON.stringify(item.target) === JSON.stringify(reviewTarget),
  );
  manifest.memoryReview ??= { key: randomUUID(), runId: null, appliedChangeId: null };
  save();
  const reviewKey = manifest.memoryReview.key;
  let reviewRunId = manifest.memoryReview.runId ?? reusable?.runId ?? null;
  if (reviewRunId) {
    manifest.memoryReview.runId = reviewRunId;
    save();
  }
  if (!reviewRunId) {
    const created = await evaluateFetch<{ runId: string }>(browser, '/api/memory-reviews', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': reviewKey,
      },
      body: {
        modelAgentId: sub.id,
        target: reviewTarget,
        sources: [{ conversationId: purchaseConversationId }],
        instruction:
          '把这次采购评审里可复用的结论整理成主题记忆条目：交期、抽检比例、违约金与售后追溯，保持简短。',
      },
    });
    reviewRunId = created.runId;
    manifest.memoryReview = {
      ...manifest.memoryReview,
      key: reviewKey,
      runId: reviewRunId,
      appliedChangeId: null,
    };
    save();
  }
  const reviewDone = await waitFor(
    () => api<MemoryReviewDetail>(browser, `/api/memory-reviews/${reviewRunId}`),
    (detail) => detail.status !== 'queued' && detail.status !== 'running',
    '记忆审核运行结束',
    15 * 60_000,
    3_000,
  );
  if (reviewDone.status !== 'succeeded') {
    gaps.add(`记忆审核未成功：${reviewDone.status} ${reviewDone.error ?? ''}`);
  } else if (reviewDone.decision !== 'applied') {
    const applied = await api<{ id: string }>(browser, `/api/memory-reviews/${reviewRunId}/apply`, {
      method: 'POST',
    });
    manifest.memoryReview = {
      ...manifest.memoryReview,
      key: reviewKey,
      runId: reviewRunId,
      appliedChangeId: applied.id,
    };
    save();
  } else {
    manifest.memoryReview = {
      ...manifest.memoryReview,
      key: reviewKey,
      runId: reviewRunId,
      appliedChangeId: reviewDone.appliedChangeId,
    };
    save();
  }

  if (manifest.memoryReview?.appliedChangeId && !manifest.memoryReview.appliedContent) {
    manifest.memoryReview.appliedContent = (
      await api<{ content: string }>(
        browser,
        `/api/agents/${main.id}/memory/procurement-strategy.md`,
      )
    ).content;
    save();
  }
  manifest.gaps = [...gaps];
  manifest.status = gaps.size === 0 ? 'complete' : 'partial';
  save();

  if (gaps.size > 0) {
    throw new Error(`业务数据集存在缺口：\n- ${[...gaps].join('\n- ')}`);
  }
});

test('business dataset verify: read-only checks for experts, scenarios, eval, schedules, shares, memory', {
  session: 'admin',
  timeout: 10 * 60_000,
}, async ({ app, browser }) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', '专用数据验收：设置 E2E_DEV_DATA=1 才运行');
  // 本用例由 `pnpm dev:data:verify` 的标题筛选单独选中；无论是否设置 E2E_DEV_DATA_VERIFY 都只读。

  const manifest = must(readManifest(), `缺少 ${datasetPath('business')}；先运行构建`);
  const problems: string[] = [...manifest.gaps];
  const check = (condition: unknown, message: string): void => {
    if (!condition) problems.push(message);
  };

  check(manifest.datasetId === DATASET_ID, `manifest datasetId 不是 ${DATASET_ID}`);
  check(
    originOf(app.baseUrl) === manifest.origin,
    `manifest origin 与当前实例不一致：${manifest.origin} vs ${app.baseUrl}`,
  );
  await app.open('/agents');
  const me = await api<{ authenticated: boolean; user?: { businessId: string } }>(
    browser,
    '/api/auth/me',
  );
  check(me.authenticated, '管理员会话未生效');
  check(me.user?.businessId === manifest.actor.businessId, 'manifest 主体与当前账户不一致');

  // 专家与固定身份。列表摘要带 slug/role/model 与 parentId，仍按 manifest ID 回详情核对正文。
  const agentByKey = new Map<AgentKey, AgentDetail>();
  for (const key of Object.keys(AGENT_DEFS) as AgentKey[]) {
    const def = AGENT_DEFS[key];
    const recorded = manifest.entities.agents[key];
    let agent: AgentDetail | null = null;
    if (recorded?.id) {
      agent = await agentDetail(browser, recorded.id);
    } else {
      const summaries = await api<AgentSummary[]>(browser, '/api/agents');
      for (const summary of summaries) {
        if (summary.name !== def.name) continue;
        const candidate = await agentDetail(browser, summary.id);
        if (candidate.slug === def.slug) agent = candidate;
      }
    }
    check(agent, `缺少专家 ${def.slug}`);
    if (!agent) continue;
    agentByKey.set(key, agent);
    check(agent.slug === def.slug, `专家 ${def.slug} slug 不一致：${agent.slug}`);
    check(agent.name === def.name, `专家 ${def.slug} 名称不是 ${def.name}`);
    check(agent.enabled === def.enabled, `专家 ${def.slug} 启用状态不是 ${def.enabled}`);
    check(agent.model === def.model, `专家 ${def.slug} 模型不是 ${def.model}`);
    check(recorded?.id === agent.id, `manifest 中 ${key} 专家 ID 与实际不一致`);
  }
  const main = must(agentByKey.get('main'), '缺少主专家');
  const sub = must(agentByKey.get('sub'), '缺离子专家');
  const openui = must(agentByKey.get('openui'), '缺少 OpenUI 专家');

  // 列表摘要缺 parentId 时前端子专家选择器不会渲染；这里固定真实契约。
  const summaries = await api<AgentSummary[]>(browser, '/api/agents');
  const summaryOf = (id: string): AgentSummary | undefined =>
    summaries.find((item) => item.id === id);
  check(summaryOf(main.id)?.parentId === null, '主专家列表摘要 parentId 不是 null');
  check(summaryOf(sub.id)?.parentId === main.id, '子专家列表摘要 parentId 未指向主专家');
  for (const key of Object.keys(AGENT_DEFS) as AgentKey[]) {
    const agent = must(agentByKey.get(key), `缺少 ${key} 专家`);
    const summary = summaryOf(agent.id);
    check(
      summary?.slug === agent.slug &&
        summary.role === agent.role &&
        summary.model === agent.model &&
        summary.uiFormat === agent.uiFormat &&
        summary.createdAt === agent.createdAt,
      `${key} 专家列表摘要身份字段与详情不一致`,
    );
  }

  const detail = await api<{
    serverIds: string[];
    skillIds: string[];
    subAgentIds: string[];
    pluginBindings: Array<{ pluginId: string }>;
    runtimeEnvironmentId: string | null;
    model: string;
  }>(browser, `/api/agents/${main.id}`);
  check(detail.subAgentIds.includes(sub.id), '主专家未绑定子专家');
  check(detail.skillIds.length >= 2, `主专家技能绑定不足：${detail.skillIds.length}`);
  check(detail.pluginBindings.length >= 1, '主专家未绑定插件');
  check(
    manifest.entities.readOnlyConnector !== null &&
      detail.serverIds.includes(manifest.entities.readOnlyConnector.id),
    '主专家未绑定只读生成连接器',
  );
  check(
    manifest.entities.knowledge?.serverId !== null &&
      manifest.entities.knowledge?.serverId !== undefined &&
      detail.serverIds.includes(manifest.entities.knowledge.serverId),
    '主专家未绑定知识库 server',
  );
  check(
    manifest.entities.runtimeEnvironment !== null &&
      detail.runtimeEnvironmentId === manifest.entities.runtimeEnvironment.id,
    '主专家未绑定成功发布的专用环境',
  );
  const runtime = must(manifest.entities.runtimeEnvironment, '缺少专用运行环境');
  const runtimeManifest = JSON.parse(readFileSync(datasetPath('runtime'), 'utf8')) as {
    dataset: string;
    runtimeEnvironmentId: string;
    publishedVersionId: string | null;
  };
  const environment = await api<{ onlineVersionId: string | null }>(
    browser,
    `/api/runtime-environments/${runtime.id}`,
  );
  check(
    runtimeManifest.dataset === DATASET_ID &&
      runtimeManifest.runtimeEnvironmentId === runtime.id &&
      runtimeManifest.publishedVersionId === runtime.onlineVersionId &&
      environment.onlineVersionId === runtime.onlineVersionId,
    '专用环境线上指针与 runtime/business manifest 不一致',
  );
  const version = await api<{ status: string }>(
    browser,
    `/api/runtime-environments/${runtime.id}/versions/${must(runtime.onlineVersionId, '专用环境缺少线上版本')}`,
  );
  check(version.status === 'ready', '专用环境线上版本不是 ready');
  for (const key of ['main', 'sub', 'openui', 'fault'] as const) {
    const agent = must(manifest.entities.agents[key], `缺少 ${key} 专家`);
    const current = await api<{ runtimeEnvironmentId: string | null; serverIds: string[] }>(
      browser,
      `/api/agents/${agent.id}`,
    );
    check(current.runtimeEnvironmentId === runtime.id, `${key} 专家未绑定专用环境`);
    if (key === 'sub')
      check(
        Boolean(
          manifest.entities.approvalConnector &&
            current.serverIds.includes(manifest.entities.approvalConnector.id),
        ),
        '审批专家未绑定审批连接器',
      );
  }
  check(!manifest.timeoutOverride?.dirty, 'timeout 临时修改尚未恢复');
  check(openui.uiFormat === 'openui', 'OpenUI 专家 uiFormat 不是 openui');

  // 规则、风格、记忆各 1。
  const rules = await api<Array<{ slug: string }>>(browser, `/api/agents/${main.id}/rules`);
  check(
    rules.some((item) => item.slug === 'procurement-guard'),
    '主专家缺少采购规则',
  );
  const styles = await api<Array<{ slug: string; isSelected: boolean; body: string }>>(
    browser,
    `/api/agents/${main.id}/output-styles`,
  );
  check(
    styles.filter((item) => item.isSelected).length === 1 &&
      styles.some(
        (item) => item.slug === 'procurement-brief' && item.isSelected && item.body === STYLE_BODY,
      ),
    '主专家必须选中采购简报且正文一致',
  );
  const memory = await api<{ files: Array<{ name: string }> }>(
    browser,
    `/api/agents/${main.id}/memory`,
  );
  check(
    memory.files.some((item) => item.name === 'MEMORY.md'),
    '主专家缺少记忆索引',
  );
  check(
    memory.files.some((item) => item.name === 'procurement-strategy.md'),
    '主专家缺少记忆主题',
  );

  // 完整文件真实可渲染，且包含绑定与新增文件。
  const files = await api<{
    mcpJson: string;
    subAgents: Array<{ slug: string }>;
    skills: Array<{ slug: string; files: Array<{ path: string }> }>;
    rules: Array<{ slug: string }>;
    outputStyles: Array<{ slug: string }>;
    selectedOutputStyle: string | null;
    plugins: Array<{ slug: string }>;
  }>(browser, `/api/agents/${main.id}/files`);
  check(
    files.mcpJson.includes(manifest.entities.readOnlyConnector?.name ?? '\u0000'),
    '.mcp.json 未包含只读连接器',
  );
  check(
    files.subAgents.some((item) => item.slug === AGENT_DEFS.sub.slug),
    '完整文件缺少子专家文件',
  );
  check(
    files.rules.some((item) => item.slug === 'procurement-guard'),
    '完整文件缺少规则',
  );
  check(
    files.outputStyles.some((item) => item.slug === 'procurement-brief'),
    '完整文件缺少输出风格',
  );
  check(files.selectedOutputStyle === 'procurement-brief', '输出风格未被选中');
  check(files.plugins.length >= 1, '完整文件缺少插件目录');

  // 场景运行与业务边界交叉核对。
  const runOf = async (key: ScenarioKey): Promise<RunDetail | null> => {
    const state = manifest.scenarios[key];
    if (!state?.runId) {
      problems.push(`场景 ${key} 缺少运行 ID`);
      return null;
    }
    try {
      return await api<RunDetail>(browser, `/api/runs/${state.runId}`);
    } catch {
      problems.push(`场景 ${key} 的运行 ${state.runId} 无法读取`);
      return null;
    }
  };
  const expectRun = async (key: ScenarioKey, status: string): Promise<RunDetail | null> => {
    const run = await runOf(key);
    if (run)
      check(run.run.status === status, `场景 ${key} 运行状态是 ${run.run.status}，期望 ${status}`);
    return run;
  };

  const purchase = await expectRun('purchase-success', 'succeeded');
  if (purchase) {
    const conversation = await api<ConversationDetail>(
      browser,
      `/api/conversations/${must(manifest.scenarios['purchase-success']?.conversationId, '采购会话缺失')}`,
    );
    const attachments = conversation.messages.some((message) =>
      JSON.stringify(message.content).includes('QH-PO-2026-001-采购单.md'),
    );
    check(attachments, '采购运行没有记录 Markdown 附件');
    const outputs = await api<{ items: OutputFile[] }>(
      browser,
      `/api/conversations/${conversation.conversation.id}/outputs?limit=50`,
    );
    const artifact = outputs.items.find(
      (item) => item.runId === runOfId(purchase) && item.path.endsWith('.md'),
    );
    check(artifact, '采购运行没有 Markdown 成果');
    if (artifact) {
      const content = await api<{ content: string }>(
        browser,
        `/api/conversations/${conversation.conversation.id}/outputs/${artifact.runId}/content?path=${encodeURIComponent(artifact.path)}`,
      );
      check(
        content.content.includes('QH-PO-2026-001') || content.content.includes('云杉'),
        '采购成果没有引用采购单或供应商',
      );
    }
  }
  await expectRun('openui-board', 'succeeded');
  {
    const conversationId = manifest.scenarios['openui-board']?.conversationId;
    if (!conversationId) problems.push('看板场景缺少会话 ID');
    else {
      const conversation = await api<ConversationDetail>(
        browser,
        `/api/conversations/${conversationId}`,
      );
      const assistant = conversation.messages.find((message) => message.role === 'assistant');
      check(assistant?.uiFormat === 'openui', '看板回复没有使用 OpenUI 格式');
      check(
        Boolean(assistant?.uiProgram) || JSON.stringify(assistant?.content ?? '').includes('root'),
        '看板回复没有 OpenUI 程序',
      );
      check(
        JSON.stringify(assistant ?? {}).includes('售后处理看板'),
        '看板回复缺少「售后处理看板」标题',
      );
    }
  }
  const approvalApproved = await expectRun('approval-approved', 'succeeded');
  if (approvalApproved) {
    const approvals = await api<{ items: ApprovalItem[] }>(
      browser,
      `/api/runs/${runOfId(approvalApproved)}/approvals`,
    );
    check(
      approvals.items.some((item) => item.approvedAt !== null),
      '没有已批准的审批记录',
    );
  }
  const approvalCancel = await expectRun('approval-cancel', 'cancelled');
  if (approvalCancel) {
    const approvals = await api<{ items: ApprovalItem[] }>(
      browser,
      `/api/runs/${runOfId(approvalCancel)}/approvals`,
    );
    check(approvals.items.length > 0, '取消场景没有产生审批请求');
    check(!approvals.items.some((item) => item.waiting), '取消后审批仍在等待');
    check(!approvals.items.some((item) => item.approvedAt !== null), '取消场景不应有批准记录');
  }
  await expectRun('stop', 'cancelled');
  await expectRun('timeout', 'timeout');
  const failed = await expectRun('failed', 'failed');
  if (failed) check(Boolean(failed.run.error), '失败运行没有错误信息');

  const disabled = must(manifest.entities.agents.disabled, '缺少停用专家');
  const disabledDetail = await api<{ enabled: boolean }>(browser, `/api/agents/${disabled.id}`);
  check(disabledDetail.enabled === false, '旧客服专家未停用');

  // 两个任务各自的标记、运行和终态必须一致，其他 schedule 运行不计数。
  const schedules = await api<ScheduleItem[]>(browser, '/api/schedules');
  check(manifest.schedules.length === 2, 'manifest 必须记录两个定时任务');
  for (let index = 0; index < 2; index += 1) {
    const marker = `[${DATASET_ID}:schedule-${index}]`;
    const record = manifest.schedules.find((item) => item.marker === marker);
    if (!record) {
      problems.push(`缺少任务 ${marker}`);
      continue;
    }
    const schedule = schedules.find((item) => item.id === record.id);
    check(
      schedule &&
        !schedule.enabled &&
        schedule.agentId === main.id &&
        schedule.prompt.includes(marker),
      `任务 ${marker} 缺失、未暂停或绑定不符`,
    );
    check(schedule?.lastRunAt, `任务 ${marker} 没有真实触发记录`);
    const found = await findConversationByMarker(browser, main.id, marker);
    check(record.runId && found?.runId === record.runId, `任务 ${marker} 消息与运行归属不符`);
    if (record.runId) {
      const run = await api<RunDetail>(browser, `/api/runs/${record.runId}`);
      check(
        run.run.trigger === 'schedule' &&
          run.run.agentId === main.id &&
          run.run.status === 'succeeded',
        `任务 ${marker} 运行不是实际 schedule 成功终态`,
      );
    }
  }

  // 评估：批次 failed，两用例一过一不过，两条底层运行都成功。
  const evalId = must(manifest.eval.runId, '缺少评估批次 ID');
  const evalDetail = await api<EvalRunDetail>(browser, `/api/eval/runs/${evalId}`);
  check(
    evalDetail.evalRun.status === 'failed',
    `评估批次状态是 ${evalDetail.evalRun.status}，期望 failed`,
  );
  check(evalDetail.evalRun.total === 2, `评估用例总数是 ${evalDetail.evalRun.total}，期望 2`);
  check(evalDetail.evalRun.passed === 1, `评估通过数是 ${evalDetail.evalRun.passed}，期望 1`);
  check(
    evalDetail.results.length === 2 &&
      evalDetail.results.filter((item) => item.passed).length === 1,
    '评估结果不是两个固定用例一过一不过',
  );
  for (const result of evalDetail.results) {
    if (!result.runId) {
      problems.push(`评估用例「${result.name}」缺少运行 ID`);
      continue;
    }
    const resultRun = await api<RunDetail>(browser, `/api/runs/${result.runId}`);
    check(
      resultRun.run.status === 'succeeded',
      `评估底层运行 ${result.runId} 状态是 ${resultRun.run.status}`,
    );
  }

  // 分享：1 有效 + 1 已撤销，有效链接可公开读取。
  const shareConversation = manifest.shares.conversationId;
  const shareRun = manifest.shares.runId;
  const sharePath = manifest.shares.path;
  check(Boolean(shareConversation && shareRun && sharePath), '缺少成果分享定位信息');
  if (shareConversation && shareRun && sharePath) {
    const shares = await api<{ items: ShareItem[] }>(
      browser,
      `/api/conversations/${shareConversation}/output-shares?runId=${shareRun}&path=${encodeURIComponent(sharePath)}`,
    );
    const active = shares.items.filter((item) => item.revokedAt === null);
    check(active.length >= 1, '没有有效分享');
    check(
      shares.items.some((item) => item.revokedAt !== null),
      '没有已撤销分享',
    );
    const first = active[0];
    if (first) {
      const token = first.urlPath.split('#')[1] ?? '';
      const publicCheck = (await browser.evaluate(`(async () => {
          const response = await fetch('/api/public/output-shares/${first.id}', {
            headers: { authorization: 'Bearer ' + ${JSON.stringify(token)} },
          });
          const body = await response.json().catch(() => null);
          return { status: response.status, body };
        })()`)) as { status: number; body: unknown };
      check(publicCheck.status === 200, `有效分享公开读取失败：${publicCheck.status}`);
      check(
        JSON.stringify(publicCheck.body).includes('QH-PO-2026-001'),
        '分享文件元数据不含采购单号',
      );
    }
  }

  // 记忆审核：已采纳。
  const review = must(manifest.memoryReview, '缺少记忆审核记录');
  const reviewDetail = await api<MemoryReviewDetail>(
    browser,
    `/api/memory-reviews/${must(review.runId, '缺少记忆审核运行')}`,
  );
  check(reviewDetail.status === 'succeeded', `记忆审核状态是 ${reviewDetail.status}`);
  check(reviewDetail.decision === 'applied', `记忆审核决定是 ${reviewDetail.decision}`);
  check(Boolean(reviewDetail.proposal), '记忆审核没有提案');
  check(Boolean(reviewDetail.appliedChangeId), '记忆审核没有采纳变更记录');

  if (problems.length > 0) {
    throw new Error(`业务数据验收失败：\n- ${[...new Set(problems)].join('\n- ')}`);
  }
});

function runOfId(detail: RunDetail): string {
  return detail.run.id;
}
