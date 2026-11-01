import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type RunListItem, type RunStatus } from '../src/lib/api.js';
import {
  formatCost,
  formatDuration,
  formatRelative,
  formatTokens,
  shortId,
} from '../src/lib/format.js';
import { RunsPage } from '../src/pages/runs.js';

const run: RunListItem = {
  id: 'run_01m5bv0faceh4v4jtw00eta1sn',
  agentId: 'agent-1',
  agentName: '专家',
  status: 'succeeded',
  startedAt: '2026-10-03T00:00:00.000Z',
  endedAt: '2026-10-03T00:00:01.000Z',
  latencyMs: 1000,
  costUsd: '0.01',
  turns: 2,
  inputTokens: 10,
  outputTokens: 20,
  error: '采集失败：连接超时',
};

const longError = [
  '工具调用失败：读取仓库文件时连接被上游重置。',
  '已重试 3 次，最后一次在 12.4s 后超时。',
  '根本原因：模型网关返回 502 Bad Gateway（trace gateway-timeout-17）。',
].join('\n');

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnMount: false, gcTime: Infinity },
    },
  });
  client.setQueryData(['agents'], []);
  client.setQueryData(['runs', null, null, 100], { items: [run] });
  vi.spyOn(api, 'runs').mockResolvedValue({ items: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

type TestRouter = ReturnType<typeof buildRouter>;

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const runs = createRoute({
    getParentRoute: () => shell,
    path: '/runs/',
    component: RunsPage,
    validateSearch: (search: Record<string, unknown>) => ({
      agent: typeof search.agent === 'string' ? search.agent : undefined,
      status: search.status as RunStatus | undefined,
      view: search.view === 'cards' ? 'cards' : search.view === 'table' ? 'table' : undefined,
    }),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([runs])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

async function mount(initialPath = '/runs'): Promise<TestRouter> {
  const router = buildRouter(initialPath);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  return router;
}

function cards(): Element | null {
  return host.querySelector('ul[aria-label="运行列表"]');
}

function table(): Element | null {
  return host.querySelector('table[aria-label="运行列表"]');
}

describe('run list view toggle', () => {
  it('defaults to the table and renders cards instead of rows when the URL asks for cards', async () => {
    const router = await mount();
    expect(table()).not.toBeNull();
    expect(cards()).toBeNull();

    await act(async () => {
      await router.navigate({ to: '/runs', search: { view: 'cards' } });
    });
    expect(cards()).not.toBeNull();
    expect(table()).toBeNull();
  });

  it('opens the card view from a view=cards URL with every run field', async () => {
    await mount('/runs?view=cards');

    expect(table()).toBeNull();
    const text = cards()?.textContent ?? '';
    expect(text).toContain('专家');
    expect(text).toContain('成功');
    expect(text).toContain(formatRelative(run.startedAt));
    expect(text).toContain(formatDuration(run.latencyMs));
    expect(text).toContain(formatCost(run.costUsd));
    expect(text).toContain(formatTokens(run.inputTokens));
    expect(text).toContain(formatTokens(run.outputTokens));
    expect(text).toContain(shortId(run.id));
    expect(text).toContain('运行 ID');
    expect(text).toContain('错误');
    expect(text).toContain('采集失败：连接超时');
    expect(
      cards()
        ?.querySelector(`a[aria-label="查看运行 ${shortId(run.id)}"]`)
        ?.getAttribute('href'),
    ).toBe(`/runs/${run.id}?fromView=cards`);
  });

  it('expands the full error text on click and keeps the row from navigating', async () => {
    client.setQueryData(['runs', null, null, 100], { items: [{ ...run, error: longError }] });
    const router = await mount();

    const expand = [...host.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === '展开全文',
    );
    if (!expand) throw new Error('Missing error expand button');
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    const cell = expand.parentElement;
    let errorText = cell?.querySelector('span');
    expect(errorText?.textContent).toBe(longError);
    expect(errorText?.className).toContain('whitespace-nowrap');

    await act(async () => expand.click());

    expect(expand.getAttribute('aria-expanded')).toBe('true');
    expect(expand.textContent?.trim()).toBe('收起');
    errorText = cell?.querySelector('span');
    expect(errorText?.textContent).toBe(longError);
    expect(errorText?.className).not.toContain('whitespace-nowrap');
    expect(errorText?.className).toContain('break-words');
    expect(router.state.location.pathname).toBe('/runs');
  });

  it('shows the full run error in the card without truncating it', async () => {
    client.setQueryData(['runs', null, null, 100], { items: [{ ...run, error: longError }] });
    await mount('/runs?view=cards');

    const card = cards();
    const error = card?.querySelector('p');
    expect(error?.textContent).toBe(longError);
    expect(error?.className).not.toContain('line-clamp');
    expect(card?.textContent).toContain('错误');
    expect(card?.textContent).toContain('运行 ID');
  });

  it('writes the chosen view into the URL when the toggle is clicked', async () => {
    const router = await mount();
    const toggle = [...host.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === '卡片',
    );
    if (!toggle) throw new Error('Missing card view toggle');

    await act(async () => toggle.click());
    await vi.waitFor(() => expect(cards()).not.toBeNull());
    expect(table()).toBeNull();
    expect(router.state.location.pathname).toBe('/runs');
    expect(router.state.location.search).toMatchObject({ view: 'cards' });
  });
});
