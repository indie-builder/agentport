import type { AuthMe, PermissionId, PersonalRun } from '@agentport/shared';
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
import { api } from '../src/lib/api.js';
import { shortId } from '../src/lib/format.js';
import { PersonalUsagePage } from '../src/pages/personal-usage.js';
import { personalUsageSearchSchema } from '../src/routes/-search.js';

function meWith(permissionIds: PermissionId[]): AuthMe {
  return {
    authenticated: true,
    user: { businessId: 'user-1', username: 'tester', name: '测试用户' },
    roles: [],
    grants: permissionIds.map((permissionId) => ({ permissionId, scope: 'own_data' })),
  };
}

const chatRun: PersonalRun = {
  id: 'run_chat',
  agentId: 'agent-a',
  agentName: '专家甲',
  status: 'succeeded',
  startedAt: '2026-10-30T09:00:00.000Z',
  endedAt: '2026-10-30T09:01:00.000Z',
  latencyMs: 60_000,
  costUsd: '0.1000',
  turns: 3,
  inputTokens: 1000,
  outputTokens: 200,
  error: null,
  trigger: 'chat',
  createdAt: '2026-10-30T09:00:00.000Z',
  conversationId: 'conv-1',
};

const reviewRun: PersonalRun = {
  ...chatRun,
  id: 'run_review',
  agentName: '专家乙',
  status: 'failed',
  trigger: 'review',
  startedAt: '2026-10-30T10:00:00.000Z',
  conversationId: null,
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createRouter>;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(path: string, me: AuthMe): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const page = createRoute({
    getParentRoute: () => shell,
    path: '/personal/usage',
    component: PersonalUsagePage,
    validateSearch: personalUsageSearchSchema,
  });
  const stubs = ['/login', '/chat', '/personal/reviews', '/runs/$runId'].map((stubPath) =>
    createRoute({
      getParentRoute: () => shell,
      path: stubPath,
      component: () => createElement('h1', null, `stub ${stubPath}`),
    }),
  );
  router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page, ...stubs])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  client.setQueryData(['me'], me);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

function rows(): HTMLTableRowElement[] {
  // 展开详情会为每行多渲染一个面板行；只取带行操作按钮的数据行。
  return [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')].filter((row) =>
    row.querySelector('button[data-row]'),
  );
}

function headers(): string[] {
  return [...host.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim() ?? '');
}

function button(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function maybeButton(label: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
    ) ?? null
  );
}

function link(row: Element, label: string): HTMLAnchorElement {
  const match = [...row.querySelectorAll<HTMLAnchorElement>('a')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing link: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.history.replaceState(null, '', '/');
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('使用记录的任务视角', () => {
  it('先显示专家、来源、状态与时间，运行 ID 收进展开详情', async () => {
    const me = meWith(['runs.read', 'conversations.read', 'personal_memory.read']);
    vi.spyOn(api, 'personalRuns').mockResolvedValue({
      items: [chatRun, reviewRun],
      nextCursor: null,
    });
    await mount('/personal/usage', me);
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    // 末尾空表头是列设置操作列。
    expect(headers()).toEqual(['专家', '来源', '状态', '时间', '去向', '']);

    const first = rows()[0];
    if (!first) throw new Error('Missing first run row');
    const firstCell = first.children[0];
    expect(firstCell?.textContent?.trim()).toBe('专家甲');
    expect(first.textContent).not.toContain('run_chat');
    expect(first.textContent).toContain('对话');
    expect(first.textContent).toContain('成功');

    await click(button('展开 run_chat'));
    const runId = host.querySelector('[title="run_chat"]');
    expect(runId?.textContent).toBe(shortId('run_chat'));

    const second = rows()[1];
    if (!second) throw new Error('Missing second run row');
    expect(second.textContent).toContain('专家乙');
    expect(second.textContent).toContain('记忆提案');
    expect(second.textContent).toContain('失败');
  });

  it('耗时、成本与 Token 只在展开详情里出现，主表保持任务列', async () => {
    const me = meWith(['runs.read', 'conversations.read']);
    vi.spyOn(api, 'personalRuns').mockResolvedValue({
      items: [chatRun],
      nextCursor: null,
    });
    await mount('/personal/usage', me);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    expect(host.textContent).not.toContain('60.0 s');
    expect(host.textContent).not.toContain('$0.1000');
    expect(host.textContent).not.toContain('1.0k / 200');

    await click(button('展开 run_chat'));
    await vi.waitFor(() => expect(host.textContent).toContain('60.0 s'));
    expect(host.textContent).toContain('$0.1000');
    expect(host.textContent).toContain('1.0k / 200');
  });

  it('按来源和权限给出明确的落点链接', async () => {
    const me = meWith(['runs.read', 'conversations.read', 'personal_memory.read']);
    vi.spyOn(api, 'personalRuns').mockResolvedValue({
      items: [chatRun, reviewRun],
      nextCursor: null,
    });
    await mount('/personal/usage', me);
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    const [chat, review] = rows();
    if (!chat || !review) throw new Error('Missing run rows');
    expect(link(chat, '回到对话').getAttribute('href')).toBe(
      '/chat?agent=agent-a&conversation=conv-1',
    );
    expect(link(review, '审核提案').getAttribute('href')).toBe('/personal/reviews?run=run_review');
  });

  it('缺少会话或记忆权限时只提供查看运行', async () => {
    const me = meWith(['runs.read']);
    vi.spyOn(api, 'personalRuns').mockResolvedValue({
      items: [chatRun, reviewRun],
      nextCursor: null,
    });
    await mount('/personal/usage', me);
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    for (const [row, runId] of [
      [rows()[0], 'run_chat'],
      [rows()[1], 'run_review'],
    ] as const) {
      if (!row) throw new Error('Missing run row');
      expect([...row.querySelectorAll('a')].map((item) => item.textContent?.trim())).toEqual([
        '查看运行',
      ]);
      expect(link(row, '查看运行').getAttribute('href')).toBe(
        `/runs/${runId}?backTo=${encodeURIComponent('/personal/usage?days=30')}`,
      );
    }
  });

  it('整行不再隐式跳转，只有显式链接会离开', async () => {
    const me = meWith(['runs.read', 'conversations.read']);
    vi.spyOn(api, 'personalRuns').mockResolvedValue({
      items: [chatRun],
      nextCursor: null,
    });
    await mount('/personal/usage', me);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    const row = rows()[0];
    if (!row) throw new Error('Missing run row');
    await click(row);
    expect(router.state.location.pathname).toBe('/personal/usage');

    await click(link(row, '回到对话'));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/chat'));
    expect(router.state.location.search).toEqual({
      agent: 'agent-a',
      conversation: 'conv-1',
    });
  });

  it('没有汇总权限时隐藏汇总，但统计窗口仍可达并只请求运行明细', async () => {
    const me = meWith(['runs.read']);
    vi.spyOn(api, 'me').mockResolvedValue(me);
    const usage = vi.spyOn(api, 'personalUsage');
    vi.spyOn(api, 'personalRuns').mockResolvedValue({
      items: [chatRun],
      nextCursor: null,
    });
    await mount('/personal/usage', me);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    expect(host.querySelector('[aria-label="统计窗口"]')).not.toBeNull();
    expect(host.textContent).not.toContain('使用汇总');
    expect(usage).not.toHaveBeenCalled();
  });

  it('失败快捷只按 failed 筛选并可清除，同时重置游标', async () => {
    const me = meWith(['runs.read']);
    const runs = vi.spyOn(api, 'personalRuns').mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    await mount('/personal/usage?cursor=cursor-2', me);
    await vi.waitFor(() => expect(runs).toHaveBeenCalled());
    expect(maybeButton('清除失败筛选')).toBeNull();

    await click(button('只看失败'));
    await vi.waitFor(() =>
      expect(router.state.location.search).toMatchObject({ status: 'failed' }),
    );
    expect((router.state.location.search as { cursor?: string }).cursor).toBeUndefined();
    expect(runs).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed' }),
      expect.any(AbortSignal),
    );
    expect(maybeButton('清除失败筛选')).not.toBeNull();

    await click(button('清除失败筛选'));
    await vi.waitFor(() => expect(router.state.location.search).not.toHaveProperty('status'));
  });
});
