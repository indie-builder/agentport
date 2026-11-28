import {
  type Agent,
  type ApiTool,
  agentInputSchema,
  PERMISSIONS,
  type Server,
  type Skill,
} from '@agentport/shared';
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
import { ResourcePage } from '../src/components/resource-page.js';
import { ApiError, api } from '../src/lib/api.js';
import { AgentEditor } from '../src/pages/agents/agent-editor.js';
import { ServerFormDialog, ServersPage } from '../src/pages/servers/index.js';
import { SkillsPage } from '../src/pages/skills.js';
import {
  agentDetailSearchSchema,
  serversSearchSchema,
  skillsSearchSchema,
} from '../src/routes/-search.js';
import { allAccessMe } from './me-fixture.js';

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const server: Server = {
  id: 'server',
  name: 'connector',
  description: '',
  kind: 'http',
  url: 'https://example.com/mcp',
  headers: {},
  createdAt: 'v1',
  updatedAt: 'v1',
};
const generatedServer: Server = {
  id: 'server',
  name: 'connector',
  description: '',
  kind: 'generated',
  baseUrl: 'https://example.com',
  headers: {},
  createdAt: 'v1',
  updatedAt: 'v1',
};
const allPermissions = PERMISSIONS.map((permission) => permission.id);
const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  isDefault: false,
  parentId: null,
  createdAt: 'v1',
  updatedAt: 'v1',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

let client: QueryClient;
let host: HTMLDivElement | undefined;
let root: Root | undefined;
let history: ReturnType<typeof createBrowserHistory> | undefined;

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

async function mountRouter(
  initialEntry: string,
  extra?: (shell: ReturnType<typeof createRoute>) => ReturnType<typeof createRoute>[],
) {
  window.history.replaceState(null, '', initialEntry);
  history = createBrowserHistory();
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const routes = extra
    ? extra(shell)
    : [
        createRoute({
          getParentRoute: () => shell,
          path: '/skills',
          validateSearch: skillsSearchSchema,
          component: SkillsPage,
        }),
        createRoute({
          getParentRoute: () => shell,
          path: '/servers',
          validateSearch: serversSearchSchema,
          component: ServersPage,
        }),
        createRoute({
          getParentRoute: () => shell,
          path: '/agents/$agentId',
          validateSearch: agentDetailSearchSchema,
          component: () =>
            createElement(AgentEditor, {
              agent,
              permissions: allPermissions,
              onDirtyChange() {},
              onPendingChange() {},
              onDeleteRequest() {},
            }),
        }),
        createRoute({
          getParentRoute: () => shell,
          path: '/away',
          component: () => createElement('h1', null, 'Destination'),
        }),
        ...['/plugins', '/knowledge', '/data-domains', '/agents/'].map((path) =>
          createRoute({
            getParentRoute: () => shell,
            path,
            component: () => createElement('h1', null, path),
          }),
        ),
      ];
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren(routes)]),
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

function dialogByTitle(title: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]'),
  ].find((item) => item.querySelector('h2')?.textContent === title);
  if (!found) throw new Error(`Missing dialog: ${title}`);
  return found;
}

function hasDialog(title: string): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]')].some(
    (item) => item.querySelector('h2')?.textContent === title,
  );
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

function unloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
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
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  client.setQueryData(['me'], allAccessMe);
  client.setQueryData(['agents'], { items: [], truncated: false });
  client.setQueryData(['agent-options'], {
    servers: [],
    skills: [],
    plugins: [],
    runtimeEnvironments: [],
  });
  client.setQueryData(['connector-catalog'], []);
  client.setQueryData(['skills', 'all'], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['servers'], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['knowledge', 'bases'], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [null],
  });
  client.setQueryData(['runtime-environments'], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['plugins', { enabled: true }], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  vi.spyOn(api, 'skills').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'marketSkills').mockResolvedValue([]);
  vi.spyOn(api, 'servers').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'tools').mockResolvedValue([]);
  vi.spyOn(api, 'agentReference').mockResolvedValue({ items: [], truncated: false });
  vi.spyOn(api, 'agentFiles').mockResolvedValue({
    mcpJson: '{}',
    claudeMd: '',
    agentMd: '',
    settingsJson: '{}',
    skills: [],
    subAgents: [],
    rules: [],
    outputStyles: [],
    selectedOutputStyle: null,
    plugins: [],
  });
  vi.spyOn(api, 'connectorCatalog').mockResolvedValue([]);
  vi.spyOn(api, 'runtimeEnvironments').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'knowledgeBases').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'plugins').mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  history?.destroy();
  client.clear();
  host?.remove();
  root = undefined;
  host = undefined;
  history = undefined;
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('skills toolbar', () => {
  it('hides market ranking controls only while a market search is active', async () => {
    await mountRouter('/skills?scope=market&marketView=trending');
    await waitFor(() => document.querySelector('[aria-label="榜单"]'));
    expect(document.querySelector('[aria-label="榜单"]')).not.toBeNull();

    const search = await waitFor(() =>
      document.querySelector<HTMLInputElement>('input[aria-label="搜索技能"]'),
    );
    if (!search) throw new Error('Missing search input');
    await typeInput(search, 'react');

    await waitFor(() => document.querySelector('[aria-label="榜单"]') === null);
    expect(document.querySelector('[aria-label="榜单"]')).toBeNull();
  });
});

describe('resource navigation', () => {
  it.each(['skills', 'servers', 'plugins', 'knowledge'] as const)(
    'renders %s as real navigation links instead of tabs',
    async (section) => {
      await mountRouter(`/${section}`, (shell) =>
        (['skills', 'servers', 'plugins', 'knowledge', 'data-domains'] as const).map((path) =>
          createRoute({
            getParentRoute: () => shell,
            path: `/${path}`,
            component: () =>
              createElement(
                ResourcePage,
                {
                  section,
                  query: '',
                  onQueryChange() {},
                  sort: 'newest',
                  onSortChange() {},
                  count: 0,
                  status: 'success',
                },
                null,
              ),
          }),
        ),
      );

      const nav = await waitFor(() => document.querySelector('nav[aria-label="资源类型"]'));
      if (!nav) throw new Error('Missing resource navigation');
      const links = [...nav.querySelectorAll<HTMLAnchorElement>('a')];
      expect(
        links.map((node) => [node.getAttribute('href'), node.getAttribute('aria-current')]),
      ).toEqual([
        ['/skills', section === 'skills' ? 'page' : null],
        ['/servers', section === 'servers' ? 'page' : null],
        ['/plugins', section === 'plugins' ? 'page' : null],
        ['/knowledge', section === 'knowledge' ? 'page' : null],
        ['/data-domains', null],
      ]);
    },
  );
});

describe('resource toolbar reading order', () => {
  it('keeps navigation, actions, search, filters, sort and count in reading order', async () => {
    const onQueryChange = vi.fn();
    const onAction = vi.fn();
    await mountRouter('/skills', (shell) => [
      createRoute({
        getParentRoute: () => shell,
        path: '/skills',
        component: () =>
          createElement(
            ResourcePage,
            {
              section: 'skills',
              query: '',
              onQueryChange,
              sort: 'newest',
              onSortChange() {},
              count: 2,
              status: 'success',
              leadingFilters: createElement('button', { type: 'button' }, '来源'),
              filters: createElement('button', { type: 'button' }, '使用情况'),
              actions: createElement('button', { type: 'button', onClick: onAction }, '新建'),
            },
            null,
          ),
      }),
      ...['/servers', '/plugins', '/knowledge', '/data-domains'].map((path) =>
        createRoute({
          getParentRoute: () => shell,
          path,
          component: () => createElement('h1', null, path),
        }),
      ),
    ]);

    const container = host!;
    const nav = container.querySelector('nav[aria-label="资源类型"]');
    const search = container.querySelector('input[aria-label="搜索技能"]');
    const buttons = [...container.querySelectorAll('button')];
    const source = buttons.find((item) => item.textContent === '来源');
    const usage = buttons.find((item) => item.textContent === '使用情况');
    const sort = container.querySelector('button[aria-label="资源排序"]');
    const action = buttons.find((item) => item.textContent === '新建');
    const count = container.querySelector('[role="status"]');
    const requiredNode = <T extends Element>(node: T | null | undefined, name: string): T => {
      if (!node) throw new Error(`Missing ${name} control`);
      return node;
    };
    const navNode = requiredNode(nav, 'nav');
    const searchNode = requiredNode(search, 'search');
    const sourceNode = requiredNode(source, 'source');
    const usageNode = requiredNode(usage, 'usage');
    const sortNode = requiredNode(sort, 'sort');
    const actionNode = requiredNode(action, 'action');
    const countNode = requiredNode(count, 'count');
    const order = (first: Element, second: Element): boolean =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(order(navNode, actionNode)).toBe(true);
    expect(order(actionNode, sourceNode)).toBe(true);
    expect(order(sourceNode, searchNode)).toBe(true);
    expect(order(searchNode, usageNode)).toBe(true);
    expect(order(usageNode, sortNode)).toBe(true);
    expect(order(sortNode, countNode)).toBe(true);
    expect(container.querySelectorAll('h1')).toHaveLength(1);

    await typeInput(searchNode as HTMLInputElement, 'react');
    expect(onQueryChange).toHaveBeenCalledWith('react');

    await click(actionNode as HTMLButtonElement);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('renders the market toolbar without a sort control', async () => {
    await mountRouter('/skills', (shell) => [
      createRoute({
        getParentRoute: () => shell,
        path: '/skills',
        component: () =>
          createElement(
            ResourcePage,
            {
              section: 'skills',
              query: '',
              onQueryChange() {},
              count: 0,
              status: 'success',
            },
            null,
          ),
      }),
      ...['/servers', '/plugins', '/knowledge', '/data-domains'].map((path) =>
        createRoute({
          getParentRoute: () => shell,
          path,
          component: () => createElement('h1', null, path),
        }),
      ),
    ]);

    expect(host?.querySelector('button[aria-label="资源排序"]')).toBeNull();
    expect(host?.querySelector('input[aria-label="搜索技能"]')).not.toBeNull();
  });
});

describe('resource draft navigation', () => {
  it.each(['skill', 'server', 'tool'] as const)(
    'guards dirty and pending %s forms on navigation and unload',
    async (kind) => {
      if (kind === 'tool') {
        client.setQueryData(['servers'], {
          pages: [{ items: [generatedServer], nextCursor: null }],
          pageParams: [undefined],
        });
        vi.spyOn(api, 'servers').mockResolvedValue({ items: [generatedServer], nextCursor: null });
      }
      const router = await mountRouter(kind === 'skill' ? '/skills' : '/servers');

      if (kind === 'skill') {
        await click(await waitFor(() => button('新建技能')));
        const nameInput = await waitFor(() =>
          document.querySelector<HTMLInputElement>('#skill-name'),
        );
        if (!nameInput) throw new Error('Missing skill name input');
        await typeInput(nameInput, 'unsaved');
      } else if (kind === 'server') {
        await click(await waitFor(() => button('新建连接器')));
        const kindGroup = await waitFor(() =>
          document.querySelector<HTMLElement>('[aria-label="来源类型"]'),
        );
        const httpOption = [
          ...(kindGroup?.querySelectorAll<HTMLButtonElement>('button') ?? []),
        ].find((item) => item.textContent?.includes('远程 MCP'));
        if (!httpOption) throw new Error('Missing HTTP kind option');
        await click(httpOption);
        const nameInput = await waitFor(() =>
          document.querySelector<HTMLInputElement>('#server-name'),
        );
        if (!nameInput) throw new Error('Missing server name input');
        await typeInput(nameInput, 'unsaved');
      } else {
        await click(await waitFor(() => button('操作 connector')));
        const toolsItem = await waitFor(() =>
          [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
            item.textContent?.includes('工具定义'),
          ),
        );
        await click(toolsItem);
        const nameInput = await waitFor(() =>
          document.querySelector<HTMLInputElement>('#tool-name-server'),
        );
        if (!nameInput) throw new Error('Missing tool name input');
        await typeInput(nameInput, 'unsaved');
      }

      expect(unloadPrevented()).toBe(true);
      await act(async () => {
        void router.navigate({ to: '/away' });
      });
      await waitFor(() => hasDialog('放弃未保存的更改？'));
      const dirtyConfirm = dialogByTitle('放弃未保存的更改？');
      expect(button('放弃并离开', dirtyConfirm).disabled).toBe(false);
      await click(button('取消', dirtyConfirm));
      await waitFor(() => !hasDialog('放弃未保存的更改？'));

      if (kind === 'skill') {
        const saving = deferred<Skill>();
        vi.spyOn(api, 'createSkill').mockReturnValue(saving.promise);
        await typeInput(document.querySelector<HTMLInputElement>('#skill-slug')!, 'unsaved-skill');
        await typeInput(document.querySelector<HTMLInputElement>('#skill-desc')!, 'demo');
        await click(button('保存'));
        await waitFor(() => vi.mocked(api.createSkill).mock.calls.length === 1);
        expect(unloadPrevented()).toBe(true);
        await act(async () => {
          void router.navigate({ to: '/away' });
        });
        await waitFor(() => hasDialog('放弃未保存的更改？'));
        const pendingConfirm = dialogByTitle('放弃未保存的更改？');
        expect(pendingConfirm.textContent).toContain('正在保存，请等待请求完成。');
        expect(button('放弃并离开', pendingConfirm).disabled).toBe(true);
        await click(button('取消', pendingConfirm));
        await act(async () => {
          saving.resolve({
            id: 'skill-1',
            slug: 'unsaved-skill',
            name: 'unsaved',
            description: 'demo',
            body: '',
            sourceId: null,
            createdAt: 'v1',
            updatedAt: 'v1',
            status: 'draft',
            submittedAt: null,
            reviewedAt: null,
            reviewedBy: null,
            reviewNote: null,
          });
        });
        await flush();
      } else if (kind === 'server') {
        const saving = deferred<Server>();
        vi.spyOn(api, 'createServer').mockReturnValue(saving.promise);
        await typeInput(
          document.querySelector<HTMLInputElement>('#server-url')!,
          'https://example.com/mcp',
        );
        await click(button('创建'));
        await waitFor(() => vi.mocked(api.createServer).mock.calls.length === 1);
        expect(unloadPrevented()).toBe(true);
        await act(async () => {
          void router.navigate({ to: '/away' });
        });
        await waitFor(() => hasDialog('放弃未保存的更改？'));
        const pendingConfirm = dialogByTitle('放弃未保存的更改？');
        expect(pendingConfirm.textContent).toContain('正在保存，请等待请求完成。');
        expect(button('放弃并离开', pendingConfirm).disabled).toBe(true);
        await click(button('取消', pendingConfirm));
        await act(async () => {
          saving.resolve({ ...server, id: 'server-new' });
        });
        await flush();
      } else {
        const saving = deferred<ApiTool>();
        vi.spyOn(api, 'createTool').mockReturnValue(saving.promise);
        await click(button('添加'));
        await waitFor(() => vi.mocked(api.createTool).mock.calls.length === 1);
        expect(unloadPrevented()).toBe(true);
        await act(async () => {
          void router.navigate({ to: '/away' });
        });
        await waitFor(() => hasDialog('放弃未保存的更改？'));
        const pendingConfirm = dialogByTitle('放弃未保存的更改？');
        expect(pendingConfirm.textContent).toContain('正在保存，请等待请求完成。');
        expect(button('放弃并离开', pendingConfirm).disabled).toBe(true);
        await click(button('取消', pendingConfirm));
        await act(async () => {
          saving.resolve({
            id: 'tool-new',
            serverId: 'server',
            name: 'unsaved',
            description: '',
            method: 'GET',
            pathTemplate: '/',
            inputSchema: { type: 'object', properties: {} },
            paramsIn: 'query',
            approvalMode: 'allow',
            enabled: true,
            createdAt: 'v1',
            updatedAt: 'v1',
          });
        });
        await flush();
      }

      expect(unloadPrevented()).toBe(false);
    },
  );
});

describe('conflict recovery', () => {
  it('retains agent draft and requires confirmation before fetching a replacement', async () => {
    const reload = vi.spyOn(api, 'agent').mockResolvedValue(agent);
    const update = vi.spyOn(api, 'updateAgent').mockRejectedValueOnce(new ApiError(409, 'Changed'));
    await mountRouter('/agents/expert?tab=config');

    const name = await waitFor(() => document.querySelector<HTMLInputElement>('#agent-name'));
    if (!name) throw new Error('Missing agent name input');
    await typeInput(name, 'my-draft');
    await click(button('保存草稿'));

    await waitFor(() => update.mock.calls.length === 1);
    expect(update.mock.calls[0]?.[2]).toBe('v1');
    expect(reload).not.toHaveBeenCalled();

    await click(await waitFor(() => button('加载最新配置')));
    const confirmation = await waitFor(() => dialogByTitle('放弃草稿并加载最新配置？'));
    expect(confirmation.textContent).toContain('丢失');
    expect(reload).not.toHaveBeenCalled();

    await click(button('放弃并加载', confirmation));
    await waitFor(() => reload.mock.calls.length === 1);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('retains server draft and requires confirmation before fetching a replacement', async () => {
    const reload = vi.spyOn(api, 'server').mockResolvedValue(server);
    const update = vi
      .spyOn(api, 'updateServer')
      .mockRejectedValueOnce(new ApiError(409, 'Changed'));
    await mountRouter('/servers', (shell) => [
      createRoute({
        getParentRoute: () => shell,
        path: '/servers',
        component: () =>
          createElement(ServerFormDialog, {
            server,
            onClose() {},
            onSaved() {},
            getReturnFocus: () => null,
          }),
      }),
    ]);

    const name = await waitFor(() => document.querySelector<HTMLInputElement>('#server-name'));
    if (!name) throw new Error('Missing server name input');
    await typeInput(name, 'my-draft');

    const form = name.closest('form');
    if (!form) throw new Error('Missing server form');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(update.mock.calls[0]?.[2]).toBe('v1');
    expect(reload).not.toHaveBeenCalled();

    const reloadButton = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('加载最新配置'),
    );
    if (!reloadButton) throw new Error('Missing reload button');
    await click(reloadButton);

    const confirm = [...document.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('放弃并加载'),
    );
    if (!confirm) throw new Error('Missing confirm button');
    expect(document.body.textContent).toContain('放弃草稿并加载最新配置？');
    expect(document.body.textContent).toContain('当前未保存的更改会丢失');
    await click(confirm);
    await waitFor(() => reload.mock.calls.length === 1);
    expect(reload).toHaveBeenCalledOnce();
  });
});
