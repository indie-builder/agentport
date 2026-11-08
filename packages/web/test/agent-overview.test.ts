import type {
  Agent,
  AgentMemoryOverview,
  KnowledgeBase,
  PermissionId,
  RunList,
} from '@agentport/shared';
import { agentInputSchema, PERMISSIONS } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOverview, type AgentOverviewTarget } from '../src/components/agent-overview.js';
import { api } from '../src/lib/api.js';
import { formatDateTime } from '../src/lib/format.js';

const agent: Agent = {
  ...agentInputSchema.parse({
    slug: 'expert',
    name: 'Expert',
    description: '负责把用户反馈整理成周报。',
    model: 'group/flash',
    effort: 'high',
    serverIds: ['server_connector', 'server_kb'],
    skillIds: ['skill_a', 'skill_b'],
    subAgentIds: ['agent_child'],
    pluginBindings: [{ pluginId: 'plugin_a', allowHooks: false, allowMcp: true }],
  }),
  id: 'expert',
  role: '内容运营',
  parentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-02-02T08:00:00Z',
};

const memoryOverview: AgentMemoryOverview = {
  policy: {
    enabled: true,
    writeMode: 'native_auto',
    injectPersonalMemory: true,
    injectRules: true,
    topicLimit: 20,
  },
  index: { present: true, lines: 42, bytes: 1024, maxLines: 200, maxBytes: 25 * 1024 },
  topics: { count: 3, bytes: 3072, unlinked: [], stale: [] },
  rules: { count: 2, bytes: 512 },
  personal: { chars: 120, maxChars: 9000 },
  unaccounted: { count: 0, names: [] },
  health: [
    {
      code: 'topics_stale',
      level: 'warn',
      title: '主题长期未更新',
      detail: '超过 60 天未更新：old.md',
    },
  ],
  recentChanges: [],
  changesTotal: 0,
};

const knowledgeBase = {
  id: 'kb_1',
  serverId: 'server_kb',
  name: '产品手册',
  slug: 'handbook',
  description: '',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as KnowledgeBase;

const rule = {
  id: 'rule_1',
  agentId: agent.id,
  slug: 'no-console',
  content: '# 规则',
  globs: '',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const style = (slug: string, isSelected: boolean) => ({
  id: `style_${slug}`,
  agentId: agent.id,
  slug,
  description: '',
  keepCodingInstructions: false,
  body: '# 风格',
  isSelected,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const run = {
  id: 'run_1',
  agentId: agent.id,
  agentName: agent.name,
  status: 'succeeded' as const,
  startedAt: '2026-03-01T02:30:00.000Z',
  endedAt: '2026-03-01T02:31:00.000Z',
  latencyMs: 60_000,
  costUsd: '0.01',
  turns: 2,
  inputTokens: 100,
  outputTokens: 200,
  error: null,
  trigger: 'schedule' as const,
};

const allPermissions: PermissionId[] = PERMISSIONS.filter((permission) =>
  [
    'agents.read',
    'agents.use',
    'agents.config.read',
    'agents.memory.read',
    'agents.rules.read',
    'agents.styles.read',
    'agents.files.read',
  ].includes(permission.id),
).map((permission) => permission.id);

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createBrowserHistory>;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function waitFor<T>(probe: () => T, tries = 60): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 查询或路由还没落地，继续等。
    }
    await flush();
  }
  return probe();
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function button(text: string, scope: ParentNode = host): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

function row(label: string): HTMLButtonElement {
  const element = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.trim().startsWith(label),
  );
  if (!element) throw new Error(`Missing row: ${label}`);
  return element;
}

async function mount(options: {
  config?: Agent | null;
  permissions?: readonly PermissionId[];
  agent?: Partial<Pick<Agent, 'description' | 'role' | 'enabled' | 'updatedAt'>>;
  canReadKnowledge?: boolean;
  canViewRuns?: boolean;
  onNavigate?: (next: AgentOverviewTarget) => void;
}) {
  const props = {
    agentId: agent.id,
    agent: { ...agent, ...options.agent },
    config: options.config === undefined ? agent : options.config,
    permissions: options.permissions ?? allPermissions,
    canReadKnowledge: options.canReadKnowledge ?? true,
    canViewRuns: options.canViewRuns ?? true,
    onNavigate: options.onNavigate ?? (() => {}),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => createElement(AgentOverview, props),
  });
  const runs = createRoute({
    getParentRoute: () => rootRoute,
    path: '/runs',
    component: () => createElement('h1', null, 'Runs'),
  });
  history = createBrowserHistory();
  history.replace('/');
  history.flush();
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, runs]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'agentMemoryOverview').mockResolvedValue(memoryOverview);
  vi.spyOn(api, 'agentRules').mockResolvedValue([rule, { ...rule, id: 'rule_2', slug: 'naming' }]);
  vi.spyOn(api, 'agentOutputStyles').mockResolvedValue([
    style('concise', true),
    style('detailed', false),
    style('formal', false),
  ]);
  vi.spyOn(api, 'knowledgeBases').mockResolvedValue({
    items: [knowledgeBase],
    nextCursor: null,
  });
  vi.spyOn(api, 'runs').mockResolvedValue({ items: [] } satisfies RunList);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  history?.destroy();
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('agent overview', () => {
  it('renders the purpose with status and update time, without repeating the role', async () => {
    await mount({});

    await waitFor(() => row('专家记忆'));

    const text = host.textContent ?? '';
    expect(text).toContain('负责把用户反馈整理成周报。');
    expect(text).toContain('用途');
    // 角色徽章只在页头出现，概览不再重复一行。
    expect(text).not.toContain('角色');
    expect(text).not.toContain('内容运营');
    expect(text).toContain('已启用');
    expect(text).toContain(formatDateTime(agent.updatedAt));
    // 有读权时不出现权限说明。
    expect(text).not.toContain('只能使用这个专家');
  });

  it('offers a persistent identity entry to the maintainer', async () => {
    const navigations: AgentOverviewTarget[] = [];
    await mount({ onNavigate: (next) => navigations.push(next) });

    await waitFor(() => button('编辑配置'));
    await click(button('编辑配置'));

    expect(navigations).toEqual([{ tab: 'config', section: 'identity' }]);
  });

  it('states the empty description without a second config button', async () => {
    await mount({ agent: { description: '' } });

    await waitFor(() => button('编辑配置'));

    expect(host.textContent).toContain('尚未填写介绍');
    const labels = [...host.querySelectorAll('button')].map((item) => item.textContent?.trim());
    expect(labels).not.toContain('去配置');
    expect(labels.filter((label) => label === '编辑配置')).toHaveLength(1);
  });

  it('explains the permission limit when there is no read grant', async () => {
    await mount({ permissions: ['agents.use'], config: null, canViewRuns: false });

    await waitFor(() => host.textContent?.includes('只能使用这个专家'));

    const text = host.textContent ?? '';
    expect(text).toContain('当前账户只能使用这个专家，查看或修改配置需要对应的维护权限。');
    expect(text).not.toContain('能力');
    expect(text).not.toContain('知识状态');
    expect(text).not.toContain('最近运行');
    const labels = [...host.querySelectorAll('button')].map((item) => item.textContent?.trim());
    expect(labels).not.toContain('编辑配置');
    expect(api.agentMemoryOverview).not.toHaveBeenCalled();
    expect(api.agentRules).not.toHaveBeenCalled();
    expect(api.agentOutputStyles).not.toHaveBeenCalled();
    expect(api.runs).not.toHaveBeenCalled();
  });

  it('counts capacity without faking zero rows and links to the capability section', async () => {
    const navigations: AgentOverviewTarget[] = [];
    await mount({ onNavigate: (next) => navigations.push(next) });

    await waitFor(() => button('管理能力'));

    const text = host.textContent ?? '';
    expect(text).toContain('group/flash');
    expect(text).toContain('high');
    expect(text).toContain('连接器');
    expect(text).toContain('1 个');
    expect(text).toContain('知识库');
    expect(text).toContain('技能');
    expect(text).toContain('2 个');
    expect(text).toContain('子智能体');
    expect(text).toContain('插件');

    // 两个配置入口文案必须能区分：用途是「编辑配置」，能力是「管理能力」。
    expect(button('编辑配置')).toBeDefined();
    await click(button('管理能力'));
    expect(navigations).toEqual([{ tab: 'config', section: 'capability' }]);
  });

  it('omits empty capability rows instead of showing zero', async () => {
    await mount({
      config: {
        ...agent,
        serverIds: [],
        skillIds: [],
        subAgentIds: [],
        pluginBindings: [],
      },
    });

    await waitFor(() => button('管理能力'));

    const text = host.textContent ?? '';
    expect(text).toContain('推理强度');
    expect(text).not.toContain('连接器');
    expect(text).not.toContain('知识库');
    expect(text).not.toContain('子智能体');
    expect(text).not.toContain('0 个');
  });

  it('links every knowledge row to its own tab and section', async () => {
    const navigations: AgentOverviewTarget[] = [];
    await mount({ onNavigate: (next) => navigations.push(next) });

    await waitFor(() => row('输出风格'));

    const text = host.textContent ?? '';
    expect(text).toContain('3 个主题 · 索引 42 / 200 行');
    expect(text).toContain('注意');
    expect(text).toContain('2 条');
    expect(text).toContain('3 个 · 已启用 1 个');

    await click(row('专家记忆'));
    await click(row('项目规则'));
    await click(row('输出风格'));
    expect(navigations).toEqual([
      { tab: 'memory', view: 'overview' },
      { tab: 'instructions', instruction: 'rules' },
      { tab: 'instructions', instruction: 'styles' },
    ]);
  });

  it('reports a failed knowledge query on one line and retries it', async () => {
    vi.mocked(api.agentRules).mockRejectedValue(new Error('规则加载失败'));
    await mount({});

    await waitFor(() => host.textContent?.includes('项目规则没有加载出来'));
    expect(host.textContent).toContain('规则加载失败');

    await click(button('重试', host));
    await waitFor(() => vi.mocked(api.agentRules).mock.calls.length > 1);
    expect(vi.mocked(api.agentRules).mock.calls.length).toBeGreaterThan(1);
  });

  it('states that there are no runs yet instead of inventing data', async () => {
    await mount({});

    await waitFor(() => host.textContent?.includes('这个专家还没有运行记录。'));
    expect(host.textContent).not.toContain('查看全部运行');
    expect(api.runs).toHaveBeenCalledWith({ agentId: 'expert', limit: 5 });
  });

  it('lists the latest runs and links to the filtered run list', async () => {
    vi.mocked(api.runs).mockResolvedValue({
      items: [
        run,
        {
          ...run,
          id: 'run_2',
          status: 'failed',
          trigger: 'chat',
          startedAt: '2026-03-02T02:30:00.000Z',
          error: '超时',
        },
      ],
    });
    await mount({});

    await waitFor(() => host.textContent?.includes('成功'));

    const text = host.textContent ?? '';
    expect(text).toContain(formatDateTime(run.startedAt));
    expect(text).toContain('定时任务');
    expect(text).toContain('对话');
    expect(text).toContain('成功');
    expect(text).toContain('失败');

    const link = host.querySelector<HTMLAnchorElement>('a[href^="/runs"]');
    expect(link?.getAttribute('href')).toBe('/runs?agent=expert');
  });

  it('hides the run block without runs.read', async () => {
    await mount({ canViewRuns: false });

    await waitFor(() => row('专家记忆'));
    expect(host.textContent).not.toContain('最近运行');
    expect(api.runs).not.toHaveBeenCalled();
  });
});
