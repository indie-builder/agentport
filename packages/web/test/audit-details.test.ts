import { Blob as NodeBlob } from 'node:buffer';
import { utcWindowStart } from '@agentport/shared';
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
import { downloadBlob, downloadJson } from '../src/lib/browser-files.js';
import { formatDateTime } from '../src/lib/format.js';
import { toastError, toastPromise, toastSuccess } from '../src/lib/toast.js';
import { AuditPage } from '../src/pages/audit.js';
import { auditSearchSchema } from '../src/routes/-search.js';

const toastMocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastPromise: vi.fn(
    async <Value>(
      promise: Promise<Value> | (() => Promise<Value>),
      messages: {
        loading: string;
        success?: string | ((value: Value) => string);
      },
    ) => {
      try {
        const value = await (typeof promise === 'function' ? promise() : promise);
        const message =
          typeof messages.success === 'function' ? messages.success(value) : messages.success;
        if (typeof message === 'string') toastMocks.toastSuccess(message);
        return value;
      } catch (error) {
        toastMocks.toastError(error);
        throw error;
      }
    },
  ),
}));

vi.mock('../src/lib/browser-files.js', () => ({ downloadJson: vi.fn(), downloadBlob: vi.fn() }));
vi.mock('../src/lib/toast.js', () => toastMocks);

const DIGEST = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function entry(id: string, patch: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id,
    actor: `actor-${id}`,
    actorKind: 'user',
    subjectBusinessId: null,
    action: 'agent.create',
    target: null,
    status: 'ok',
    durationMs: null,
    requestId: null,
    inputDigest: null,
    detail: null,
    detailType: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function page(items: AuditEntry[], nextCursor: string | null = null): AuditList {
  return { items, nextCursor };
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

function rowButton(actor: string): HTMLButtonElement {
  const row = [...container.querySelectorAll('tbody tr')].find(
    (tr) => tr.querySelector(`span[title="${actor}"]`) !== null,
  );
  const found = row?.querySelector<HTMLButtonElement>('button[data-row]');
  if (!found) throw new Error(`missing row trigger for ${actor}`);
  return found;
}

function rowActionLabel(row: AuditEntry): string {
  return `打开 ${row.action}${row.target ? ` ${row.target}` : ''} · ${formatDateTime(row.createdAt)}`;
}

async function openRow(actor: string): Promise<void> {
  await act(async () => rowButton(actor).click());
  await flush();
}

function inspectorSheet(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function requireInspector(): HTMLElement {
  const sheet = inspectorSheet();
  if (!sheet) throw new Error('missing inspector sheet');
  return sheet;
}

async function closeInspector(): Promise<void> {
  const sheet = requireInspector();
  const close = [...sheet.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.getAttribute('aria-label') === '关闭',
  );
  if (!close) throw new Error('missing close button');
  await act(async () => close.click());
  await flush();
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

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text,
  );
  if (!found) throw new Error(`missing button ${text}`);
  return found;
}

async function openMoreMenu(): Promise<void> {
  const trigger = button('更多操作');
  if (trigger.getAttribute('aria-expanded') === 'true') return;
  await act(async () => trigger.click());
  await flush();
}

function menuItem(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent?.trim() === text,
  );
  if (!found) throw new Error(`missing menuitem ${text}`);
  return found;
}

async function clickMoreAction(text: string): Promise<void> {
  await openMoreMenu();
  await act(async () => menuItem(text).click());
  await flush();
}

beforeEach(() => {
  vi.mocked(downloadBlob).mockClear();
  vi.mocked(downloadJson).mockClear();
  vi.mocked(toastError).mockClear();
  vi.mocked(toastPromise).mockClear();
  vi.mocked(toastSuccess).mockClear();
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
  vi.unstubAllGlobals();
});

describe('audit CSV export', () => {
  it('downloads a BOM-prefixed CSV using the same data and filters as JSON export', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const row = entry('exported', {
      action: 'agent.update',
      target: 'agent:123',
      status: 'denied',
      actor: 'alice',
      actorKind: 'service',
      durationMs: 42,
      requestId: 'req-123',
      detail: { from: 'allow', to: 'ask' },
      detailType: 'object',
    });
    const data = {
      format: 'agentport/audit@1' as const,
      exportedAt: '2026-01-02T00:00:00.000Z',
      items: [{ ...row, detail: { from: 'allow', to: null } }],
    };
    vi.spyOn(api, 'audit').mockResolvedValue(page([]));
    vi.spyOn(api, 'exportAudit').mockResolvedValue(data);
    await mount(
      '?action=agent.&target=agent:123&actor=alice&status=denied&actorKind=service&range=7',
    );

    await clickMoreAction('导出 CSV');
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(api.exportAudit).toHaveBeenLastCalledWith({
      action: 'agent.',
      target: 'agent:123',
      actor: 'alice',
      status: 'denied',
      actorKind: 'service',
      since: utcWindowStart(7).toISOString(),
    });
    const download = vi.mocked(downloadBlob).mock.calls[0];
    if (!download) throw new Error('missing CSV download');
    const [blob, filename] = download;
    expect(filename).toBe('audit.csv');
    expect(blob.type).toBe('text/csv;charset=utf-8');
    expect(await blob.text()).toContain(
      `时间,动作,目标,状态,操作者,主体类型,耗时ms,请求ID,变更明细\n${formatDateTime(row.createdAt)},agent.update,agent:123,拒绝,alice,服务,42,req-123,from=allow; to=`,
    );
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 3)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf]),
    );
    await clickMoreAction('导出审计 (JSON)');
    expect(api.exportAudit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.exportAudit).mock.calls[1]).toEqual(
      vi.mocked(api.exportAudit).mock.calls[0],
    );
    expect(downloadJson).toHaveBeenCalledWith(data, 'audit.json');
  });

  it('disables CSV export until the edited filter has settled', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(page([]));
    vi.spyOn(api, 'exportAudit').mockResolvedValue({
      format: 'agentport/audit@1',
      exportedAt: '2026-01-02T00:00:00.000Z',
      items: [],
    });
    await mount();
    await typeAction('auth.');
    await openMoreMenu();
    const pendingItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
      (node) => node.textContent?.trim() === '等待筛选…',
    );
    expect(pendingItems).toHaveLength(2);
    const csvItem = pendingItems[1] as HTMLElement;
    expect(csvItem.getAttribute('aria-disabled')).toBe('true');
    await act(async () => csvItem.click());
    expect(api.exportAudit).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    });
    const readyCsv = menuItem('导出 CSV');
    expect(readyCsv.getAttribute('aria-disabled')).toBeNull();
    await act(async () => readyCsv.click());
    expect(api.exportAudit).toHaveBeenCalledWith({ action: 'auth.' });
  });
});

describe('audit time range', () => {
  it('queries the seven-day UTC window from the URL', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(page([entry('a')]));
    await mount('?range=7');

    await waitFor(() =>
      expect(api.audit).toHaveBeenLastCalledWith(
        expect.objectContaining({ since: utcWindowStart(7).toISOString() }),
        expect.anything(),
      ),
    );
  });
});

describe('audit integrity verification', () => {
  it('reports a complete chain and starts without a cursor', async () => {
    vi.spyOn(api, 'verifyAudit').mockResolvedValue({
      ok: true,
      checked: 12,
      brokenSeq: null,
      nextAfterSeq: null,
      complete: true,
    });
    vi.spyOn(api, 'audit').mockResolvedValue(page([entry('a')]));
    await mount();

    await clickMoreAction('校验完整性');
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('审计链完整，已校验 12 条记录'));
    expect(api.verifyAudit).toHaveBeenCalledWith({ limit: 5000 });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('reports the broken sequence without a success notification', async () => {
    vi.spyOn(api, 'verifyAudit').mockResolvedValue({
      ok: false,
      checked: 5,
      brokenSeq: '42',
      nextAfterSeq: null,
      complete: false,
    });
    vi.spyOn(api, 'audit').mockResolvedValue(page([entry('a')]));
    await mount();

    await clickMoreAction('校验完整性');
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.objectContaining({ message: '审计链校验失败：seq 42 处断链（已校验 5 条）' }),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('follows the returned cursor and totals the checked records across pages', async () => {
    vi.spyOn(api, 'verifyAudit')
      .mockResolvedValueOnce({
        ok: true,
        checked: 5000,
        brokenSeq: null,
        nextAfterSeq: 100,
        complete: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        checked: 10,
        brokenSeq: null,
        nextAfterSeq: null,
        complete: true,
      });
    vi.spyOn(api, 'audit').mockResolvedValue(page([entry('a')]));
    await mount();

    await clickMoreAction('校验完整性');
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('审计链完整，已校验 5010 条记录'),
    );
    expect(api.verifyAudit).toHaveBeenCalledTimes(2);
    expect(api.verifyAudit).toHaveBeenNthCalledWith(2, { limit: 5000, afterSeq: 100 });
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('audit row details', () => {
  it('opens exactly the requested row with actor, full event id and input digest, and closes again', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(
      page([
        entry('audit_aaa', { actor: 'admin', inputDigest: DIGEST }),
        entry('audit_bbb', { actor: 'alice', inputDigest: null }),
      ]),
    );
    await mount();
    await waitFor(() => expect(rowButton('admin')).not.toBeUndefined());

    const trigger = rowButton('admin');
    expect(trigger.getAttribute('aria-label')).toBe(rowActionLabel(entry('audit_aaa')));
    expect(inspectorSheet()).toBeNull();

    await openRow('admin');
    const opened = requireInspector();
    expect(detailValue(opened, '操作者')).toBe('admin');
    expect(detailValue(opened, '主体类型')).toBe('用户');
    expect(detailValue(opened, '事件 ID')).toBe('audit_aaa');
    expect(detailValue(opened, '输入摘要')).toBe(DIGEST);

    await closeInspector();
    await waitFor(() => expect(inspectorSheet()).toBeNull());
  });

  it('shows a dash instead of inventing a digest when the event has none', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(page([entry('audit_login', { inputDigest: null })]));
    await mount();
    await waitFor(() => expect(rowButton('actor-audit_login')).not.toBeUndefined());

    await openRow('actor-audit_login');
    const panel = requireInspector();
    expect(detailValue(panel, '操作者')).toBe('actor-audit_login');
    expect(detailValue(panel, '输入摘要')).toBe('—');
    expect(panel.textContent).not.toMatch(/[0-9a-f]{32}/);
  });

  it('shows the recorded change detail with readable labels', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(
      page([
        entry('audit_change', {
          action: 'server.tool.approval_mode.changed',
          detail: {
            to: 'ask',
            from: 'allow',
            toolName: 'github',
            toolId: 'tool_x',
            constructor: 'x',
          },
          detailType: 'object',
        }),
      ]),
    );
    await mount();
    await waitFor(() => expect(rowButton('actor-audit_change')).not.toBeUndefined());

    await openRow('actor-audit_change');
    const panel = requireInspector();
    expect(detailValue(panel, '工具')).toBe('github');
    expect(detailValue(panel, '工具 ID')).toBe('tool_x');
    expect(detailValue(panel, '变更前')).toBe('allow');
    expect(detailValue(panel, '变更后')).toBe('ask');
    expect(detailValue(panel, 'constructor')).toBe('x');
    const labels = [...panel.querySelectorAll('dt')].map((node) => node.textContent);
    expect(labels.indexOf('变更前')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('变更前')).toBeLessThan(labels.indexOf('变更后'));
  });

  it('shows a dash for a null detail value', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(
      page([
        entry('audit_null', {
          action: 'security.tool_policy.deleted',
          detail: { policyId: 'tap_x', to: null },
          detailType: 'object',
        }),
      ]),
    );
    await mount();
    await waitFor(() => expect(rowButton('actor-audit_null')).not.toBeUndefined());
    await openRow('actor-audit_null');
    const panel = requireInspector();
    expect(detailValue(panel, 'policyId')).toBe('tap_x');
    expect(detailValue(panel, '变更后')).toBe('—');
  });

  it('adds no detail rows when the event has none', async () => {
    vi.spyOn(api, 'audit').mockResolvedValue(page([entry('audit_plain', { detail: null })]));
    await mount();
    await waitFor(() => expect(rowButton('actor-audit_plain')).not.toBeUndefined());

    await openRow('actor-audit_plain');
    const panel = requireInspector();
    const labels = [...panel.querySelectorAll('dt')].map((node) => node.textContent);
    expect(labels).toEqual([
      '操作者',
      '主体类型',
      '目标',
      '耗时',
      '事件 ID',
      '请求 ID',
      '输入摘要',
    ]);
    expect(panel.textContent).not.toContain('变更明细');
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
    await waitFor(() => expect(rowButton('admin')).not.toBeUndefined());
    await openRow('admin');
    expect(detailValue(requireInspector(), '操作者')).toBe('admin');

    await typeAction('auth.');
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    });
    expect(api.audit).toHaveBeenLastCalledWith({ action: 'auth.', limit: 100 }, expect.anything());
    await waitFor(() => expect(detailValue(requireInspector(), '操作者')).toBe('bob'));
    expect(detailValue(requireInspector(), '事件 ID')).toBe('audit_aaa');
    expect(detailValue(requireInspector(), '输入摘要')).toBe('feed'.repeat(8));
  });

  it('opens a newly appended page row with its own details', async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      entry(`e${index}`, index === 0 ? { actor: 'first-page', inputDigest: DIGEST } : {}),
    );
    vi.spyOn(api, 'audit').mockImplementation(async (query) =>
      query.cursor === 'e99'
        ? page([entry('new_row', { actor: 'new-user', inputDigest: 'feed'.repeat(8) })])
        : page(first, 'e99'),
    );
    await mount();
    await waitFor(() => expect(rowButton('first-page')).not.toBeUndefined());
    await openRow('first-page');
    expect(detailValue(requireInspector(), '操作者')).toBe('first-page');
    await closeInspector();

    await act(async () => loadMore().click());
    await waitFor(() =>
      expect(api.audit).toHaveBeenLastCalledWith({ limit: 100, cursor: 'e99' }, expect.anything()),
    );
    await waitFor(() => expect(rowButton('new-user')).not.toBeUndefined());

    await openRow('new-user');
    const panel = requireInspector();
    expect(detailValue(panel, '操作者')).toBe('new-user');
    expect(detailValue(panel, '事件 ID')).toBe('new_row');
    expect(detailValue(panel, '输入摘要')).toBe('feed'.repeat(8));
    expect(panel.textContent).not.toContain('first-page');
  });
});
