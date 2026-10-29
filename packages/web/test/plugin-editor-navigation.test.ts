import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserHistory, createRoute, RouterProvider } from '@tanstack/react-router';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { PluginDialog } from '../src/pages/plugins.js';
import { captureBlockedNavigations, routerFor, settled } from './navigation-blocker.js';

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

const plugin = {
  id: 'plugin',
  slug: 'demo',
  runtimeName: 'demo',
  name: 'Demo 插件',
  description: '演示插件',
  version: '1.0.0',
  capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
  files: [],
  agentCount: 1,
  sourceId: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

function Harness() {
  const [open, setOpen] = useState(true);
  return open
    ? createElement(PluginDialog, {
        plugin,
        finalFocus: () => null,
        onClose: () => setOpen(false),
      })
    : createElement('p', null, '已关闭');
}

let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let history: ReturnType<typeof createBrowserHistory>;
let router: ReturnType<typeof routerFor>;
let blocked: Array<Promise<boolean>>;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) throw new Error(`Missing input: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  window.history.replaceState(null, '', '/plugins/');
  history = createBrowserHistory();
  blocked = captureBlockedNavigations(history);
  // 建立上一页条目，让保存中的 back() 是真实 POP，而不是同页刷新。
  history.replace('/plugins/other');
  await new Promise((resolve) => setTimeout(resolve, 0));
  history.push('/plugins/');
  await new Promise((resolve) => setTimeout(resolve, 0));
  router = routerFor(history, (shell) => [
    createRoute({ getParentRoute: () => shell, path: '/plugins/', component: Harness }),
    createRoute({
      getParentRoute: () => shell,
      path: '/plugins/other',
      component: () => createElement('p', null, '其他页面'),
    }),
  ]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  history?.destroy();
  host?.remove();
  vi.restoreAllMocks();
});

describe('plugin editor blocked navigation', () => {
  it('settles a POP blocked during save before the successful save closes the dialog', async () => {
    let finishSave!: () => void;
    const update = vi.spyOn(api, 'updatePlugin').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve(plugin);
        }),
    );
    await mount();
    expect(document.body.textContent).toContain('编辑插件');

    type('plugin-name', '新名称');
    await click(button('保存'));
    expect(update).toHaveBeenCalledOnce();

    // 保存请求未完成时用户按浏览器后退。
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await flush();
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    const pending = blocked.at(-1);
    expect(pending).toBeDefined();

    await act(async () => finishSave());
    await flush();

    expect(await settled(pending as Promise<boolean>)).toBe(true);
    expect(document.body.textContent).not.toContain('编辑插件');
    expect(document.body.textContent).not.toContain('放弃未保存的更改？');
    expect(history.location.pathname).toBe('/plugins/');

    // 结算后普通导航不再被遗留拦截挡住。
    await act(async () => {
      await router.navigate({ to: '/plugins/other' });
    });
    expect(document.body.textContent).toContain('其他页面');
  });
});
