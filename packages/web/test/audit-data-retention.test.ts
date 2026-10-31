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
import {
  type AgentAccess,
  api,
  type EvalRun,
  type OverviewTimeseriesPoint,
  type RunListItem,
  type RunStatus,
} from '../src/lib/api.js';
import { EvalPage } from '../src/pages/eval.js';
import { RunTrendCard } from '../src/pages/overview.js';
import { RunsPage } from '../src/pages/runs.js';
import { evalSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

function runItem(id: string, overrides: Partial<RunListItem> = {}): RunListItem {
  return {
    id,
    agentId: 'agent-1',
    agentName: '专家',
    status: 'succeeded',
    startedAt: '2026-10-22T00:00:00Z',
    endedAt: '2026-10-22T00:01:00Z',
    latencyMs: 1000,
    costUsd: '0.01',
    turns: 1,
    inputTokens: 10,
    outputTokens: 20,
    error: null,
    ...overrides,
  };
}

const trendPoints: OverviewTimeseriesPoint[] = [
  { date: '2026-10-27', runs: 3, failed: 1, costUsd: 0.1234, tokens: 1200 },
  { date: '2026-10-28', runs: 2, failed: 0, costUsd: 0.5, tokens: 300 },
];

function evalRun(id: string, overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id,
    agentId: 'agent-a',
    status: 'succeeded',
    total: 2,
    passed: 1,
    error: null,
    createdAt: '2026-10-22T00:00:00Z',
    finishedAt: '2026-10-22T00:01:00Z',
    ...overrides,
  };
}

const allEvalPermissions: AgentAccess = {
  agentId: 'agent-a',
  permissionIds: ['eval.read', 'eval.manage', 'eval.execute'],
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 320,
    height: 160,
    top: 0,
    left: 0,
    right: 320,
    bottom: 160,
    x: 0,
    y: 0,
    toJSON() {},
  } as DOMRect);
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnMount: false, gcTime: Infinity },
    },
  });
  client.setQueryData(['agents'], [{ id: 'agent-a', name: 'Expert A' }]);
  client.setQueryData(['agent-access', 'agent-a'], allEvalPermissions);
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
  vi.unstubAllGlobals();
});

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
}

function button(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].findLast(
      (element) =>
        element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
    ) ?? null
  );
}

async function click(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`Missing button: ${label}`);
  await act(async () => target.click());
}

function trigger(): HTMLButtonElement {
  const target = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('趋势数据'),
  );
  if (!target) throw new Error('Missing trend table trigger');
  return target;
}

async function actWaitFor(assert: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

function fill(id: string, value: string): void {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!input) throw new Error(`Missing field: ${id}`);
  const prototype =
    input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mountRuns(): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const runs = createRoute({
    getParentRoute: () => shell,
    path: '/runs/',
    component: RunsPage,
    validateSearch: (search: Record<string, unknown>) => ({
      agent: typeof search.agent === 'string' ? search.agent : undefined,
      status: search.status as RunStatus | undefined,
    }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([runs])]),
    history: createMemoryHistory({ initialEntries: ['/runs'] }),
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
}

async function mountEval(): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const evalRoute = createRoute({
    getParentRoute: () => shell,
    path: '/eval',
    validateSearch: evalSearchSchema,
    component: EvalPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([evalRoute])]),
    history: createMemoryHistory({ initialEntries: ['/eval?agent=agent-a'] }),
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
}

describe('run list keeps cached rows when a refetch fails', () => {
  it('keeps the loaded table and shows the real error with a retry', async () => {
    vi.spyOn(api, 'runs')
      .mockResolvedValueOnce({ items: [runItem('run_cached')] })
      .mockRejectedValueOnce(new Error('runs unavailable'))
      .mockResolvedValueOnce({ items: [runItem('run_cached'), runItem('run_recovered')] });

    await mountRuns();
    await actWaitFor(() => expect(host.querySelector('[title="run_cached"]')).not.toBeNull());

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['runs', null, null, 100] });
    });
    await actWaitFor(() => expect(host.textContent).toContain('runs unavailable'));

    expect(host.querySelector('table[aria-label="运行列表"]')).not.toBeNull();
    expect(host.querySelector('[title="run_cached"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button('重试')).not.toBeNull();

    await click('重试');
    await actWaitFor(() => expect(host.querySelector('[title="run_recovered"]')).not.toBeNull());
    expect(host.textContent).not.toContain('runs unavailable');
    expect(host.querySelector('[title="run_cached"]')).not.toBeNull();
  });

  it('keeps the loaded empty state instead of replacing it with an error', async () => {
    vi.spyOn(api, 'runs')
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new Error('runs unavailable'));

    await mountRuns();
    await actWaitFor(() => expect(host.textContent).toContain('还没有运行记录'));

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['runs', null, null, 100] });
    });
    await actWaitFor(() => expect(host.textContent).toContain('runs unavailable'));
    expect(host.textContent).toContain('还没有运行记录');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('uses the full error state only when no run data was ever loaded', async () => {
    vi.spyOn(api, 'runs').mockRejectedValue(new Error('runs unavailable'));

    await mountRuns();
    await actWaitFor(() => expect(host.textContent).toContain('runs unavailable'));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector('table[aria-label="运行列表"]')).toBeNull();
  });
});

describe('overview trend keeps cached data when a refetch fails', () => {
  it('keeps the chart and its data table while reporting the refresh error', async () => {
    vi.spyOn(api, 'overviewTimeseries')
      .mockResolvedValueOnce(trendPoints)
      .mockRejectedValueOnce(new Error('trend unavailable'))
      .mockResolvedValueOnce(trendPoints);

    await render(createElement(RunTrendCard, { days: 7 }));
    await actWaitFor(() =>
      expect(
        [...host.querySelectorAll('button')].some((item) => item.textContent?.includes('趋势数据')),
      ).toBe(true),
    );

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['overview', 'timeseries', 7] });
    });
    await actWaitFor(() => expect(host.textContent).toContain('trend unavailable'));

    expect(host.querySelector('[data-slot="chart"]')).not.toBeNull();
    expect(host.textContent).not.toContain('发起对话后生成趋势');
    expect(button('重试')).not.toBeNull();

    await act(async () => trigger().click());
    expect(host.querySelector('table caption')?.textContent).toBe('最近 7 天运行趋势明细');
    expect(host.querySelector('table')?.textContent).toContain('2026-10-27');

    await click('重试');
    await actWaitFor(() => expect(host.textContent).not.toContain('trend unavailable'));
    expect(host.querySelector('[data-slot="chart"]')).not.toBeNull();
    expect(host.querySelector('table')?.textContent).toContain('2026-10-27');
  });
});

describe('eval agent access states', () => {
  it('shows that permissions are still being checked instead of claiming none', async () => {
    vi.spyOn(api, 'evalCases').mockResolvedValue([]);
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'agentAccess').mockReturnValue(new Promise(() => {}));
    client.removeQueries({ queryKey: ['agent-access', 'agent-a'] });

    await mountEval();
    await actWaitFor(() => expect(host.textContent).toContain('正在检查评估权限，稍后再试'));

    expect(host.textContent).not.toContain('当前账户没有执行该专家评估的权限');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button('运行评估')).toBeNull();
    expect(button('新建用例')).toBeNull();
  });

  it('reports a real access error instead of claiming the account has no permission, then restores actions on retry', async () => {
    vi.spyOn(api, 'evalCases').mockResolvedValue([]);
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [], nextCursor: null });
    const access = vi
      .spyOn(api, 'agentAccess')
      .mockRejectedValueOnce(new Error('permission service down'))
      .mockResolvedValueOnce(allEvalPermissions);
    client.removeQueries({ queryKey: ['agent-access', 'agent-a'] });

    await mountEval();
    await actWaitFor(() => expect(host.textContent).toContain('permission service down'));

    expect(host.textContent).toContain('评估权限没有加载出来');
    expect(host.textContent).not.toContain('当前账户没有执行该专家评估的权限');
    expect(host.textContent).toContain('评估权限加载失败，请重试');
    expect(button('运行评估')).toBeNull();
    expect(button('新建用例')).toBeNull();
    expect(button('重试')).not.toBeNull();

    await click('重试');
    await actWaitFor(() => expect(button('运行评估')).not.toBeNull());
    expect(access).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('评估权限没有加载出来');
    expect(button('新建用例')).not.toBeNull();
  });

  it('hides write entry points in the empty case state without eval.manage', async () => {
    client.setQueryData(['agent-access', 'agent-a'], {
      agentId: 'agent-a',
      permissionIds: ['eval.read', 'eval.execute'],
    } satisfies AgentAccess);
    vi.spyOn(api, 'evalCases').mockResolvedValue([]);
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [], nextCursor: null });

    await mountEval();
    await actWaitFor(() => expect(host.textContent).toContain('还没有用例'));

    expect(button('新建用例')).toBeNull();
    expect(button('导入 JSON')).toBeNull();
    expect(button('导出 JSON')).not.toBeNull();
    expect(button('运行评估')).not.toBeNull();
  });

  it('keeps an open draft when a background access refresh fails', async () => {
    vi.spyOn(api, 'agentAccess').mockRejectedValue(new Error('access refresh failed'));
    vi.spyOn(api, 'evalCases').mockResolvedValue([]);
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [], nextCursor: null });

    await mountEval();
    await actWaitFor(() => expect(button('新建用例')).not.toBeNull());
    await click('新建用例');
    await actWaitFor(() => expect(document.getElementById('eval-name')).not.toBeNull());
    fill('eval-name', 'Draft kept');
    fill('eval-prompt', 'Draft prompt');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['agent-access', 'agent-a'] });
    });
    await actWaitFor(() => expect(document.body.textContent).toContain('access refresh failed'));

    expect(document.getElementById('eval-name')).not.toBeNull();
    expect((document.getElementById('eval-name') as HTMLInputElement).value).toBe('Draft kept');
    expect(button('新建用例')).not.toBeNull();
  });

  it('explains that comparison needs two finished runs', async () => {
    vi.spyOn(api, 'evalCases').mockResolvedValue([]);
    vi.spyOn(api, 'evalRuns').mockResolvedValue({
      items: [evalRun('evalRun_only1')],
      nextCursor: null,
    });

    await mountEval();
    await actWaitFor(() => expect(host.textContent).toContain('至少需要两次已结束的运行'));

    const compare = button('比较运行');
    expect(compare?.disabled).toBe(true);
    expect(compare?.title).toBe('至少需要两次已结束的运行');
  });
});
