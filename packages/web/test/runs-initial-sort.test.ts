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
import { RunsPage } from '../src/pages/runs.js';

function run(id: string, startedAt: string | null): RunListItem {
  return {
    id,
    agentId: 'agent-1',
    agentName: '专家',
    status: startedAt === null ? 'queued' : 'succeeded',
    startedAt,
    endedAt: startedAt,
    latencyMs: startedAt === null ? null : 1000,
    costUsd: '0.01',
    turns: 1,
    inputTokens: 10,
    outputTokens: 20,
    error: null,
  };
}

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

async function mount(): Promise<void> {
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

describe('run list initial sort', () => {
  it('shows the newest runs first and exposes that direction on the 开始 column', async () => {
    client.setQueryData(['runs', null, null, 100], {
      items: [
        run('run_old', '2026-10-01T00:00:00.000Z'),
        run('run_new', '2026-10-03T00:00:00.000Z'),
        run('run_queued', null),
      ],
    });
    vi.spyOn(api, 'runs').mockResolvedValue({ items: [] });
    await mount();

    const table = host.querySelector('table[aria-label="运行列表"]');
    const header = table?.querySelector('th[aria-sort]');
    expect(header?.getAttribute('aria-sort')).toBe('descending');
    expect(header?.textContent).toContain('开始');

    const ids = () =>
      [...(table?.querySelectorAll('tbody code') ?? [])].map(
        (code) => code.getAttribute('title') ?? '',
      );
    expect(ids()).toEqual(['run_new', 'run_old', 'run_queued']);

    const sort = host.querySelector<HTMLButtonElement>('button[aria-label="开始，按此列排序"]');
    if (!sort) throw new Error('Missing sort button');
    await act(async () => sort.click());
    expect(table?.querySelector('th[aria-sort]')?.getAttribute('aria-sort')).toBe('ascending');
    expect(ids()).toEqual(['run_old', 'run_new', 'run_queued']);
    expect(api.runs).not.toHaveBeenCalled();
  });
});
