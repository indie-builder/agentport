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

async function inspectRoute(path: string, auth: 'success' | 'pending' | 'error') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (auth === 'success') client.setQueryData(['me'], { authenticated: true, username: 'review' });
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      shell.addChildren([missing, detail, pluginsIndex, pluginDetail]),
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
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
    },
  };
}

beforeEach(() => vi.spyOn(window, 'scrollTo').mockImplementation(() => {}));
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
