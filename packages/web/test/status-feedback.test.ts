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
import type { HealthMetrics } from '../src/lib/api.js';
import { OverviewPage } from '../src/pages/overview.js';
import { operationsSearchSchema } from '../src/routes/-search.js';
import { allAccessMe } from './me-fixture.js';

const metrics: HealthMetrics = {
  process: { uptimeSeconds: 120, memoryRssBytes: 1024, bunVersion: '1.4.3' },
  queue: { waiting: 3, active: 1, completed: 0, failed: 0, delayed: 0, oldestWaitingMs: null },
  knowledgeQueue: null,
  db: { connected: true, pingMs: 2, maxConnections: 10 },
  redis: { pingMs: 2 },
};

const queueCounts = {
  waiting: 3,
  active: 1,
  completed: 0,
  failed: 0,
  delayed: 0,
  oldestWaitingMs: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let metricsFetches: Array<() => Promise<Response>> = [];
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let history: ReturnType<typeof createMemoryHistory> | undefined;

function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/health/metrics') {
      const next = metricsFetches.shift();
      if (!next) throw new Error(`unexpected metrics fetch #${metricsFetches.length}`);
      return next();
    }
    if (path === '/health/live') return json({ status: 'ok' });
    if (path === '/health/ready') return json({ status: 'ok', db: 'ok', redis: 'ok' });
    if (path === '/api/auth/me') return json(allAccessMe);
    if (path === '/api/overview') {
      return json({
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
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch);
}

async function mount() {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnWindowFocus: false, gcTime: Infinity },
    },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const operations = createRoute({
    getParentRoute: () => shell,
    path: '/operations',
    validateSearch: operationsSearchSchema,
    component: OverviewPage,
  });
  history = createMemoryHistory({ initialEntries: ['/operations?section=health'] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([operations])]),
    history,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
}

async function waitFor(assert: () => void) {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((element) =>
    element.textContent?.trim().startsWith(label),
  );
  if (!found) throw new Error(`missing button ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  metricsFetches = [];
  installFetch();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  history?.destroy();
  history = undefined;
  client?.clear();
  container?.remove();
  vi.restoreAllMocks();
});

describe('status metrics failure feedback', () => {
  it('shows unknown, not zeros or a made-up Redis outage, when the first metrics request fails over the network', async () => {
    metricsFetches = [() => Promise.reject(new TypeError('Failed to fetch'))];

    await mount();
    await waitFor(() => expect(container.textContent).toContain('指标读取失败'));

    expect(container.textContent).not.toContain('运行时长');
    expect(container.textContent).not.toContain('PONG');
    expect(container.textContent).not.toContain('BullMQ');
    expect(container.textContent).not.toContain('Ping 失败');
    expect(container.textContent).not.toContain('Redis 不可用');
    expect(container.textContent).not.toContain('指标刷新失败');

    const unknowns = [...container.querySelectorAll('[data-slot="badge"], span')].filter(
      (element) => element.textContent === '未知',
    );
    expect(unknowns.length).toBeGreaterThanOrEqual(4);
    expect(container.textContent).not.toContain('等待 0');
    expect(container.textContent).not.toContain('总数 0');
  });

  it('shares the queue judgment with the overview instead of ignoring failures or using another limit', async () => {
    const cases = [
      [{ failed: 2 }, '队列有 2 个历史失败记录'],
      [{ waiting: 11, active: 11 }, '队列积压：11 个等待'],
      [{ waiting: 20, active: 20 }, '队列积压：20 个等待'],
    ] as const;
    metricsFetches = [async () => json(metrics)];
    await mount();
    await waitFor(() => expect(container.textContent).toContain('1.4.3'));
    for (const [queue, message] of cases) {
      metricsFetches = [async () => json({ ...metrics, queue: { ...queueCounts, ...queue } })];
      await click('刷新');
      await waitFor(() => expect(container.textContent).toContain(message));
      const queueCard = [...container.querySelectorAll('[data-slot="card"]')].find(
        (card) => card.querySelector('h2')?.textContent === '队列 agent-runs',
      );
      expect(queueCard?.querySelector('[data-slot="badge"]')?.textContent).toBe('注意');
      expect(queueCard?.textContent).toContain(message);
    }
    expect(container.textContent).not.toContain('队列指标不可用');
  });

  it('keeps 10 waiting tasks below the shared backlog limit', async () => {
    metricsFetches = [
      async () => json({ ...metrics, queue: { ...queueCounts, waiting: 10, active: 10 } }),
    ];

    await mount();
    await waitFor(() => expect(container.textContent).toContain('1.4.3'));
    expect(container.textContent).not.toContain('队列积压');
    expect(container.textContent).not.toContain('注意');
  });

  it('reports a missing queue reading as unavailable instead of zeros', async () => {
    metricsFetches = [async () => json({ ...metrics, queue: null })];

    await mount();
    await waitFor(() => expect(container.textContent).toContain('队列指标不可用'));

    expect(container.textContent).toContain('BullMQ');
    expect(container.textContent).not.toContain('运行中0');
    expect(container.textContent).not.toContain('延迟0');
  });

  it('does not claim there is no consumer just because nothing is running', async () => {
    metricsFetches = [
      async () => json({ ...metrics, queue: { ...queueCounts, waiting: 3, active: 0 } }),
    ];

    await mount();
    await waitFor(() =>
      expect(container.textContent).toContain('有 3 个任务等待，当前没有运行中的任务'),
    );
    expect(container.textContent).toContain('检查 worker 是否存活');
  });

  it('keeps the last successful readings through a failed refresh, disables retry while pending, and clears the error after recovery', async () => {
    const retry = deferred<Response>();
    metricsFetches = [
      async () => json(metrics),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => retry.promise,
    ];

    await mount();
    await waitFor(() => expect(container.textContent).toContain('1.4.3'));
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('PONG');

    await click('刷新');
    await waitFor(() => expect(container.textContent).toContain('指标刷新失败'));
    expect(container.textContent).toContain('以下保留上次成功读取的指标。');
    expect(container.textContent).toContain('1.4.3');
    expect(container.textContent).toContain('PONG');
    expect(container.textContent).toContain('注意');
    expect(button('重试').disabled).toBe(false);

    await click('重试');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(button('重试').disabled).toBe(true);
    expect(container.textContent).toContain('1.4.3');
    expect(container.textContent).toContain('指标刷新失败');

    retry.resolve(
      json({ ...metrics, queue: { ...queueCounts, waiting: 4 }, redis: { pingMs: 5 } }),
    );
    await waitFor(() => expect(container.textContent).not.toContain('指标刷新失败'));
    expect(container.textContent).toContain('PONG');
    expect(container.textContent).not.toContain('注意');
    expect(container.textContent).not.toContain('未知');
  });
});
