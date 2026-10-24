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
  counts: { agents: 0, servers: 0, runs: 0, running: 0 },
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
      if (status === 'failed') expect(host.textContent).toContain('Retained execution failed');
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

  it('keeps retained history visible with the legacy overview fallback', async () => {
    client.setQueryData(['overview'], null);
    client.setQueryData(['runs', null, null, 50], { items: [retainedRun] });
    await mount();
    expect(host.querySelector('[title="run_retained"]')).not.toBeNull();
    expect(host.textContent).not.toContain('开始配置');
  });

  it.each(['pending', 'error'] as const)(
    'does not declare an empty platform while fallback history is %s',
    async (state) => {
      client.setQueryData(['overview'], null);
      client.removeQueries({ queryKey: ['runs'] });
      if (state === 'error') {
        client
          .getQueryCache()
          .build(client, { queryKey: ['runs', null, null, 50] })
          .setState({
            status: 'error',
            error: new Error('History unavailable'),
          });
      }
      await mount();
      expect(host.textContent).not.toContain('开始配置');
      expect(host.textContent).toContain('最近运行');
      if (state === 'error') expect(host.textContent).toContain('History unavailable');
    },
  );

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
