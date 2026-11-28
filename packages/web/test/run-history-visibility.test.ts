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
import { RunsPage } from '../src/pages/runs/index.js';
import { allAccessMe } from './me-fixture.js';

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
      queries: {
        retry: false,
        retryOnMount: false,
        refetchOnMount: false,
        staleTime: Infinity,
        gcTime: Infinity,
      },
    },
  });
  client.setQueryData(['me'], allAccessMe);
  client.setQueryData(['agents'], { items: [], truncated: false });
  client.setQueryData(['servers'], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['health-metrics'], null);
  client.setQueryData(['overview', 'timeseries', 7], []);
  client.setQueryData(['attention'], { approvals: [], failedRuns: [], total: 0 });
  client.setQueryData(['runs', null, null, null, null, 50], {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
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

async function mount(path = '/operations') {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const overview = createRoute({
    getParentRoute: () => shell,
    path: '/operations',
    component: OverviewPage,
  });
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
  it.each([true, false])(
    'renders aggregated expert metrics without duplicating recent run rows (canReadAgents=%s)',
    async (canReadAgents) => {
      client.setQueryData(
        ['me'],
        canReadAgents
          ? allAccessMe
          : {
              ...allAccessMe,
              grants: allAccessMe.grants.filter((grant) => grant.permissionId !== 'agents.read'),
            },
      );
      client.setQueryData(['overview'], {
        ...noConfiguration,
        recent: [retainedRun],
        agents: [
          {
            agentId: 'agt_retained',
            name: '巡检专家',
            slug: 'inspector',
            createdAt: '2026-01-01T00:00:00Z',
            enabled: true,
            lastRunStartTime: '2026-01-02T00:00:00Z',
            runCount: 3,
            totalCost: 0.12,
            errorRate: 0,
            latencyP50: 400,
            latencyP99: 900,
            totalTokens: 1200,
          },
        ],
      } satisfies Overview);
      await mount();
      expect(host.textContent).toContain('专家运行');
      expect(host.querySelector('table[aria-label="最近运行"]')).toBeNull();
      const metricsTable = host.querySelector('table[aria-label="专家指标"]');
      expect(metricsTable?.textContent).toContain('巡检专家');
      expect(Boolean(host.querySelector('a[href="/agents/agt_retained"]'))).toBe(canReadAgents);
      expect(Boolean(host.querySelector('a[href="/agents"]'))).toBe(canReadAgents);
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
    expect(host.textContent).not.toContain('还没有运行数据');
    expect(host.textContent).toContain('专家运行');
    expect(host.querySelector('table[aria-label="最近运行"]')).toBeNull();
  });

  it('shows empty state when no resources or executions exist', async () => {
    client.setQueryData(['overview'], noConfiguration);
    await mount();
    expect(host.textContent).toContain('还没有运行数据');
    expect(host.querySelector('a[href="/agents"]')).not.toBeNull();
    expect(host.querySelector('a[href="/chat"]')).not.toBeNull();
  });

  it('renders the real failure instead of inferring statistics from list endpoints', async () => {
    client
      .getQueryCache()
      .build(client, { queryKey: ['overview'] })
      .setState({ status: 'error', error: new Error('Overview unavailable') });
    await mount();
    expect(host.textContent).toContain('Overview unavailable');
    expect(host.textContent).not.toContain('还没有运行数据');
    expect(host.querySelector('table[aria-label="专家指标"]')).toBeNull();
  });

  it('reports loading without declaring an empty platform', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    client.removeQueries({ queryKey: ['overview'] });
    await mount();
    expect(host.textContent).not.toContain('还没有运行数据');
    expect(host.querySelector('[aria-label="加载中"]')).not.toBeNull();
  });

  it('never fetches the list endpoints the overview already aggregates', async () => {
    const servers = vi.spyOn(api, 'servers').mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    const agents = vi.spyOn(api, 'agentReference').mockResolvedValue({
      items: [],
      truncated: false,
    });
    const runs = vi.spyOn(api, 'runs').mockResolvedValue({ items: [], nextCursor: null });
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

  it('uses a truthful expert management destination when configured', async () => {
    client.setQueryData(['overview'], {
      ...noConfiguration,
      counts: { ...noConfiguration.counts, agents: 1 },
    } satisfies Overview);
    await mount();
    expect(host.textContent).toContain('专家运行');
    expect(host.querySelector('a[href="/agents"]')?.textContent).toBe('管理专家');
    expect(host.querySelector('table[aria-label="最近运行"]')).toBeNull();
  });
});

describe('run list scope disclosure', () => {
  it.each([
    { path: '/runs?view=table', agent: null, status: null, scope: '共 100 条运行' },
    {
      path: '/runs?status=failed&view=table',
      agent: null,
      status: 'failed',
      scope: '共 100 条运行',
    },
    {
      path: '/runs?agent=deleted-agent&status=failed&view=table',
      agent: 'deleted-agent',
      status: 'failed',
      scope: '共 100 条运行',
    },
  ])(
    'discloses the returned subset and sorts only its rows: $path',
    async ({ path, agent, status, scope }) => {
      const items = Array.from({ length: 100 }, (_, index) => ({
        ...retainedRun,
        id: `run_${index}`,
        latencyMs: index + 1,
      }));
      client.setQueryData(['runs', agent, status, null, null, 50], {
        pages: [{ items, nextCursor: null }],
        pageParams: [undefined],
      });
      await mount(path);
      expect(host.textContent).toContain(scope);
      expect(host.textContent).toContain('排序仅作用于当前显示');
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
