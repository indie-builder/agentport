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
import { ApiError, api } from '../src/lib/api.js';
import { LoginPage } from '../src/pages/login.js';

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

async function mountLogin(): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: LoginPage,
  });
  history = createMemoryHistory({ initialEntries: ['/login'] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute]),
    history,
  });
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

async function submitCredentials(): Promise<void> {
  const usernameInput = host.querySelector<HTMLInputElement>('#username');
  const passwordInput = host.querySelector<HTMLInputElement>('#password');
  const submitButton = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!usernameInput || !passwordInput || !submitButton) {
    throw new Error('Missing login controls');
  }
  await act(async () => {
    setInput(usernameInput, 'admin');
    setInput(passwordInput, 'secret');
  });
  await act(async () => {
    submitButton.click();
  });
  await flush();
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'me').mockResolvedValue({ authenticated: false });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
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

describe('login failure recovery', () => {
  it('explains rejected credentials', async () => {
    vi.spyOn(api, 'login').mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
    await mountLogin();

    await submitCredentials();

    const error = await waitFor(() => host.querySelector('#login-error')?.textContent);
    expect(error).toContain('用户名或密码错误');
    expect(
      host.querySelector('form[aria-label="登录"]')?.getAttribute('aria-describedby'),
    ).toContain('login-error');
  });

  it.each([
    [new ApiError(0, 'Failed to fetch'), '连不上 API 服务，请确认它已启动并检查网络后重试。'],
    [
      new ApiError(500, 'Internal detail'),
      '服务端暂时无法完成请求，请稍后重试；持续出现时查看服务日志。',
    ],
    [new Error('HTTP 502'), '请求没有完成，请稍后重试。'],
  ])('retains formatted non-credential error %s', async (error, message) => {
    vi.spyOn(api, 'login').mockRejectedValueOnce(error);
    await mountLogin();

    await submitCredentials();

    const text = await waitFor(() => host.querySelector('#login-error')?.textContent);
    expect(text).toContain(message);
    expect(text).not.toContain('用户名或密码错误');
  });
});
