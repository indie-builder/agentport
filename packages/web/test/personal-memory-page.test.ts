import type { MemoryChange, PermissionId, PersonalMemory } from '@agentport/shared';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
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
import { AppShell } from '../src/components/app-shell.js';
import { ApiError, api } from '../src/lib/api.js';
import { PersonalMemoryPage, PersonalReviewsPage } from '../src/pages/personal-memory.js';
import { personalReviewsSearchSchema } from '../src/routes/-search.js';
import { allAccessMe } from './me-fixture.js';

const memory: PersonalMemory = {
  content: '旧偏好',
  revision: 2,
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const change: MemoryChange = {
  id: 'chg_1',
  target: { kind: 'personal' },
  before: { content: '更早的偏好', globs: null, index: null },
  after: { content: '旧偏好', globs: null, index: null },
  sourceReviewRunId: null,
  reversesChangeId: null,
  state: 'applied',
  createdAt: '2026-10-01T00:00:00.000Z',
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createRouter>;

function meWith(permissionIds: PermissionId[]) {
  return {
    authenticated: true as const,
    user: { businessId: 'test-user', username: 'tester', name: '测试用户' },
    roles: [],
    grants: permissionIds.map((permissionId) => ({ permissionId, scope: 'own_data' as const })),
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(
  url = '/personal/memory',
  historyOptions: { entries?: string[]; index?: number; browser?: boolean } = {},
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: AppShell });
  const memoryRoute = createRoute({
    getParentRoute: () => shell,
    path: '/personal/memory',
    component: PersonalMemoryPage,
  });
  const reviewsRoute = createRoute({
    getParentRoute: () => shell,
    path: '/personal/reviews',
    validateSearch: personalReviewsSearchSchema,
    component: PersonalReviewsPage,
  });
  const stubs = [
    '/',
    '/agents',
    '/chat',
    '/schedules',
    '/skills',
    '/eval',
    '/operations',
    '/runs',
    '/runtime-environments',
    '/status',
    '/audit',
    '/personal/profile',
    '/personal/security',
    '/personal/shares',
    '/personal/usage',
    '/away',
  ].map((path) =>
    createRoute({
      getParentRoute: () => shell,
      path,
      component: () => createElement('h1', null, path === '/away' ? 'Destination' : path),
    }),
  );
  let history: ReturnType<typeof createBrowserHistory>;
  if (historyOptions.browser) {
    history = createBrowserHistory();
    history.push('/away');
    history.flush?.();
    history.push(url);
    history.flush?.();
  } else {
    history = createMemoryHistory({
      initialEntries: historyOptions.entries ?? [url],
      initialIndex: historyOptions.index,
    });
  }
  router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([memoryRoute, reviewsRoute, ...stubs])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await vi.waitFor(() =>
    expect(host.querySelector('h1')?.textContent).toBe(
      url.startsWith('/personal/reviews') ? '记忆提案' : '个人记忆',
    ),
  );
  if (url.startsWith('/personal/reviews')) {
    await vi.waitFor(() => expect(host.textContent).toContain('生成记忆提案'));
  } else {
    // 面板在个人记忆查询结束后才渲染；等它出现，后续断言才有稳定的阅读态。
    await vi.waitFor(() =>
      expect(host.querySelector('section[aria-label="个人记忆"]')).toBeTruthy(),
    );
    expect(host.textContent).toContain('每轮对话会带入这些长期信息。');
  }
  return router;
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function link(label: string): HTMLAnchorElement {
  const match = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`Missing link: ${label}`);
  return match;
}

function mainNavLink(label: string): HTMLAnchorElement {
  const nav = host.querySelector('nav[aria-label="主导航"]');
  const match = nav
    ? [...nav.querySelectorAll<HTMLAnchorElement>('a')].find(
        (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
      )
    : undefined;
  if (!match) throw new Error(`Missing main nav link: ${label}`);
  return match;
}

function mainNavHrefs(): string[] {
  const nav = host.querySelector('nav[aria-label="主导航"]');
  return nav
    ? [...nav.querySelectorAll<HTMLAnchorElement>('a')].map(
        (item) => item.getAttribute('href') ?? '',
      )
    : [];
}

/** 底部账号入口与「个人资料」导航同名，用 nav 边界区分，避免误取侧栏条目。 */
function accountEntry(): HTMLAnchorElement {
  const match = [...host.querySelectorAll<HTMLAnchorElement>('a[aria-label="个人资料"]')].find(
    (item) => item.closest('nav') === null,
  );
  if (!match) throw new Error('Missing account entry');
  return match;
}

const PERSONAL_HREFS = [
  '/personal/profile',
  '/personal/memory',
  '/personal/reviews',
  '/personal/security',
  '/personal/shares',
  '/personal/usage',
];

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function startEditing() {
  await click(button('编辑'));
  await vi.waitFor(() => expect(document.getElementById('personal-memory-content')).toBeTruthy());
}

async function expandVersions() {
  await click(button('版本历史'));
  await vi.waitFor(() =>
    expect(host.querySelector('aside[aria-label="个人记忆版本"]')).toBeTruthy(),
  );
}

async function fillEditor(value: string) {
  await vi.waitFor(() => expect(document.getElementById('personal-memory-content')).toBeTruthy());
  const element = document.getElementById('personal-memory-content');
  if (!element) throw new Error('Missing personal memory editor');
  if (element.classList.contains('cm-content')) {
    const view = EditorView.findFromDOM(element);
    if (!view) throw new Error('Missing CodeMirror view');
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    });
    await flush();
    return;
  }
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('Editor is not a textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

function editorValue(): string {
  const element = document.getElementById('personal-memory-content');
  if (element instanceof HTMLTextAreaElement) return element.value;
  const view = element ? EditorView.findFromDOM(element) : null;
  return view?.state.doc.toString() ?? '';
}

async function confirm(label: string) {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Missing dialog');
  await click(button(label, dialog));
}

beforeEach(() => {
  localStorage.clear();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    },
  });
  client.setQueryData(['me'], allAccessMe);
  client.setQueryData(['agents'], []);
  vi.spyOn(api, 'me').mockResolvedValue(allAccessMe);
  vi.spyOn(api, 'personalMemory').mockResolvedValue(memory);
  vi.spyOn(api, 'personalMemoryVersions').mockResolvedValue({ items: [change] });
  vi.spyOn(api, 'writePersonalMemory').mockResolvedValue({
    content: '新偏好',
    revision: 3,
    updatedAt: '2026-10-02T00:00:00.000Z',
    changeId: 'chg_2',
  });
  vi.spyOn(api, 'rollbackMemoryChange').mockResolvedValue({
    ...change,
    id: 'chg_3',
    after: change.before,
    before: change.after,
    reversesChangeId: change.id,
  });
  vi.spyOn(api, 'memoryReviews').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'agents').mockResolvedValue([]);
  vi.spyOn(api, 'conversations').mockResolvedValue([]);
  vi.spyOn(api, 'agentRules').mockResolvedValue([]);
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

describe('个人记忆页', () => {
  it('渲染唯一 h1，并把个人导航与底部账号入口标为当前', async () => {
    await mount();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe('个人记忆');
    // 标题与意义说明只出现一次，不再在内容区重复一个同名 h2。
    expect([...host.querySelectorAll('h2')].some((item) => item.textContent === '个人记忆')).toBe(
      false,
    );
    expect(host.textContent?.split('每轮对话会带入这些长期信息。')).toHaveLength(2);
    // 个人资料导航与底部账号入口同名，必须按 nav 范围区分。
    expect(mainNavLink('个人记忆').getAttribute('aria-current')).toBe('page');
    expect(accountEntry().getAttribute('aria-current')).toBe('page');
    // 导航分组与顺序由导航单元维护；这里只确认六个个人目的地都可达。
    expect(new Set(mainNavHrefs())).toEqual(new Set(PERSONAL_HREFS));
    for (const href of [
      '/agents',
      '/chat',
      '/schedules',
      '/skills',
      '/eval',
      '/operations',
      '/runs',
      '/status',
      '/audit',
    ]) {
      expect(mainNavHrefs()).not.toContain(href);
    }
    // 内容区旧横导航删除后，个人导航只保留在 AppShell 侧栏。
    expect(host.querySelector('nav[aria-label="个人导航"]')).toBeNull();
  });

  it('记忆提案是独立路由，不渲染个人记忆编辑器', async () => {
    await mount('/personal/reviews');
    await vi.waitFor(() => expect(host.textContent).toContain('生成记忆提案'));
    expect(host.textContent).not.toContain('个人记忆内容（Markdown）');
    expect(host.querySelector('h1')?.textContent).toBe('记忆提案');
    expect(mainNavLink('记忆提案').getAttribute('aria-current')).toBe('page');
    expect(accountEntry().getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('nav[aria-label="个人导航"]')).toBeNull();
  });

  it('默认以 Markdown 阅读已有内容，编辑后才出现源码编辑器', async () => {
    await mount();
    expect(host.textContent).toContain('每轮对话会带入这些长期信息。');
    await vi.waitFor(() => expect(host.textContent).toContain('旧偏好'));
    expect(document.getElementById('personal-memory-content')).toBeNull();
    expect(button('编辑')).toBeTruthy();
    expect(link('去对话').getAttribute('href')).toBe('/chat');
    expect(link('从对话整理').getAttribute('href')).toBe('/personal/reviews?create=true');
    // 有内容时阅读态动作只在顶部出现一次。
    expect(
      [...host.querySelectorAll('a')].filter((item) => item.textContent?.trim() === '从对话整理'),
    ).toHaveLength(1);

    await startEditing();
    expect(editorValue()).toBe('旧偏好');
    await click(button('取消'));
    await vi.waitFor(() => expect(document.getElementById('personal-memory-content')).toBeNull());
  });

  it('缺少会话读取权限时阅读态不提供去对话入口', async () => {
    const me = meWith(['personal_memory.read', 'personal_memory.write', 'personal_memory.review']);
    vi.mocked(api.me).mockResolvedValue(me);
    client.setQueryData(['me'], me);
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('旧偏好'));
    expect(
      [...host.querySelectorAll('a')].some((item) => item.textContent?.trim() === '去对话'),
    ).toBe(false);
    expect(link('从对话整理')).toBeTruthy();
    expect(link('下载')).toBeTruthy();
  });

  it('取消编辑放弃草稿前确认', async () => {
    await mount();
    await startEditing();
    await fillEditor('未保存的修改');
    await click(button('取消'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('放弃未保存的修改？');
    await click(button('取消', document.querySelector('[role="dialog"]') as HTMLElement));
    expect(editorValue()).toBe('未保存的修改');

    await click(button('取消'));
    await confirm('放弃修改');
    await vi.waitFor(() => expect(document.getElementById('personal-memory-content')).toBeNull());
    await vi.waitFor(() => expect(host.textContent).toContain('旧偏好'));
  });

  it('空记忆只保留中央的自己填写与从对话整理，不重复顶部动作', async () => {
    vi.mocked(api.personalMemory).mockResolvedValue({
      content: '',
      revision: 0,
      updatedAt: null,
    });
    await mount();
    expect(host.textContent).toContain('还没有个人记忆');
    expect(
      [...host.querySelectorAll('a')].filter((item) => item.textContent?.trim() === '从对话整理'),
    ).toHaveLength(1);
    expect(link('从对话整理').getAttribute('href')).toBe('/personal/reviews?create=true');
    // 空态没有可编辑或可下载的内容，顶部动作不重复出现。
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === '编辑')).toBe(
      false,
    );
    expect(
      [...host.querySelectorAll('a')].some((item) => item.textContent?.trim() === '下载'),
    ).toBe(false);
    expect(
      [...host.querySelectorAll('a')].some((item) => item.textContent?.trim() === '去对话'),
    ).toBe(false);

    await click(button('自己填写'));
    await vi.waitFor(() => expect(document.getElementById('personal-memory-content')).toBeTruthy());
    expect(editorValue()).toBe('');
  });

  it('加载已有内容并用 expectedRevision 保存，保存后明确下一轮生效', async () => {
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('旧偏好'));
    await startEditing();
    expect(editorValue()).toBe('旧偏好');
    await fillEditor('新偏好');
    expect(host.textContent).toContain('未保存');

    // 保存后服务端重读返回新内容，失效产生的重取要拿到它。
    vi.mocked(api.personalMemory).mockResolvedValue({
      content: '新偏好',
      revision: 3,
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
    await click(button('保存'));
    expect(api.writePersonalMemory).toHaveBeenCalledWith({
      content: '新偏好',
      expectedRevision: 2,
    });
    await vi.waitFor(() => expect(host.textContent).toContain('已保存，下一轮对话会带入。'));
    expect(document.getElementById('personal-memory-content')).toBeNull();
    await vi.waitFor(() => expect(host.textContent).toContain('新偏好'));
  });

  it('保存成功后立即重新请求版本并显示新记录', async () => {
    const savedChange: MemoryChange = {
      ...change,
      id: 'chg_2',
      before: { content: '旧偏好', globs: null, index: null },
      after: { content: '新偏好', globs: null, index: null },
      createdAt: '2026-10-02T00:00:00.000Z',
    };
    let saved = false;
    vi.mocked(api.personalMemoryVersions).mockImplementation(async () => ({
      items: saved ? [savedChange] : [],
    }));
    vi.mocked(api.writePersonalMemory).mockImplementation(async () => {
      saved = true;
      return {
        content: '新偏好',
        revision: 3,
        updatedAt: '2026-10-02T00:00:00.000Z',
        changeId: savedChange.id,
      };
    });
    await mount();
    await expandVersions();
    expect(api.personalMemory).toHaveBeenCalledTimes(1);

    await startEditing();
    await fillEditor('新偏好');
    await click(button('保存'));

    await vi.waitFor(() => expect(api.personalMemoryVersions).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(api.personalMemory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.textContent).toContain('新偏好'));
  });

  it('版本历史默认收起，展开后才列出记录与回滚动作', async () => {
    await mount();
    expect(host.querySelector('aside[aria-label="个人记忆版本"]')).toBeNull();
    expect(
      [...host.querySelectorAll('button')].some((item) =>
        item.getAttribute('aria-label')?.startsWith('回滚 '),
      ),
    ).toBe(false);

    await expandVersions();
    expect(
      [...host.querySelectorAll('button')].some((item) =>
        item.getAttribute('aria-label')?.startsWith('回滚 '),
      ),
    ).toBe(true);
  });

  it('409 保留草稿并由重新加载放弃草稿', async () => {
    vi.mocked(api.writePersonalMemory).mockRejectedValue(
      new ApiError(409, '个人记忆已被其他编辑更新，请刷新后重试', { code: 'CONFLICT' }),
    );
    await mount();
    await startEditing();
    await fillEditor('冲突草稿');
    await click(button('保存'));
    await vi.waitFor(() => expect(host.textContent).toContain('个人记忆已被其他编辑更新'));
    expect(editorValue()).toBe('冲突草稿');

    vi.mocked(api.personalMemory).mockResolvedValue({
      content: '服务器上的新内容',
      revision: 4,
      updatedAt: '2026-10-03T00:00:00.000Z',
    });
    await click(button('重新加载'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '重新加载并放弃草稿？',
    );
    await confirm('放弃并重新加载');
    await vi.waitFor(() => expect(editorValue()).toBe('服务器上的新内容'));
  });

  it('接近上限显示字数，超限阻止保存', async () => {
    await mount();
    await startEditing();
    await fillEditor('a'.repeat(8501));
    expect(host.textContent).toContain('8501 / 9000');
    expect(button('保存').disabled).toBe(false);

    await fillEditor('a'.repeat(9001));
    expect(host.textContent).toContain('9001 / 9000');
    expect(host.textContent).toContain('超出 1 个字符');
    expect(button('保存').disabled).toBe(true);
  });

  it('下载保留原生链接语义并指向个人偏好文件', async () => {
    await mount();
    const download = link('下载');
    expect(download.getAttribute('href')).toBe('/api/me/memory/download');
    expect(download.getAttribute('role')).toBeNull();
    expect(download.hasAttribute('download')).toBe(true);
  });

  it('回滚版本调用变更账本并在成功后重新读取', async () => {
    await mount();
    await expandVersions();
    const rollback = await vi.waitFor(() => {
      const match = [...host.querySelectorAll('button')].find((item) =>
        item.getAttribute('aria-label')?.startsWith('回滚 '),
      );
      expect(match).toBeTruthy();
      return match as HTMLButtonElement;
    });
    await click(rollback);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('回滚这次保存？');
    await confirm('回滚');
    expect(api.rollbackMemoryChange).toHaveBeenCalledWith('chg_1');
    await vi.waitFor(() => expect(api.personalMemoryVersions).toHaveBeenCalledTimes(2));
  });

  it('回滚后刷新个人偏好与版本列表', async () => {
    const rollbackChange: MemoryChange = {
      ...change,
      id: 'chg_3',
      before: { content: '旧偏好', globs: null, index: null },
      after: { content: '更早的偏好', globs: null, index: null },
      reversesChangeId: change.id,
      createdAt: '2026-10-02T00:00:00.000Z',
    };
    let rolledBack = false;
    vi.mocked(api.rollbackMemoryChange).mockImplementation(async () => {
      rolledBack = true;
      return rollbackChange;
    });
    vi.mocked(api.personalMemory).mockImplementation(async () =>
      rolledBack
        ? { content: '更早的偏好', revision: 5, updatedAt: '2026-10-02T00:00:00.000Z' }
        : memory,
    );
    vi.mocked(api.personalMemoryVersions).mockImplementation(async () => ({
      items: rolledBack ? [rollbackChange, change] : [change],
    }));
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('旧偏好'));
    await expandVersions();

    const rollback = await vi.waitFor(() => {
      const match = [...host.querySelectorAll('button')].find((item) =>
        item.getAttribute('aria-label')?.startsWith('回滚 '),
      );
      expect(match).toBeTruthy();
      return match as HTMLButtonElement;
    });
    await click(rollback);
    await confirm('回滚');

    await vi.waitFor(() => expect(api.personalMemoryVersions).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.textContent).toContain('更早的偏好'));
    expect(api.personalMemory.mock.calls.length).toBeGreaterThan(1);
    expect(host.querySelector('aside[aria-label="个人记忆版本"]')?.textContent).toContain(
      '回滚记录',
    );
  });

  it('回滚冲突显示服务端原因', async () => {
    vi.mocked(api.rollbackMemoryChange).mockRejectedValue(
      new ApiError(409, '目标内容在此版本之后已被修改，请刷新后重试', { code: 'CONFLICT' }),
    );
    await mount();
    await expandVersions();
    const rollback = await vi.waitFor(() => {
      const match = [...host.querySelectorAll('button')].find((item) =>
        item.getAttribute('aria-label')?.startsWith('回滚 '),
      );
      expect(match).toBeTruthy();
      return match as HTMLButtonElement;
    });
    await click(rollback);
    await confirm('回滚');
    await vi.waitFor(() => expect(host.textContent).toContain('目标内容在此版本之后已被修改'));
  });

  it('保存始终使用开始编辑时的 revision，外部刷新不改变草稿基线', async () => {
    vi.mocked(api.writePersonalMemory).mockRejectedValue(
      new ApiError(409, '个人记忆已被其他编辑更新，请刷新后重试', { code: 'CONFLICT' }),
    );
    await mount();
    await startEditing();
    await fillEditor('本地草稿');

    // 外部编辑让查询缓存刷新到新 revision，但这次保存仍应以编辑开始时的 2 为基线。
    await act(async () => {
      client.setQueryData(['personal-memory'], {
        content: '服务器上的新内容',
        revision: 5,
        updatedAt: '2026-10-05T00:00:00.000Z',
      });
    });
    await flush();
    await click(button('保存'));

    expect(api.writePersonalMemory).toHaveBeenCalledWith({
      content: '本地草稿',
      expectedRevision: 2,
    });
    await vi.waitFor(() => expect(host.textContent).toContain('个人记忆已被其他编辑更新'));
    expect(editorValue()).toBe('本地草稿');
  });

  it('后台刷新失败保留草稿和保存基线，重试不清空草稿', async () => {
    await mount();
    await startEditing();
    await fillEditor('本地草稿');
    expect(host.textContent).toContain('未保存');

    let fail = true;
    vi.mocked(api.personalMemory).mockImplementation(async () => {
      if (fail) throw new Error('刷新失败');
      return { content: '服务器新内容', revision: 5, updatedAt: '2026-10-05T00:00:00.000Z' };
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: ['personal-memory'], exact: true });
    });
    await flush();
    expect(host.textContent).toContain('刷新失败');
    expect(editorValue()).toBe('本地草稿');
    expect(host.textContent).toContain('未保存');

    fail = false;
    await click(button('重试'));
    await vi.waitFor(() => expect(host.textContent).not.toContain('刷新失败'));
    expect(editorValue()).toBe('本地草稿');
    expect(host.textContent).toContain('未保存');

    await click(button('保存'));
    expect(api.writePersonalMemory).toHaveBeenCalledWith({
      content: '本地草稿',
      expectedRevision: 2,
    });
  });

  it('浏览器返回走同一放弃确认，取消后草稿仍在', async () => {
    await mount('/personal/memory', { browser: true });
    await startEditing();
    await fillEditor('未保存的草稿');

    await act(async () => {
      router.history.back();
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        '放弃未保存的个人记忆？',
      ),
    );
    await click(button('取消', document.querySelector('[role="dialog"]') as HTMLElement));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/personal/memory'));
    expect(editorValue()).toBe('未保存的草稿');
    expect(host.textContent).toContain('未保存');

    await act(async () => {
      router.history.back();
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        '放弃未保存的个人记忆？',
      ),
    );
    await confirm('放弃并离开');
    await vi.waitFor(() => expect(host.textContent).toContain('Destination'));
  });

  it('切到记忆提案前确认放弃草稿', async () => {
    await mount();
    await startEditing();
    await fillEditor('未保存的草稿');
    await act(async () => {
      void router.navigate({ to: '/personal/reviews' });
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        '放弃未保存的个人记忆？',
      ),
    );
    await confirm('放弃并离开');
    await vi.waitFor(() => expect(host.textContent).toContain('生成记忆提案'));
    await act(async () => {
      void router.navigate({ to: '/personal/memory' });
    });
    await vi.waitFor(() => expect(host.textContent).toContain('旧偏好'));
  });

  it('离开路由前确认放弃草稿', async () => {
    await mount();
    await startEditing();
    await fillEditor('未保存的草稿');
    await act(async () => {
      void router.navigate({ to: '/away' });
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '放弃未保存的个人记忆？',
    );
    await confirm('放弃并离开');
    await vi.waitFor(() => expect(host.textContent).toContain('Destination'));
  });
});
