import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/app-shell.js';
import { PageHeader } from '../src/components/page.js';

async function inspectRoute(
  path: string,
  auth: 'success' | 'pending' | 'error' | 'unauthenticated',
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (auth === 'success') client.setQueryData(['me'], { authenticated: true, username: 'review' });
  if (auth === 'unauthenticated') client.setQueryData(['me'], { authenticated: false });
  client.setQueryDefaults(['me'], {
    queryFn: () =>
      auth === 'error' ? Promise.reject(new Error('offline')) : new Promise(() => {}),
  });
  const rootRoute = createRootRoute();
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: AppShell });
  const missing = createRoute({
    getParentRoute: () => shell,
    path: '$',
    component: () => createElement(PageHeader, { title: '页面不存在' }),
  });
  const detail = createRoute({
    getParentRoute: () => shell,
    path: '/runs/$runId',
    component: () => createElement(PageHeader, { title: '运行详情' }),
  });
  const knowledge = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/$baseId',
    component: () => createElement(PageHeader, { title: '知识库详情' }),
  });
  const knowledgeIndex = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/',
    component: () => createElement(PageHeader, { title: '知识库' }),
  });
  const agentsIndex = createRoute({
    getParentRoute: () => shell,
    path: '/agents/',
    component: () => createElement(PageHeader, { title: '专家' }),
  });
  const agentDetail = createRoute({
    getParentRoute: () => shell,
    path: '/agents/$agentId',
    component: () => createElement(PageHeader, { title: '专家详情' }),
  });
  const skills = createRoute({
    getParentRoute: () => shell,
    path: '/skills',
    component: () => createElement(PageHeader, { title: '技能' }),
  });
  const servers = createRoute({
    getParentRoute: () => shell,
    path: '/servers',
    component: () => createElement(PageHeader, { title: '连接器' }),
  });
  const overview = createRoute({
    getParentRoute: () => shell,
    path: '/',
    component: () => createElement(PageHeader, { title: '工作台' }),
  });
  const chat = createRoute({
    getParentRoute: () => shell,
    path: '/chat',
    component: () => createElement(PageHeader, { title: '对话' }),
  });
  const schedules = createRoute({
    getParentRoute: () => shell,
    path: '/schedules',
    component: () => createElement(PageHeader, { title: '定时任务' }),
  });
  const evalRoute = createRoute({
    getParentRoute: () => shell,
    path: '/eval',
    component: () => createElement(PageHeader, { title: '评估' }),
  });
  const status = createRoute({
    getParentRoute: () => shell,
    path: '/status',
    component: () => createElement(PageHeader, { title: '健康' }),
  });
  const audit = createRoute({
    getParentRoute: () => shell,
    path: '/audit',
    component: () => createElement(PageHeader, { title: '审计' }),
  });
  const pluginsIndex = createRoute({
    getParentRoute: () => shell,
    path: '/plugins/',
    component: () => createElement(PageHeader, { title: '插件' }),
  });
  const pluginDetail = createRoute({
    getParentRoute: () => shell,
    path: '/plugins/$pluginId',
    component: () => createElement(PageHeader, { title: '插件详情' }),
  });
  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => createElement(PageHeader, { title: '登录' }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      shell.addChildren([
        missing,
        detail,
        knowledge,
        knowledgeIndex,
        agentsIndex,
        agentDetail,
        skills,
        servers,
        overview,
        chat,
        schedules,
        evalRoute,
        status,
        audit,
        pluginsIndex,
        pluginDetail,
      ]),
      login,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  return {
    host,
    router,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('shell route identity', () => {
  it.each(['success', 'pending', 'error'] as const)(
    'names unknown known-prefix paths as not found while auth is %s',
    async (auth) => {
      const view = await inspectRoute('/eval/missing', auth);
      try {
        expect(document.title).toBe('页面不存在 · 控制台');
        expect(view.host.querySelectorAll('h1')).toHaveLength(1);
        expect(view.host.querySelector('h1')?.textContent).toBe('页面不存在');
      } finally {
        await view.close();
      }
    },
  );

  it('names a matched knowledge detail as knowledge rather than not found', async () => {
    const view = await inspectRoute('/knowledge/kb_review', 'success');
    try {
      expect(document.title).toBe('知识库 · 控制台');
      expect(view.host.querySelectorAll('h1')).toHaveLength(1);
    } finally {
      await view.close();
    }
  });

  it('keeps the title for a matched run detail route', async () => {
    const view = await inspectRoute('/runs/run_review', 'success');
    try {
      expect(document.title).toBe('运行 · 控制台');
    } finally {
      await view.close();
    }
  });

  it.each(['/plugins', '/plugins/'])('names the plugin list route %s', async (path) => {
    const view = await inspectRoute(path, 'success');
    try {
      expect(document.title).toBe('插件 · 控制台');
      expect(document.body.textContent).not.toContain('页面不存在');
    } finally {
      await view.close();
    }
  });

  it('names the plugin detail route', async () => {
    const view = await inspectRoute('/plugins/plugin_review', 'success');
    try {
      expect(document.title).toBe('插件 · 控制台');
    } finally {
      await view.close();
    }
  });
});

function activeNavLinks(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('nav[aria-label="主导航"] a[aria-current="page"]')).map(
    (link) => link.getAttribute('href') ?? '',
  );
}

describe('unauthenticated deep links', () => {
  it('sends the current path, search and hash to login', async () => {
    const target = '/plugins/plugin_review?tab=content&file=README.md&mode=source#top';
    const view = await inspectRoute(target, 'unauthenticated');
    try {
      await vi.waitFor(() => expect(view.router.state.location.pathname).toBe('/login'));
      expect(view.router.state.location.search).toEqual({ returnTo: target });
    } finally {
      await view.close();
    }
  });

  it('still redirects a path that merely starts with login', async () => {
    const view = await inspectRoute('/login-other', 'unauthenticated');
    try {
      await vi.waitFor(() => expect(view.router.state.location.pathname).toBe('/login'));
      expect(view.router.state.location.search).toEqual({ returnTo: '/login-other' });
    } finally {
      await view.close();
    }
  });
});

describe('sidebar active route', () => {
  it.each([
    '/agents/agent_review',
    '/agents/',
    '/skills',
    '/servers',
    '/plugins/',
    '/plugins/plugin_review',
    '/knowledge/',
    '/knowledge/kb_review',
  ])('marks the resource nav for %s', async (path) => {
    const view = await inspectRoute(path, 'success');
    try {
      expect(activeNavLinks(view.host)).toEqual(['/agents']);
    } finally {
      await view.close();
    }
  });

  it('marks runs for both the list and a run detail', async () => {
    for (const path of ['/runs/', '/runs/run_review']) {
      const view = await inspectRoute(path, 'success');
      try {
        expect(activeNavLinks(view.host)).toEqual(['/runs']);
      } finally {
        await view.close();
      }
    }
  });

  it('keeps the other existing nav items marked', async () => {
    for (const [path, href] of [
      ['/', '/'],
      ['/chat', '/chat'],
      ['/schedules', '/schedules'],
      ['/eval', '/eval'],
      ['/status', '/status'],
      ['/audit', '/audit'],
    ] as const) {
      const view = await inspectRoute(path, 'success');
      try {
        expect(activeNavLinks(view.host)).toEqual([href]);
      } finally {
        await view.close();
      }
    }
  });

  it('marks no nav item for an unknown route even behind a known prefix', async () => {
    const view = await inspectRoute('/eval/missing', 'success');
    try {
      expect(activeNavLinks(view.host)).toEqual([]);
    } finally {
      await view.close();
    }
  });
});

const RESOURCE_LABEL = '专家·技能·连接器·插件·知识库';

function navLink(host: HTMLElement): HTMLAnchorElement {
  const link = Array.from(host.querySelectorAll('nav[aria-label="主导航"] a')).find(
    (candidate) => candidate.getAttribute('aria-label') === RESOURCE_LABEL,
  );
  if (!link) throw new Error(`Missing resource nav link named ${RESOURCE_LABEL}`);
  return link as HTMLAnchorElement;
}

describe('sidebar collapse', () => {
  it('keeps the same label node and accessible name through collapse and immediate expand', async () => {
    const view = await inspectRoute('/agents/', 'success');
    try {
      const link = navLink(view.host);
      const label = link.querySelector('span:last-child');
      expect(link.getAttribute('aria-current')).toBe('page');

      const collapse = view.host.querySelector<HTMLButtonElement>('button[aria-label="收起侧栏"]');
      await act(async () => collapse?.click());

      const collapsed = navLink(view.host);
      const collapsedLabel = collapsed.querySelector('span:last-child');
      expect(collapsedLabel).toBe(label);
      expect(collapsedLabel?.closest('[aria-hidden="true"]')).toBeNull();
      // 收起草稿只做 90ms 淡出：标签保留自身宽度（absolute），不能被裁成 0 宽。
      expect(collapsedLabel?.classList.contains('opacity-0')).toBe(true);
      expect(collapsedLabel?.classList.contains('absolute')).toBe(true);
      expect(collapsedLabel?.classList.contains('duration-[90ms]')).toBe(true);
      expect(collapsed.getAttribute('aria-current')).toBe('page');

      const expand = view.host.querySelector<HTMLButtonElement>('button[aria-label="展开侧栏"]');
      await act(async () => expand?.click());

      expect(navLink(view.host).querySelector('span:last-child')).toBe(label);
      expect(navLink(view.host).getAttribute('aria-current')).toBe('page');
      expect(view.host.querySelector('nav[aria-label="主导航"] .sr-only')).toBeNull();
    } finally {
      await view.close();
    }
  });

  it('only opens the nav tooltip while collapsed', async () => {
    vi.useFakeTimers();
    const view = await inspectRoute('/agents/', 'success');
    try {
      const link = navLink(view.host);
      link.focus();
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();

      const collapse = view.host.querySelector<HTMLButtonElement>('button[aria-label="收起侧栏"]');
      await act(async () => collapse?.click());
      // 同一 Link 节点跨状态保留，先失焦再聚焦才会重新触发 tooltip。
      await act(async () => navLink(view.host).blur());
      navLink(view.host).focus();
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(
        RESOURCE_LABEL,
      );
    } finally {
      vi.useRealTimers();
      await view.close();
    }
  });
});
