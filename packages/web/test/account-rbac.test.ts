import type {
  AuthMe,
  PermissionDefinition,
  Role,
  RoleMatrix,
  RoleMatrixInput,
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
import { AccessDenied } from '../src/components/app-shell.js';
import { toastError, toastSuccess } from '../src/lib/toast.js';
import { AccountsPage } from '../src/pages/accounts.js';
import { AgentDetailPage } from '../src/pages/agents.js';
import { RolesPage } from '../src/pages/roles.js';
import { rolesSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const CATALOG: PermissionDefinition[] = [
  {
    id: 'agents.read',
    label: '查看专家',
    treePath: ['专家', '发现'],
    scopes: ['authorized_agents', 'platform'],
  },
  {
    id: 'agents.use',
    label: '使用专家',
    treePath: ['专家', '发现'],
    scopes: ['authorized_agents', 'platform'],
  },
  {
    id: 'agents.config.read',
    label: '查看配置',
    treePath: ['专家', '配置'],
    scopes: ['maintained_agents', 'owned_agents', 'platform'],
  },
  {
    // 真实共享依赖：保存时要求同时授权 agents.config.read。
    id: 'agents.config.update',
    label: '修改配置',
    treePath: ['专家', '配置'],
    scopes: ['maintained_agents', 'owned_agents', 'platform'],
  },
  {
    id: 'roles.manage',
    label: '管理角色',
    treePath: ['平台', '角色'],
    scopes: ['platform'],
  },
  {
    id: 'accounts.read',
    label: '查看账户',
    treePath: ['平台', '账户'],
    scopes: ['platform'],
  },
  {
    id: 'accounts.manage',
    label: '管理账户',
    treePath: ['平台', '账户'],
    scopes: ['platform'],
  },
] as PermissionDefinition[];

const ALL = CATALOG.map((item) => item.id);

function me(permissionIds: readonly string[] = ALL): AuthMe {
  return {
    authenticated: true,
    user: { businessId: 'admin', username: 'admin', name: '管理员' },
    roles: [],
    grants: permissionIds.map((permissionId) => ({
      permissionId: permissionId as never,
      scope: (CATALOG.find((item) => item.id === permissionId)?.scopes[0] ?? 'platform') as never,
    })),
  };
}

const summary = {
  id: 'agt_1',
  name: '专家一',
  description: '',
  enabled: true,
  createdBy: 'admin',
  ownerBusinessId: 'admin',
};
const fullAgent = {
  ...summary,
  slug: 'expert-one',
  role: '通用助手',
  model: 'claude-sonnet-5-5',
  systemPrompt: '',
  serverIds: [],
  skillIds: [],
  pluginBindings: [],
  subAgentIds: [],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'default',
  uiFormat: 'markdown',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  parentId: null,
  runtimeEnvironmentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

type Call = { method: string; path: string; body?: unknown };
type Handler = (call: Call) => Response | Promise<Response>;
const calls: Call[] = [];
let handlers: Array<{ method: string; match: RegExp; handler: Handler }> = [];

function route(method: string, match: RegExp, handler: Handler): void {
  handlers.push({ method, match, handler });
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
function problem(status: number, message: string, code = 'ERROR'): Response {
  return Response.json({ code, message }, { status });
}
function bodyOf(path: string, method = 'PUT'): unknown {
  return calls.find((call) => call.method === method && call.path === path)?.body;
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createBrowserHistory>;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function waitFor<T>(probe: () => T, tries = 50): Promise<T> {
  for (let index = 0; index < tries; index += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 页面切换过程中继续等。
    }
    await flush();
  }
  return probe();
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
function maybeButton(text: string, scope: ParentNode = document): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
    ) ?? null
  );
}
function checkbox(label: string, scope: ParentNode = document): HTMLElement {
  const element = scope.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${label}"]`);
  if (!element) throw new Error(`Missing checkbox: ${label}`);
  return element;
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flush();
}
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}
function field(id: string, scope: ParentNode = document): HTMLInputElement {
  const element = scope.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`Missing field: ${id}`);
  return element;
}
function menuItem(text: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing menu item: ${text}`);
  return element;
}
async function openMenu(label: string): Promise<void> {
  const trigger = button(label);
  // Base UI 用 mousedown 打开菜单，jsdom 的 click() 不会触发。
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await flush();
}
function maybeDialog(titlePrefix: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((item) =>
      item.querySelector('h2')?.textContent?.startsWith(titlePrefix),
    ) ?? null
  );
}
function dialog(titlePrefix: string): HTMLElement {
  const element = maybeDialog(titlePrefix);
  if (!element) throw new Error(`Missing dialog: ${titlePrefix}`);
  return element;
}

async function mount(
  path: string,
  component: () => React.ReactNode,
  searchSchema?: unknown,
): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const page = createRoute({
    getParentRoute: () => shell,
    path: path.replace(/\$[^/]+/g, (_match) => '$agentId') as never,
    ...(searchSchema === undefined ? {} : { validateSearch: searchSchema as never }),
    component,
  });
  const away = createRoute({
    getParentRoute: () => shell,
    path: '/away',
    component: () => createElement('h1', null, 'Away'),
  });
  window.history.replaceState(null, '', path.replace('$agentId', 'agt_1'));
  history = createBrowserHistory();
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page, away])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

function prepare(): void {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  handlers = [];
  calls.length = 0;
  route('GET', /^\/api\/auth\/me$/, () => json(me()));
  route('GET', /^\/api\/permissions$/, () =>
    json({ permissions: CATALOG, scopes: [{ id: 'platform', label: '全平台' }] }),
  );
  route('GET', /^\/api\/servers$/, () => json([]));
  route('GET', /^\/api\/skills$/, () => json([]));
  route('GET', /^\/api\/plugins$/, () => json([]));
  route('GET', /^\/api\/runtime-environments$/, () => json([]));
  route('GET', /^\/api\/knowledge\/bases/, () => json({ items: [], nextCursor: null }));
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      };
      calls.push(call);
      const match = handlers.find(
        (item) => item.method === call.method && item.match.test(call.path),
      );
      if (!match) return problem(404, `未模拟 ${call.method} ${call.path}`, 'NOT_FOUND');
      return match.handler(call);
    }),
  );
}

beforeEach(prepare);
afterEach(async () => {
  await act(async () => root.unmount());
  history?.destroy();
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('专家详情只认完整配置', () => {
  it('从摘要进入详情会请求完整配置并渲染配置表单', async () => {
    route('GET', /^\/api\/agents$/, () => json([summary]));
    route('GET', /^\/api\/agents\/agt_1$/, () => json(fullAgent));
    route('GET', /^\/api\/agents\/agt_1\/access$/, () =>
      json({ agentId: 'agt_1', permissionIds: ALL }),
    );

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => document.querySelector('#agent-name'));

    expect(document.querySelector<HTMLInputElement>('#agent-name')?.value).toBe('专家一');
    expect(calls.some((call) => call.method === 'GET' && call.path === '/api/agents/agt_1')).toBe(
      true,
    );
  });

  it('没有配置读取权限时只提供对话，不请求也不渲染配置', async () => {
    route('GET', /^\/api\/agents$/, () => json([summary]));
    route('GET', /^\/api\/agents\/agt_1\/access$/, () =>
      json({ agentId: 'agt_1', permissionIds: ['agents.read', 'agents.use'] }),
    );

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(
      () => maybeButton('开始对话') ?? document.querySelector('a[href*="agent=agt_1"]'),
    );

    expect(document.querySelector('#agent-name')).toBeNull();
    expect(maybeButton('保存更改')).toBeNull();
    expect(calls.some((call) => call.path === '/api/agents/agt_1')).toBe(false);
  });

  it('成员授权与转交负责人成功后提示并携带正确请求体', async () => {
    route('GET', /^\/api\/agents$/, () => json([summary]));
    route('GET', /^\/api\/agents\/agt_1\/access$/, () =>
      json({
        agentId: 'agt_1',
        permissionIds: ['agents.read', 'agents.use', 'agents.members.manage', 'agents.transfer'],
      }),
    );
    route('GET', /^\/api\/agents\/agt_1\/members$/, () =>
      json({ ownerBusinessId: 'admin', members: [] }),
    );
    route('GET', /^\/api\/identities/, () =>
      json({ items: [{ businessId: 'bob', name: '鲍勃', accountActive: true }], total: 1 }),
    );
    route('PUT', /^\/api\/agents\/agt_1\/members\/bob$/, () =>
      json({
        businessId: 'bob',
        name: '鲍勃',
        accountActive: true,
        canUse: true,
        canMaintain: false,
      }),
    );
    route('POST', /^\/api\/agents\/agt_1\/transfer$/, () => json(fullAgent));

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => maybeButton('专家管理操作'));

    await click(button('专家管理操作'));
    await click(menuItem('管理成员'));
    await waitFor(() => maybeButton('添加'));
    await click(button('添加'));
    expect(bodyOf('/api/agents/agt_1/members/bob', 'PUT')).toEqual({
      canUse: true,
      canMaintain: false,
    });
    expect(toastSuccess).toHaveBeenCalledWith('已添加 鲍勃');

    await click(button('关闭'));
    await click(button('专家管理操作'));
    await click(menuItem('转交负责人'));
    await waitFor(() => document.querySelector('[role="checkbox"]'));
    const transferTarget = document.querySelector<HTMLElement>('[role="checkbox"]');
    if (!transferTarget) throw new Error('Missing transfer checkbox');
    await click(transferTarget);
    await click(button('转交'));
    expect(bodyOf('/api/agents/agt_1/transfer', 'POST')).toEqual({ ownerBusinessId: 'bob' });
    expect(toastSuccess).toHaveBeenCalledWith('负责人已转交');
  });

  it('成员授权被拒绝时保留提示并显示服务端原因', async () => {
    route('GET', /^\/api\/agents$/, () => json([summary]));
    route('GET', /^\/api\/agents\/agt_1\/access$/, () =>
      json({
        agentId: 'agt_1',
        permissionIds: ['agents.read', 'agents.use', 'agents.members.manage'],
      }),
    );
    route('GET', /^\/api\/agents\/agt_1\/members$/, () =>
      json({ ownerBusinessId: 'admin', members: [] }),
    );
    route('GET', /^\/api\/identities/, () =>
      json({ items: [{ businessId: 'bob', name: '鲍勃', accountActive: true }], total: 1 }),
    );
    route('PUT', /^\/api\/agents\/agt_1\/members\/bob$/, () =>
      problem(403, '只有负责人可以管理成员', 'FORBIDDEN'),
    );

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => maybeButton('专家管理操作'));
    await click(button('专家管理操作'));
    await click(menuItem('管理成员'));
    await waitFor(() => maybeButton('添加'));
    await click(button('添加'));

    expect(toastError).toHaveBeenCalled();
    expect(dialog('管理「专家一」的成员')).toBeTruthy();
  });
});

describe('专家配置权限拆分', () => {
  function editorAccess(permissionIds: string[]): void {
    route('GET', /^\/api\/agents$/, () => json([summary]));
    route('GET', /^\/api\/agents\/agt_1\/access$/, () => json({ agentId: 'agt_1', permissionIds }));
    route('GET', /^\/api\/agents\/agt_1$/, () => json(fullAgent));
  }

  it('绑定维护人只读 options 摘要，不发需要全局读取的资源请求', async () => {
    editorAccess(['agents.read', 'agents.config.read', 'agents.bindings.manage']);
    route('GET', /^\/api\/agents\/options$/, () =>
      json({
        servers: [
          { id: 'srv_1', name: '连接器', kind: 'http' },
          { id: 'kb_server', name: '知识库', kind: 'knowledge' },
        ],
        skills: [{ id: 'skl_1', slug: 'skill', name: '技能', description: '说明' }],
        plugins: [{ id: 'plg_1', slug: 'plugin', name: '插件' }],
        runtimeEnvironments: [{ id: 'env_1', name: '环境', hasOnlineVersion: true }],
      }),
    );

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => document.querySelector('#agent-name'));
    await waitFor(() => calls.some((call) => call.path === '/api/agents/options'));

    expect(calls.some((call) => call.path === '/api/agents/options')).toBe(true);
    for (const path of [
      '/api/servers',
      '/api/skills',
      '/api/plugins',
      '/api/runtime-environments',
      '/api/knowledge/bases',
    ]) {
      expect(calls.some((call) => call.path.startsWith(path))).toBe(false);
    }
  });

  it('只有配置读取权时字段只读，不产生无法保存的草稿', async () => {
    editorAccess(['agents.read', 'agents.config.read']);

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => document.querySelector('#agent-name'));

    expect(field('agent-name').disabled).toBe(true);
    await click(button('行为'));
    expect(document.querySelector<HTMLTextAreaElement>('#agent-prompt')?.disabled).toBe(true);
    await click(button('权限'));
    const bash = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="toggle"]')].find(
      (item) => item.textContent?.startsWith('Bash'),
    );
    expect(bash?.disabled).toBe(true);
    if (bash) await click(bash);
    expect(maybeButton('保存更改')).toBeNull();
  });

  it('只有启停权时开关可保存，提交体只含 enabled', async () => {
    editorAccess(['agents.read', 'agents.config.read', 'agents.enable']);
    route('PATCH', /^\/api\/agents\/agt_1$/, () => json({ ...fullAgent, enabled: false }));

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => document.querySelector('#agent-name'));
    expect(field('agent-name').disabled).toBe(true);

    const toggle = document.querySelector<HTMLElement>('[role="switch"]');
    if (!toggle) throw new Error('Missing enable switch');
    await click(toggle);
    await waitFor(() => maybeButton('保存更改'));
    await click(button('保存更改'));
    const body = await waitFor(() => bodyOf('/api/agents/agt_1', 'PATCH') as object);
    expect(body).toEqual({
      enabled: false,
      expectedUpdatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('配置保存不夹带启停或资源绑定字段', async () => {
    editorAccess(['agents.read', 'agents.config.read', 'agents.config.update']);
    route('PATCH', /^\/api\/agents\/agt_1$/, () => json(fullAgent));

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => document.querySelector('#agent-name'));
    await type(field('agent-name'), '新名字');
    await click(button('保存更改'));

    const body = (await waitFor(() => bodyOf('/api/agents/agt_1', 'PATCH'))) as Record<
      string,
      unknown
    >;
    // 未变化的配置、绑定与启停字段不随改名提交。
    expect(body).toEqual({ name: '新名字', expectedUpdatedAt: '2026-01-01T00:00:00Z' });
  });

  it('有全部专家权限时改名也只提交 name', async () => {
    editorAccess([
      'agents.read',
      'agents.config.read',
      'agents.config.update',
      'agents.bindings.manage',
      'agents.enable',
    ]);
    route('GET', /^\/api\/agents\/options$/, () =>
      json({ servers: [], skills: [], plugins: [], runtimeEnvironments: [] }),
    );
    route('PATCH', /^\/api\/agents\/agt_1$/, () => json(fullAgent));

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => document.querySelector('#agent-name'));
    await type(field('agent-name'), '新名字');
    await click(button('保存更改'));

    expect(bodyOf('/api/agents/agt_1', 'PATCH')).toEqual({
      name: '新名字',
      expectedUpdatedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('没有配置读取权但有启停权时，详情页提供独立启停入口', async () => {
    route('GET', /^\/api\/agents$/, () => json([summary]));
    route('GET', /^\/api\/agents\/agt_1\/access$/, () =>
      json({ agentId: 'agt_1', permissionIds: ['agents.read', 'agents.enable'] }),
    );
    route('PATCH', /^\/api\/agents\/agt_1$/, () => json({ ...summary, enabled: false }));

    await mount('/agents/$agentId', AgentDetailPage);
    await waitFor(() => maybeButton('停用专家'));
    await click(button('停用专家'));

    expect(bodyOf('/api/agents/agt_1', 'PATCH')).toEqual({ enabled: false });
    expect(calls.some((call) => call.method === 'GET' && call.path === '/api/agents/agt_1')).toBe(
      false,
    );
    expect(toastSuccess).toHaveBeenCalledWith('专家已停用');
  });
});

describe('角色权限矩阵', () => {
  const matrix: RoleMatrix = {
    revision: 3,
    roles: [
      {
        id: 'role_admin',
        name: '管理员',
        systemKey: 'admin',
        grants: [{ permissionId: 'agents.read', scope: 'platform' }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'role_member',
        name: '成员',
        systemKey: null,
        grants: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  };
  let current: RoleMatrix = matrix;

  beforeEach(() => {
    current = structuredClone(matrix);
    route('GET', /^\/api\/roles$/, () => json(current));
  });

  // 服务端回包带真实 id/systemKey；保存载荷本身不含 systemKey，不能直接回显 request body。
  function persistSave(call: Call): Response {
    const payload = call.body as RoleMatrixInput;
    const roles: Role[] = payload.roles.map((role, index) => {
      const existing = current.roles.find((item) => item.id === role.id);
      return {
        id: role.id ?? `role_new_${index + 1}`,
        name: role.name,
        systemKey: existing?.systemKey ?? null,
        grants: role.grants,
        createdAt: existing?.createdAt ?? '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
    });
    current = { revision: current.revision + 1, roles };
    return json(current);
  }

  function matrixTable(): HTMLTableElement {
    const element = document.querySelector<HTMLTableElement>('table[aria-label="角色权限矩阵"]');
    if (!element) throw new Error('Missing role permission matrix');
    return element;
  }
  function cell(role: string, label: string): HTMLElement {
    return checkbox(`${role}：${label}`);
  }
  function maybeCell(role: string, label: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${role}：${label}"]`);
  }
  function scopeToggle(role: string, leaf: string, scopeLabel: string): HTMLElement {
    const group = document.querySelector<HTMLElement>(`[aria-label="${role}：${leaf} 授权范围"]`);
    if (!group) throw new Error(`Missing scope group: ${role}：${leaf}`);
    const item = group.querySelector<HTMLElement>(`[aria-label="${scopeLabel}范围"]`);
    if (!item) throw new Error(`Missing scope: ${role} ${leaf} ${scopeLabel}`);
    return item;
  }
  function roleNameInput(scope: ParentNode = document): HTMLInputElement {
    const inputs = scope.querySelectorAll<HTMLInputElement>('input[aria-label="角色名称"]');
    if (inputs.length !== 1) throw new Error(`Expected one role name input, got ${inputs.length}`);
    return inputs[0] as HTMLInputElement;
  }
  async function openSettings(role: string): Promise<HTMLElement> {
    await click(button(`设置角色 ${role}`));
    return (await waitFor(() => maybeDialog(`角色设置：${role}`))) as HTMLElement;
  }
  function searchInput(): HTMLInputElement {
    const element = document.querySelector<HTMLInputElement>('input[aria-label="搜索权限"]');
    if (!element) throw new Error('Missing role search');
    return element;
  }
  function isDisabled(element: HTMLElement): boolean {
    return (
      element.hasAttribute('disabled') ||
      (element as HTMLButtonElement).disabled === true ||
      element.getAttribute('aria-disabled') === 'true'
    );
  }
  async function openRoles(): Promise<void> {
    await mount('/roles', RolesPage, rolesSearchSchema);
    await waitFor(() => matrixTable());
  }

  it('顶部按角色分列、行头为功能，数据单元格只含勾选框', async () => {
    await openRoles();
    const table = matrixTable();

    const headCells = [...table.querySelectorAll<HTMLTableCellElement>('thead th')];
    expect(headCells.length).toBeGreaterThanOrEqual(2);
    expect(headCells.every((item) => item.getAttribute('scope') === 'col')).toBe(true);
    expect(
      headCells
        .map((item) =>
          item.querySelector('button[aria-label^="设置角色 "]')?.getAttribute('aria-label'),
        )
        .filter((label): label is string => label !== undefined),
    ).toEqual(['设置角色 管理员', '设置角色 成员']);

    const rows = [...table.querySelectorAll<HTMLTableRowElement>('tbody tr')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [head, ...cells] = [...row.children];
      expect(head?.tagName).toBe('TH');
      expect(head?.getAttribute('scope')).toBe('row');
      expect(cells).toHaveLength(2);
      for (const item of cells) {
        expect(item.tagName).toBe('TD');
        expect(item.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
        expect(
          item.querySelectorAll(
            'button:not([role="checkbox"]), a, select, textarea, [role="combobox"], [role="group"]',
          ),
        ).toHaveLength(0);
        expect(item.textContent?.trim()).toBe('');
      }
    }

    expect(document.querySelectorAll('input[aria-label="角色名称"]')).toHaveLength(0);
    expect(cell('管理员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('false');
  });

  it('父级半选与整棵子树勾选使用同一份矩阵草稿', async () => {
    await openRoles();
    const settings = await openSettings('成员');
    expect(roleNameInput(settings).value).toBe('成员');
    await click(button('完成', settings));

    await click(cell('成员', '专家'));
    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(cell('成员', '使用专家').getAttribute('aria-checked')).toBe('true');
    expect(cell('成员', '查看配置').getAttribute('aria-checked')).toBe('true');

    await click(cell('成员', '使用专家'));
    expect(cell('成员', '专家').getAttribute('aria-checked')).toBe('mixed');
    // 其他角色列的授权不受影响。
    expect(cell('管理员', '查看专家').getAttribute('aria-checked')).toBe('true');
  });

  it('搜索与折叠不会丢掉已勾选的权限', async () => {
    await openRoles();
    await click(cell('成员', '查看专家'));

    await click(button('收起 专家'));
    expect(maybeCell('成员', '查看专家')).toBeNull();

    await type(searchInput(), '使用专家');
    expect(maybeCell('成员', '查看专家')).toBeNull();
    expect(cell('成员', '使用专家').getAttribute('aria-checked')).toBe('false');

    await type(searchInput(), '');
    expect(maybeCell('成员', '查看专家')).toBeNull();
    await click(button('展开 专家'));
    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
  });

  it('角色设置只列已授权叶的范围，完成不提交，范围随页头保存提交', async () => {
    route('PUT', /^\/api\/roles$/, persistSave);
    await openRoles();
    await click(cell('成员', '查看配置'));
    expect(cell('成员', '查看配置').getAttribute('aria-checked')).toBe('true');

    const settings = await openSettings('成员');
    expect(document.querySelectorAll('input[aria-label="角色名称"]')).toHaveLength(1);
    expect(roleNameInput(settings).value).toBe('成员');
    expect(settings.querySelector('[aria-label="成员：查看配置 授权范围"]')).not.toBeNull();
    expect(settings.querySelector('[aria-label="成员：查看专家 授权范围"]')).toBeNull();
    expect(scopeToggle('成员', '查看配置', '全平台').getAttribute('aria-pressed')).toBe('false');

    await click(scopeToggle('成员', '查看配置', '全平台'));
    expect(scopeToggle('成员', '查看配置', '全平台').getAttribute('aria-pressed')).toBe('true');
    await click(button('完成', settings));

    expect(maybeDialog('角色设置：成员')).toBeNull();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(cell('成员', '查看配置').getAttribute('aria-checked')).toBe('true');
    expect(button('保存更改').disabled).toBe(false);

    await click(button('保存更改'));
    const body = bodyOf('/api/roles', 'PUT') as RoleMatrixInput;
    expect(body.roles.find((role) => role.id === 'role_member')?.grants).toEqual([
      { permissionId: 'agents.config.read', scope: 'maintained_agents' },
      { permissionId: 'agents.config.read', scope: 'platform' },
    ]);
  });

  it('同名父节点按层级区分，折叠父级隐藏整个同名子树', async () => {
    const nested: PermissionDefinition[] = [
      {
        id: 'agents.read',
        label: '查看专家',
        treePath: ['专家', '发现'],
        scopes: ['platform'],
      },
      {
        id: 'agents.config.read',
        label: '查看配置',
        treePath: ['专家', '配置'],
        scopes: ['platform'],
      },
      {
        id: 'agents.config.update',
        label: '修改配置',
        treePath: ['专家', '配置', '配置'],
        scopes: ['platform'],
      },
    ] as PermissionDefinition[];
    handlers = handlers.filter(
      (item) => !(item.method === 'GET' && item.match.test('/api/permissions')),
    );
    route('GET', /^\/api\/permissions$/, () =>
      json({ permissions: nested, scopes: [{ id: 'platform', label: '全平台' }] }),
    );
    await openRoles();

    const namedConfig = () =>
      [...matrixTable().querySelectorAll<HTMLTableRowElement>('tbody tr')].filter(
        (row) => row.children[0]?.textContent?.trim() === '配置',
      );
    expect(namedConfig()).toHaveLength(2);

    await click(button('收起 配置', namedConfig()[0] as HTMLElement));
    expect(namedConfig()).toHaveLength(1);
    expect(maybeCell('管理员', '查看配置')).toBeNull();
    expect(maybeCell('管理员', '修改配置')).toBeNull();
  });

  it('保存提交 expectedRevision 与完整草稿', async () => {
    route('PUT', /^\/api\/roles$/, persistSave);
    await openRoles();
    await click(cell('成员', '查看专家'));
    await click(button('保存更改'));

    const body = bodyOf('/api/roles', 'PUT') as RoleMatrixInput;
    expect(body.expectedRevision).toBe(3);
    expect(body.roles.find((role) => role.id === 'role_member')?.grants).toEqual([
      { permissionId: 'agents.read', scope: 'authorized_agents' },
    ]);
    expect(toastSuccess).toHaveBeenCalledWith('角色矩阵已保存');

    // 服务端回包保留 systemKey，保存后管理员角色仍是只读的。
    const settings = await openSettings('管理员');
    expect(maybeButton('删除角色 管理员', settings)).toBeNull();
    await click(button('完成', settings));
    expect(isDisabled(cell('管理员', '查看专家'))).toBe(true);
  });

  it('删除中间角色后其余角色的名称、授权与保存载荷不串列', async () => {
    current.roles = [
      current.roles[0] as Role,
      {
        ...(current.roles[1] as Role),
        grants: [{ permissionId: 'agents.use', scope: 'platform' }],
      },
      {
        id: 'role_auditor',
        name: '审计员',
        systemKey: null,
        grants: [{ permissionId: 'accounts.read', scope: 'platform' }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    route('PUT', /^\/api\/roles$/, persistSave);
    await openRoles();
    expect(cell('审计员', '查看账户').getAttribute('aria-checked')).toBe('true');
    expect(cell('审计员', '使用专家').getAttribute('aria-checked')).toBe('false');

    const settings = await openSettings('成员');
    await click(button('删除角色 成员', settings));
    const confirmation = await waitFor(() => maybeDialog('删除这个角色？'));
    await click(button('删除', confirmation as HTMLElement));
    await waitFor(() => !maybeButton('设置角色 成员'));

    // 删掉前一个角色后，审计员的列与设置仍按自己的字段取值。
    expect(cell('审计员', '查看账户').getAttribute('aria-checked')).toBe('true');
    expect(cell('审计员', '使用专家').getAttribute('aria-checked')).toBe('false');
    expect(cell('管理员', '查看专家').getAttribute('aria-checked')).toBe('true');
    const auditor = await openSettings('审计员');
    expect(roleNameInput(auditor).value).toBe('审计员');
    await click(button('完成', auditor));

    await click(button('保存更改'));
    const body = bodyOf('/api/roles', 'PUT') as RoleMatrixInput;
    expect(body.roles.map((role) => role.name)).toEqual(['管理员', '审计员']);
    expect(body.roles[0]?.grants).toEqual([{ permissionId: 'agents.read', scope: 'platform' }]);
    expect(body.roles[1]?.id).toBe('role_auditor');
    expect(body.roles[1]?.grants).toEqual([{ permissionId: 'accounts.read', scope: 'platform' }]);
  });

  it('删除前一角色后撤销授权，工具栏与格子仍按角色自身基线反馈', async () => {
    current.roles.push({
      ...(current.roles[1] as Role),
      id: 'role_auditor',
      name: '审计员',
      grants: [{ permissionId: 'accounts.read', scope: 'platform' }],
    });
    await openRoles();
    const settings = await openSettings('成员');
    await click(button('删除角色 成员', settings));
    await click(button('删除', dialog('删除这个角色？')));
    await waitFor(() => !maybeButton('设置角色 成员'));

    await click(cell('审计员', '查看账户'));

    expect(cell('审计员', '查看账户').getAttribute('aria-checked')).toBe('false');
    expect(cell('审计员', '查看账户').closest('td')?.getAttribute('data-changed')).toBe('true');
    expect(document.querySelector('[aria-label="未保存权限变更"]')?.textContent).toBe(
      '1 项权限未保存',
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe('审计员：查看账户 撤销');
  });

  it('保存成功重置基线后，范围弹层与未保存标记按新基线计算', async () => {
    route('PUT', /^\/api\/roles$/, persistSave);
    await openRoles();
    await click(cell('成员', '查看配置'));
    const changed = () => cell('成员', '查看配置').closest('td')?.getAttribute('data-changed');
    expect(changed()).toBe('true');

    await click(button('保存更改'));
    await waitFor(() => button('保存更改').disabled);
    expect(changed()).toBe('false');
    expect(cell('成员', '查看配置').getAttribute('aria-checked')).toBe('true');

    // reset 后的基线仍能打开已授权叶的范围，并重新把范围改动标成未保存。
    const settings = await openSettings('成员');
    expect(settings.querySelector('[aria-label="成员：查看配置 授权范围"]')).not.toBeNull();
    await click(scopeToggle('成员', '查看配置', '全平台'));
    await click(button('完成', settings));
    expect(changed()).toBe('true');
    expect(button('保存更改').disabled).toBe(false);

    await click(button('保存更改'));
    const saved = calls.filter((call) => call.method === 'PUT' && call.path === '/api/roles').at(-1)
      ?.body as RoleMatrixInput;
    expect(saved.roles.find((role) => role.id === 'role_member')?.grants).toEqual([
      { permissionId: 'agents.config.read', scope: 'maintained_agents' },
      { permissionId: 'agents.config.read', scope: 'platform' },
    ]);
  });

  it('缺少读取依赖时保存前拒绝 PUT 并显示可修正的错误', async () => {
    route('PUT', /^\/api\/roles$/, persistSave);
    await openRoles();
    await click(cell('成员', '修改配置'));
    expect(cell('成员', '查看配置').getAttribute('aria-checked')).toBe('false');

    await click(button('保存更改'));

    expect(document.body.textContent).toContain(
      'agents.config.update 需要同时授权 agents.config.read',
    );
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    // 补齐依赖后同一份草稿可以保存。
    await click(cell('成员', '查看配置'));
    await click(button('保存更改'));
    const body = bodyOf('/api/roles', 'PUT') as RoleMatrixInput;
    expect(body.roles.find((role) => role.id === 'role_member')?.grants).toEqual([
      { permissionId: 'agents.config.read', scope: 'maintained_agents' },
      { permissionId: 'agents.config.update', scope: 'maintained_agents' },
    ]);
  });

  it('409 冲突保留草稿并给出重新加载入口', async () => {
    route('PUT', /^\/api\/roles$/, () => problem(409, '矩阵已被其他操作修改', 'CONFLICT'));
    await openRoles();
    await click(cell('成员', '查看专家'));
    await click(button('保存更改'));

    expect(document.body.textContent).toContain('矩阵已被其他操作修改');
    expect(maybeButton('重新加载')).toBeTruthy();
    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
  });

  it('搜索时父级批量禁用，授权叶范围仍可编辑，清空后恢复整棵子树', async () => {
    // 使用专家在搜索“查看专家”时被隐藏，用非默认 scope 验证批量不会改写隐藏叶。
    const member = current.roles[1];
    if (!member) throw new Error('Missing member role');
    member.grants = [{ permissionId: 'agents.use', scope: 'platform' }];
    await openRoles();
    await type(searchInput(), '查看专家');

    expect(isDisabled(cell('成员', '专家'))).toBe(true);
    expect(isDisabled(cell('成员', '发现'))).toBe(true);
    expect(maybeCell('成员', '使用专家')).toBeNull();
    expect(maybeCell('成员', '查看配置')).toBeNull();

    // 点击禁用的父级不会改动任何叶，包括当前被隐藏的叶。
    await click(cell('成员', '专家'));
    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('false');

    // 可见叶在搜索期间仍可勾选，已授权叶的范围可在设置里编辑。
    await click(cell('成员', '查看专家'));
    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    const settings = await openSettings('成员');
    const platformScope = scopeToggle('成员', '查看专家', '全平台');
    expect(isDisabled(platformScope)).toBe(false);
    await click(platformScope);
    expect(platformScope.getAttribute('aria-pressed')).toBe('true');
    await click(button('完成', settings));

    await type(searchInput(), '');

    // 隐藏叶的授权与 scope 保持不动，父级三态按整棵子树重算。
    expect(cell('成员', '使用专家').getAttribute('aria-checked')).toBe('true');
    const hidden = await openSettings('成员');
    expect(scopeToggle('成员', '使用专家', '全平台').getAttribute('aria-pressed')).toBe('true');
    await click(button('完成', hidden));
    expect(cell('成员', '查看配置').getAttribute('aria-checked')).toBe('false');
    expect(cell('成员', '专家').getAttribute('aria-checked')).toBe('mixed');

    // 重新启用的父级恢复整棵子树批量勾选，已有 scope 不被默认值覆盖。
    expect(isDisabled(cell('成员', '专家'))).toBe(false);
    await click(cell('成员', '专家'));
    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(cell('成员', '使用专家').getAttribute('aria-checked')).toBe('true');
    expect(cell('成员', '查看配置').getAttribute('aria-checked')).toBe('true');
    const verified = await openSettings('成员');
    expect(scopeToggle('成员', '使用专家', '全平台').getAttribute('aria-pressed')).toBe('true');
    await click(button('完成', verified));
  });

  it('父级全选保留已有授权的范围，不回落到默认 scope', async () => {
    const member = current.roles[1];
    if (!member) throw new Error('Missing member role');
    member.grants = [{ permissionId: 'agents.use', scope: 'platform' }];
    route('PUT', /^\/api\/roles$/, persistSave);
    await openRoles();

    await click(cell('成员', '专家'));
    await click(button('保存更改'));

    const body = bodyOf('/api/roles', 'PUT') as RoleMatrixInput;
    expect(body.roles.find((role) => role.id === 'role_member')?.grants).toContainEqual({
      permissionId: 'agents.use',
      scope: 'platform',
    });
  });

  it('点击重新加载并确认后，用服务端最新矩阵替换草稿', async () => {
    route('PUT', /^\/api\/roles$/, () => problem(409, '矩阵已被其他操作修改', 'CONFLICT'));
    await openRoles();
    await click(cell('成员', '查看专家'));
    await click(button('保存更改'));
    expect(document.body.textContent).toContain('矩阵已被其他操作修改');

    current = { ...structuredClone(matrix), revision: 4 };
    await click(button('重新加载'));
    const confirmation = dialog('放弃当前草稿并重新加载？');
    await click(button('重新加载', confirmation));
    await waitFor(() => !document.body.textContent?.includes('矩阵已被其他操作修改'));

    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('false');
  });

  it('确认重载遇到 503 且保留旧缓存时，草稿、冲突与反馈不变并显示错误', async () => {
    route('PUT', /^\/api\/roles$/, () => problem(409, '矩阵已被其他操作修改', 'CONFLICT'));
    await openRoles();
    await click(cell('成员', '查看专家'));
    await click(button('保存更改'));
    const feedback = document.querySelector('[role="status"]')?.textContent;
    const count = document.querySelector('[aria-label="未保存权限变更"]')?.textContent;
    const cached = client.getQueryData(['role-matrix']);
    expect(cached).toEqual(current);
    handlers = handlers.filter((item) => !(item.method === 'GET' && item.match.test('/api/roles')));
    route('GET', /^\/api\/roles$/, () => problem(503, '角色矩阵暂时不可用', 'UNAVAILABLE'));

    await click(button('重新加载'));
    await click(button('重新加载', dialog('放弃当前草稿并重新加载？')));

    expect(client.getQueryState(['role-matrix'])?.status).toBe('error');
    expect(client.getQueryData(['role-matrix'])).toBe(cached);
    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(cell('成员', '查看专家').closest('td')?.getAttribute('data-changed')).toBe('true');
    expect(button('保存更改').disabled).toBe(false);
    expect(document.body.textContent).toContain('有未保存的更改');
    expect(document.body.textContent).toContain('矩阵已被其他操作修改');
    expect(document.querySelector('[role="status"]')?.textContent).toBe(feedback);
    expect(document.querySelector('[aria-label="未保存权限变更"]')?.textContent).toBe(count);
    expect(dialog('放弃当前草稿并重新加载？')).toBeTruthy();
    expect(toastError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, message: '角色矩阵暂时不可用' }),
    );
    await click(button('取消', dialog('放弃当前草稿并重新加载？')));
    await act(async () => {
      await history.push('/away');
    });
    await flush();
    expect(dialog('放弃未保存的角色矩阵？')).toBeTruthy();
  });

  it('后台刷新到新版本时不覆盖未保存草稿', async () => {
    await openRoles();
    await click(cell('成员', '查看专家'));
    current = { ...structuredClone(matrix), revision: 4 };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['role-matrix'] });
    });
    await flush();

    expect(cell('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain('当前草稿已保留');
  });

  it('设置弹层与搜索保留草稿，离开页面时先确认', async () => {
    await openRoles();
    await click(cell('成员', '查看专家'));

    // 打开/关闭角色设置与权限搜索只改本地草稿，不算离开页面。
    const settings = await openSettings('成员');
    await type(roleNameInput(settings), '审计员');
    await click(button('完成', settings));
    await type(searchInput(), '查看');
    expect(maybeDialog('放弃未保存的角色矩阵？')).toBeNull();

    await type(searchInput(), '');
    expect(cell('审计员', '查看专家').getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      await history.push('/away');
    });
    await flush();
    expect(dialog('放弃未保存的角色矩阵？')).toBeTruthy();
  });
});

describe('无权访问页面', () => {
  it('提供刷新权限入口且不再要求重新登录', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await mount('/denied', () =>
      createElement(AccessDenied, {
        home: '/agents',
        noPermissions: false,
        onLogout: () => {},
      }),
    );
    await flush();

    expect(document.body.textContent).toContain('刷新权限');
    expect(document.body.textContent).not.toContain('重新登录');
    await click(button('刷新权限'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] });
  });
});

describe('账户管理', () => {
  const account = {
    businessId: 'alice',
    username: 'alice',
    name: '爱丽丝',
    status: 'active' as const,
    roles: [],
    createdAt: '2026-01-01T00:00:00Z',
  };
  let status: 'active' | 'disabled' = 'active';

  beforeEach(() => {
    status = 'active';
    route('GET', /^\/api\/accounts$/, () => json({ items: [{ ...account, status }], total: 1 }));
    route('GET', /^\/api\/roles$/, () =>
      json({ revision: 1, roles: [{ ...matrixRole, id: 'role_member', name: '成员' }] }),
    );
    route('PATCH', /^\/api\/accounts\/alice\/status$/, (call) => {
      status = (call.body as { status: 'active' | 'disabled' }).status;
      return json({ ...account, status });
    });
    route('DELETE', /^\/api\/accounts\/alice$/, () => json({ ok: true }));
  });
  const matrixRole = {
    systemKey: null,
    grants: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  async function openAccounts(): Promise<void> {
    await mount('/accounts', AccountsPage);
    await waitFor(() => maybeButton('新建账户'));
  }

  it('同业务 ID 冲突后必须显式确认才以 restore:true 重建', async () => {
    const posts: unknown[] = [];
    route('POST', /^\/api\/accounts$/, (call) => {
      posts.push(call.body);
      return posts.length === 1
        ? problem(409, '该业务 ID 已有历史记录', 'CONFLICT')
        : json({ ...account, name: '爱丽丝' });
    });
    await openAccounts();
    await click(button('新建账户'));
    await type(field('account-business-id'), 'alice');
    await type(field('account-username'), 'alice');
    await type(field('account-name'), '爱丽丝');
    await type(field('account-password'), 'password123');
    await click(button('创建账户'));

    expect(document.body.textContent).toContain('该业务 ID 已有历史记录');
    expect(document.body.textContent).toContain('不需要其他技术 ID');
    expect(posts).toHaveLength(1);
    await click(button('恢复原身份和授权'));
    expect(posts[1]).toMatchObject({ businessId: 'alice', restore: true });
  });

  it('停用需要确认，启用可直接撤销停用状态', async () => {
    await openAccounts();
    await waitFor(() => maybeButton('操作 爱丽丝'));
    await openMenu('操作 爱丽丝');
    await click(menuItem('停用'));
    expect(dialog('停用账户「爱丽丝」')).toBeTruthy();
    await click(button('停用', dialog('停用账户「爱丽丝」')));
    expect(bodyOf('/api/accounts/alice/status', 'PATCH')).toEqual({ status: 'disabled' });

    await waitFor(() => host.querySelector('tbody')?.textContent?.includes('停用'));
    await openMenu('操作 爱丽丝');
    await click(menuItem('启用'));
    expect(calls.filter((call) => call.path === '/api/accounts/alice/status').at(-1)?.body).toEqual(
      { status: 'active' },
    );
  });

  it('删除认证只发 DELETE，并说明业务授权保留', async () => {
    await openAccounts();
    await waitFor(() => maybeButton('操作 爱丽丝'));
    await openMenu('操作 爱丽丝');
    await click(menuItem('删除认证'));
    const confirmation = dialog('删除「爱丽丝」的登录认证');
    expect(confirmation.textContent).toContain('业务内容、角色、专家归属与个人记忆都会保留');
    await click(button('删除', confirmation));
    expect(
      calls.some((call) => call.method === 'DELETE' && call.path === '/api/accounts/alice'),
    ).toBe(true);
    expect(toastSuccess).toHaveBeenCalledWith('已删除登录认证，业务授权仍保留');
  });
});
