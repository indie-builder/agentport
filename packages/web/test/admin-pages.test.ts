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
import { api, type HealthMetrics, type Overview } from '../src/lib/api.js';
import { LoginPage } from '../src/pages/login.js';
import { OverviewPage } from '../src/pages/overview.js';
import { StatusPage } from '../src/pages/status.js';
import { operationsSearchSchema } from '../src/routes/-search.js';
import { allAccessMe } from './me-fixture.js';

const metrics: HealthMetrics = {
  process: { uptimeSeconds: 20, memoryRssBytes: 1024, bunVersion: '1.3.0' },
  queue: null,
  knowledgeQueue: null,
  db: { connected: true, pingMs: 1, maxConnections: 10 },
  redis: { pingMs: 1 },
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createMemoryHistory> | undefined;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor<T>(probe: () => T, tries = 50): Promise<T> {
  for (let index = 0; index < tries; index += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {}
    await flush();
  }
  return probe();
}

async function mountPage(
  initialEntry: string,
  component: () => React.ReactNode,
  path: string,
  validateSearch?: typeof operationsSearchSchema,
): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const target =
    path === '/login'
      ? createRoute({ getParentRoute: () => rootRoute, path: '/login', component })
      : createRoute({
          getParentRoute: () => shell,
          path: path as never,
          ...(validateSearch === undefined ? {} : { validateSearch }),
          component,
        });
  const routeTree =
    path === '/login'
      ? rootRoute.addChildren([target])
      : rootRoute.addChildren([shell.addChildren([target])]);
  history = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createRouter({ routeTree, history });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(text: string): HTMLButtonElement {
  const element = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'me').mockResolvedValue({ authenticated: false });
  vi.spyOn(api, 'login').mockResolvedValue({ ok: true });
  vi.spyOn(api, 'healthLive').mockResolvedValue({
    reachable: true,
    httpStatus: 200,
    body: { status: 'ok' },
    error: null,
  });
  vi.spyOn(api, 'healthReady').mockResolvedValue({
    reachable: true,
    httpStatus: 200,
    body: { status: 'ok', db: 'ok', redis: 'ok' },
    error: null,
  });
  vi.spyOn(api, 'healthMetrics').mockResolvedValue(metrics);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  history?.destroy();
  history = undefined;
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('login validation', () => {
  it('allows an empty submission so required errors can be shown', async () => {
    await mountPage('/login', LoginPage, '/login');
    const submitButton = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submitButton) throw new Error('Missing login submit button');
    expect(submitButton.disabled).toBe(false);
    expect(host.querySelector('#username')?.hasAttribute('required')).toBe(true);
    expect(host.querySelector('#password')?.hasAttribute('required')).toBe(true);

    await click(submitButton);

    await waitFor(() => host.querySelector('#username-error')?.textContent);
    expect(host.querySelector('#username')?.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector('#username-error')?.textContent).toBeTruthy();
    expect(host.querySelector('#password')?.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector('#password-error')?.textContent).toBeTruthy();
    expect(api.login).not.toHaveBeenCalled();
  });

  it.each([
    ['', '', 'username'],
    ['admin', '', 'password'],
  ])('reports missing fields and focuses %s / %s', async (username, password, first) => {
    await mountPage('/login', LoginPage, '/login');
    const usernameInput = host.querySelector<HTMLInputElement>('#username');
    const passwordInput = host.querySelector<HTMLInputElement>('#password');
    const submitButton = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!usernameInput || !passwordInput || !submitButton) {
      throw new Error('Missing login controls');
    }
    await act(async () => {
      setInput(usernameInput, username);
      setInput(passwordInput, password);
    });

    await click(submitButton);

    await waitFor(() => host.querySelector(`#${first}-error`)?.textContent);
    expect(host.querySelector(`#${first}`)?.getAttribute('aria-invalid')).toBe('true');
    expect(host.querySelector(`#${first}-error`)?.textContent).toBeTruthy();
    expect(document.activeElement?.id).toBe(first);
    expect(api.login).not.toHaveBeenCalled();
  });
});

describe('overview summaries', () => {
  it.each([true, false])('labels enabled=%s visibly', async (enabled) => {
    const overview: Overview = {
      window: { days: 7, since: '2026-01-01T00:00:00Z' },
      counts: {
        agents: 1,
        servers: 1,
        runs: 0,
        running: 0,
        failed: 0,
        tokens: 0,
        costUsd: 0,
        avgLatencyMs: null,
      },
      recent: [],
      agents: [
        {
          agentId: 'a',
          name: 'LongExpertName',
          enabled,
          slug: 'a',
          createdAt: '',
          lastRunStartTime: null,
          runCount: 0,
          totalCost: 0,
          errorRate: 0,
          latencyP50: null,
          latencyP99: null,
          totalTokens: 0,
        },
      ],
    };
    client.setQueryData(['me'], allAccessMe);
    client.setQueryData(['health-metrics'], metrics);
    client.setQueryData(['overview'], overview);
    client.setQueryData(['overview', 'timeseries', 7], []);
    client.setQueryData(['attention'], { approvals: [], failedRuns: [], total: 0 });
    client.setQueryData(['retention'], {
      runDays: 30,
      messageDays: 30,
      agentVersions: 10,
      updatedAt: null,
      updatedBy: null,
    });

    await mountPage('/operations?tab=agents', OverviewPage, '/operations', operationsSearchSchema);

    await waitFor(() => host.textContent?.includes('LongExpertName'));
    expect(host.textContent).toContain(enabled ? '已启用' : '已停用');
  });
});

describe('smoke check announcements', () => {
  it('keeps the live region mounted before results arrive', async () => {
    await mountPage('/status', StatusPage, '/status');

    const liveRegion = host.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.textContent).toContain('就绪检查尚未运行');
  });

  it('renders readable success and failure with the actual probe outcomes', async () => {
    vi.spyOn(api, 'healthLive').mockResolvedValue({
      reachable: true,
      httpStatus: 200,
      body: { status: 'ok' },
      error: null,
    });
    vi.spyOn(api, 'healthReady').mockRejectedValue(new Error('Offline'));
    vi.spyOn(api, 'healthMetrics').mockResolvedValue(null);

    await mountPage('/status', StatusPage, '/status');
    await click(button('运行冒烟检查'));

    const liveRegion = await waitFor(() => {
      const region = host.querySelector('[aria-live="polite"]');
      const runButton = button('运行冒烟检查');
      return region?.textContent?.includes('GET /health/metrics') && !runButton.disabled
        ? region
        : null;
    });

    expect(liveRegion.textContent).toContain('通过');
    expect(liveRegion.textContent).toContain('失败');
    expect(liveRegion.textContent).toContain('Offline');
  });
});
