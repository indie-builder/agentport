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
import { api, type RunDetail, type RunListItem, type RunStatus } from '../src/lib/api.js';
import { RunDetailPage } from '../src/pages/run-detail.js';
import { RunsPage } from '../src/pages/runs.js';
import { runDetailSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const at = '2026-10-28T00:00:00Z';

const listItem: RunListItem = {
  id: 'run_1',
  agentId: 'agent-1',
  agentName: '专家',
  status: 'succeeded',
  startedAt: at,
  endedAt: at,
  latencyMs: 1000,
  costUsd: null,
  turns: 1,
  inputTokens: null,
  outputTokens: null,
  error: null,
};

const detail: RunDetail = {
  run: {
    id: 'run_1',
    agentId: 'agent-1',
    agentName: '专家',
    status: 'succeeded',
    startedAt: at,
    endedAt: at,
    latencyMs: 1000,
    turns: 1,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: null,
    conversationId: 'conv-1',
    sessionId: null,
    sandboxId: null,
    runtimeEnvironment: null,
  },
  steps: [
    { kind: 'user', at, text: '帮我部署' },
    { kind: 'assistant', at, text: '已完成' },
  ],
  conversation: { id: 'conv-1', agentId: 'agent-1', title: '会话标题' },
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createMemoryHistory>;

async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(path = '/runs') {
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
  const runDetail = createRoute({
    getParentRoute: () => shell,
    path: '/runs/$runId',
    component: RunDetailPage,
    validateSearch: runDetailSearchSchema,
  });
  const chat = createRoute({
    getParentRoute: () => shell,
    path: '/chat',
    component: () => createElement('h1', null, '对话'),
  });
  history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([runs, runDetail, chat])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'run').mockResolvedValue(detail);
  vi.spyOn(api, 'runApprovals').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'runQuestions').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'runs').mockResolvedValue({ items: [listItem] });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  client.setQueryData(['agents'], []);
  client.setQueryData(['runs', 'agent-a', 'failed', 100], { items: [listItem] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  history?.destroy();
  client.clear();
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('run detail navigation', () => {
  it('carries list filters into the detail and restores them on the way back', async () => {
    const router = await mount('/runs?agent=agent-a&status=failed');
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="打开 run_1"]');
    if (!open) throw new Error('Missing run row action');
    await act(async () => open.click());
    await act(async () => {
      await vi.waitFor(() => expect(router.state.location.pathname).toBe('/runs/run_1'));
    });
    expect(router.state.location.search).toEqual({
      fromAgent: 'agent-a',
      fromStatus: 'failed',
    });

    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain('会话标题'));
    });
    const back = host.querySelector<HTMLAnchorElement>('a[aria-label="返回运行列表"]');
    expect(back?.getAttribute('href')).toBe('/runs?agent=agent-a&status=failed');

    // 选中步骤只改 step，列表来源筛选仍在 URL 里。
    const steps = host.querySelectorAll<HTMLButtonElement>('ol button');
    await act(async () => steps[1]?.click());
    expect(router.state.location.search).toMatchObject({
      fromAgent: 'agent-a',
      fromStatus: 'failed',
      step: 1,
    });

    await act(async () => back?.click());
    await act(async () => {
      await vi.waitFor(() => expect(router.state.location.pathname).toBe('/runs'));
    });
    expect(router.state.location.search).toEqual({ agent: 'agent-a', status: 'failed' });
  });

  it('links the conversation title back to its chat with the real search contract', async () => {
    await mount('/runs/run_1?fromAgent=agent-a&fromStatus=failed');
    const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (anchor) => anchor.textContent?.trim() === '会话标题',
    );
    if (!link) throw new Error('Missing conversation link');
    const url = new URL(link.getAttribute('href') ?? '', 'http://localhost');
    expect(url.pathname).toBe('/chat');
    expect(url.searchParams.get('agent')).toBe('agent-1');
    expect(url.searchParams.get('conversation')).toBe('conv-1');
  });

  it('returns to the conversation even when it has no title', async () => {
    vi.mocked(api.run).mockResolvedValue({
      ...detail,
      conversation: { ...detail.conversation, title: '' },
    });
    await mount('/runs/run_1?fromAgent=agent-a');
    const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (anchor) => anchor.textContent?.trim() === '返回会话',
    );
    if (!link) throw new Error('Missing untitled conversation link');
    const url = new URL(link.getAttribute('href') ?? '', 'http://localhost');
    expect(url.pathname).toBe('/chat');
    expect(url.searchParams.get('agent')).toBe('agent-1');
    expect(url.searchParams.get('conversation')).toBe('conv-1');
  });
});
