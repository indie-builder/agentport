import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { OUTPUT_WRITE_MARKER, requireExecutionStack } from './support/execution-stack.js';

await requireExecutionStack();

const ADMIN = {
  username: process.env.E2E_ADMIN_USER ?? 'admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? '',
};

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);

interface AgentSummary {
  id: string;
  name: string;
  isFavorite?: boolean;
  lastUsedAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  visibility?: string;
  tags?: string[];
  skillIds?: string[];
}

interface RunDetail {
  run: { id: string; status: string };
}

interface SearchItem {
  kind: string;
  id: string;
  title: string;
  path?: string;
  conversationId?: string;
  runId?: string;
}

interface Role {
  id: string;
  name: string;
  systemKey: string | null;
  grants: Array<{ permissionId: string; scope: string }>;
}

interface RoleMatrix {
  revision: number;
  roles: Role[];
}

interface Account {
  businessId: string;
  username: string;
  password: string;
  name: string;
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

async function waitRun(browser: Browser, runId: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  let last = '';
  while (Date.now() < deadline) {
    const detail = await apiJson<RunDetail>(browser, 'GET', `/api/runs/${runId}`);
    last = JSON.stringify(detail);
    if (detail.run.status === 'succeeded') return;
    if (TERMINAL_STATUSES.has(detail.run.status))
      throw new Error(`运行 ${runId} 终态 ${detail.run.status}: ${last}`);
    await sleep(1_000);
  }
  throw new Error(`等待运行 ${runId} 进入终态超时：${last}`);
}

function login(browser: Browser, account: { username: string; password: string }): Promise<void> {
  return apiJson(browser, 'POST', '/api/auth/login', account, 200);
}

function adminLogin(browser: Browser): Promise<void> {
  return login(browser, ADMIN);
}

async function bestEffort(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.log(`[发现 E2E 清理跳过] ${label}：${String(error)}`);
  }
}

test('agent discovery 授权专家发现、归档恢复、统一搜索、个人清单与技能审核', {
  session: 'admin',
  timeout: 600_000,
}, async ({ app, browser, screen }) => {
  await app.open('/');
  await browser.setViewport({ width: 1440, height: 900 });
  const suffix = crypto.randomUUID().slice(0, 8);
  const tag = `E2E-${suffix}`;
  const message = `${OUTPUT_WRITE_MARKER} E2E 发现与搜索 ${suffix}`;
  const agents: string[] = [];
  const accounts: Account[] = [];
  let agentId: string | undefined;
  let privateAgentId: string | undefined;
  let searchSkillId: string | undefined;
  let draftSkillId: string | undefined;
  let serverId: string | undefined;
  let knowledgeBaseId: string | undefined;
  let customRoleName: string | undefined;

  try {
    const matrix = await apiJson<RoleMatrix>(browser, 'GET', '/api/roles');
    const userRole = matrix.roles.find((role) => role.systemKey === 'user');
    if (userRole === undefined) throw new Error('角色矩阵缺少系统「用户」角色');
    customRoleName = `E2E 发现用户 ${suffix}`;
    const seen = new Set<string>();
    const grants = [
      ...userRole.grants,
      { permissionId: 'skills.read', scope: 'own_data' },
      { permissionId: 'skills.create', scope: 'own_data' },
      { permissionId: 'skills.update', scope: 'own_data' },
      { permissionId: 'agents.config.read', scope: 'maintained_agents' },
    ].filter((grant) => {
      const key = `${grant.permissionId}\u0000${grant.scope}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const replaced = await apiJson<RoleMatrix>(
      browser,
      'PUT',
      '/api/roles',
      {
        expectedRevision: matrix.revision,
        roles: [
          ...matrix.roles.map((role) => ({
            id: role.id,
            name: role.name,
            grants: role.grants,
          })),
          { name: customRoleName, grants },
        ],
      },
      200,
    );
    const customRole = replaced.roles.find((role) => role.name === customRoleName);
    if (customRole === undefined) throw new Error('自定义角色未出现在角色矩阵');

    const user: Account = {
      businessId: `e2e-discovery-${suffix}`,
      username: `e2e_discovery_${suffix}`,
      password: `E2e-discovery-${suffix}-pass`,
      name: `E2E 发现用户 ${suffix}`,
    };
    await apiJson(
      browser,
      'POST',
      '/api/accounts',
      {
        businessId: user.businessId,
        username: user.username,
        name: user.name,
        password: user.password,
        roleIds: [customRole.id],
      },
      201,
    );
    accounts.push(user);

    const visibleAgent = await apiJson<AgentSummary>(
      browser,
      'POST',
      '/api/agents',
      {
        slug: `e2e-discovery-visible-${suffix}`,
        name: `E2E 可见专家 ${suffix}`,
        systemPrompt: 'E2E discovery visible',
        visibility: 'organization',
        tags: [tag],
      },
      201,
    );
    agentId = visibleAgent.id;
    agents.push(agentId);
    await apiJson(
      browser,
      'POST',
      `/api/agents/${agentId}/publish`,
      { note: 'e2e discovery' },
      200,
    );

    const privateAgent = await apiJson<AgentSummary>(
      browser,
      'POST',
      '/api/agents',
      {
        slug: `e2e-discovery-private-${suffix}`,
        name: `E2E 私有专家 ${suffix}`,
        systemPrompt: 'E2E discovery private',
      },
      201,
    );
    privateAgentId = privateAgent.id;
    agents.push(privateAgentId);
    await apiJson(
      browser,
      'POST',
      `/api/agents/${privateAgentId}/publish`,
      { note: 'e2e private' },
      200,
    );

    await login(browser, user);
    const visible = await apiJson<{ items: AgentSummary[] }>(browser, 'GET', '/api/agents');
    expect(visible.items.some((agent) => agent.id === agentId)).toBe(true);
    expect(visible.items.some((agent) => agent.id === privateAgentId)).toBe(false);

    const discovered = visible.items.find((agent) => agent.id === agentId);
    if (discovered === undefined) throw new Error('普通用户列表缺少可见专家');
    expect(discovered.visibility).toBe('organization');
    const userAccess = await apiJson<{ permissionIds: string[] }>(
      browser,
      'GET',
      `/api/agents/${agentId}/access`,
      undefined,
      200,
    );
    expect(userAccess.permissionIds).toContain('agents.use');
    await apiJson(browser, 'GET', `/api/agents/${privateAgentId}`, undefined, 404);
    await apiJson(browser, 'GET', `/api/agents/${privateAgentId}/access`, undefined, 404);

    const tagged = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      `/api/agents?tag=${encodeURIComponent(tag)}`,
    );
    expect(tagged.items.some((agent) => agent.id === agentId)).toBe(true);

    await apiJson(browser, 'PUT', `/api/agents/${agentId}/favorite`, { favorite: true }, 200);
    const favorites = await apiJson<{ items: AgentSummary[] }>(browser, 'GET', '/api/agents');
    expect(favorites.items.find((agent) => agent.id === agentId)?.isFavorite).toBe(true);

    const started = await apiJson<{ runId: string; conversationId: string }>(
      browser,
      'POST',
      '/api/chat',
      { agentId, message },
      202,
    );
    await waitRun(browser, started.runId);

    const recent = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      '/api/agents?sort=recent',
    );
    expect(recent.items[0]?.id).toBe(agentId);
    expect(recent.items[0]?.lastUsedAt).not.toBeNull();

    const outputsUrl = `/api/conversations/${started.conversationId}/outputs`;
    const outputs = await apiJson<{ items: Array<{ runId: string; path: string }> }>(
      browser,
      'GET',
      outputsUrl,
    );
    const artifact = outputs.items.find(
      (item) => item.runId === started.runId && item.path === 'normal-report.md',
    );
    if (artifact === undefined)
      throw new Error(`会话成果缺少 normal-report.md：${JSON.stringify(outputs)}`);

    await adminLogin(browser);
    await apiJson(browser, 'POST', `/api/agents/${agentId}/archive`, undefined, 200);
    await login(browser, user);
    const activeAfterArchive = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      '/api/agents',
    );
    expect(activeAfterArchive.items.some((agent) => agent.id === agentId)).toBe(false);
    const userArchived = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      '/api/agents?status=archived',
    );
    expect(userArchived.items.some((agent) => agent.id === agentId)).toBe(false);

    await adminLogin(browser);
    const adminArchived = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      '/api/agents?status=archived',
    );
    const archivedRow = adminArchived.items.find((agent) => agent.id === agentId);
    if (archivedRow === undefined || archivedRow.archivedAt == null)
      throw new Error(`管理员归档列表缺少专家：${JSON.stringify(adminArchived)}`);
    await apiJson(browser, 'POST', `/api/agents/${agentId}/restore`, undefined, 200);

    await login(browser, user);
    const activeAfterArchiveRestore = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      '/api/agents',
    );
    expect(activeAfterArchiveRestore.items.some((agent) => agent.id === agentId)).toBe(true);

    await adminLogin(browser);
    await apiJson(browser, 'DELETE', `/api/agents/${agentId}`, undefined, 204);
    const deletedRows = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      '/api/agents?status=deleted',
    );
    const deletedRow = deletedRows.items.find((agent) => agent.id === agentId);
    if (deletedRow === undefined || deletedRow.deletedAt == null)
      throw new Error(`管理员删除列表缺少专家：${JSON.stringify(deletedRows)}`);

    await login(browser, user);
    const activeAfterDelete = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      '/api/agents',
    );
    expect(activeAfterDelete.items.some((agent) => agent.id === agentId)).toBe(false);
    const deletedOutputs = await apiJson<{ items: Array<{ runId: string; path: string }> }>(
      browser,
      'GET',
      outputsUrl,
    );
    expect(
      deletedOutputs.items.some(
        (item) => item.runId === started.runId && item.path === 'normal-report.md',
      ),
    ).toBe(true);

    await adminLogin(browser);
    await apiJson(browser, 'POST', `/api/agents/${agentId}/restore`, undefined, 200);
    await login(browser, user);
    const activeAfterDeleteRestore = await apiJson<{ items: AgentSummary[] }>(
      browser,
      'GET',
      '/api/agents',
    );
    expect(activeAfterDeleteRestore.items.some((agent) => agent.id === agentId)).toBe(true);
    const restoredOutputs = await apiJson<{ items: Array<{ runId: string; path: string }> }>(
      browser,
      'GET',
      outputsUrl,
    );
    expect(
      restoredOutputs.items.some(
        (item) => item.runId === started.runId && item.path === 'normal-report.md',
      ),
    ).toBe(true);

    const userSearch = await apiJson<{ items: SearchItem[] }>(
      browser,
      'GET',
      `/api/search?q=${encodeURIComponent(suffix)}&limit=20`,
    );
    expect(userSearch.items.some((item) => item.kind === 'agent' && item.id === agentId)).toBe(
      true,
    );
    expect(
      userSearch.items.some(
        (item) => item.kind === 'conversation' && item.id === started.conversationId,
      ),
    ).toBe(true);
    const outputSearch = await apiJson<{ items: SearchItem[] }>(
      browser,
      'GET',
      '/api/search?q=normal-report.md&limit=20',
    );
    expect(
      outputSearch.items.some(
        (item) =>
          item.kind === 'output' &&
          item.conversationId === started.conversationId &&
          item.path === 'normal-report.md',
      ),
    ).toBe(true);

    await adminLogin(browser);
    const searchSkill = await apiJson<{ id: string; status: string }>(
      browser,
      'POST',
      '/api/skills',
      {
        slug: `e2e-discovery-skill-${suffix}`,
        name: `E2E 发现技能 ${suffix}`,
        description: 'E2E discovery search',
        body: `E2E discovery skill ${suffix}`,
      },
      201,
    );
    searchSkillId = searchSkill.id;
    expect(searchSkill.status).toBe('published');
    const server = await apiJson<{ id: string }>(
      browser,
      'POST',
      '/api/servers',
      {
        kind: 'generated',
        name: `e2e-discovery-server-${suffix}`,
        description: 'E2E discovery search',
        baseUrl: 'https://example.com',
        headers: {},
      },
      201,
    );
    serverId = server.id;

    let knowledgeSkipped: string | null = null;
    const profiles = await apiJson<Array<{ id: string; kind: string; enabled: boolean }>>(
      browser,
      'GET',
      '/api/knowledge/model-profiles',
    );
    const embeddingProfile = profiles.find(
      (profile) => profile.kind === 'embedding' && profile.enabled,
    );
    if (embeddingProfile === undefined) {
      knowledgeSkipped = '隔离栈没有可用的 embedding 模型档案，跳过知识库创建';
    } else {
      const knowledgeBase = await apiJson<{ id: string }>(
        browser,
        'POST',
        '/api/knowledge/bases',
        {
          slug: `e2e-discovery-kb-${suffix}`,
          name: `E2E 发现知识库 ${suffix}`,
          description: 'E2E discovery search',
          embeddingProfileId: embeddingProfile.id,
        },
        201,
      );
      knowledgeBaseId = knowledgeBase.id;
    }

    const adminSearch = await apiJson<{ items: SearchItem[] }>(
      browser,
      'GET',
      `/api/search?q=${encodeURIComponent(suffix)}&limit=20`,
    );
    expect(
      adminSearch.items.some((item) => item.kind === 'skill' && item.id === searchSkillId),
    ).toBe(true);
    expect(adminSearch.items.some((item) => item.kind === 'server' && item.id === serverId)).toBe(
      true,
    );
    if (knowledgeBaseId !== undefined) {
      expect(
        adminSearch.items.some((item) => item.kind === 'knowledge' && item.id === knowledgeBaseId),
      ).toBe(true);
    }
    console.log(
      JSON.stringify({
        discoverySearch: {
          user: userSearch.items.map((item) => ({ kind: item.kind, id: item.id })),
          output: outputSearch.items.map((item) => ({ kind: item.kind, path: item.path })),
          admin: adminSearch.items.map((item) => ({ kind: item.kind, id: item.id })),
          knowledgeSkipped,
        },
      }),
    );

    await login(browser, user);
    const personalConversations = await apiJson<{ items: Array<{ id: string; title: string }> }>(
      browser,
      'GET',
      '/api/me/conversations',
    );
    expect(personalConversations.items.some((item) => item.id === started.conversationId)).toBe(
      true,
    );
    const personalOutputs = await apiJson<{
      items: Array<{ conversationId: string; path: string }>;
    }>(browser, 'GET', '/api/me/outputs');
    expect(
      personalOutputs.items.some(
        (item) =>
          item.conversationId === started.conversationId && item.path === 'normal-report.md',
      ),
    ).toBe(true);

    await app.open('/personal/work');
    await expect(screen.getByRole('heading', { name: '会话与成果', level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    await expect(screen.getByRole('tab', { name: '会话', exact: true })).toBeVisible();
    await expect(screen.getByRole('tab', { name: '成果', exact: true })).toBeVisible();
    await screen.getByRole('tab', { name: '成果', exact: true }).tap();
    await expect(screen.getByText('normal-report.md').first()).toBeVisible({ timeout: 30_000 });

    await app.open(`/search?q=${encodeURIComponent(suffix)}`);
    await expect(screen.getByRole('heading', { name: '搜索', level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    await expect(screen.getByRole('heading', { name: '专家', level: 2 })).toBeVisible({
      timeout: 60_000,
    });
    await expect(screen.getByText(`E2E 可见专家 ${suffix}`).first()).toBeVisible();

    const draft = await apiJson<{ id: string; status: string }>(
      browser,
      'POST',
      `/api/runs/${started.runId}/skill-draft`,
      undefined,
      201,
    );
    draftSkillId = draft.id;
    expect(draft.status).toBe('draft');

    await adminLogin(browser);
    const blocked = await apiJson<{ code?: string }>(
      browser,
      'PATCH',
      `/api/agents/${agentId}`,
      { skillIds: [draftSkillId] },
      400,
    );
    expect(blocked.code).toBe('INVALID_INPUT');

    await login(browser, user);
    const pending = await apiJson<{ status: string }>(
      browser,
      'POST',
      `/api/skills/${draftSkillId}/submit`,
      undefined,
      200,
    );
    expect(pending.status).toBe('pending');

    await adminLogin(browser);
    const approved = await apiJson<{ status: string }>(
      browser,
      'POST',
      `/api/skills/${draftSkillId}/approve`,
      undefined,
      200,
    );
    expect(approved.status).toBe('published');
    const bound = await apiJson<{ kind: 'detail' | 'summary'; agent: AgentSummary }>(
      browser,
      'PATCH',
      `/api/agents/${agentId}`,
      { skillIds: [draftSkillId] },
      200,
    );
    expect(bound.agent.skillIds ?? []).toContain(draftSkillId);
    expect((await app.screenshot('agent-discovery-search')).length).toBeGreaterThan(0);
  } finally {
    await bestEffort('管理员重新登录', () => adminLogin(browser));
    for (const id of agents) {
      await bestEffort(`删除专家 ${id}`, () =>
        apiJson(browser, 'DELETE', `/api/agents/${id}`, undefined, 204),
      );
    }
    for (const id of [draftSkillId, searchSkillId]) {
      if (id === undefined) continue;
      await bestEffort(`删除技能 ${id}`, () =>
        apiJson(browser, 'DELETE', `/api/skills/${id}`, undefined, 204),
      );
    }
    if (serverId !== undefined) {
      await bestEffort(`删除连接器 ${serverId}`, () =>
        apiJson(browser, 'DELETE', `/api/servers/${serverId}`, undefined, 204),
      );
    }
    if (knowledgeBaseId !== undefined) {
      await bestEffort(`删除知识库 ${knowledgeBaseId}`, () =>
        apiJson(browser, 'DELETE', `/api/knowledge/bases/${knowledgeBaseId}`, undefined, 204),
      );
    }
    for (const account of accounts) {
      await bestEffort(`删除账号 ${account.businessId}`, () =>
        apiJson(browser, 'DELETE', `/api/accounts/${account.businessId}`, undefined, 200),
      );
    }
    if (customRoleName !== undefined) {
      await bestEffort('移除自定义角色', async () => {
        const current = await apiJson<RoleMatrix>(browser, 'GET', '/api/roles');
        const target = current.roles.find((role) => role.name === customRoleName);
        if (target === undefined) return;
        await apiJson(
          browser,
          'PUT',
          '/api/roles',
          {
            expectedRevision: current.revision,
            roles: current.roles
              .filter((role) => role.id !== target.id)
              .map((role) => ({ id: role.id, name: role.name, grants: role.grants })),
          },
          200,
        );
      });
    }
  }
});

test('archived agent cannot be woken by channel mention', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, browser }) => {
  await app.open('/');
  await adminLogin(browser);
  const suffix = crypto.randomUUID().slice(0, 8);
  const agent = await apiJson<AgentSummary>(
    browser,
    'POST',
    '/api/agents',
    {
      slug: `e2e-archive-wake-${suffix}`,
      name: `E2E 归档唤醒专家 ${suffix}`,
      systemPrompt: 'E2E archive wake',
    },
    201,
  );
  await apiJson(
    browser,
    'POST',
    `/api/agents/${agent.id}/publish`,
    { note: 'e2e archive wake' },
    200,
  );

  const channel = await apiJson<{ id: string }>(
    browser,
    'POST',
    '/api/channels',
    {
      name: `E2E 归档唤醒频道 ${suffix}`,
    },
    201,
  );
  await apiJson(
    browser,
    'POST',
    `/api/channels/${channel.id}/agents`,
    { agentId: agent.id, autoWakeOnAll: true },
    201,
  );

  const archived = await apiJson<AgentSummary>(
    browser,
    'POST',
    `/api/agents/${agent.id}/archive`,
    undefined,
    200,
  );
  expect(archived.archivedAt ?? null).not.toBeNull();

  const marker = `E2E-ARCHIVE-WAKE-${suffix}`;
  const rejected = await apiJson<{ code?: string }>(
    browser,
    'POST',
    `/api/channels/${channel.id}/messages`,
    { body: `@${agent.name} ${marker}`, mentions: [agent.id] },
    400,
  );
  expect(rejected.code).toBe('INVALID_INPUT');

  const messages = await apiJson<Array<{ body: string }>>(
    browser,
    'GET',
    `/api/channels/${channel.id}/messages`,
  );
  expect(messages.some((message) => message.body.includes(marker))).toBe(false);

  const active = await apiJson<{ items: AgentSummary[] }>(browser, 'GET', '/api/agents');
  expect(active.items.some((row) => row.id === agent.id)).toBe(false);
});
