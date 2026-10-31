import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/app-shell.js';
import { PageHeader } from '../src/components/page.js';
import { routeTree } from '../src/routeTree.gen.js';
import { allAccessMe } from './me-fixture.js';

async function inspectRoute(
  path: string,
  auth: 'success' | 'pending' | 'error' | 'unauthenticated',
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (auth === 'success') client.setQueryData(['me'], allAccessMe);
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
    // 真实详情页按加载后的实体命名，这里用路由参数模拟不同实体的 h1。
    component: function AgentDetailPage() {
      const params = useParams({ strict: false });
      return createElement(PageHeader, { title: `专家 ${String(params.agentId)}` });
    },
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
    path: '/operations',
    component: () => createElement(PageHeader, { title: '概况' }),
  });
  const runtimeEnvironments = createRoute({
    getParentRoute: () => shell,
    path: '/runtime-environments/',
    component: () => createElement(PageHeader, { title: '运行环境' }),
  });
  const runsIndex = createRoute({
    getParentRoute: () => shell,
    path: '/runs/',
    component: () => createElement(PageHeader, { title: '运行' }),
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
        runsIndex,
        knowledge,
        knowledgeIndex,
        agentsIndex,
        agentDetail,
        skills,
        servers,
        overview,
        runtimeEnvironments,
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
        expect(document.title).toBe('页面不存在 · PACE');
        expect(view.host.querySelectorAll('h1')).toHaveLength(1);
        expect(view.host.querySelector('h1')?.textContent).toBe('页面不存在');
      } finally {
        await view.close();
      }
    },
  );

  it('names a matched knowledge detail by its page heading', async () => {
    const view = await inspectRoute('/knowledge/kb_review', 'success');
    try {
      expect(document.title).toBe('知识库详情 · PACE');
      expect(view.host.querySelectorAll('h1')).toHaveLength(1);
    } finally {
      await view.close();
    }
  });

  it('names a matched run detail by its page heading', async () => {
    const view = await inspectRoute('/runs/run_review', 'success');
    try {
      expect(document.title).toBe('运行详情 · PACE');
    } finally {
      await view.close();
    }
  });

  it.each(['/plugins', '/plugins/'])('names the plugin list route %s', async (path) => {
    const view = await inspectRoute(path, 'success');
    try {
      expect(document.title).toBe('插件 · PACE');
      expect(document.body.textContent).not.toContain('页面不存在');
    } finally {
      await view.close();
    }
  });

  it('names the plugin detail route by its page heading', async () => {
    const view = await inspectRoute('/plugins/plugin_review', 'success');
    try {
      expect(document.title).toBe('插件详情 · PACE');
    } finally {
      await view.close();
    }
  });

  it('names two different detail pages by their own heading', async () => {
    for (const [agentId, title] of [
      ['agent_alpha', '专家 agent_alpha · PACE'],
      ['agent_beta', '专家 agent_beta · PACE'],
    ] as const) {
      const view = await inspectRoute(`/agents/${agentId}`, 'success');
      try {
        expect(document.title).toBe(title);
      } finally {
        await view.close();
      }
    }
  });

  it('follows the main heading when a detail page updates it after loading', async () => {
    const view = await inspectRoute('/agents/agent_review', 'success');
    try {
      expect(document.title).toBe('专家 agent_review · PACE');
      const h1 = view.host.querySelector('#main-content h1');
      if (!h1) throw new Error('missing main heading');
      await act(async () => {
        h1.textContent = '数据分析专家';
      });
      await vi.waitFor(() => expect(document.title).toBe('数据分析专家 · PACE'));
    } finally {
      await view.close();
    }
  });

  it('drops the detail heading after leaving the detail route', async () => {
    const view = await inspectRoute('/agents/agent_review', 'success');
    try {
      expect(document.title).toBe('专家 agent_review · PACE');
      await act(async () => {
        await view.router.navigate({ to: '/chat' });
      });
      expect(document.title).toBe('对话 · PACE');
      const h1 = view.host.querySelector('#main-content h1');
      if (!h1) throw new Error('missing main heading');
      await act(async () => {
        h1.textContent = '不应进入标题';
      });
      expect(document.title).toBe('对话 · PACE');
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
    '/skills',
    '/servers',
    '/plugins/',
    '/plugins/plugin_review',
    '/knowledge/',
    '/knowledge/kb_review',
  ])('marks the resource nav for %s', async (path) => {
    const view = await inspectRoute(path, 'success');
    try {
      expect(activeNavLinks(view.host)).toEqual(['/skills']);
    } finally {
      await view.close();
    }
  });

  it.each(['/agents/', '/agents/agent_review'])(
    'marks the expert-finding nav for %s',
    async (path) => {
      const view = await inspectRoute(path, 'success');
      try {
        expect(activeNavLinks(view.host)).toEqual(['/agents']);
      } finally {
        await view.close();
      }
    },
  );

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
      ['/chat', '/chat'],
      ['/schedules', '/schedules'],
      ['/eval', '/eval'],
      ['/operations', '/operations'],
      ['/runtime-environments/', '/runtime-environments'],
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

function navLinks(host: HTMLElement): HTMLAnchorElement[] {
  return Array.from(host.querySelectorAll('nav[aria-label="主导航"] a'));
}

function navHrefs(host: HTMLElement): string[] {
  return navLinks(host).map((link) => link.getAttribute('href') ?? '');
}

describe('business and operations navigation contexts', () => {
  it('shows only business items plus the secondary operations entry on business pages', async () => {
    const view = await inspectRoute('/agents/', 'success');
    try {
      expect(navHrefs(view.host)).toEqual(['/agents', '/chat', '/schedules', '/skills', '/eval']);
      expect(view.host.querySelector('a[aria-label="运维"]')?.getAttribute('href')).toBe(
        '/operations',
      );
      for (const href of ['/operations', '/runs', '/runtime-environments', '/status', '/audit']) {
        expect(navHrefs(view.host)).not.toContain(href);
      }
    } finally {
      await view.close();
    }
  });

  it('shows only operations items and the workspace return on operations pages', async () => {
    const view = await inspectRoute('/operations', 'success');
    try {
      expect(navHrefs(view.host)).toEqual([
        '/operations',
        '/runs',
        '/runtime-environments',
        '/status',
        '/audit',
        '/accounts',
        '/roles',
      ]);
      expect(view.host.querySelector('a[aria-label="返回工作区"]')?.getAttribute('href')).toBe(
        '/agents',
      );
      for (const href of ['/agents', '/chat', '/schedules', '/skills', '/eval']) {
        expect(navHrefs(view.host)).not.toContain(href);
      }
    } finally {
      await view.close();
    }
  });

  it('keeps the operations context on every operations deep link', async () => {
    for (const path of [
      '/runs/',
      '/runs/run_review',
      '/runtime-environments/',
      '/status',
      '/audit',
    ]) {
      const view = await inspectRoute(path, 'success');
      try {
        expect(navHrefs(view.host)[0]).toBe('/operations');
        expect(view.host.querySelector('a[aria-label="返回工作区"]')).not.toBeNull();
      } finally {
        await view.close();
      }
    }
  });

  it('falls back to the business context for unknown routes without selecting an item', async () => {
    const view = await inspectRoute('/runs/missing/extra', 'success');
    try {
      expect(navHrefs(view.host)).toEqual(['/agents', '/chat', '/schedules', '/skills', '/eval']);
      expect(activeNavLinks(view.host)).toEqual([]);
    } finally {
      await view.close();
    }
  });

  it.each([
    ['/agents/', '找专家 · PACE'],
    ['/skills', '资源 · PACE'],
    ['/servers', '连接器 · PACE'],
    ['/knowledge/', '知识库 · PACE'],
    ['/operations', '概况 · PACE'],
    ['/runs/', '运行 · PACE'],
    ['/runtime-environments/', '运行环境 · PACE'],
    ['/status', '健康 · PACE'],
    ['/audit', '审计 · PACE'],
  ])('names the business page %s as %s', async (path, title) => {
    const view = await inspectRoute(path, 'success');
    try {
      expect(document.title).toBe(title);
    } finally {
      await view.close();
    }
  });
});

describe('default workspace route', () => {
  it('redirects / to the expert-finding page', async () => {
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const router = createRouter({ routeTree, history });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(['me'], allAccessMe);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        await router.load();
        root.render(
          createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
        );
      });
      await vi.waitFor(() => expect(router.state.location.pathname).toBe('/agents'));
    } finally {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      history.destroy();
    }
  });
});

const RESOURCE_LABEL = '资源';

function navLink(host: HTMLElement): HTMLAnchorElement {
  const link = Array.from(host.querySelectorAll('nav[aria-label="主导航"] a')).find(
    (candidate) => candidate.getAttribute('aria-label') === RESOURCE_LABEL,
  );
  if (!link) throw new Error(`Missing resource nav link named ${RESOURCE_LABEL}`);
  return link as HTMLAnchorElement;
}

describe('personal entry', () => {
  it('sends the bottom user info to the profile in both sidebar states', async () => {
    const view = await inspectRoute('/agents/', 'success');
    try {
      expect(view.host.querySelector('a[aria-label="个人资料"]')?.getAttribute('href')).toBe(
        '/personal/profile',
      );
      const collapse = view.host.querySelector<HTMLButtonElement>('button[aria-label="收起侧栏"]');
      await act(async () => collapse?.click());
      const collapsed = view.host.querySelector('a[aria-label="个人资料"]');
      expect(collapsed?.getAttribute('href')).toBe('/personal/profile');
    } finally {
      await view.close();
    }
  });
});

describe('sidebar collapse', () => {
  it('keeps the same label node and accessible name through collapse and immediate expand', async () => {
    const view = await inspectRoute('/skills', 'success');
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
    const view = await inspectRoute('/skills', 'success');
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
