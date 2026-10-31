import type {
  AuthMe,
  MemoryReview,
  PermissionId,
  PersonalOutputShare,
  PersonalRun,
  PersonalSession,
  PersonalUsageSummary,
} from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ComponentType, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api.js';
import { PersonalReviewsPage } from '../src/pages/personal-memory.js';
import { PersonalProfilePage } from '../src/pages/personal-profile.js';
import { PersonalSecurityPage } from '../src/pages/personal-security.js';
import { PersonalSharesPage } from '../src/pages/personal-shares.js';
import { PersonalUsagePage } from '../src/pages/personal-usage.js';
import {
  personalReviewsSearchSchema,
  personalSharesSearchSchema,
  personalUsageSearchSchema,
} from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

function meWith(permissionIds: PermissionId[], name = '测试用户'): AuthMe {
  return {
    authenticated: true,
    user: { businessId: 'user-1', username: 'tester', name },
    roles: [],
    grants: permissionIds.map((permissionId) => ({ permissionId, scope: 'own_data' })),
  };
}

const sessionCurrent: PersonalSession = {
  id: 'sess-current',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  expiresAt: '2026-11-20T00:00:00.000Z',
  ipAddress: '127.0.0.1',
  userAgent: 'Chrome on macOS',
  current: true,
};

const sessionOther: PersonalSession = {
  ...sessionCurrent,
  id: 'sess-other',
  userAgent: 'Safari on iOS',
  current: false,
};

const share: PersonalOutputShare = {
  id: 'share-1',
  runId: 'run-1',
  path: 'report.md',
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-22T00:00:00.000Z',
  revokedAt: null,
  urlPath: '/s/share-1#token',
  conversationId: 'conv-1',
  conversationTitle: '季度总结',
  agentId: 'agent-a',
};

const usage: PersonalUsageSummary = {
  days: 30,
  since: '2026-10-01T00:00:00.000Z',
  until: '2026-10-31T00:00:00.000Z',
  runCount: 3,
  succeeded: 1,
  failed: 1,
  cancelled: 0,
  timeout: 0,
  queued: 0,
  running: 1,
  inputTokens: 1200,
  outputTokens: 300,
  costUsd: '0.0500',
  costRecordedRuns: 2,
  costMissingRuns: 1,
};

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
  status: 'running',
  trigger: 'review',
  startedAt: '2026-10-30T10:00:00.000Z',
  conversationId: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
};

const review: MemoryReview = {
  runId: 'run-review-1',
  modelAgentId: 'agent-a',
  target: { kind: 'personal' },
  status: 'succeeded',
  decision: 'pending',
  sources: [{ conversationId: 'conv-1', title: '季度总结', messageCount: 4 }],
  before: { content: '旧内容', globs: null, index: null },
  proposal: {
    summary: '补充偏好',
    proposedContent: '新内容',
    evidence: [{ messageId: 'm1', quote: '以后都用中文', kind: 'user_fact' }],
  },
  appliedChangeId: null,
  costUsd: '0.0100',
  error: null,
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createRouter>;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(options: {
  path: string;
  component: ComponentType;
  validateSearch?: (input: unknown) => unknown;
  me: AuthMe;
}) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const page = createRoute({
    getParentRoute: () => shell,
    path: options.path,
    component: options.component,
    ...(options.validateSearch === undefined
      ? {}
      : { validateSearch: options.validateSearch as never }),
  });
  const stubs = ['/login', '/chat', '/personal/reviews', '/personal/memory', '/runs/$runId']
    .filter((path) => path !== options.path)
    .map((path) =>
      createRoute({
        getParentRoute: () => shell,
        path,
        component: () => createElement('h1', null, `stub ${path}`),
      }),
    );
  router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page, ...stubs])]),
    history: createMemoryHistory({ initialEntries: [options.path] }),
  });
  client.setQueryData(['me'], options.me);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function maybeButton(label: string, scope: ParentNode = document): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
    ) ?? null
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function confirm(label: string) {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Missing dialog');
  await click(button(label, dialog));
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

describe('个人资料', () => {
  it('只保存显示姓名并刷新已登录身份', async () => {
    let name = '旧姓名';
    const identity = (): AuthMe => meWith([], name);
    vi.spyOn(api, 'me').mockImplementation(async () => identity());
    vi.spyOn(api, 'updatePersonalProfile').mockImplementation(async (input) => {
      name = input.name;
      return { businessId: 'user-1', username: 'tester', name: input.name };
    });
    await mount({ path: '/personal/profile', component: PersonalProfilePage, me: identity() });
    await vi.waitFor(() => {
      const nameInput = document.getElementById('personal-name');
      expect(nameInput).toBeInstanceOf(HTMLInputElement);
      expect((nameInput as HTMLInputElement).value).toBe('旧姓名');
    });
    expect(host.textContent).toContain('tester');
    expect(host.textContent).toContain('user-1');

    const input = document.getElementById('personal-name');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing name input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '新姓名',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('保存'));
    await vi.waitFor(() =>
      expect(api.updatePersonalProfile).toHaveBeenCalledWith({ name: '新姓名' }),
    );
    await vi.waitFor(() =>
      expect(client.getQueryData<AuthMe>(['me'])).toMatchObject({
        user: { name: '新姓名' },
      }),
    );
  });
});

describe('安全与会话', () => {
  it('鲜度不足时只提供重新登录动作，不自动登出', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(meWith([]));
    vi.spyOn(api, 'meSessions').mockRejectedValue(
      new ApiError(403, '请重新登录后管理登录会话', { code: 'FORBIDDEN' }),
    );
    const logout = vi.spyOn(api, 'logout').mockResolvedValue({ ok: true });
    await mount({ path: '/personal/security', component: PersonalSecurityPage, me: meWith([]) });
    await vi.waitFor(() => expect(host.textContent).toContain('请重新登录后管理登录会话'));
    expect(logout).not.toHaveBeenCalled();
    await click(button('重新登录'));
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('标记当前会话并只允许撤销其他会话', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(meWith([]));
    vi.spyOn(api, 'meSessions').mockResolvedValue({
      items: [sessionCurrent, sessionOther],
    });
    const revoke = vi.spyOn(api, 'revokeMeSession').mockResolvedValue(undefined);
    await mount({ path: '/personal/security', component: PersonalSecurityPage, me: meWith([]) });
    await vi.waitFor(() => expect(host.textContent).toContain('当前会话'));
    expect(host.textContent).toContain('Chrome on macOS');
    expect(host.textContent).toContain('Safari on iOS');
    expect(maybeButton('撤销 sess-current')).toBeNull();
    const revokeButtons = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (item) => item.textContent?.trim() === '撤销',
    );
    expect(revokeButtons).toHaveLength(1);
    const onlyRevoke = revokeButtons[0];
    if (!onlyRevoke) throw new Error('Missing revoke button');
    await click(onlyRevoke);
    await confirm('撤销会话');
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('sess-other'));
  });
});

describe('使用记录', () => {
  it('只有汇总权限时只请求汇总，并区分已记录成本与覆盖', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(meWith(['overview.read']));
    vi.spyOn(api, 'personalUsage').mockResolvedValue(usage);
    const runs = vi.spyOn(api, 'personalRuns');
    await mount({
      path: '/personal/usage',
      component: PersonalUsagePage,
      validateSearch: personalUsageSearchSchema,
      me: meWith(['overview.read']),
    });
    await vi.waitFor(() => expect(host.textContent).toContain('已记录成本'));
    expect(host.textContent).toContain('$0.0500 · 2/3 次运行');
    expect(host.textContent).toContain('1 次运行未记录成本');
    expect(host.textContent).toContain('1.2k 输入 / 300 输出');
    expect(runs).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('运行 ID');
  });

  it('连续翻页可到第三页，回到最新与下一页分别显示', async () => {
    const me = meWith(['runs.read']);
    vi.spyOn(api, 'me').mockResolvedValue(me);
    const pageRun = (id: string): PersonalRun => ({ ...chatRun, id });
    const runs = vi.spyOn(api, 'personalRuns').mockImplementation(async (query) => {
      if (!query.cursor) return { items: [pageRun('run_p1')], nextCursor: 'cursor-2' };
      if (query.cursor === 'cursor-2')
        return { items: [pageRun('run_p2')], nextCursor: 'cursor-3' };
      if (query.cursor === 'cursor-3') return { items: [pageRun('run_p3')], nextCursor: null };
      return { items: [], nextCursor: null };
    });
    await mount({
      path: '/personal/usage',
      component: PersonalUsagePage,
      validateSearch: personalUsageSearchSchema,
      me,
    });
    await vi.waitFor(() => expect(host.querySelector('[title="run_p1"]')).toBeTruthy());
    expect(maybeButton('回到最新')).toBeNull();
    expect(maybeButton('下一页')).not.toBeNull();

    await click(button('下一页'));
    await vi.waitFor(() => expect(host.querySelector('[title="run_p2"]')).toBeTruthy());
    expect(maybeButton('回到最新')).not.toBeNull();
    expect(maybeButton('下一页')).not.toBeNull();

    await click(button('下一页'));
    await vi.waitFor(() => expect(host.querySelector('[title="run_p3"]')).toBeTruthy());
    expect(maybeButton('下一页')).toBeNull();
    expect(runs).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-3' }),
      expect.any(AbortSignal),
    );

    await click(button('回到最新'));
    await vi.waitFor(() =>
      expect((router.state.location.search as { cursor?: string }).cursor).toBeUndefined(),
    );
    await vi.waitFor(() => expect(host.querySelector('[title="run_p1"]')).toBeTruthy());
  });

  it('汇总窗口按 UTC 显示，不随本地时区', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(meWith(['overview.read']));
    vi.spyOn(api, 'personalUsage').mockResolvedValue({
      ...usage,
      since: '2026-10-31T20:00:00.000Z',
      until: '2026-10-31T22:00:00.000Z',
    });
    await mount({
      path: '/personal/usage',
      component: PersonalUsagePage,
      validateSearch: personalUsageSearchSchema,
      me: meWith(['overview.read']),
    });
    await vi.waitFor(() => expect(host.textContent).toContain('10/31 20:00 – 10/31 22:00'));
  });

  it('有运行权限时按真实来源跳转', async () => {
    const me = meWith(['runs.read', 'conversations.read']);
    vi.spyOn(api, 'me').mockResolvedValue(me);
    const usageSpy = vi.spyOn(api, 'personalUsage');
    vi.spyOn(api, 'personalRuns').mockResolvedValue({
      items: [chatRun, reviewRun],
      nextCursor: null,
    });
    await mount({
      path: '/personal/usage',
      component: PersonalUsagePage,
      validateSearch: personalUsageSearchSchema,
      me,
    });
    await vi.waitFor(() => expect(host.textContent).toContain('对话'));
    expect(host.textContent).toContain('历史回顾');
    expect(usageSpy).not.toHaveBeenCalled();

    const rows = [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const firstRow = rows[0];
    if (!firstRow) throw new Error('Missing run row');
    await click(firstRow);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/chat'));
    expect(router.state.location.search).toEqual({
      agent: 'agent-a',
      conversation: 'conv-1',
    });
  });
});

describe('我的分享', () => {
  it('列出来源、复制入口并在撤销后刷新', async () => {
    vi.spyOn(api, 'personalOutputShares').mockResolvedValue({
      items: [share],
      nextCursor: null,
    });
    const revoke = vi.spyOn(api, 'revokePersonalOutputShare').mockResolvedValue(undefined);
    const me = meWith(['conversations.read', 'conversations.share']);
    vi.spyOn(api, 'me').mockResolvedValue(me);
    await mount({
      path: '/personal/shares',
      component: PersonalSharesPage,
      validateSearch: personalSharesSearchSchema,
      me,
    });
    await vi.waitFor(() => expect(host.textContent).toContain('季度总结'));
    expect(host.textContent).toContain('report.md');
    const source = host.querySelector<HTMLAnchorElement>('a[href^="/chat?"]');
    expect(source?.getAttribute('href')).toBe('/chat?agent=agent-a&conversation=conv-1');
    expect(maybeButton('复制 report.md 的分享链接')).not.toBeNull();

    await click(button('撤销'));
    await confirm('撤销分享');
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('share-1'));
  });
});

describe('历史回顾只读', () => {
  it('可查看详情但没有创建、采用或拒绝动作', async () => {
    const me = meWith(['personal_memory.read']);
    vi.spyOn(api, 'me').mockResolvedValue(me);
    const agents = vi.spyOn(api, 'agents').mockResolvedValue([]);
    const conversations = vi.spyOn(api, 'personalConversations');
    vi.spyOn(api, 'memoryReviews').mockResolvedValue({ items: [review] });
    await mount({
      path: '/personal/reviews',
      component: PersonalReviewsPage,
      validateSearch: personalReviewsSearchSchema,
      me,
    });
    await vi.waitFor(() => expect(host.textContent).toContain('补充偏好'));
    expect(maybeButton('新建回顾')).toBeNull();
    expect(agents).not.toHaveBeenCalled();
    expect(conversations).not.toHaveBeenCalled();

    await click(button('查看'));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(maybeButton('采用', dialog)).toBeNull();
    expect(maybeButton('不采用', dialog)).toBeNull();
    expect(maybeButton('重新生成', dialog)).toBeNull();
    expect(dialog.querySelector('a[href^="/chat?"]')).toBeNull();
    expect(maybeButton('关闭详情', dialog)).not.toBeNull();
  });
});
