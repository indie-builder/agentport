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
import { type AuditEntry, type AuditList, api } from '../src/lib/api.js';
import { formatDateTime } from '../src/lib/format.js';
import { AuditPage } from '../src/pages/audit.js';
import { auditSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const DIGEST = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function entry(id: string, patch: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id,
    actor: `actor-${id}`,
    action: 'agent.create',
    target: null,
    status: 'ok',
    durationMs: null,
    requestId: null,
    inputDigest: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function page(items: AuditEntry[]): AuditList {
  return { items };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let history: ReturnType<typeof createBrowserHistory>;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assert: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

async function mount(search = ''): Promise<void> {
  window.history.replaceState(null, '', `/audit${search}`);
  history = createBrowserHistory();
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const audit = createRoute({
    getParentRoute: () => shell,
    path: '/audit',
    validateSearch: auditSearchSchema,
    component: AuditPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([audit])]),
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

/** 展开按钮的名称随状态在「展开/收起 <业务名>」间切换，按主键关联的面板取当前按钮。 */
function toggle(id: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button[data-row]')].find(
    (button) => button.getAttribute('aria-controls')?.endsWith(`-row-panel-${id}`),
  );
  if (!found) throw new Error(`missing row toggle for ${id}`);
  return found;
}

function rowActionLabel(prefix: '展开' | '收起', row: AuditEntry): string {
  return `${prefix} ${row.action}${row.target ? ` ${row.target}` : ''} · ${formatDateTime(row.createdAt)}`;
}

async function toggleRow(id: string): Promise<void> {
  await act(async () => toggle(id).click());
  await flush();
}

function panelOf(id: string): HTMLElement {
  const panelId = toggle(id).getAttribute('aria-controls');
  if (!panelId) throw new Error(`row ${id} is not expandable`);
  const panel = document.getElementById(panelId);
  if (!panel) throw new Error(`missing panel for ${id}`);
  return panel;
}

function detailValue(panel: HTMLElement, label: string): string {
  const term = [...panel.querySelectorAll('dt')].find((node) => node.textContent === label);
  if (!term) throw new Error(`missing detail ${label}`);
  return term.nextElementSibling?.textContent ?? '';
}

async function typeAction(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="按动作前缀过滤"]');
  if (!input) throw new Error('missing action filter');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('input value setter unavailable');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function loadMore(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '加载更多',
  );
  if (!found) throw new Error('missing load more');
  return found;
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  history?.destroy();
  container.remove();
  vi.restoreAllMocks();
});

describe('audit row details', () => {
  it('opens exactly the requested row with actor, full event id and input digest, and collapses again', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(
      page([
        entry('audit_aaa', { actor: 'admin', inputDigest: DIGEST }),
        entry('audit_bbb', { actor: 'alice', inputDigest: null }),
      ]),
    );
    await mount();
    await waitFor(() => expect(toggle('audit_aaa')).not.toBeUndefined());

    // 原生 button + aria-expanded/aria-controls 是键盘可操作的基础，不在此断言读屏。
    const trigger = toggle('audit_aaa');
    expect(trigger.getAttribute('aria-label')).toBe(rowActionLabel('展开', entry('audit_aaa')));
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.type).toBe('button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await toggleRow('audit_aaa');
    const opened = panelOf('audit_aaa');
    expect(toggle('audit_aaa').getAttribute('aria-label')).toBe(
      rowActionLabel('收起', entry('audit_aaa')),
    );
    expect(toggle('audit_aaa').getAttribute('aria-expanded')).toBe('true');
    expect(detailValue(opened, '操作者')).toBe('admin');
    expect(detailValue(opened, '事件 ID')).toBe('audit_aaa');
    expect(detailValue(opened, '输入摘要')).toBe(DIGEST);
    expect(toggle('audit_bbb').getAttribute('aria-expanded')).toBe('false');
    expect(panelOf('audit_bbb')).not.toBe(opened);

    await toggleRow('audit_aaa');
    expect(toggle('audit_aaa').getAttribute('aria-label')).toBe(
      rowActionLabel('展开', entry('audit_aaa')),
    );
    expect(toggle('audit_aaa').getAttribute('aria-expanded')).toBe('false');
    expect(panelOf('audit_aaa').textContent).not.toContain(DIGEST);
  });

  it('shows a dash instead of inventing a digest when the event has none', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(page([entry('audit_login', { inputDigest: null })]));
    await mount();
    await waitFor(() => expect(toggle('audit_login')).not.toBeUndefined());

    await toggleRow('audit_login');
    const panel = panelOf('audit_login');
    expect(detailValue(panel, '操作者')).toBe('actor-audit_login');
    expect(detailValue(panel, '输入摘要')).toBe('—');
    expect(panel.textContent).not.toMatch(/[0-9a-f]{32}/);
  });

  it('keeps the open row bound to its id when filtering returns different data', async () => {
    vi.spyOn(api, 'audit').mockImplementation(async (query) =>
      query.action
        ? page([
            entry('audit_aaa', { actor: 'bob', inputDigest: 'feed'.repeat(8) }),
            entry('audit_zzz', { actor: 'carol', inputDigest: null }),
          ])
        : page([
            entry('audit_aaa', { actor: 'admin', inputDigest: DIGEST }),
            entry('audit_zzz', { actor: 'dave', inputDigest: null }),
          ]),
    );
    await mount();
    await waitFor(() => expect(toggle('audit_aaa')).not.toBeUndefined());
    await toggleRow('audit_aaa');
    expect(detailValue(panelOf('audit_aaa'), '操作者')).toBe('admin');

    await typeAction('auth.');
    // 防抖 300ms 后才换查询键；在 act 内推进真实定时器，避免更新落在 React 之外。
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    });
    expect(api.audit).toHaveBeenLastCalledWith({ action: 'auth.', limit: 100 }, expect.anything());
    await waitFor(() => expect(detailValue(panelOf('audit_aaa'), '操作者')).toBe('bob'));
    expect(detailValue(panelOf('audit_aaa'), '事件 ID')).toBe('audit_aaa');
    expect(detailValue(panelOf('audit_aaa'), '输入摘要')).toBe('feed'.repeat(8));
    expect(toggle('audit_zzz').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a newly appended page row with its own details', async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      entry(`e${index}`, index === 0 ? { actor: 'first-page', inputDigest: DIGEST } : {}),
    );
    vi.spyOn(api, 'audit').mockImplementation(async (query) =>
      query.beforeId === 'e99'
        ? page([entry('new_row', { actor: 'new-user', inputDigest: 'feed'.repeat(8) })])
        : page(first),
    );
    await mount();
    await waitFor(() => expect(toggle('e0')).not.toBeUndefined());
    await toggleRow('e0');
    expect(detailValue(panelOf('e0'), '操作者')).toBe('first-page');

    await act(async () => loadMore().click());
    await waitFor(() =>
      expect(api.audit).toHaveBeenLastCalledWith(
        { limit: 100, beforeId: 'e99' },
        expect.anything(),
      ),
    );
    await waitFor(() => expect(toggle('new_row')).not.toBeUndefined());

    await toggleRow('new_row');
    expect(detailValue(panelOf('new_row'), '操作者')).toBe('new-user');
    expect(detailValue(panelOf('new_row'), '事件 ID')).toBe('new_row');
    expect(detailValue(panelOf('new_row'), '输入摘要')).toBe('feed'.repeat(8));
    expect(panelOf('e0').textContent).not.toContain('first-page');
  });
});
