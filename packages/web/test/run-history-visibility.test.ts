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
import { api, type Overview, type RunListItem, type RunStatus } from '../src/lib/api.js';
import { OverviewPage } from '../src/pages/overview.js';
import { RunsPage } from '../src/pages/runs.js';

const retainedRun: RunListItem = {
  id: 'run_retained',
  agentId: 'deleted-agent',
  agentName: null,
  status: 'failed',
  startedAt: '2020-01-01T00:00:00Z',
  endedAt: '2020-01-01T00:00:01Z',
  latencyMs: 1000,
  costUsd: null,
  turns: 1,
  inputTokens: null,
  outputTokens: null,
  error: 'Retained execution failed',
};
const noConfiguration: Overview = {
  window: { days: 7, since: '2026-01-01T00:00:00Z' },
  counts: {
    agents: 0,
    servers: 0,
    runs: 0,
    running: 0,
    failed: 0,
    tokens: 0,
    costUsd: 0,
    avgLatencyMs: null,
  },
  recent: [],
  agents: [],
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'runs').mockImplementation(() => new Promise(() => {}));
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnMount: false, gcTime: Infinity },
    },
  });
  client.setQueryData(['agents'], []);
  client.setQueryData(['servers'], []);
  client.setQueryData(['health-metrics'], null);
  client.setQueryData(['runs', null, null, 50], { items: [] });
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

async function mount(path = '/') {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const overview = createRoute({ getParentRoute: () => shell, path: '/', component: OverviewPage });
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
    routeTree: rootRoute.addChildren([shell.addChildren([overview, runs])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  expect(host.querySelectorAll('h1')).toHaveLength(1);
}

describe('overview retained run history', () => {
  it.each(['failed', 'succeeded', 'queued'] as const)(
    'keeps %s history visible with no resources and zero runs in the statistics window',
    async (status) => {
      client.setQueryData(['overview'], {
        ...noConfiguration,
        recent: [
          { ...retainedRun, status, startedAt: status === 'queued' ? null : retainedRun.startedAt },
        ],
      } satisfies Overview);
      await mount();
      expect(host.querySelector('table[aria-label="最近运行"]')?.textContent).toContain('已删除');
      expect(host.querySelector('[title="run_retained"]')).not.toBeNull();
      expect(host.textContent).not.toContain('开始配置');
      if (status === 'failed') {
        // 失败运行仍可从「最近运行」的状态与错误标记辨认；详情入口在「需要处理」。
        expect(host.querySelector('table[aria-label="最近运行"]')?.textContent).toContain('失败');
        expect(host.querySelector('[title="Retained execution failed"]')).not.toBeNull();
      }
    },
  );

  it.each([
    { runs: 1, running: 0 },
    { runs: 0, running: 1 },
  ])('does not claim a new platform when aggregate execution counts exist: %j', async (counts) => {
    client.setQueryData(['overview'], {
      ...noConfiguration,
      counts: { ...noConfiguration.counts, ...counts },
    } satisfies Overview);
    await mount();
    expect(host.textContent).not.toContain('开始配置');
    expect(host.querySelector('a[href="/runs"]')?.textContent).toBe('查看运行');
  });

  it('shows onboarding when no resources or executions exist', async () => {
    client.setQueryData(['overview'], noConfiguration);
    await mount();
    expect(host.textContent).toContain('开始配置');
    expect(host.querySelector('a[href="/servers"]')).not.toBeNull();
  });

  it('renders the real failure instead of inferring statistics from list endpoints', async () => {
    client
      .getQueryCache()
      .build(client, { queryKey: ['overview'] })
      .setState({ status: 'error', error: new Error('Overview unavailable') });
    await mount();
    expect(host.textContent).toContain('Overview unavailable');
    expect(host.textContent).not.toContain('开始配置');
    expect(host.querySelector('table[aria-label="最近运行"]')).toBeNull();
  });

  it('reports loading without declaring an empty platform', async () => {
    client.removeQueries({ queryKey: ['overview'] });
    await mount();
    expect(host.textContent).not.toContain('开始配置');
    expect(host.querySelector('[aria-label="加载中"]')).not.toBeNull();
  });

  it('never fetches the list endpoints the overview already aggregates', async () => {
    const servers = vi.spyOn(api, 'servers').mockResolvedValue([]);
    const agents = vi.spyOn(api, 'agents').mockResolvedValue([]);
    const runs = vi.spyOn(api, 'runs').mockResolvedValue({ items: [] });
    // 清掉预置缓存：页面若仍在请求列表接口，spy 会收到调用，而不是命中缓存。
    client.removeQueries({ queryKey: ['servers'] });
    client.removeQueries({ queryKey: ['agents'] });
    client.removeQueries({ queryKey: ['runs'] });
    client.setQueryData(['overview'], {
      ...noConfiguration,
      counts: { ...noConfiguration.counts, agents: 1 },
    } satisfies Overview);
    await mount();
    expect(servers).not.toHaveBeenCalled();
    expect(agents).not.toHaveBeenCalled();
    expect(runs).not.toHaveBeenCalled();
  });

  it('uses a truthful run destination label when configured', async () => {
    client.setQueryData(['overview'], {
      ...noConfiguration,
      counts: { ...noConfiguration.counts, agents: 1 },
    } satisfies Overview);
    await mount();
    expect(host.querySelector('a[href="/runs"]')?.textContent).toBe('查看运行');
    expect(host.textContent).not.toContain('查看全部');
  });
});

describe('run list scope disclosure', () => {
  it.each([
    { path: '/runs', agent: null, status: null, scope: '最近 100 条运行' },
    {
      path: '/runs?status=failed',
      agent: null,
      status: 'failed',
      scope: '符合筛选条件的最近 100 条运行',
    },
    {
      path: '/runs?agent=deleted-agent&status=failed',
      agent: 'deleted-agent',
      status: 'failed',
      scope: '符合筛选条件的最近 100 条运行',
    },
  ])(
    'discloses the returned subset and sorts only its rows: $path',
    async ({ path, agent, status, scope }) => {
      const items = Array.from({ length: 100 }, (_, index) => ({
        ...retainedRun,
        id: `run_${index}`,
        latencyMs: index + 1,
      }));
      client.setQueryData(['runs', agent, status, 100], { items });
      await mount(path);
      expect(host.textContent).toContain(scope);
      expect(host.textContent).toContain('排序仅作用于当前显示的记录');
      const table = host.querySelector('table[aria-label="运行列表"]');
      expect(table?.querySelectorAll('tbody tr')).toHaveLength(100);
      expect(table?.querySelector('tbody code')?.getAttribute('title')).toBe('run_0');
      const sort = host.querySelector<HTMLButtonElement>('button[aria-label="耗时，按此列排序"]');
      expect(sort).not.toBeNull();
      await act(async () => sort?.click());
      expect(table?.querySelector('tbody code')?.getAttribute('title')).toBe('run_99');
      expect(table?.querySelector('th[aria-sort="descending"]')?.textContent).toContain('耗时');
      expect(table?.querySelectorAll('tbody tr')).toHaveLength(100);
      expect(api.runs).not.toHaveBeenCalled();
    },
  );
});
