import type { AuthMe, PermissionDefinition } from '@agentport/shared';
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
import { RolesPage } from '../src/pages/roles.js';

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
function maybeButton(text: string, scope: ParentNode = document): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
    ) ?? null
  );
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = maybeButton(text, scope);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
function checkbox(label: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${label}"]`);
  if (!element) throw new Error(`Missing checkbox: ${label}`);
  return element;
}
function nameInput(label: string): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing name input: ${label}`);
  return element;
}
function searchInput(): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>('input[aria-label="搜索权限"]');
  if (!element) throw new Error('Missing role search');
  return element;
}
function disabledControl(element: HTMLElement): boolean {
  return (
    element.hasAttribute('disabled') ||
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute('aria-disabled') === 'true'
  );
}
function describedError(input: HTMLInputElement): HTMLElement | null {
  const id = input.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id);
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flush();
}
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function mount(path: string, component: () => React.ReactNode): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const page = createRoute({
    getParentRoute: () => shell,
    path: path as never,
    component,
  });
  window.history.replaceState(null, '', path);
  history = createBrowserHistory();
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page])]),
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

const matrix = {
  revision: 3,
  roles: [
    {
      id: 'role_admin',
      name: '管理员',
      systemKey: 'admin' as const,
      grants: [{ permissionId: 'agents.read', scope: 'platform' as const }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'role_member',
      name: '成员',
      systemKey: null,
      grants: [] as Array<{ permissionId: string; scope: string }>,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
};
let current = matrix;

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
  route('GET', /^\/api\/roles$/, () => json(current));
  route('PUT', /^\/api\/roles$/, (call) =>
    json({ ...current, revision: current.revision + 1, ...(call.body as object) }),
  );
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

beforeEach(() => {
  current = structuredClone(matrix);
  prepare();
});
afterEach(async () => {
  await act(async () => root.unmount());
  history?.destroy();
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openRoles(): Promise<void> {
  await mount('/roles', RolesPage);
  await waitFor(() => document.querySelector('table[aria-label="角色权限矩阵"]'));
}

describe('角色矩阵：搜索时的父级批量勾选', () => {
  it('搜索时父级禁用，点击不会授予隐藏权限；清空后恢复完整三态与批量勾选', async () => {
    await openRoles();
    await type(searchInput(), '查看专家');

    const parent = checkbox('成员：专家');
    expect(parent.getAttribute('aria-checked')).toBe('false');
    expect(disabledControl(parent)).toBe(true);

    await click(parent);
    await type(searchInput(), '');

    expect(checkbox('成员：查看专家').getAttribute('aria-checked')).toBe('false');
    expect(checkbox('成员：使用专家').getAttribute('aria-checked')).toBe('false');
    expect(checkbox('成员：查看配置').getAttribute('aria-checked')).toBe('false');
    expect(checkbox('成员：专家').getAttribute('aria-checked')).toBe('false');

    await click(checkbox('成员：专家'));
    expect(checkbox('成员：查看专家').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('成员：使用专家').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('成员：查看配置').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('成员：专家').getAttribute('aria-checked')).toBe('true');
  });

  it('搜索只显示已授权叶时父级禁用，点击不会撤销可见授权或授予隐藏权限', async () => {
    const member = current.roles[1];
    if (!member) throw new Error('Missing member role');
    member.grants = [{ permissionId: 'agents.read', scope: 'authorized_agents' }];
    await openRoles();
    await type(searchInput(), '查看专家');

    const parent = checkbox('成员：专家');
    expect(parent.getAttribute('aria-checked')).toBe('true');
    expect(disabledControl(parent)).toBe(true);

    await click(parent);
    await type(searchInput(), '');

    expect(checkbox('成员：查看专家').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('成员：使用专家').getAttribute('aria-checked')).toBe('false');
    expect(checkbox('成员：查看配置').getAttribute('aria-checked')).toBe('false');
    expect(checkbox('成员：专家').getAttribute('aria-checked')).toBe('mixed');
  });

  it('搜索时叶动作仍可编辑，清空后保持所选', async () => {
    await openRoles();
    await type(searchInput(), '使用专家');

    const leaf = checkbox('成员：使用专家');
    expect(disabledControl(leaf)).toBe(false);
    await click(leaf);
    expect(leaf.getAttribute('aria-checked')).toBe('true');

    await type(searchInput(), '');
    expect(checkbox('成员：使用专家').getAttribute('aria-checked')).toBe('true');
  });
});

describe('角色矩阵：名称校验就地反馈', () => {
  it('空白名称在字段旁报错并禁用保存，改正后错误消失且可保存', async () => {
    await openRoles();
    const save = button('保存更改');
    const member = nameInput('角色名称：成员');

    await type(member, '   ');
    expect(save.disabled).toBe(true);
    expect(member.getAttribute('aria-invalid')).toBe('true');
    const blankError = describedError(member);
    expect(blankError?.textContent?.trim()).toBe('角色名称不能为空。');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    await click(save);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    await type(member, '审计员');
    expect(member.getAttribute('aria-invalid')).toBe('false');
    expect(member.getAttribute('aria-describedby')).toBeNull();
    expect(blankError?.isConnected).toBe(false);
    expect(save.disabled).toBe(false);

    await click(save);
    const body = (await waitFor(() => bodyOf('/api/roles'))) as {
      roles: Array<{ id?: string; name: string }>;
    };
    expect(body.roles.find((role) => role.id === 'role_member')?.name).toBe('审计员');
  });

  it('重复名称在每个字段旁同时报错，修正后立即清除并可保存', async () => {
    await openRoles();
    const save = button('保存更改');
    const admin = nameInput('角色名称：管理员');
    const member = nameInput('角色名称：成员');

    await type(member, '管理员');
    for (const input of [admin, member]) {
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const error = describedError(input);
      expect(error?.textContent?.trim()).toBe('角色名称不能重复。');
    }
    expect(admin.getAttribute('aria-describedby')).not.toBe(
      member.getAttribute('aria-describedby'),
    );
    expect(save.disabled).toBe(true);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    await type(member, '审计员');
    for (const input of [admin, member]) {
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect(input.getAttribute('aria-describedby')).toBeNull();
    }
    expect(save.disabled).toBe(false);

    await click(save);
    const body = (await waitFor(() => bodyOf('/api/roles'))) as {
      roles: Array<{ id?: string; name: string }>;
    };
    expect(body.roles.map((role) => role.name)).toEqual(['管理员', '审计员']);
  });
});
