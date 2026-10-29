import { type InfiniteData, QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import { api, type EvalRun, type EvalRunPage } from '../src/lib/api.js';
import { EvalPage } from '../src/pages/eval.js';
import { evalSearchSchema } from '../src/routes/-search.js';

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let history: ReturnType<typeof createBrowserHistory>;

const newest: EvalRun = {
  id: 'evalRun_newest',
  agentId: 'agent-a',
  status: 'succeeded',
  total: 11,
  passed: 1,
  error: null,
  createdAt: '2026-10-22T00:00:02Z',
  finishedAt: '2026-10-22T00:01:02Z',
};

const older: EvalRun = {
  id: 'evalRun_older',
  agentId: 'agent-a',
  status: 'succeeded',
  total: 22,
  passed: 2,
  error: null,
  createdAt: '2026-10-22T00:00:01Z',
  finishedAt: '2026-10-22T00:01:01Z',
};

type EvalRunsQuery = { agentId?: string; cursor?: string; limit?: number };

async function mount(
  responses: (EvalRunPage | Error)[] | ((query: EvalRunsQuery) => Promise<EvalRunPage>) = [
    { items: [newest], nextCursor: newest.id },
    { items: [older], nextCursor: null },
  ],
) {
  vi.spyOn(api, 'evalCases').mockResolvedValue([]);
  const evalRuns = vi.spyOn(api, 'evalRuns');
  if (typeof responses === 'function') {
    evalRuns.mockImplementation((query) => responses(query ?? {}));
  } else {
    for (const response of responses) {
      if (response instanceof Error) evalRuns.mockRejectedValueOnce(response);
      else evalRuns.mockResolvedValueOnce(response);
    }
  }
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  client.setQueryData(['agents'], [{ id: 'agent-a', name: 'Expert A' }]);

  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const evalRoute = createRoute({
    getParentRoute: () => shell,
    path: '/eval',
    validateSearch: evalSearchSchema,
    component: EvalPage,
  });
  window.history.replaceState(null, '', '/eval?agent=agent-a');
  history = createBrowserHistory();
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([evalRoute])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await actWaitFor(() => expect(container.textContent).toContain('1 / 11'));
  return { evalRuns };
}

async function actWaitFor(assert: () => void) {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].findLast(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client?.clear();
  history?.destroy();
  container.remove();
  vi.restoreAllMocks();
});

describe('evaluation run pagination', () => {
  it('loads older runs a cursor page at a time and stops at the end', async () => {
    const { evalRuns } = await mount();

    expect(evalRuns).toHaveBeenNthCalledWith(
      1,
      { agentId: 'agent-a', limit: 50 },
      expect.any(AbortSignal),
    );

    await act(async () => button('加载更多').click());
    await actWaitFor(() => expect(container.textContent).toContain('2 / 22'));
    expect(evalRuns).toHaveBeenNthCalledWith(
      2,
      { agentId: 'agent-a', limit: 50, cursor: newest.id },
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).not.toContain('加载更多');
    expect(container.textContent).toContain('已到末尾');
  });

  it('refetches loaded pages with the refreshed 50-item boundary cursor', async () => {
    const makeRun = (index: number): EvalRun => ({
      id: `evalRun_${String(index).padStart(3, '0')}`,
      agentId: 'agent-a',
      status: 'succeeded',
      total: 11,
      passed: 1,
      error: null,
      createdAt: new Date(Date.UTC(2026, 9, 22, 0, 0, index)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 9, 22, 0, 1, index)).toISOString(),
    });
    // 模拟服务端按 (createdAt, id) 倒序的游标分页，保留插入头部后的真实边界行为。
    const runs: EvalRun[] = Array.from({ length: 60 }, (_, index) => makeRun(index + 1));
    const servePage = async (query: EvalRunsQuery): Promise<EvalRunPage> => {
      const ordered = [...runs].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
      const start = query.cursor ? ordered.findIndex((run) => run.id === query.cursor) + 1 : 0;
      const items = ordered.slice(start, start + (query.limit ?? 50));
      const hasMore = start + items.length < ordered.length;
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    };

    const { evalRuns } = await mount(servePage);
    const cache = () =>
      client.getQueryData<InfiniteData<EvalRunPage>>(['eval-runs', 'agent-a', 50]);
    await actWaitFor(() => expect(cache()?.pages).toHaveLength(1));

    await act(async () => button('加载更多').click());
    await actWaitFor(() => expect(cache()?.pages).toHaveLength(2));
    expect(evalRuns).toHaveBeenNthCalledWith(
      2,
      { agentId: 'agent-a', limit: 50, cursor: 'evalRun_011' },
      expect.any(AbortSignal),
    );
    expect(cache()?.pages.map((page) => page.items.length)).toEqual([50, 10]);

    // 新 run 插到头部：第一页的 50 条边界后移，第二页必须用新边界重新取。
    runs.push(makeRun(61));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['eval-runs'] });
    });

    expect(evalRuns).toHaveBeenNthCalledWith(
      3,
      { agentId: 'agent-a', limit: 50 },
      expect.any(AbortSignal),
    );
    expect(evalRuns).toHaveBeenNthCalledWith(
      4,
      { agentId: 'agent-a', limit: 50, cursor: 'evalRun_012' },
      expect.any(AbortSignal),
    );

    const refreshed = cache();
    expect(refreshed?.pageParams).toEqual([null, 'evalRun_012']);
    expect(refreshed?.pages.map((page) => page.items.length)).toEqual([50, 11]);
    expect(refreshed?.pages.flatMap((page) => page.items.map((run) => run.id))).toEqual(
      Array.from({ length: 61 }, (_, index) => `evalRun_${String(61 - index).padStart(3, '0')}`),
    );
  });

  it('keeps loaded runs and retries the same cursor after a next page failure', async () => {
    const { evalRuns } = await mount([
      { items: [newest], nextCursor: newest.id },
      new Error('network down'),
      { items: [older], nextCursor: null },
    ]);

    await act(async () => button('加载更多').click());
    await actWaitFor(() => expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1));

    expect(container.textContent).toContain('1 / 11');
    expect(container.textContent).toContain('下一页加载失败，保留已加载的运行记录');
    expect(container.textContent).not.toContain('内容没有加载出来');

    await act(async () => button('重试').click());
    await actWaitFor(() => expect(container.textContent).toContain('2 / 22'));

    expect(evalRuns).toHaveBeenNthCalledWith(
      3,
      { agentId: 'agent-a', limit: 50, cursor: newest.id },
      expect.any(AbortSignal),
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.textContent).toContain('已到末尾');
  });
});
