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
import { toastSuccess } from '../src/lib/toast.js';
import { AccountsPage } from '../src/pages/accounts.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const CATALOG: PermissionDefinition[] = [
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
  {
    id: 'roles.manage',
    label: '管理角色',
    treePath: ['平台', '角色'],
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

const roleMember = {
  id: 'role_member',
  name: '成员',
  systemKey: null,
  grants: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const baseMatrix = { revision: 1, roles: [roleMember] };
const alice = {
  businessId: 'alice',
  username: 'alice',
  name: '爱丽丝',
  status: 'active' as const,
  roles: [{ id: 'role_member', name: '成员' }],
  createdAt: '2026-01-01T00:00:00Z',
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createBrowserHistory>;
let mePermissions: string[];
let rolesHandler: Handler;
let accountsHandler: Handler;
let rolesRequests: number;

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
async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await flush();
}
async function clickBackdrop(): Promise<void> {
  const overlays = document.querySelectorAll<HTMLElement>('[data-slot="dialog-overlay"]');
  const overlay = overlays[overlays.length - 1];
  if (!overlay) throw new Error('Missing dialog backdrop');
  await act(async () => overlay.click());
  await flush();
}

async function mount(): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const page = createRoute({
    getParentRoute: () => shell,
    path: '/accounts',
    component: AccountsPage,
  });
  const away = createRoute({
    getParentRoute: () => shell,
    path: '/away',
    component: () => createElement('h1', null, 'Away'),
  });
  window.history.replaceState(null, '', '/accounts');
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
  mePermissions = ALL;
  rolesRequests = 0;
  rolesHandler = () => json(baseMatrix);
  accountsHandler = () => json({ items: [alice], total: 1 });
  route('GET', /^\/api\/auth\/me$/, () => json(me(mePermissions)));
  route('GET', /^\/api\/accounts$/, (call) => accountsHandler(call));
  route('GET', /^\/api\/roles$/, (call) => {
    rolesRequests += 1;
    return rolesHandler(call);
  });
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

async function openAccounts(): Promise<void> {
  await mount();
  await waitFor(() => maybeButton('新建账户'));
}

async function fillNewAccount(): Promise<void> {
  await type(field('account-business-id'), 'bob');
  await type(field('account-username'), 'bob');
  await type(field('account-name'), '鲍勃');
  await type(field('account-password'), 'test-password-123');
}

describe('账户弹窗的未保存保护', () => {
  it('新建填写后点取消先确认，确认后才关闭且不发请求', async () => {
    await openAccounts();
    await click(button('新建账户'));
    await type(field('account-business-id'), 'bob');

    const createDialog = dialog('新建账户');
    await click(button('取消', createDialog));
    expect(dialog('放弃未保存的更改？')).toBeTruthy();
    expect(document.body.textContent).toContain('关闭后填写的内容会丢失。');
    expect(maybeDialog('新建账户')).toBeTruthy();
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/accounts')).toBe(
      false,
    );

    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    await waitFor(() => maybeDialog('新建账户') === null);
  });

  it('编辑填写后按 Esc 先确认，确认后才关闭且不发请求', async () => {
    await openAccounts();
    await click(button('编辑'));
    await type(field('account-edit-name'), '新名字');
    expect(maybeButton('保存')).toBeTruthy();

    await pressEscape();
    expect(dialog('放弃未保存的更改？')).toBeTruthy();
    expect(maybeDialog('编辑账户「爱丽丝」')).toBeTruthy();
    expect(
      calls.some((call) => call.method === 'PATCH' && call.path === '/api/accounts/alice'),
    ).toBe(false);

    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    await waitFor(() => maybeDialog('编辑账户「爱丽丝」') === null);
  });

  it('重置密码填写后点遮罩先确认', async () => {
    await openAccounts();
    await click(button('重置密码'));
    await type(field('account-reset-password'), 'test-password-123');

    await clickBackdrop();
    expect(dialog('放弃未保存的更改？')).toBeTruthy();
    expect(maybeDialog('重置「爱丽丝」的密码')).toBeTruthy();
    expect(
      calls.some((call) => call.method === 'POST' && call.path === '/api/accounts/alice/password'),
    ).toBe(false);

    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    await waitFor(() => maybeDialog('重置「爱丽丝」的密码') === null);
  });

  it('分配角色改动后离开路由先确认，确认才离开且不发请求', async () => {
    await openAccounts();
    await click(button('分配角色'));
    const assignDialog = dialog('分配「爱丽丝」的角色');
    const member = await waitFor(() =>
      assignDialog.querySelector<HTMLElement>('[role="checkbox"]'),
    );
    expect(member.getAttribute('aria-checked')).toBe('true');
    await click(member);

    await act(async () => {
      await history.push('/away');
    });
    await flush();
    expect(dialog('放弃未保存的更改？')).toBeTruthy();
    expect(maybeDialog('分配「爱丽丝」的角色')).toBeTruthy();
    expect(
      calls.some((call) => call.method === 'PUT' && call.path === '/api/accounts/alice/roles'),
    ).toBe(false);

    await click(button('放弃并离开', dialog('放弃未保存的更改？')));
    await waitFor(() => document.querySelector('h1')?.textContent === 'Away');
  });
});

describe('账户弹窗保存中', () => {
  it('新建请求挂起时 Esc、关闭与取消都不能关闭，完成后才关闭', async () => {
    const gate = deferred<Response>();
    route('POST', /^\/api\/accounts$/, () => gate.promise);

    await openAccounts();
    await click(button('新建账户'));
    await waitFor(() => document.querySelector('#role-role_member'));
    await fillNewAccount();
    await click(button('创建账户'));
    expect(document.body.textContent).toContain('正在创建…');

    await pressEscape();
    expect(maybeDialog('新建账户')).toBeTruthy();
    expect(button('取消', dialog('新建账户')).disabled).toBe(true);
    expect(button('关闭', dialog('新建账户')).disabled).toBe(true);

    await act(async () =>
      gate.resolve(json({ ...alice, businessId: 'bob', username: 'bob', name: '鲍勃' })),
    );
    await flush();
    await waitFor(() => maybeDialog('新建账户') === null);
    expect(toastSuccess).toHaveBeenCalledWith('已创建账户 鲍勃');
  });

  it('分配角色请求挂起时不能关闭，完成后才关闭', async () => {
    const gate = deferred<Response>();
    route('PUT', /^\/api\/accounts\/alice\/roles$/, () => gate.promise);

    await openAccounts();
    await click(button('分配角色'));
    const member = await waitFor(() => document.querySelector<HTMLElement>('#role-role_member'));
    await click(member);
    await click(button('保存'));
    expect(document.body.textContent).toContain('正在保存…');

    await pressEscape();
    expect(maybeDialog('分配「爱丽丝」的角色')).toBeTruthy();
    expect(button('取消', dialog('分配「爱丽丝」的角色')).disabled).toBe(true);
    expect(button('关闭', dialog('分配「爱丽丝」的角色')).disabled).toBe(true);

    await act(async () => gate.resolve(json({ ok: true })));
    await flush();
    await waitFor(() => maybeDialog('分配「爱丽丝」的角色') === null);
  });
});

describe('账户字段错误关联', () => {
  it('新建空表单提交后每个字段都有错误描述与首错聚焦', async () => {
    await openAccounts();
    await click(button('新建账户'));
    await waitFor(() => document.querySelector('#role-role_member'));
    await click(button('创建账户'));

    for (const [id, errorId] of [
      ['account-business-id', 'account-business-id-error'],
      ['account-username', 'account-username-error'],
      ['account-name', 'account-name-error'],
      ['account-password', 'account-password-error'],
    ] as const) {
      const input = field(id);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe(errorId);
      expect(document.getElementById(errorId)?.textContent).toBeTruthy();
    }
    expect(field('account-business-id').getAttribute('aria-describedby')).toBe(
      'account-business-id-error',
    );
    await waitFor(() => document.activeElement?.id === 'account-business-id');
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/accounts')).toBe(
      false,
    );
  });

  it('编辑用户名与姓名分别就近报错，服务端错误仍保留在表单', async () => {
    route('PATCH', /^\/api\/accounts\/alice$/, () => problem(400, '用户名已被占用', 'CONFLICT'));

    await openAccounts();
    await click(button('编辑'));
    await type(field('account-edit-username'), '');
    await type(field('account-edit-name'), '');
    await click(button('保存'));

    const username = field('account-edit-username');
    const name = field('account-edit-name');
    expect(username.getAttribute('aria-invalid')).toBe('true');
    expect(username.getAttribute('aria-describedby')).toBe('account-edit-username-error');
    expect(document.getElementById('account-edit-username-error')?.textContent).toBe(
      '请填写用户名。',
    );
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBe('account-edit-name-error');
    expect(document.getElementById('account-edit-name-error')?.textContent).toBe('请填写姓名。');
    await waitFor(() => document.activeElement?.id === 'account-edit-username');
    expect(
      calls.some((call) => call.method === 'PATCH' && call.path === '/api/accounts/alice'),
    ).toBe(false);

    await type(field('account-edit-username'), 'alice');
    await type(field('account-edit-name'), '爱丽丝');
    await click(button('保存'));
    expect(await waitFor(() => bodyOf('/api/accounts/alice', 'PATCH'))).toBeTruthy();
    expect(document.body.textContent).toContain('用户名已被占用');
  });

  it('重置密码的长度与确认不一致分别报错并聚焦第一个字段', async () => {
    await openAccounts();
    await click(button('重置密码'));
    await type(field('account-reset-password'), 'abc');
    await type(field('account-reset-confirm'), 'xyz');
    await click(button('重置密码', dialog('重置「爱丽丝」的密码')));

    const password = field('account-reset-password');
    const confirm = field('account-reset-confirm');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(password.getAttribute('aria-describedby')).toBe('account-reset-password-error');
    expect(document.getElementById('account-reset-password-error')?.textContent).toBe(
      '密码至少 8 个字符。',
    );
    expect(confirm.getAttribute('aria-invalid')).toBe('true');
    expect(confirm.getAttribute('aria-describedby')).toBe('account-reset-confirm-error');
    expect(document.getElementById('account-reset-confirm-error')?.textContent).toBe(
      '两次输入的密码不一致。',
    );
    await waitFor(() => document.activeElement?.id === 'account-reset-password');
    expect(
      calls.some((call) => call.method === 'POST' && call.path === '/api/accounts/alice/password'),
    ).toBe(false);
  });
});

describe('账户弹窗的角色目录', () => {
  it('角色目录加载中不伪装成空目录，保存禁用且关闭不受影响', async () => {
    const gate = deferred<Response>();
    rolesHandler = () => gate.promise;

    await openAccounts();
    await click(button('新建账户'));
    expect(document.querySelector('[aria-label="加载中"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('没有可分配的角色。');

    await fillNewAccount();
    expect(button('创建账户').disabled).toBe(true);
    await click(button('创建账户'));
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/accounts')).toBe(
      false,
    );

    await click(button('取消', dialog('新建账户')));
    expect(dialog('放弃未保存的更改？')).toBeTruthy();
    expect(document.body.textContent).toContain('关闭后填写的内容会丢失。');
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    await waitFor(() => maybeDialog('新建账户') === null);

    await act(async () => gate.resolve(json(baseMatrix)));
    await flush();
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/accounts')).toBe(
      false,
    );
  });

  it('角色目录失败时显示可重试错误，不错误发起创建', async () => {
    let failed = false;
    rolesHandler = () => {
      if (!failed) {
        failed = true;
        return problem(500, '角色目录不可用', 'INTERNAL_ERROR');
      }
      return json(baseMatrix);
    };

    await openAccounts();
    await click(button('新建账户'));
    await waitFor(() => document.body.textContent?.includes('角色目录没有加载出来'));
    expect(button('创建账户').disabled).toBe(true);

    await fillNewAccount();
    await click(button('创建账户'));
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/accounts')).toBe(
      false,
    );

    await click(button('重试'));
    await waitFor(() => document.querySelector('#role-role_member'));
    expect(rolesRequests).toBeGreaterThanOrEqual(2);
    expect(button('创建账户').disabled).toBe(false);
  });

  it('缓存目录仍在且后台刷新失败时保留已选角色并可保存', async () => {
    client.setQueryData(['role-matrix'], baseMatrix);
    rolesHandler = () => problem(500, '刷新失败', 'INTERNAL_ERROR');
    route('PUT', /^\/api\/accounts\/alice\/roles$/, () => json({ ok: true }));

    await openAccounts();
    await click(button('分配角色'));
    await waitFor(() => document.body.textContent?.includes('角色目录没有加载出来'));

    const assignDialog = dialog('分配「爱丽丝」的角色');
    const member = assignDialog.querySelector<HTMLElement>('[role="checkbox"]');
    expect(member).toBeTruthy();
    expect(member?.getAttribute('aria-checked')).toBe('true');
    if (!member) return;
    await click(member);
    expect(member.getAttribute('aria-checked')).toBe('false');

    await click(button('保存'));
    expect(await waitFor(() => bodyOf('/api/accounts/alice/roles'))).toEqual({ roleIds: [] });
  });

  it('没有 roles.manage 时创建不请求角色目录，载荷不携带 roleIds', async () => {
    mePermissions = ['accounts.read', 'accounts.manage'];
    route('POST', /^\/api\/accounts$/, () => json({ ...alice, businessId: 'bob', name: '鲍勃' }));

    await openAccounts();
    await click(button('新建账户'));
    const createDialog = dialog('新建账户');
    expect(createDialog.textContent).not.toContain('角色');
    expect(document.querySelector('#role-role_member')).toBeNull();
    expect(calls.some((call) => call.path === '/api/roles')).toBe(false);

    await fillNewAccount();
    await click(button('创建账户'));

    const body = (await waitFor(() => bodyOf('/api/accounts', 'POST'))) as Record<string, unknown>;
    expect(body).toEqual({
      businessId: 'bob',
      username: 'bob',
      name: '鲍勃',
      password: 'test-password-123',
      restore: false,
    });
    expect(body).not.toHaveProperty('roleIds');
  });
});
