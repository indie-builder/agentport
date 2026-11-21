import { randomUUID } from 'node:crypto';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { requireExecutionStack } from './support/execution-stack.js';

await requireExecutionStack();

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);

interface AgentDetail {
  id: string;
  enabled: boolean;
  isDefault?: boolean;
  hasDraft?: boolean;
  publishedVersion?: number | null;
}

interface RunDetail {
  run: { id: string; status: string; agentVersion?: number | null };
  steps: Array<{ kind: string; text?: string }>;
}

interface EvalRunDetail {
  evalRun: {
    id: string;
    status: string;
    total: number;
    passed: number;
    error: string | null;
    agentVersion?: number | null;
    resourceVersions?: unknown;
  };
  results: Array<{ output: string; passed: boolean }>;
}

interface AgentDefinition {
  agent: { systemPrompt: string };
  rules: Array<{ slug: string; content: string }>;
  outputStyles: Array<{
    slug: string;
    description: string;
    keepCodingInstructions: boolean;
    body: string;
    isSelected: boolean;
  }>;
  workflows: Array<{ slug: string; content: string }>;
  hooks: { files: Array<{ path: string; content: string }> };
  memoryPolicy: {
    enabled: boolean;
    writeMode: string;
    injectPersonalMemory: boolean;
    injectRules: boolean;
    topicLimit: number;
  };
  resources: {
    servers: Array<{
      id: string;
      name: string;
      kind: string;
      config: Record<string, unknown>;
      secretsEncrypted?: string;
      tools?: Array<{
        id: string;
        name: string;
        pathTemplate: string;
        enabled: boolean;
        approvalMode: string;
      }>;
    }>;
    skills: Array<{
      id: string;
      slug: string;
      body: string;
      files: Array<{ path: string; content: string }>;
    }>;
    plugins: unknown[];
    subAgents: unknown[];
    runtimeEnvironment: { id: string; name: string; versionId: string | null } | null;
  };
}

interface VersionDetail {
  version: number;
  definition: AgentDefinition | null;
  definitionState: string;
}

interface VersionSummary {
  version: number;
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
  expected?: number,
): Promise<T> {
  const response = await browserFetch(browser, method, path, body);
  const ok =
    expected === undefined
      ? response.status >= 200 && response.status < 300
      : response.status === expected;
  if (!ok) throw new Error(`${method} ${path} ${response.status}: ${response.text}`);
  return (response.text === '' ? null : JSON.parse(response.text)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitRun(browser: Browser, runId: string): Promise<string> {
  const deadline = Date.now() + 180_000;
  let last = '';
  while (Date.now() < deadline) {
    const detail = await apiJson<RunDetail>(browser, 'GET', `/api/runs/${runId}`);
    last = JSON.stringify(detail);
    if (detail.run.status === 'succeeded') {
      return detail.steps
        .filter((step) => step.kind === 'assistant')
        .map((step) => step.text ?? '')
        .join('\n');
    }
    if (TERMINAL_STATUSES.has(detail.run.status))
      throw new Error(`运行 ${runId} 终态 ${detail.run.status}: ${last}`);
    await sleep(1_000);
  }
  throw new Error(`等待运行 ${runId} 进入终态超时：${last}`);
}

async function waitEval(browser: Browser, evalRunId: string): Promise<EvalRunDetail> {
  const deadline = Date.now() + 180_000;
  let last = '';
  while (Date.now() < deadline) {
    const detail = await apiJson<EvalRunDetail>(browser, 'GET', `/api/eval/runs/${evalRunId}`);
    last = JSON.stringify(detail);
    if (detail.evalRun.status === 'succeeded') return detail;
    if (detail.evalRun.status !== 'running')
      throw new Error(`评估 ${evalRunId} 终态 ${detail.evalRun.status}: ${last}`);
    await sleep(1_000);
  }
  throw new Error(`等待评估 ${evalRunId} 结束超时：${last}`);
}

test('publishes, trials, rolls back and takes an agent offline through real runs', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, screen, browser }) => {
  await requireExecutionStack();
  await app.open('/');
  const suffix = randomUUID().slice(0, 8);
  let agentId: string | undefined;
  let skillId: string | undefined;
  let serverId: string | undefined;

  try {
    const agents = await apiJson<{ items: AgentDetail[] }>(browser, 'GET', '/api/agents');
    const defaultAgent = agents.items.find((item) => item.isDefault === true);
    if (defaultAgent === undefined) throw new Error('缺少默认助手');
    const defaultChat = await apiJson<{ runId: string }>(browser, 'POST', '/api/chat', {
      agentId: defaultAgent.id,
      message: `e2e-default-assistant-${suffix}`,
    });
    await waitRun(browser, defaultChat.runId);
    const defaultRun = await apiJson<RunDetail>(browser, 'GET', `/api/runs/${defaultChat.runId}`);
    expect(typeof defaultRun.run.agentVersion).toBe('number');

    const agent = await apiJson<AgentDetail>(browser, 'POST', '/api/agents', {
      slug: `e2e-agent-publish-${suffix}`,
      name: `E2E 专家发布 ${suffix}`,
      systemPrompt: `E2E-SYSTEM-ECHO:live-${suffix}`,
    });
    agentId = agent.id;

    const skill = await apiJson<{ id: string }>(browser, 'POST', '/api/skills', {
      slug: `e2e-skill-${suffix}`,
      name: `E2E Skill ${suffix}`,
      description: 'E2E 资源快照',
      body: `SKILL-BODY-V1-${suffix}`,
    });
    skillId = skill.id;
    const server = await apiJson<{ id: string }>(browser, 'POST', '/api/servers', {
      kind: 'generated',
      name: `e2e-gen-${suffix}`,
      description: 'E2E generated',
      baseUrl: 'https://example.com',
      headers: {},
    });
    serverId = server.id;
    const tool = await apiJson<{ id: string }>(browser, 'POST', `/api/servers/${serverId}/tools`, {
      name: 'echo',
      description: 'E2E tool',
      method: 'GET',
      pathTemplate: '/echo-v1',
      inputSchema: { type: 'object', properties: {} },
      paramsIn: 'query',
      approvalMode: 'allow',
    });
    await apiJson(browser, 'PATCH', `/api/agents/${agentId}`, {
      serverIds: [serverId],
      skillIds: [skillId],
    });

    const patched = await apiJson<AgentDetail>(
      browser,
      'PATCH',
      `/api/agents/${agentId}`,
      { systemPrompt: `E2E-SYSTEM-ECHO:draft-${suffix}` },
      200,
    );
    expect(patched.hasDraft).toBe(true);

    await apiJson(browser, 'PUT', `/api/agents/${agentId}/rules/rule-draft`, {
      content: `rule-v1-${suffix}`,
      globs: '',
    });
    await apiJson(browser, 'PUT', `/api/agents/${agentId}/hooks/settings`, {
      enabled: true,
      config: {},
    });
    await apiJson(browser, 'PUT', `/api/agents/${agentId}/hooks/files`, {
      path: 'check.sh',
      content: '#!/bin/sh\necho ok',
      executable: true,
    });
    await apiJson(browser, 'PUT', `/api/agents/${agentId}/output-styles/concise`, {
      description: 'E2E style',
      keepCodingInstructions: false,
      body: 'E2E-STYLE-BODY',
    });
    const workflow = await apiJson<{ id: string }>(
      browser,
      'POST',
      `/api/agents/${agentId}/workflows`,
      {
        slug: 'e2e-flow',
        content:
          "export const meta = {\n  name: 'E2E flow',\n  description: 'E2E workflow',\n}\n\n// E2E-WORKFLOW-BODY\n",
      },
    );
    const memoryPolicy = {
      enabled: true,
      writeMode: 'proposal_only',
      injectPersonalMemory: false,
      injectRules: true,
      topicLimit: 9,
    };
    await apiJson(browser, 'PUT', `/api/agents/${agentId}/memory/policy`, {
      policy: memoryPolicy,
    });

    await apiJson(browser, 'POST', '/api/eval/cases', {
      agentId,
      name: `publish-eval-${suffix}`,
      prompt: `eval-${suffix}`,
      expectation: `draft-${suffix}`,
    });
    const draftVersions = await apiJson<VersionSummary[]>(
      browser,
      'GET',
      `/api/agents/${agentId}/versions`,
    );
    const draftVersion = Math.max(...draftVersions.map((item) => item.version));
    const evalAccepted = await apiJson<{ evalRunId: string }>(browser, 'POST', '/api/eval/runs', {
      agentId,
      target: 'draft',
    });
    const evalDetail = await waitEval(browser, evalAccepted.evalRunId);
    expect(evalDetail.evalRun).toMatchObject({ total: 1, passed: 1, error: null });
    expect(evalDetail.results[0]?.passed).toBe(true);
    expect(evalDetail.results[0]?.output).toContain(`[SYSTEM:draft-${suffix}]`);
    expect(evalDetail.evalRun.agentVersion).toBe(draftVersion);
    expect(draftVersion).toBeGreaterThan(1);
    expect(evalDetail.evalRun.resourceVersions).not.toBeNull();
    expect(evalDetail.evalRun.resourceVersions).toMatchObject({
      servers: expect.any(Array),
      skills: expect.any(Array),
      plugins: expect.any(Array),
      subAgents: expect.any(Array),
    });

    const trial = await apiJson<{ runId: string }>(
      browser,
      'POST',
      `/api/agents/${agentId}/trial`,
      { prompt: `trial-${suffix}` },
    );
    const trialRun = await waitRun(browser, trial.runId);
    expect(trialRun).toContain(`[SYSTEM:draft-${suffix}]`);

    const liveRun = await apiJson<{ runId: string }>(browser, 'POST', '/api/chat', {
      agentId,
      message: `live-${suffix}`,
    });
    const live = await waitRun(browser, liveRun.runId);
    expect(live).toContain(`[SYSTEM:live-${suffix}]`);
    expect(live).not.toContain(`draft-${suffix}`);

    const published = await apiJson<AgentDetail>(
      browser,
      'POST',
      `/api/agents/${agentId}/publish`,
      { note: 'e2e publish' },
      200,
    );
    expect(published.hasDraft).toBe(false);
    expect(typeof published.publishedVersion).toBe('number');
    const publishedVersion = published.publishedVersion;
    if (typeof publishedVersion !== 'number') throw new Error('发布后缺少 publishedVersion');
    expect(publishedVersion).toBeGreaterThan(1);

    const versionDetail = await apiJson<VersionDetail>(
      browser,
      'GET',
      `/api/agents/${agentId}/versions/${publishedVersion}`,
    );
    const definition = versionDetail.definition;
    if (definition === null) throw new Error(`v${publishedVersion} 缺少 definition`);
    expect(definition.agent.systemPrompt).toContain(`draft-${suffix}`);
    expect(definition.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'rule-draft', content: `rule-v1-${suffix}` }),
      ]),
    );
    expect(definition.hooks.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'check.sh', content: '#!/bin/sh\necho ok' }),
      ]),
    );
    expect(definition.outputStyles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'concise',
          description: 'E2E style',
          keepCodingInstructions: false,
          body: 'E2E-STYLE-BODY',
          isSelected: true,
        }),
      ]),
    );
    expect(definition.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'e2e-flow',
          content: expect.stringContaining('E2E-WORKFLOW-BODY'),
        }),
      ]),
    );
    expect(definition.memoryPolicy).toEqual(memoryPolicy);
    expect(versionDetail.definitionState).toBe('available');
    const snapshotServer = definition.resources.servers.find((item) => item.id === serverId);
    if (snapshotServer === undefined) throw new Error('发布快照缺少 server');
    expect(snapshotServer.config).toEqual({ baseUrl: 'https://example.com' });
    expect(snapshotServer.secretsEncrypted).toBeUndefined();
    expect(snapshotServer.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'echo',
          pathTemplate: '/echo-v1',
          enabled: true,
          approvalMode: 'allow',
        }),
      ]),
    );
    expect(JSON.stringify(versionDetail.definition)).not.toContain('mcpToken');
    const snapshotSkill = definition.resources.skills.find(
      (item) => item.slug === `e2e-skill-${suffix}`,
    );
    if (snapshotSkill === undefined) throw new Error('发布快照缺少 skill');
    expect(snapshotSkill.body).toBe(`SKILL-BODY-V1-${suffix}`);

    const afterPublish = await apiJson<{ runId: string }>(browser, 'POST', '/api/chat', {
      agentId,
      message: `after-publish-${suffix}`,
    });
    const publishedRun = await waitRun(browser, afterPublish.runId);
    expect(publishedRun).toContain(`[SYSTEM:draft-${suffix}]`);

    await apiJson(browser, 'PATCH', `/api/agents/${agentId}`, {
      systemPrompt: `E2E-SYSTEM-ECHO:next-${suffix}`,
    });
    await apiJson(browser, 'PUT', `/api/agents/${agentId}/rules/rule-draft`, {
      content: `rule-v2-${suffix}`,
      globs: '',
    });
    await apiJson(browser, 'PUT', `/api/agents/${agentId}/output-styles/concise`, {
      description: 'E2E style changed',
      keepCodingInstructions: true,
      body: 'E2E-STYLE-CHANGED',
    });
    await apiJson(browser, 'PATCH', `/api/agents/${agentId}/workflows/${workflow.id}`, {
      content:
        "export const meta = {\n  name: 'E2E flow',\n  description: 'E2E workflow',\n}\n\n// E2E-WORKFLOW-CHANGED\n",
    });
    await apiJson(browser, 'PUT', `/api/agents/${agentId}/memory/policy`, {
      policy: { ...memoryPolicy, topicLimit: 12 },
    });
    await apiJson(browser, 'PUT', `/api/agents/${agentId}/hooks/files`, {
      path: 'check.sh',
      content: '#!/bin/sh\necho changed',
      executable: true,
    });
    await apiJson(
      browser,
      'POST',
      `/api/agents/${agentId}/rollback`,
      { version: publishedVersion },
      200,
    );

    const versions = await apiJson<VersionSummary[]>(
      browser,
      'GET',
      `/api/agents/${agentId}/versions`,
    );
    const latestVersion = Math.max(...versions.map((item) => item.version));
    const rolledBack = await apiJson<VersionDetail>(
      browser,
      'GET',
      `/api/agents/${agentId}/versions/${latestVersion}`,
    );
    const rolledBackDefinition = rolledBack.definition;
    if (rolledBackDefinition === null) throw new Error(`v${latestVersion} 缺少 definition`);
    expect(rolledBackDefinition.agent.systemPrompt).toContain(`draft-${suffix}`);
    expect(rolledBackDefinition.agent.systemPrompt).not.toContain(`next-${suffix}`);
    expect(rolledBackDefinition.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'rule-draft', content: `rule-v1-${suffix}` }),
      ]),
    );
    expect(rolledBackDefinition.outputStyles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'concise',
          description: 'E2E style',
          keepCodingInstructions: false,
          body: 'E2E-STYLE-BODY',
          isSelected: true,
        }),
      ]),
    );
    expect(rolledBackDefinition.outputStyles).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ body: 'E2E-STYLE-CHANGED' })]),
    );
    expect(rolledBackDefinition.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'e2e-flow',
          content: expect.stringContaining('E2E-WORKFLOW-BODY'),
        }),
      ]),
    );
    expect(rolledBackDefinition.workflows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('E2E-WORKFLOW-CHANGED') }),
      ]),
    );
    expect(rolledBackDefinition.memoryPolicy).toEqual(memoryPolicy);
    expect(rolledBackDefinition.hooks.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'check.sh', content: '#!/bin/sh\necho ok' }),
      ]),
    );

    const afterRollback = await apiJson<{ runId: string }>(browser, 'POST', '/api/chat', {
      agentId,
      message: `after-rollback-${suffix}`,
    });
    const rollbackRun = await waitRun(browser, afterRollback.runId);
    expect(rollbackRun).toContain(`[SYSTEM:draft-${suffix}]`);

    await apiJson(browser, 'PATCH', `/api/skills/${skill.id}`, {
      body: `SKILL-BODY-V2-${suffix}`,
    });
    await apiJson(browser, 'PATCH', `/api/servers/${server.id}`, {
      baseUrl: 'https://example.org',
    });
    await apiJson(browser, 'PATCH', `/api/servers/${server.id}/tools/${tool.id}`, {
      pathTemplate: '/echo-v2',
    });
    await apiJson(
      browser,
      'POST',
      `/api/agents/${agentId}/rollback`,
      { version: publishedVersion },
      200,
    );
    const resourceVersions = await apiJson<VersionSummary[]>(
      browser,
      'GET',
      `/api/agents/${agentId}/versions`,
    );
    const latestResourceVersion = Math.max(...resourceVersions.map((item) => item.version));
    const resourceRollback = await apiJson<VersionDetail>(
      browser,
      'GET',
      `/api/agents/${agentId}/versions/${latestResourceVersion}`,
    );
    const resourceDefinition = resourceRollback.definition;
    if (resourceDefinition === null) throw new Error(`v${latestResourceVersion} 缺少 definition`);
    const rolledBackSkill = resourceDefinition.resources.skills.find(
      (item) => item.slug === `e2e-skill-${suffix}`,
    );
    if (rolledBackSkill === undefined) throw new Error('回滚快照缺少 skill');
    expect(rolledBackSkill.body).toBe(`SKILL-BODY-V1-${suffix}`);
    const rolledBackServer = resourceDefinition.resources.servers.find(
      (item) => item.id === server.id,
    );
    if (rolledBackServer === undefined) throw new Error('回滚快照缺少 server');
    expect(rolledBackServer.config).toEqual({ baseUrl: 'https://example.com' });
    const rolledBackTool = rolledBackServer.tools?.find((item) => item.name === 'echo');
    if (rolledBackTool === undefined) throw new Error('回滚快照缺少 tool');
    expect(rolledBackTool.pathTemplate).toBe('/echo-v1');
    const liveSkill = await apiJson<{ body: string }>(browser, 'GET', `/api/skills/${skill.id}`);
    expect(liveSkill.body).toBe(`SKILL-BODY-V2-${suffix}`);

    await browser.setViewport({ width: 1440, height: 900 });
    await app.open(`/agents/${agentId}?tab=config`);
    await expect(screen.getByRole('button', { name: '发布' }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(screen.getByRole('button', { name: '试跑' }).first()).toBeVisible({
      timeout: 15_000,
    });
    const moreButton = screen.getByRole('button', { name: '更多操作' }).first();
    await expect(moreButton).toBeVisible({ timeout: 15_000 });
    await moreButton.tap();
    await expect(screen.getByText(/下线专家/).first()).toBeVisible({ timeout: 15_000 });
    await browser.keyboard.press('Escape');
    await expect(screen.getByText(/保存更改|保存草稿|已保存/).first()).toBeVisible({
      timeout: 15_000,
    });
    const historyButton = screen.getByRole('button', { name: '版本历史' }).first();
    await expect(historyButton).toBeVisible({ timeout: 15_000 });
    await historyButton.tap();
    await expect(screen.getByText('版本历史', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    expect((await app.screenshot('agent-publish-1440')).length).toBeGreaterThan(0);

    await app.open(`/agents/${agentId}?tab=instructions`);
    await expect(screen.getByRole('tab', '项目规则').first()).toBeVisible({ timeout: 60_000 });
    await screen.getByRole('tab', '配置', { exact: true }).tap();
    const trialButton = screen.getByRole('button', { name: '试跑' }).first();
    await expect(trialButton).toBeVisible({ timeout: 15_000 });
    await trialButton.tap();
    const trialDialog = screen.getByRole('dialog', '试跑当前草稿');
    await trialDialog.getByLabel('输入').fill(`ui-trial-${suffix}`);
    await trialDialog.getByRole('button', { name: '开始试跑' }).tap();
    const trialRunLink = trialDialog.getByRole('link', { name: '查看运行' });
    await expect(trialRunLink).toBeVisible({ timeout: 60_000 });
    const uiTrialRunId = (await trialRunLink.getAttribute('href'))?.match(/\/runs\/([^/?#]+)/)?.[1];
    if (uiTrialRunId === undefined) throw new Error('试跑未给出运行链接');
    await waitRun(browser, uiTrialRunId);
    await browser.keyboard.press('Escape');

    await apiJson(browser, 'PATCH', `/api/agents/${agentId}`, {
      systemPrompt: `E2E-SYSTEM-ECHO:ui-publish-${suffix}`,
    });
    await app.open(`/agents/${agentId}?tab=config`);
    const publishButton = screen.getByRole('button', { name: '发布' }).first();
    await expect(publishButton).toBeVisible({ timeout: 60_000 });
    await publishButton.tap();
    const publishDialog = screen.getByRole('dialog', /发布专家/);
    await publishDialog.getByRole('button', { name: '发布', exact: true }).tap();
    await expect(screen.getByText(/已发布 v\d+/).first()).toBeVisible({ timeout: 30_000 });

    const offline = await apiJson<AgentDetail>(
      browser,
      'POST',
      `/api/agents/${agentId}/offline`,
      undefined,
      200,
    );
    expect(offline.enabled).toBe(false);
    const blocked = await browserFetch(browser, 'POST', '/api/chat', {
      agentId,
      message: `offline-${suffix}`,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.text).toContain('AGENT_DISABLED');

    await browser.setViewport({ width: 1200, height: 900 });
    await app.open(`/agents/${agentId}?tab=config`);
    await expect(screen.getByText(/上线专家|已停用|已下线/).first()).toBeVisible({
      timeout: 60_000,
    });
    expect((await app.screenshot('agent-publish-1200')).length).toBeGreaterThan(0);
  } finally {
    if (agentId !== undefined) {
      await apiJson(browser, 'DELETE', `/api/agents/${agentId}`);
    }
    if (skillId !== undefined) {
      try {
        await apiJson(browser, 'DELETE', `/api/skills/${skillId}`);
      } catch {}
    }
    if (serverId !== undefined) {
      try {
        await apiJson(browser, 'DELETE', `/api/servers/${serverId}`);
      } catch {}
    }
  }
});
