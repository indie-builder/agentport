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
function maybeDialog(titlePrefix: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((item) =>
      item.querySelector('h2')?.textContent?.trim().startsWith(titlePrefix),
    ) ?? null
  );
}
function dialog(titlePrefix: string): HTMLElement {
  const element = maybeDialog(titlePrefix);
  if (!element) throw new Error(`Missing dialog: ${titlePrefix}`);
  return element;
}
function permissionMatrix(): HTMLTableElement {
  const element = document.querySelector<HTMLTableElement>('table[aria-label="角色权限矩阵"]');
  if (!element) throw new Error('Missing role permission matrix');
  return element;
}
function maybeMatrixCheckbox(role: string, label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${role}：${label}"]`);
}
function matrixCheckbox(role: string, label: string): HTMLElement {
  const element = maybeMatrixCheckbox(role, label);
  if (!element) throw new Error(`Missing checkbox: ${role}：${label}`);
  return element;
}
function cellOf(role: string, label: string): HTMLTableCellElement {
  const cell = matrixCheckbox(role, label).closest('td');
  if (!(cell instanceof HTMLTableCellElement)) {
    throw new Error(`Missing data cell: ${role}：${label}`);
  }
  return cell;
}
function dataCells(): HTMLTableCellElement[] {
  return [...permissionMatrix().querySelectorAll<HTMLTableCellElement>('tbody td')];
}
function ariaDescription(role: string, label: string): string {
  return matrixCheckbox(role, label).getAttribute('aria-description') ?? '';
}
function statusRegion(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="status"]');
  if (!element) throw new Error('Missing role=status feedback');
  return element;
}
function unsavedCount(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[aria-label="未保存权限变更"]');
  if (!element) throw new Error('Missing unsaved count');
  return element;
}
function settingsDialog(role: string): HTMLElement {
  return dialog(`角色设置：${role}`);
}
async function openSettings(role: string): Promise<HTMLElement> {
  await click(button(`设置角色 ${role}`));
  return waitFor(() => maybeDialog(`角色设置：${role}`)) as Promise<HTMLElement>;
}
function roleNameInput(scope: ParentNode = document): HTMLInputElement {
  const elements = scope.querySelectorAll<HTMLInputElement>('input[aria-label="角色名称"]');
  if (elements.length !== 1) {
    throw new Error(`Expected one role name input, got ${elements.length}`);
  }
  return elements[0] as HTMLInputElement;
}
function searchInput(): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>('input[aria-label="搜索权限"]');
  if (!element) throw new Error('Missing role search');
  return element;
}
function scopeToggle(role: string, leaf: string, scopeLabel: string): HTMLButtonElement {
  const group = document.querySelector<HTMLElement>(`[aria-label="${role}：${leaf} 授权范围"]`);
  if (!group) throw new Error(`Missing scope group: ${role}：${leaf}`);
  const item = group.querySelector<HTMLButtonElement>(`[aria-label="${scopeLabel}范围"]`);
  if (!item) throw new Error(`Missing scope: ${role} ${leaf} ${scopeLabel}`);
  return item;
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
  route('PUT', /^\/api\/roles$/, (call) => {
    const payload = call.body as RoleMatrixInput;
    // 服务端回包带真实 id/systemKey；保存载荷本身不含 systemKey，不能直接回显 request body。
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
  await waitFor(() => permissionMatrix());
}

describe('角色权限矩阵：页面契约', () => {
  it('顶部按角色分列、行头为功能，数据单元格只含勾选框', async () => {
    await openRoles();
    const table = permissionMatrix();

    const headCells = [...table.querySelectorAll<HTMLTableCellElement>('thead th')];
    expect(headCells.length).toBeGreaterThanOrEqual(2);
    expect(headCells.every((cell) => cell.getAttribute('scope') === 'col')).toBe(true);
    expect(
      headCells
        .map((cell) =>
          cell.querySelector('button[aria-label^="设置角色 "]')?.getAttribute('aria-label'),
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
      for (const cell of cells) {
        expect(cell.tagName).toBe('TD');
        expect(cell.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
        expect(
          cell.querySelectorAll(
            'button:not([role="checkbox"]), a, select, textarea, [role="combobox"], [role="group"]',
          ),
        ).toHaveLength(0);
        expect(cell.textContent?.trim()).toBe('');
      }
    }

    expect(document.querySelectorAll('input[aria-label="角色名称"]')).toHaveLength(0);
    expect(matrixCheckbox('管理员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('false');
  });

  it('父级折叠隐藏整棵子树，展开按钮同步 aria-expanded', async () => {
    await openRoles();
    const collapse = button('收起 专家');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');

    await click(collapse);
    expect(button('展开 专家').getAttribute('aria-expanded')).toBe('false');
    for (const label of ['发现', '配置', '查看专家', '使用专家', '查看配置']) {
      expect(maybeMatrixCheckbox('成员', label)).toBeNull();
    }

    await click(button('展开 专家'));
    expect(matrixCheckbox('成员', '查看专家')).toBeTruthy();
  });
});

describe('角色权限矩阵：搜索时的父级批量勾选', () => {
  it('搜索时父级禁用，点击不会授予隐藏权限；清空后恢复完整三态与批量勾选', async () => {
    await openRoles();
    await type(searchInput(), '查看专家');

    const parent = matrixCheckbox('成员', '专家');
    expect(parent.getAttribute('aria-checked')).toBe('false');
    expect(disabledControl(parent)).toBe(true);

    await click(parent);
    await type(searchInput(), '');

    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('false');
    expect(matrixCheckbox('成员', '使用专家').getAttribute('aria-checked')).toBe('false');
    expect(matrixCheckbox('成员', '查看配置').getAttribute('aria-checked')).toBe('false');
    expect(matrixCheckbox('成员', '专家').getAttribute('aria-checked')).toBe('false');

    await click(matrixCheckbox('成员', '专家'));
    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '使用专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '查看配置').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '专家').getAttribute('aria-checked')).toBe('true');
  });

  it('搜索只显示已授权叶时父级禁用，点击不会撤销可见授权或授予隐藏权限', async () => {
    const member = current.roles[1];
    if (!member) throw new Error('Missing member role');
    member.grants = [{ permissionId: 'agents.read', scope: 'authorized_agents' }];
    await openRoles();
    await type(searchInput(), '查看专家');

    const parent = matrixCheckbox('成员', '专家');
    expect(parent.getAttribute('aria-checked')).toBe('true');
    expect(disabledControl(parent)).toBe(true);

    await click(parent);
    await type(searchInput(), '');

    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '使用专家').getAttribute('aria-checked')).toBe('false');
    expect(matrixCheckbox('成员', '查看配置').getAttribute('aria-checked')).toBe('false');
    expect(matrixCheckbox('成员', '专家').getAttribute('aria-checked')).toBe('mixed');
  });

  it('搜索时叶动作仍可编辑，清空后保持所选', async () => {
    await openRoles();
    await type(searchInput(), '使用专家');

    const leaf = matrixCheckbox('成员', '使用专家');
    expect(disabledControl(leaf)).toBe(false);
    await click(leaf);
    expect(leaf.getAttribute('aria-checked')).toBe('true');

    await type(searchInput(), '');
    expect(matrixCheckbox('成员', '使用专家').getAttribute('aria-checked')).toBe('true');
  });

  it('折叠后搜索强制展开，清空后恢复折叠；父级三态批量勾选保持', async () => {
    await openRoles();

    await click(button('收起 专家'));
    expect(maybeMatrixCheckbox('成员', '查看专家')).toBeNull();
    expect(button('展开 专家').getAttribute('aria-expanded')).toBe('false');

    await type(searchInput(), '查看专家');
    expect(maybeMatrixCheckbox('成员', '查看专家')).not.toBeNull();
    expect(disabledControl(matrixCheckbox('成员', '专家'))).toBe(true);

    await type(searchInput(), '');
    expect(maybeMatrixCheckbox('成员', '查看专家')).toBeNull();

    await click(button('展开 专家'));
    expect(matrixCheckbox('成员', '专家').getAttribute('aria-checked')).toBe('false');
    await click(matrixCheckbox('成员', '专家'));
    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '使用专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '查看配置').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '专家').getAttribute('aria-checked')).toBe('true');

    await click(matrixCheckbox('成员', '使用专家'));
    expect(matrixCheckbox('成员', '专家').getAttribute('aria-checked')).toBe('mixed');
    await click(matrixCheckbox('成员', '专家'));
    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '使用专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '查看配置').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('成员', '专家').getAttribute('aria-checked')).toBe('true');

    await click(matrixCheckbox('成员', '专家'));
    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('false');
    expect(matrixCheckbox('成员', '使用专家').getAttribute('aria-checked')).toBe('false');
    expect(matrixCheckbox('成员', '查看配置').getAttribute('aria-checked')).toBe('false');
    expect(matrixCheckbox('成员', '专家').getAttribute('aria-checked')).toBe('false');
  });
});

describe('角色权限矩阵：工具栏展开控制', () => {
  it('全部收起只折叠顶层，全部展开恢复所有层级', async () => {
    await openRoles();
    expect(maybeButton('全部收起')).not.toBeNull();
    expect(maybeButton('全部展开')).not.toBeNull();

    await click(button('收起 发现'));
    expect(maybeMatrixCheckbox('成员', '查看专家')).toBeNull();

    await click(button('全部收起'));
    // 顶层组行保留（可继续批量勾选），其下所有子组与叶隐藏。
    expect(matrixCheckbox('成员', '专家')).toBeTruthy();
    expect(matrixCheckbox('成员', '平台')).toBeTruthy();
    for (const label of ['发现', '配置', '查看专家', '使用专家', '查看配置']) {
      expect(maybeMatrixCheckbox('成员', label)).toBeNull();
    }
    for (const label of ['角色', '账户', '管理角色', '查看账户', '管理账户']) {
      expect(maybeMatrixCheckbox('成员', label)).toBeNull();
    }

    await click(button('全部展开'));
    for (const label of [
      '发现',
      '配置',
      '查看专家',
      '使用专家',
      '查看配置',
      '角色',
      '账户',
      '管理角色',
      '查看账户',
      '管理账户',
    ]) {
      expect(maybeMatrixCheckbox('成员', label)).not.toBeNull();
    }
  });

  it('搜索强制展开时全部收起/展开禁用并说明原因，清空后恢复', async () => {
    await openRoles();
    await type(searchInput(), '查看专家');

    for (const label of ['全部收起', '全部展开']) {
      const control = maybeButton(label);
      expect(control).not.toBeNull();
      expect(disabledControl(control as HTMLButtonElement)).toBe(true);
      const title = control?.getAttribute('title') ?? '';
      expect(title.trim()).not.toBe('');
      expect(title).toContain('搜索');
    }

    await type(searchInput(), '');
    for (const label of ['全部收起', '全部展开']) {
      expect(disabledControl(button(label))).toBe(false);
    }
  });
});

describe('角色权限矩阵：未保存变化标记', () => {
  it('新增与撤销都标记单元格，恢复基线后清除，数据区仍只有勾选框', async () => {
    const member = current.roles[1];
    if (!member) throw new Error('Missing member role');
    member.grants = [{ permissionId: 'agents.read', scope: 'authorized_agents' }];
    await openRoles();

    expect(dataCells().every((cell) => cell.getAttribute('data-changed') === 'false')).toBe(true);

    await click(matrixCheckbox('成员', '查看专家'));
    let cell = cellOf('成员', '查看专家');
    expect(cell.getAttribute('data-changed')).toBe('true');
    expect(cell.getAttribute('title')).toContain('未保存');
    expect(ariaDescription('成员', '查看专家')).toContain('撤销');
    expect(cell.textContent?.trim()).toBe('');
    expect(
      cell.querySelectorAll(
        // Base UI Checkbox 自带 aria-hidden 的原生 input，属于勾选框本身，不计为额外控件。
        'button:not([role="checkbox"]), a, select, textarea, input:not([type="checkbox"]), [role="combobox"], [role="group"]',
      ),
    ).toHaveLength(0);

    await click(matrixCheckbox('成员', '查看专家'));
    cell = cellOf('成员', '查看专家');
    expect(cell.getAttribute('data-changed')).toBe('false');
    expect(cell.getAttribute('title') ?? '').not.toContain('未保存');
    expect(ariaDescription('成员', '查看专家')).not.toContain('撤销');

    await click(matrixCheckbox('成员', '使用专家'));
    cell = cellOf('成员', '使用专家');
    expect(cell.getAttribute('data-changed')).toBe('true');
    expect(cell.getAttribute('title')).toContain('未保存');
    expect(ariaDescription('成员', '使用专家')).toContain('新增');
    expect(cellOf('成员', '查看配置').getAttribute('data-changed')).toBe('false');
  });
});

describe('角色权限矩阵：父组聚合与范围变更', () => {
  it('折叠后父组仍标记隐藏叶的新增；范围调整单独标记并可恢复', async () => {
    const member = current.roles[1];
    if (!member) throw new Error('Missing member role');
    member.grants = [{ permissionId: 'agents.read', scope: 'authorized_agents' }];
    await openRoles();

    expect(cellOf('成员', '专家').getAttribute('data-changed')).toBe('false');

    // 只改范围、不改勾选状态，单元格同样视为未保存。
    const settings = await openSettings('成员');
    await click(scopeToggle('成员', '查看专家', '全平台'));
    await click(button('完成', settings));

    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(cellOf('成员', '查看专家').getAttribute('data-changed')).toBe('true');
    expect(cellOf('成员', '查看专家').getAttribute('title')).toContain('未保存');
    expect(ariaDescription('成员', '查看专家')).toContain('范围调整');

    // 叶被折叠隐藏后，父组聚合仍暴露该变化。
    await click(button('收起 专家'));
    expect(maybeMatrixCheckbox('成员', '查看专家')).toBeNull();
    expect(cellOf('成员', '专家').getAttribute('data-changed')).toBe('true');
    expect(cellOf('成员', '专家').getAttribute('title')).toContain('未保存');

    // 范围改回基线后变化清除。
    await click(button('展开 专家'));
    const reopened = await openSettings('成员');
    await click(scopeToggle('成员', '查看专家', '全平台'));
    await click(button('完成', reopened));

    expect(cellOf('成员', '查看专家').getAttribute('data-changed')).toBe('false');
    expect(cellOf('成员', '专家').getAttribute('data-changed')).toBe('false');
  });
});

describe('角色权限矩阵：工具栏反馈与保存清除', () => {
  it('批量勾选标记所有改动单元格，状态区反馈最近操作与未保存数量，保存成功后清除', async () => {
    await openRoles();
    await click(matrixCheckbox('成员', '专家'));

    for (const label of ['专家', '查看专家', '使用专家', '查看配置']) {
      const cell = cellOf('成员', label);
      expect(cell.getAttribute('data-changed')).toBe('true');
      expect(cell.getAttribute('title')).toContain('未保存');
    }
    expect(ariaDescription('成员', '查看专家')).toContain('新增');
    // data-changed 会把父组聚合也算一行；未保存计数只算真实叶权限变化（3 个叶），不重复计父链。
    expect(dataCells().filter((cell) => cell.getAttribute('data-changed') === 'true')).toHaveLength(
      4,
    );

    const status = statusRegion();
    expect(status.textContent).toContain('成员');
    expect(status.textContent).toContain('专家');
    expect(status.textContent).toMatch(/授权/);
    expect(unsavedCount().textContent).toContain('3');

    await click(matrixCheckbox('成员', '使用专家'));
    expect(statusRegion().textContent).toContain('使用专家');
    expect(statusRegion().textContent).toMatch(/撤销/);
    expect(unsavedCount().textContent).toContain('2');

    await click(button('保存更改'));
    await waitFor(() => bodyOf('/api/roles'));
    expect(dataCells().every((cell) => cell.getAttribute('data-changed') === 'false')).toBe(true);
    expect(
      dataCells().filter((cell) => (cell.getAttribute('title') ?? '').includes('未保存')),
    ).toHaveLength(0);
    const afterSave = document.querySelector('[aria-label="未保存权限变更"]');
    expect(afterSave === null || /(^|\D)0(\D|$)/.test(afterSave.textContent ?? '')).toBe(true);
  });
});

describe('角色设置：名称校验就地反馈', () => {
  it('空白名称在字段旁报错并禁用保存，改正后错误消失且可保存', async () => {
    await openRoles();
    const settings = await openSettings('成员');
    expect(document.querySelectorAll('input[aria-label="角色名称"]')).toHaveLength(1);

    await type(roleNameInput(), '   ');
    expect(button('保存更改').disabled).toBe(true);
    expect(roleNameInput().getAttribute('aria-invalid')).toBe('true');
    expect(describedError(roleNameInput())?.textContent?.trim()).toBe('角色名称不能为空。');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    await click(button('保存更改'));
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    await type(roleNameInput(), '审计员');
    expect(roleNameInput().getAttribute('aria-invalid')).toBe('false');
    expect(roleNameInput().getAttribute('aria-describedby')).toBeNull();
    expect(button('保存更改').disabled).toBe(false);

    await click(button('完成', settings));
    expect(maybeDialog('角色设置：成员')).toBeNull();
    await click(button('保存更改'));
    const body = (await waitFor(() => bodyOf('/api/roles'))) as RoleMatrixInput;
    expect(body.roles.find((role) => role.id === 'role_member')?.name).toBe('审计员');
  });

  it('重复名称在设置字段报错，修正后另一角色字段同步清除', async () => {
    await openRoles();

    const memberSettings = await openSettings('成员');
    await type(roleNameInput(), '管理员');
    expect(document.querySelectorAll('input[aria-label="角色名称"]')).toHaveLength(1);
    expect(roleNameInput().getAttribute('aria-invalid')).toBe('true');
    expect(describedError(roleNameInput())?.textContent?.trim()).toBe('角色名称不能重复。');
    expect(button('保存更改').disabled).toBe(true);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    await click(button('完成', memberSettings));

    const adminSettings = await openSettings('管理员');
    expect(roleNameInput(adminSettings).value).toBe('管理员');
    expect(roleNameInput(adminSettings).getAttribute('aria-invalid')).toBe('true');
    expect(describedError(roleNameInput(adminSettings))?.textContent?.trim()).toBe(
      '角色名称不能重复。',
    );
    await click(button('完成', adminSettings));

    const reopenMember = await openSettings('成员');
    await type(roleNameInput(reopenMember), '审计员');
    expect(roleNameInput(reopenMember).getAttribute('aria-invalid')).toBe('false');
    expect(roleNameInput(reopenMember).getAttribute('aria-describedby')).toBeNull();
    await click(button('完成', reopenMember));

    const reopenAdmin = await openSettings('管理员');
    expect(roleNameInput(reopenAdmin).getAttribute('aria-invalid')).toBe('false');
    expect(roleNameInput(reopenAdmin).getAttribute('aria-describedby')).toBeNull();
    await click(button('完成', reopenAdmin));

    await click(button('保存更改'));
    const body = (await waitFor(() => bodyOf('/api/roles'))) as RoleMatrixInput;
    expect(body.roles.map((role) => role.name)).toEqual(['管理员', '审计员']);
  });
});

describe('角色设置：范围与批量勾选', () => {
  it('弹层只列已授权叶的范围，修改与批量勾选共用同一份草稿', async () => {
    const member = current.roles[1];
    if (!member) throw new Error('Missing member role');
    member.grants = [{ permissionId: 'agents.config.read', scope: 'platform' }];
    await openRoles();

    const settings = await openSettings('成员');
    expect(roleNameInput(settings).value).toBe('成员');
    expect(settings.querySelector('[aria-label="成员：查看配置 授权范围"]')).not.toBeNull();
    expect(settings.querySelector('[aria-label="成员：查看专家 授权范围"]')).toBeNull();
    expect(scopeToggle('成员', '查看配置', '全平台').getAttribute('aria-pressed')).toBe('true');
    expect(scopeToggle('成员', '查看配置', '维护专家').getAttribute('aria-pressed')).toBe('false');

    await type(roleNameInput(settings), '审计员');
    await click(button('完成', settings));
    expect(maybeDialog('角色设置：成员')).toBeNull();
    expect(maybeButton('设置角色 审计员')).toBeTruthy();

    await click(matrixCheckbox('审计员', '专家'));
    expect(matrixCheckbox('审计员', '查看专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('审计员', '使用专家').getAttribute('aria-checked')).toBe('true');
    expect(matrixCheckbox('审计员', '查看配置').getAttribute('aria-checked')).toBe('true');

    const reopened = await openSettings('审计员');
    expect(scopeToggle('审计员', '查看配置', '全平台').getAttribute('aria-pressed')).toBe('true');
    expect(scopeToggle('审计员', '查看配置', '维护专家').getAttribute('aria-pressed')).toBe(
      'false',
    );
    await click(button('完成', reopened));
  });

  it('取消已有叶的最后一个范围即撤销授权，工具栏反馈撤销而非范围调整', async () => {
    const member = current.roles[1];
    if (!member) throw new Error('Missing member role');
    member.grants = [
      { permissionId: 'agents.read', scope: 'authorized_agents' },
      { permissionId: 'agents.use', scope: 'authorized_agents' },
    ];
    await openRoles();

    const settings = await openSettings('成员');
    // 先改另一权限的范围，保证总变更数不为 0。
    await click(scopeToggle('成员', '使用专家', '全平台'));
    await click(scopeToggle('成员', '查看专家', '被授权专家'));
    await click(button('完成', settings));

    expect(matrixCheckbox('成员', '查看专家').getAttribute('aria-checked')).toBe('false');
    const status = statusRegion();
    expect(status.textContent).toContain('成员');
    expect(status.textContent).toContain('查看专家');
    expect(status.textContent).toContain('撤销');
  });

  it('新建角色自动打开设置，删除按钮也只在角色设置里', async () => {
    await openRoles();

    await click(button('新建角色'));
    const created = (await waitFor(() => maybeDialog('角色设置：新角色 3'))) as HTMLElement;
    expect(roleNameInput(created).value).toBe('新角色 3');
    expect(maybeButton('设置角色 新角色 3')).toBeTruthy();
    await click(button('完成', created));

    await click(button('设置角色 新角色 3'));
    const settings = settingsDialog('新角色 3');
    await click(button('删除角色 新角色 3', settings));
    await click(button('删除', dialog('删除这个角色？')));

    expect(maybeButton('设置角色 新角色 3')).toBeNull();
    expect(maybeDialog('角色设置：新角色 3')).toBeNull();
  });
});

describe('角色权限矩阵：系统管理员', () => {
  it('管理员名称可改但授权只读、不可删除，保存提交服务端 grants', async () => {
    await openRoles();

    const settings = await openSettings('管理员');
    expect(roleNameInput(settings).disabled).toBe(false);
    expect(roleNameInput(settings).value).toBe('管理员');
    expect(maybeButton('删除角色 管理员', settings)).toBeNull();
    await type(roleNameInput(settings), '超级管理员');
    await click(button('完成', settings));

    expect(disabledControl(matrixCheckbox('超级管理员', '专家'))).toBe(true);
    expect(disabledControl(matrixCheckbox('超级管理员', '查看专家'))).toBe(true);
    await click(matrixCheckbox('超级管理员', '使用专家'));
    expect(matrixCheckbox('超级管理员', '使用专家').getAttribute('aria-checked')).toBe('false');

    await click(matrixCheckbox('成员', '使用专家'));
    expect(button('保存更改').disabled).toBe(false);
    await click(button('保存更改'));
    const body = (await waitFor(() => bodyOf('/api/roles'))) as RoleMatrixInput;
    expect(body.expectedRevision).toBe(3);
    expect(body.roles).toEqual([
      {
        id: 'role_admin',
        name: '超级管理员',
        grants: [{ permissionId: 'agents.read', scope: 'platform' }],
      },
      {
        id: 'role_member',
        name: '成员',
        grants: [{ permissionId: 'agents.use', scope: 'authorized_agents' }],
      },
    ]);

    expect(disabledControl(matrixCheckbox('超级管理员', '查看专家'))).toBe(true);
    expect(matrixCheckbox('超级管理员', '查看专家').getAttribute('aria-checked')).toBe('true');
  });
});
