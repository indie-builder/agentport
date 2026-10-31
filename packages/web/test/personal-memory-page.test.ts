import type { MemoryChange, PersonalMemory } from '@agentport/shared';
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
      url.startsWith('/personal/reviews') ? '历史回顾' : '个人记忆',
    ),
  );
  if (url.startsWith('/personal/reviews')) {
    await vi.waitFor(() => expect(host.textContent).toContain('新建回顾'));
  } else {
    await vi.waitFor(() => expect(host.textContent).toContain('个人记忆内容（Markdown）'));
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

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
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
  it('渲染唯一 h1 并把底部个人入口标为当前', async () => {
    await mount();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe('个人记忆');
    expect(link('个人资料').getAttribute('aria-current')).toBe('page');
    expect(link('对话').getAttribute('aria-current')).toBeNull();
  });

  it('历史回顾是独立路由，不渲染个人记忆编辑器', async () => {
    await mount('/personal/reviews');
    await vi.waitFor(() => expect(host.textContent).toContain('新建回顾'));
    expect(host.textContent).not.toContain('个人记忆内容（Markdown）');
    expect(host.querySelector('h1')?.textContent).toBe('历史回顾');
  });

  it('加载已有内容并用 expectedRevision 保存', async () => {
    await mount();
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
    await vi.waitFor(() => expect(host.textContent).toContain('已保存'));
    expect(editorValue()).toBe('新偏好');
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
    expect(host.textContent).toContain('保存后会记录版本。');
    expect(api.personalMemory).toHaveBeenCalledTimes(1);

    await fillEditor('新偏好');
    await click(button('保存'));

    await vi.waitFor(() => expect(api.personalMemoryVersions).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(api.personalMemory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.textContent).not.toContain('保存后会记录版本。'));
    expect(host.textContent).toContain('新偏好');
  });

  it('409 保留草稿并由重新加载放弃草稿', async () => {
    vi.mocked(api.writePersonalMemory).mockRejectedValue(
      new ApiError(409, '个人记忆已被其他编辑更新，请刷新后重试', { code: 'CONFLICT' }),
    );
    await mount();
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
    await fillEditor('a'.repeat(8501));
    expect(host.textContent).toContain('8501 / 9000');
    expect(button('保存').disabled).toBe(false);

    await fillEditor('a'.repeat(9001));
    expect(host.textContent).toContain('9001 / 9000');
    expect(host.textContent).toContain('超出 1 个字符');
    expect(button('保存').disabled).toBe(true);
  });

  it('下载直接指向个人偏好文件', async () => {
    await mount();
    const download = link('下载');
    expect(download.getAttribute('href')).toBe('/api/me/memory/download');
    expect(download.hasAttribute('download')).toBe(true);
  });

  it('回滚版本调用变更账本并在成功后重新读取', async () => {
    await mount();
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
    expect(editorValue()).toBe('旧偏好');

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
    await vi.waitFor(() => expect(editorValue()).toBe('更早的偏好'));
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

  it('切到历史回顾前确认放弃草稿', async () => {
    await mount();
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
    await vi.waitFor(() => expect(host.textContent).toContain('新建回顾'));
    await act(async () => {
      void router.navigate({ to: '/personal/memory' });
    });
    await vi.waitFor(() => expect(editorValue()).toBe('旧偏好'));
  });

  it('离开路由前确认放弃草稿', async () => {
    await mount();
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
