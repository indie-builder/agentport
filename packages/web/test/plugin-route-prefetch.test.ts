import type { Plugin } from '@agentport/shared';
import { QueryClientProvider } from '@tanstack/react-query';
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
import { queryClient } from '../src/lib/queries.js';
import { router as appRouter } from '../src/router.js';
import { Route as PluginRouteImport } from '../src/routes/_shell/plugins.$pluginId.js';

const plugin: Plugin = {
  id: 'plugin-1',
  slug: 'demo',
  runtimeName: 'demo',
  name: '演示插件',
  description: '演示插件的能力',
  version: '1.0.0',
  sourceId: 'demo@market',
  capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
  files: [{ path: 'README.md', content: '# 演示插件\n\nBODY-TOKEN', executable: false }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let host: HTMLDivElement | undefined;
let root: Root | undefined;

function buildRouter(initialEntry: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: '/_shell',
    component: Outlet,
  });
  const pluginRoute = PluginRouteImport.update({
    id: '/plugins/$pluginId',
    path: '/plugins/$pluginId',
    getParentRoute: () => shell,
  } as never);

  return createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([pluginRoute])]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });
}

async function render(router: ReturnType<typeof buildRouter>): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  queryClient.clear();
  host?.remove();
  host = undefined;
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('plugin detail route prefetch', () => {
  it('uses the shared query client and intent preloading without a duplicate request', async () => {
    const fetchPlugin = vi.spyOn(api, 'plugin').mockResolvedValue(plugin);
    const router = buildRouter('/plugins/plugin-1');

    await act(async () => {
      await router.preloadRoute({
        to: '/plugins/$pluginId',
        params: { pluginId: 'plugin-1' },
      });
    });
    expect(fetchPlugin).toHaveBeenCalledTimes(1);
    expect(fetchPlugin).toHaveBeenCalledWith('plugin-1');

    await render(router);
    expect(fetchPlugin).toHaveBeenCalledTimes(1);
    expect(host?.textContent).toContain('演示插件');
    expect(host?.textContent).toContain('BODY-TOKEN');
  });

  it('keeps the app router on intent preloading with Query-controlled freshness', () => {
    expect(appRouter.options.defaultPreload).toBe('intent');
    expect(appRouter.options.defaultPreloadStaleTime).toBe(0);
  });

  it('leaves a failed prefetch to the page error state instead of the route', async () => {
    vi.spyOn(api, 'plugin').mockRejectedValue(new Error('plugin offline'));
    const router = buildRouter('/plugins/plugin-1');

    await act(async () => {
      await router.preloadRoute({
        to: '/plugins/$pluginId',
        params: { pluginId: 'plugin-1' },
      });
    });
    await render(router);

    expect(host?.textContent).toContain('内容没有加载出来');
    expect(host?.textContent).toContain('plugin offline');
  });
});
