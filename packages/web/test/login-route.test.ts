import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Me } from '../src/lib/api.js';
import { queryClient } from '../src/lib/queries.js';
import { routeTree } from '../src/routeTree.gen.js';

vi.mock('../src/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api.js')>();
  return {
    ...actual,
    api: { ...actual.api, me: vi.fn(), login: vi.fn(), agents: vi.fn() },
  };
});

const TARGET = '/agents/agent_1';
const LOGIN_PATH = '/login?returnTo=%2Fagents%2Fagent_1';

let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createMemoryHistory> | undefined;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function mount(path = LOGIN_PATH) {
  history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
  await act(async () => {
    await router.load();
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  await flush();
  return router;
}

function form(): HTMLFormElement {
  const element = host.querySelector<HTMLFormElement>('form[aria-label="登录"]');
  if (!element) throw new Error('Missing login form');
  return element;
}

async function submit(password: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]');
  if (!input) throw new Error('Missing password input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, password);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  queryClient.clear();
  // 用真实共享客户端跑，但关掉重试，请求次数才能精确断言。
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  vi.mocked(api.me).mockReset();
  vi.mocked(api.login).mockReset();
  vi.mocked(api.agents).mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  history?.destroy();
  history = undefined;
  document.body.replaceChildren();
  queryClient.clear();
});

describe('login route session check', () => {
  it('renders the form immediately while the shared session check is still pending', async () => {
    let settle!: (me: Me) => void;
    vi.mocked(api.me).mockReturnValue(
      new Promise<Me>((resolve) => {
        settle = resolve;
      }),
    );

    const router = await mount();

    expect(api.me).toHaveBeenCalledTimes(1);
    expect(host.querySelector('form[aria-label="登录"]')).not.toBeNull();
    expect(router.state.location.pathname).toBe('/login');

    await act(async () => settle({ authenticated: false }));
    await flush();
    expect(router.state.location.pathname).toBe('/login');
    expect(host.querySelector('form[aria-label="登录"]')).not.toBeNull();
  });

  it('does not trust a stale authenticated cache when the fresh check fails, and the form still logs in', async () => {
    queryClient.setQueryData(['me'], { authenticated: true, username: 'admin' });
    vi.mocked(api.me).mockRejectedValue(new Error('offline'));

    const router = await mount();

    expect(api.me).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/login');
    expect(form()).not.toBeNull();

    vi.mocked(api.login).mockResolvedValue({ ok: true });
    vi.mocked(api.me).mockResolvedValue({ authenticated: true, username: 'admin' });
    vi.mocked(api.agents).mockResolvedValue([]);
    await submit('secret');

    expect(api.login).toHaveBeenCalledWith('admin', 'secret');
    // 首次检查 + 登录后刷新，各一次；不会因旧缓存重复请求。
    expect(api.me).toHaveBeenCalledTimes(2);
    expect(router.state.location.pathname).toBe(TARGET);
  });
});
