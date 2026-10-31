/**
 * 业务数据集 UI 验收（business 分片专用）。
 *
 * - verify：只读。核对列表摘要 parentId 契约、真实 UI 子专家选择器显示当前关系，
 *   并在已有 OpenUI 会话里实际渲染 DOM 表格/指标卡，不发起模型请求。
 * - 写验收：仅在显式 E2E_DEV_DATA_UI_WRITE=1 时运行一次，通过真实 UI 解绑再重绑，
 *   恢复原关系；不标 verify，不进入只读验收。
 */

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from '@e2e-dev/web';
import type { App, Screen } from 'e2e';
import { expect } from 'e2e';
import { api, datasetPath } from '../support/business-dataset.js';

interface AgentRef {
  id: string;
  slug: string;
  name: string;
}

interface Manifest {
  datasetId: string;
  entities: { agents: Record<'main' | 'sub' | 'openui' | 'disabled' | 'fault', AgentRef> };
  scenarios: Partial<Record<'openui-board', { conversationId?: string }>>;
}

interface AgentSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  model: string;
  uiFormat: 'markdown' | 'openui';
  parentId: string | null;
  createdAt: string;
}

interface AgentDetail extends AgentSummary {
  systemPrompt: string;
  subAgentIds: string[];
}

interface WorkspaceFiles {
  subAgents: Array<{ slug: string }>;
}

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function manifestOf(): Manifest {
  return JSON.parse(readFileSync(datasetPath('business'), 'utf8')) as Manifest;
}

async function openCapabilityTab(app: App, screen: Screen, agent: AgentRef): Promise<void> {
  await app.open(`/agents/${agent.id}`);
  await screen.getByRole('heading', { level: 1, name: agent.name }).waitFor();
  await screen.getByRole('button', '能力', { exact: false }).tap();
}

test('business UI verify: sub-agent relationship and OpenUI rendering', {
  session: 'admin',
  timeout: 5 * 60_000,
  tags: ['verify'],
}, async ({ app, screen, browser }) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', '专用数据验收：设置 E2E_DEV_DATA=1 才运行');

  const manifest = manifestOf();
  const main = must(manifest.entities.agents.main, 'manifest 缺少主专家');
  const sub = must(manifest.entities.agents.sub, 'manifest 缺少子专家');

  // 列表摘要必须带 parentId 与身份字段，前端子专家选择器据此过滤。
  await app.open('/agents');
  const summaries = await api<AgentSummary[]>(browser, '/api/agents');
  const mainSummary = must(
    summaries.find((item) => item.id === main.id),
    '列表缺少主专家',
  );
  const subSummary = must(
    summaries.find((item) => item.id === sub.id),
    '列表缺少子专家',
  );
  expect(mainSummary.parentId).toBeNull();
  expect(subSummary.parentId).toBe(main.id);
  for (const summary of [mainSummary, subSummary]) {
    expect(summary.slug.length).toBeGreaterThan(0);
    expect(summary.role.length).toBeGreaterThan(0);
    expect(summary.model.length).toBeGreaterThan(0);
    expect(['markdown', 'openui']).toContain(summary.uiFormat);
    expect(new Date(summary.createdAt).toISOString()).toBe(summary.createdAt);
    expect(summary).not.toHaveProperty('systemPrompt');
    expect(summary).not.toHaveProperty('serverIds');
    expect(summary).not.toHaveProperty('subAgentIds');
  }

  // 真实 UI：能力页的子专家选择器渲染，并显示当前绑定关系。
  await openCapabilityTab(app, screen, main);
  await expect(screen.getByRole('combobox', '子智能体')).toBeVisible();
  await expect(screen.getByRole('button', { name: `移除 ${sub.name}` })).toBeVisible();
  await app.screenshot('sub-agent-picker');

  // 已有 OpenUI 会话真实渲染 DOM 表格与指标卡；只读打开，不请求模型。
  const conversationId = must(
    manifest.scenarios['openui-board']?.conversationId,
    'manifest 缺少 OpenUI 会话',
  );
  await app.open(`/chat?conversation=${encodeURIComponent(conversationId)}`);
  await expect(screen.getByText('售后处理看板', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(screen.getByText('采购单号', { exact: true }).first()).toBeVisible();
  await expect(screen.getByText('QH-PO-2026-001', { exact: true }).first()).toBeVisible();
  expect(await browser.locator('table').count()).toBeGreaterThanOrEqual(1);
  expect(await browser.locator('table tbody tr').count()).toBe(3);
  for (const label of ['待处理', '处理中', '已解决', '12 单', '7 单', '36 单']) {
    await expect(screen.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await app.screenshot('openui-board');
});

test('business UI acceptance: unbind and rebind the sub-agent through the picker', {
  session: 'admin',
  timeout: 5 * 60_000,
}, async ({ app, screen, browser }) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', '专用数据验收：设置 E2E_DEV_DATA=1 才运行');
  test.skip(
    process.env.E2E_DEV_DATA_UI_WRITE !== '1',
    '解绑是写操作：仅在显式 E2E_DEV_DATA_UI_WRITE=1 时运行一次',
  );

  const manifest = manifestOf();
  const main = must(manifest.entities.agents.main, 'manifest 缺少主专家');
  const sub = must(manifest.entities.agents.sub, 'manifest 缺少子专家');

  const detail = (): Promise<AgentDetail> => api<AgentDetail>(browser, `/api/agents/${main.id}`);
  const child = (): Promise<AgentDetail> => api<AgentDetail>(browser, `/api/agents/${sub.id}`);
  await app.open('/agents');
  const before = await detail();
  if (!before.subAgentIds.includes(sub.id)) throw new Error('前置条件：主专家当前未绑定子专家');

  const save = async (accept: (value: AgentDetail) => boolean): Promise<void> => {
    const button = screen.getByRole('button', '保存更改').first();
    await expect(button).toBeEnabled();
    await button.tap();
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (accept(await detail())) return;
      if (Date.now() > deadline) throw new Error('保存后详情未达到预期');
      await sleep(250);
    }
  };
  const pickSub = async (): Promise<void> => {
    await screen.getByRole('combobox', '子智能体').tap();
    await browser.locator('[role="option"]').filter({ hasText: sub.name }).first().click();
    await browser.keyboard.press('Escape');
  };

  await openCapabilityTab(app, screen, main);
  await expect(screen.getByRole('button', { name: `移除 ${sub.name}` })).toBeVisible();

  // 解绑并保存，详情与子专家 parentId 都回到未绑定。
  await screen.getByRole('button', { name: `移除 ${sub.name}` }).tap();
  await save((value) => !value.subAgentIds.includes(sub.id));
  expect((await detail()).subAgentIds).not.toContain(sub.id);
  expect((await child()).parentId).toBeNull();
  await app.screenshot('sub-agent-unbound');

  // 重新选择并保存，关系恢复，工作区文件同步。
  await pickSub();
  await save((value) => value.subAgentIds.includes(sub.id));
  expect((await detail()).subAgentIds).toEqual([sub.id]);
  expect((await child()).parentId).toBe(main.id);
  const files = await api<WorkspaceFiles>(browser, `/api/agents/${main.id}/files`);
  expect(files.subAgents.map((item) => item.slug)).toContain(sub.slug);
  await expect(screen.getByRole('button', { name: `移除 ${sub.name}` })).toBeVisible();
  await app.screenshot('sub-agent-rebound');
});
