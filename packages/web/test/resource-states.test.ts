import {
  type Agent,
  type ApiTool,
  agentInputSchema,
  PERMISSIONS,
  type PermissionId,
  type Server,
} from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { AgentEditor } from '../src/pages/agents/agent-editor.js';
import { AgentsPage } from '../src/pages/agents/agents-page.js';
import { ServersPage } from '../src/pages/servers/index.js';
import {
  agentDetailSearchSchema,
  agentsSearchSchema,
  serversSearchSchema,
} from '../src/routes/-search.js';
import { allAccessMe } from './me-fixture.js';

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  isDefault: false,
  parentId: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  serverIds: ['server'],
  skillIds: ['skill'],
  subAgentIds: ['child'],
};
const server: Server = {
  id: 'server',
  name: 'connector',
  description: '',
  kind: 'generated',
  baseUrl: 'https://example.com',
  headers: {},
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const knowledgeBase = {
  id: 'kb_1',
  slug: 'handbook',
  name: '产品手册',
  description: '',
  serverId: 'server-kb',
  status: 'active' as const,
  embeddingProfileId: 'profile',
  rerankProfileId: null,
  settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const tool: ApiTool = {
  id: 'tool',
  serverId: server.id,
  name: 'list-users',
  description: '',
  method: 'GET',
  pathTemplate: '/users',
  inputSchema: {},
  paramsIn: 'query',
  approvalMode: 'allow',
  enabled: true,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const allPermissions: readonly PermissionId[] = PERMISSIONS.map((permission) => permission.id);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

let host: HTMLDivElement | undefined;
let root: Root | undefined;
let history: ReturnType<typeof createMemoryHistory> | undefined;
const clients: QueryClient[] = [];

function createClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(['me'], allAccessMe);
  client.setQueryData(['agents'], {
    items: [agent, { ...agent, id: 'child', parentId: agent.id }],
    truncated: false,
  });
  client.setQueryData(['agents', 'list', { status: 'active' }], {
    pages: [{ items: [agent, { ...agent, id: 'child', parentId: agent.id }], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['agent-tags'], { items: [] });
  client.setQueryData(['agent-options'], {
    servers: [],
    skills: [],
    plugins: [],
    runtimeEnvironments: [],
  });
  client.setQueryData(['runtime-environments'], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['connector-catalog'], []);
  client.setQueryData(['servers'], {
    pages: [{ items: [server], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['knowledge', 'bases'], {
    pages: [{ items: [knowledgeBase], nextCursor: null }],
    pageParams: [null],
  });
  client.setQueryData(['skills', 'all'], {
    pages: [
      {
        items: [
          {
            id: 'skill',
            slug: 'skill',
            name: 'Skill',
            description: '',
            body: '',
            status: 'published',
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
  client.setQueryData(['plugins', { enabled: true }], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['tools', server.id], [tool]);
  clients.push(client);
  return client;
}

function flush(ms = 10) {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor<T>(probe: () => T, tries = 60): Promise<T> {
  for (let index = 0; index < tries; index += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {}
    await flush();
  }
  return probe();
}

async function mountRoute(
  client: QueryClient,
  initialEntry: string,
  renderEditor?: () => ReactNode,
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const agentsRoute = createRoute({
    getParentRoute: () => shell,
    path: '/agents/',
    validateSearch: agentsSearchSchema,
    component: AgentsPage,
  });
  const agentDetailRoute = createRoute({
    getParentRoute: () => shell,
    path: '/agents/$agentId',
    validateSearch: agentDetailSearchSchema,
    component:
      renderEditor ??
      (() =>
        createElement(AgentEditor, {
          agent,
          permissions: allPermissions,
          onDirtyChange: () => {},
          onPendingChange: () => {},
          onDeleteRequest: () => {},
        })),
  });
  const serversRoute = createRoute({
    getParentRoute: () => shell,
    path: '/servers',
    validateSearch: serversSearchSchema,
    component: ServersPage,
  });
  const stubs = ['/chat', '/knowledge', '/skills', '/plugins'].map((path) =>
    createRoute({
      getParentRoute: () => shell,
      path,
      component: () => createElement('h1', null, path),
    }),
  );
  history = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      shell.addChildren([agentsRoute, agentDetailRoute, serversRoute, ...stubs]),
    ]),
    history,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function typeInput(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

function isDisabled(element: HTMLElement): boolean {
  return (
    element.hasAttribute('disabled') ||
    (element as HTMLButtonElement | HTMLInputElement).disabled === true ||
    element.getAttribute('aria-disabled') === 'true' ||
    element.hasAttribute('data-disabled')
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
  vi.spyOn(api, 'agent').mockResolvedValue(agent);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  history?.destroy();
  for (const client of clients.splice(0)) client.clear();
  host?.remove();
  root = undefined;
  host = undefined;
  history = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resource async state regressions', () => {
  it.each([false, true])(
    'blocks every competing editor entry during import (empty list: %s)',
    async (empty) => {
      const client = createClient();
      if (empty) {
        client.setQueryData(['agents', 'list', { status: 'active' }], {
          pages: [{ items: [], nextCursor: null }],
          pageParams: [undefined],
        });
      }
      const pendingImport = deferred<never>();
      vi.spyOn(api, 'importAgent').mockReturnValue(pendingImport.promise);

      await mountRoute(client, '/agents');
      await waitFor(() => document.querySelector('input[type="file"]'));

      const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!fileInput) throw new Error('Missing import file input');
      const zip = new File(['zip'], 'expert.zip', { type: 'application/zip' });
      Object.defineProperty(fileInput, 'files', { value: [zip], configurable: true });
      await act(async () => {
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();

      const importDialog = await waitFor(() =>
        [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) =>
          dialog.textContent?.includes('导入专家包'),
        ),
      );
      await click(button('导入', importDialog));
      await waitFor(() => vi.mocked(api.importAgent).mock.calls.length === 1);

      const headerCreate = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
        (item) =>
          item.textContent?.includes('新建专家') || item.textContent?.includes('创建数字分身'),
      );
      expect(headerCreate.length).toBeGreaterThan(0);
      expect(headerCreate.every((item) => isDisabled(item))).toBe(true);
      expect(isDisabled(button('更多操作'))).toBe(true);

      if (!empty) {
        const nameLink = document.querySelector<HTMLElement>('a[title="Expert"]');
        const chatLink = document.querySelector<HTMLElement>('a[aria-label="与 Expert 开始对话"]');
        if (!nameLink || !chatLink) throw new Error('Missing agent card links');
        expect(isDisabled(nameLink)).toBe(true);
        expect(nameLink.getAttribute('href')).toBeNull();
        expect(isDisabled(chatLink)).toBe(true);
        expect(chatLink.getAttribute('href')).toBeNull();

        await click(button('操作 Expert'));
        const configItem = await waitFor(() =>
          [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
            item.textContent?.includes('配置'),
          ),
        );
        expect(isDisabled(configItem)).toBe(true);
      }
    },
  );

  it('disables expert fields, bindings, permissions, and enabled state while saving', async () => {
    const client = createClient();
    const saving = deferred<never>();
    vi.spyOn(api, 'updateAgent').mockReturnValue(saving.promise);

    await mountRoute(client, '/agents/expert?tab=config');
    const nameInput = await waitFor(() => document.querySelector<HTMLInputElement>('#agent-name'));
    if (!nameInput) throw new Error('Missing agent name input');
    await typeInput(nameInput, 'Expert Draft');
    await click(button('保存草稿'));
    await waitFor(() => vi.mocked(api.updateAgent).mock.calls.length === 1);

    const enabledSwitch = document.querySelector<HTMLElement>('#agent-enabled');
    if (!enabledSwitch) throw new Error('Missing enabled switch');
    expect(isDisabled(enabledSwitch)).toBe(true);
    expect(isDisabled(nameInput)).toBe(true);

    await click(button('能力'));
    const serverInput = await waitFor(() =>
      document.querySelector<HTMLInputElement>('input[aria-label="MCP Server"]'),
    );
    const kbInput = document.querySelector<HTMLInputElement>('input[aria-label="知识库"]');
    const skillInput = document.querySelector<HTMLInputElement>('input[aria-label="技能"]');
    const subAgentInput = document.querySelector<HTMLInputElement>('input[aria-label="子智能体"]');
    const capabilityControls = [serverInput, kbInput, skillInput, subAgentInput];
    expect(capabilityControls.every((item) => item !== null && isDisabled(item))).toBe(true);

    await click(button('权限'));
    const permTrigger = await waitFor(() => document.querySelector<HTMLElement>('#agent-perm'));
    const allowedTools = document.querySelector<HTMLTextAreaElement>('#agent-allowed-tools');
    if (!permTrigger || !allowedTools) throw new Error('Missing permission controls');
    expect(isDisabled(permTrigger)).toBe(true);
    expect(isDisabled(allowedTools)).toBe(true);

    const builtinToggles = [
      ...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
    ];
    expect(builtinToggles.length).toBeGreaterThan(0);
    expect(builtinToggles.every((item) => isDisabled(item))).toBe(true);
  });

  it.each([
    ['tools', 'pending', false],
    ['tools', 'error', false],
    ['tools', 'error', true],
    ['servers', 'pending', false],
    ['servers', 'error', false],
  ] as const)(
    'does not count unavailable %s as zero (%s, cached: %s)',
    async (source, status, cached) => {
      const client = createClient();
      const queryKey = source === 'tools' ? ['tools', server.id] : ['servers'];

      if (source === 'tools') {
        if (!cached) {
          client.removeQueries({ queryKey });
          if (status === 'pending') {
            vi.spyOn(api, 'tools').mockReturnValue(deferred<ApiTool[]>().promise);
          } else {
            vi.spyOn(api, 'tools')
              .mockRejectedValueOnce(new Error('Resources unavailable'))
              .mockResolvedValue([tool]);
          }
        } else {
          client
            .getQueryCache()
            .find({ queryKey })
            ?.setState({
              status: 'error',
              error: new Error('Resources unavailable'),
            });
          vi.spyOn(api, 'tools').mockResolvedValue([tool]);
        }
      } else {
        client.removeQueries({ queryKey });
        if (status === 'pending') {
          vi.spyOn(api, 'servers').mockReturnValue(deferred<never>().promise);
        } else {
          vi.spyOn(api, 'servers')
            .mockRejectedValueOnce(new Error('Resources unavailable'))
            .mockResolvedValue({ items: [server], nextCursor: null });
        }
      }

      await mountRoute(client, '/agents/expert?tab=config&section=capability');
      const expected = status === 'error' ? '工具数量未知' : '工具数量加载中';
      await waitFor(() => document.body.textContent?.includes(expected));

      expect(document.body.textContent).not.toContain('将获得 0 个工具');
      expect(document.body.textContent).toContain(expected);

      if (status === 'error') {
        await click(button('重试'));
        await waitFor(() => document.body.textContent?.includes('将获得 1 个工具'));
        expect(document.body.textContent).toContain('将获得 1 个工具');
      }
    },
  );

  it.each(['pending', 'error'] as const)(
    'does not count unavailable server bindings as zero (%s)',
    async (status) => {
      const client = createClient();
      client.removeQueries({ queryKey: ['agents'] });
      if (status === 'pending') {
        vi.spyOn(api, 'agentReference').mockReturnValue(deferred<never>().promise);
      } else {
        vi.spyOn(api, 'agentReference')
          .mockRejectedValueOnce(new Error('Experts unavailable'))
          .mockResolvedValue({ items: [agent], truncated: false });
      }

      await mountRoute(client, '/servers?view=table');
      const expected = status === 'error' ? '未知' : '加载中…';
      await waitFor(() => document.querySelector('table')?.textContent?.includes(expected));
      expect(document.querySelector('table')?.textContent).toContain(expected);

      if (status === 'error') {
        await click(button('重试'));
        await waitFor(() => button('查看使用该连接器的 1 个专家'));
        expect(button('查看使用该连接器的 1 个专家')).toBeDefined();
      }
    },
  );

  it('locks only the approval select whose tool is being edited', async () => {
    const client = createClient();
    vi.spyOn(api, 'tools').mockResolvedValue([tool, { ...tool, id: 'other', name: 'other' }]);
    client.setQueryData(['tools', server.id], [tool, { ...tool, id: 'other', name: 'other' }]);

    await mountRoute(client, '/servers?view=table');
    await waitFor(() => button('操作 connector'));
    await click(button('操作 connector'));

    const toolsItem = await waitFor(() =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.includes('工具定义'),
      ),
    );
    await click(toolsItem);

    const editButton = await waitFor(() => button('编辑工具 list-users'));
    await click(editButton);

    const listUsersApproval = await waitFor(() => button('审批策略 list-users'));
    const otherApproval = button('审批策略 other');
    const enableCheckbox = document.querySelector<HTMLElement>(
      '[role="checkbox"][aria-label="启用工具 list-users"]',
    );
    if (!enableCheckbox) throw new Error('Missing enable checkbox');

    expect(isDisabled(listUsersApproval)).toBe(true);
    expect(isDisabled(otherApproval)).toBe(false);
    expect(isDisabled(enableCheckbox)).toBe(false);
  });
});
