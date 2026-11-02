import type { MemoryChange, MemoryFileContent, MemoryFileList } from '@agentport/shared';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { AgentDetailPage, AgentsPage } from '../src/pages/agents.js';
import { Composer } from '../src/pages/chat.js';
import { MemoryPanel } from '../src/pages/memory-panel.js';
import { PluginsPage } from '../src/pages/plugins.js';
import { RuntimeEnvironmentDetailPage } from '../src/pages/runtime-environment-detail.js';

const state = vi.hoisted(() => ({
  me: {
    authenticated: true as const,
    user: { businessId: 'auditor', username: 'auditor', name: '审计员' },
    roles: [] as string[],
    grants: [] as Array<{ permissionId: string; scope: string }>,
  },
  agents: [] as unknown[],
  agentAccess: [] as string[],
  plugins: [] as unknown[],
  environment: null as unknown,
  versions: [] as unknown[],
  search: {} as Record<string, string | undefined>,
  params: { environmentId: 'rtenv_1', agentId: 'agent-1' },
}));

vi.mock('../src/lib/queries.js', async (original) => {
  const actual = await original<typeof import('../src/lib/queries.js')>();
  const idle = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  const query = (data: unknown) => ({
    data,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  return {
    ...actual,
    meQuery: { queryKey: ['me'], queryFn: async () => state.me },
    useAgents: () => query(state.agents),
    useAgentAccess: () => query({ agentId: 'agent-1', permissionIds: state.agentAccess }),
    useAgentSummary: () => query(state.agents[0]),
    useAgentDetail: () => query(state.agents[0]),
    useDeleteAgent: idle,
    useUpdateAgent: idle,
    useRuntimeEnvironments: () => query([]),
    usePlugins: () => query(state.plugins),
    useUpdatePlugin: idle,
    useDeletePlugin: idle,
    useImportPlugin: () => ({ ...idle(), isPending: false }),
    useNativePlugins: () => query({ installed: [] }),
    useInstallNativePlugin: () => ({ ...idle(), isPending: false }),
    useImportNativePlugin: () => ({ ...idle(), isPending: false }),
    useRuntimeEnvironment: () => query(state.environment),
    useRuntimeEnvironmentVersions: () => query(state.versions),
    useRuntimeEnvironmentVersion: () => query(undefined),
    useUpdateRuntimeEnvironment: idle,
    useBuildRuntimeEnvironment: () => ({ ...idle(), isPending: false }),
    usePublishRuntimeEnvironment: idle,
    useDeleteRuntimeEnvironment: idle,
    useRollbackMemoryChange: () => ({ isPending: false, mutateAsync: vi.fn() }),
  };
});

vi.mock('@tanstack/react-router', async () => {
  const { createElement: h } = await import('react');
  return {
    Link: ({ to, params, ...rest }: { to: string; params?: Record<string, string> }) =>
      h('a', {
        href: params ? to.replace(/\$(\w+)/g, (_, key: string) => params[key] ?? '') : to,
        ...rest,
      }),
    useNavigate: () => vi.fn(),
    useSearch: () => state.search,
    useParams: () => state.params,
    useLocation: () => ({ state: undefined }),
    useBlocker: () => ({ status: 'idle', proceed: vi.fn(), reset: vi.fn(), current: undefined }),
  };
});

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const agent = {
  id: 'agent-1',
  slug: 'audit-agent',
  name: ' Audited agent ',
  description: '待审计专家',
  role: '通用助手',
  enabled: true,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ownerBusinessId: 'auditor',
  serverIds: [],
  skillIds: [],
  pluginBindings: [],
  subAgentIds: [],
  allowedTools: [],
  disallowedTools: [],
  model: 'test',
  systemPrompt: '',
  permissionMode: 'default',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600000,
  parentId: null,
  runtimeEnvironmentId: null,
};

const plugin = {
  id: 'plugin-1',
  slug: 'demo',
  runtimeName: 'demo',
  name: '演示插件',
  description: '插件描述',
  version: '1.0.0',
  capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
  files: [],
  agentCount: 0,
  sourceId: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

const memoryFile: MemoryFileContent = {
  name: 'MEMORY.md',
  content: '# 记忆',
  updatedAt: '2026-01-01T00:00:00Z',
};
const memoryList: MemoryFileList = {
  files: [{ name: 'MEMORY.md', size: 4, updatedAt: '2026-01-01T00:00:00Z' }],
  initialized: true,
};
const memoryChange: MemoryChange = {
  id: 'chg_1',
  target: { kind: 'agent_memory', agentId: 'agent-1', name: 'MEMORY.md' },
  before: { content: '', globs: null, index: null },
  after: { content: '# 记忆', globs: null, index: null },
  sourceReviewRunId: null,
  reversesChangeId: null,
  state: 'applied',
  createdAt: '2026-10-01T00:00:00.000Z',
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

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
      // 懒加载的编辑器与查询还没挂载，继续等下一帧。
    }
    await flush();
  }
  return probe();
}

async function mount(element: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(['me'], state.me);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(QueryClientProvider, { client }, element)));
  await flush();
}

function accessibleName(element: Element): string {
  return (
    element.getAttribute('aria-label') ??
    element.getAttribute('title') ??
    element.textContent ??
    ''
  ).trim();
}

function buttonByVisibleText(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function buttonByName(name: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => accessibleName(item) === name,
  );
  if (!found) throw new Error(`Missing button named: ${name}`);
  return found;
}

function linkByName(name: string, scope: ParentNode = document): HTMLAnchorElement {
  const found = [...scope.querySelectorAll<HTMLAnchorElement>('a')].find(
    (item) => accessibleName(item) === name,
  );
  if (!found) throw new Error(`Missing link named: ${name}`);
  return found;
}

function editorView(id: string): EditorView {
  const element = document.getElementById(id);
  if (!element?.classList.contains('cm-content')) throw new Error(`Editor not mounted: ${id}`);
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error(`Editor view not found: ${id}`);
  return view;
}

async function replaceContent(id: string, value: string) {
  await act(async () => {
    const view = editorView(id);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
  await flush();
}

beforeEach(() => {
  state.me = {
    authenticated: true,
    user: { businessId: 'auditor', username: 'auditor', name: '审计员' },
    roles: [],
    grants: [],
  };
  state.agents = [agent];
  state.agentAccess = [];
  state.plugins = [plugin];
  state.environment = null;
  state.versions = [];
  state.search = {};
  useChatStore.getState().reset();
  vi.spyOn(api, 'agentMemory').mockResolvedValue(memoryList);
  vi.spyOn(api, 'agentMemoryFile').mockResolvedValue(memoryFile);
  vi.spyOn(api, 'agentMemoryVersions').mockResolvedValue({ items: [memoryChange] });
  vi.spyOn(api, 'rollbackMemoryChange').mockResolvedValue(memoryChange);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  host?.remove();
  vi.restoreAllMocks();
});

describe('permission feedback stays visible and the action stays disabled', () => {
  it('explains a missing conversation-create grant beside the chat composer', async () => {
    await mount(
      createElement(Composer, {
        agent: agent as never,
        send: vi.fn(),
        textareaRef: { current: null },
        lastRunId: null,
        welcome: false,
      }),
    );

    const send = buttonByName('发送消息');
    expect(send.disabled).toBe(true);
    expect(host.textContent).toContain('当前账户没有新建会话的权限，不能发送消息。');

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]');
    if (!textarea) throw new Error('Missing message textarea');
    const describedBy = textarea.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain(
      '当前账户没有新建会话的权限',
    );
  });

  it('explains an enabled expert the account cannot use and keeps the start action disabled', async () => {
    await mount(createElement(AgentsPage));

    const start = buttonByVisibleText('开始对话');
    expect(start.disabled).toBe(true);
    expect(accessibleName(start)).toContain(agent.name);
    expect(host.textContent).toContain('当前账户没有使用该专家的权限，无法开始对话。');
  });

  it('shows the same reason on the expert detail page', async () => {
    await mount(createElement(AgentDetailPage));

    const start = buttonByVisibleText('开始对话');
    expect(start.disabled).toBe(true);
    expect(host.textContent).toContain('当前账户没有使用该专家的权限，无法开始对话。');
  });

  it('explains why rollback waits for the dirty memory draft and keeps it disabled', async () => {
    await mount(createElement(MemoryPanel, { agentId: 'agent-1' }));

    await waitFor(() => editorView('memory-content'));
    expect(host.textContent).not.toContain('先保存或放弃当前草稿再回滚。');

    await replaceContent('memory-content', '# 新记忆');

    const rollback = buttonByVisibleText('回滚');
    expect(rollback.disabled).toBe(true);
    expect(host.textContent).toContain('先保存或放弃当前草稿再回滚。');
    const describedBy = rollback.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain(
      '先保存或放弃当前草稿再回滚',
    );
    rollback.click();
    expect(api.rollbackMemoryChange).not.toHaveBeenCalled();
  });
});

describe('repeated action names identify their resource', () => {
  it('names each plugin detail link with the plugin', async () => {
    await mount(createElement(PluginsPage));

    const link = linkByName('演示插件');
    expect(link.textContent?.trim()).toBe('演示插件');
    expect(accessibleName(link)).toContain('演示插件');
    expect(link.getAttribute('href')).toBe('/plugins/plugin-1');
  });

  it('names each runtime build-log action with the version short id', async () => {
    state.environment = {
      id: 'rtenv_1',
      name: '运行环境',
      dockerfile: 'FROM scratch',
      isDefault: false,
      onlineVersionId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    state.versions = [
      {
        id: 'rtev_01m5bv0faceh4v4jtw00eta1sn',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: null,
        imageId: null,
      },
    ];
    await mount(createElement(RuntimeEnvironmentDetailPage));

    const log = buttonByName('查看版本 00eta1sn 的构建日志');
    expect(log.textContent?.trim()).toBe('日志');
  });
});
