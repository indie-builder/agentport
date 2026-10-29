import type { ApiTool, Server } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserHistory, createRoute, RouterProvider } from '@tanstack/react-router';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { ServerFormDialog, ToolForm } from '../src/pages/servers.js';
import { captureBlockedNavigations, routerFor, settled } from './navigation-blocker.js';

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

const server: Server = {
  id: 'srv',
  kind: 'stdio',
  name: 'demo',
  description: '',
  command: 'npx',
  args: [],
  env: {},
  createdAt: '2026-01-01',
  updatedAt: 'v1',
  lastTestedAt: null,
  lastTestOk: null,
  lastToolCount: null,
  lastTestRuntimeEnvironment: null,
};

const tool: ApiTool = {
  id: 'tool',
  serverId: 'srv',
  name: 'list-users',
  description: '',
  method: 'GET',
  pathTemplate: '/users',
  inputSchema: { type: 'object', properties: {} },
  paramsIn: 'query',
  requiresApproval: false,
  enabled: true,
  createdAt: '2026-01-01',
};

function ConnectorHarness() {
  const [state, setState] = useState<'open' | 'closed' | 'saved'>('open');
  return state === 'open'
    ? createElement(ServerFormDialog, {
        server,
        getReturnFocus: () => null,
        onClose: () => setState('closed'),
        onSaved: () => setState('saved'),
      })
    : createElement('p', null, state === 'saved' ? '已保存' : '已关闭');
}

function ToolHarness({ editing }: { editing: ApiTool | null }) {
  const [open, setOpen] = useState(true);
  return open
    ? createElement(ToolForm, {
        serverId: 'srv',
        tool: editing,
        disabled: false,
        onDirtyChange: () => {},
        onPendingChange: () => {},
        onDone: () => setOpen(false),
        onCancel: () => {},
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

function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) throw new Error(`Missing input: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  const form = document.querySelector('form');
  if (!form) throw new Error('Missing form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mount(component: () => ReturnType<typeof createElement>) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  window.history.replaceState(null, '', '/servers');
  history = createBrowserHistory();
  blocked = captureBlockedNavigations(history);
  history.replace('/servers/other');
  await new Promise((resolve) => setTimeout(resolve, 0));
  history.push('/servers');
  await new Promise((resolve) => setTimeout(resolve, 0));
  router = routerFor(history, (shell) => [
    createRoute({ getParentRoute: () => shell, path: '/servers', component }),
    createRoute({
      getParentRoute: () => shell,
      path: '/servers/other',
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

async function popWhileSaving() {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
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

describe('server connector blocked navigation', () => {
  it('settles a POP blocked during save before the successful save closes the dialog', async () => {
    let finishSave!: () => void;
    const update = vi.spyOn(api, 'updateServer').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ ...server, name: 'demo2', updatedAt: 'v2' });
        }),
    );
    await mount(() => createElement(ConnectorHarness));
    expect(document.body.textContent).toContain('编辑「demo」');

    fill('server-name', 'demo2');
    await click(button('保存更改'));
    expect(update).toHaveBeenCalledOnce();

    await popWhileSaving();
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    const pending = blocked.at(-1);
    expect(pending).toBeDefined();

    await act(async () => finishSave());
    await flush();

    expect(await settled(pending as Promise<boolean>)).toBe(true);
    expect(document.body.textContent).toBe('已保存');
    expect(history.location.pathname).toBe('/servers');
  });
});

describe('server tool blocked navigation', () => {
  it('settles a POP blocked during save before the successful save unmounts the form', async () => {
    let finishSave!: () => void;
    const update = vi.spyOn(api, 'updateTool').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ ...tool, name: 'list-all' });
        }),
    );
    await mount(() => createElement(ToolHarness, { editing: tool }));

    fill('tool-name-srv', 'list-all');
    await submit();
    expect(update).toHaveBeenCalledOnce();

    await popWhileSaving();
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    const pending = blocked.at(-1);
    expect(pending).toBeDefined();

    await act(async () => finishSave());
    await flush();

    expect(await settled(pending as Promise<boolean>)).toBe(true);
    expect(document.body.textContent).toBe('已关闭');
    expect(history.location.pathname).toBe('/servers');
  });

  it('settles a POP blocked during create even though the form stays open', async () => {
    let finishSave!: () => void;
    const create = vi.spyOn(api, 'createTool').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ ...tool, id: 'tool-new', name: 'new-tool' });
        }),
    );
    await mount(() => createElement(ToolHarness, { editing: null }));

    fill('tool-name-srv', 'new-tool');
    fill('tool-path-srv', '/new');
    await submit();
    expect(create).toHaveBeenCalledOnce();

    await popWhileSaving();
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    const pending = blocked.at(-1);
    expect(pending).toBeDefined();

    await act(async () => finishSave());
    await flush();

    expect(await settled(pending as Promise<boolean>)).toBe(true);
    expect(document.body.textContent).toContain('添加工具');
    expect(history.location.pathname).toBe('/servers');
  });
});
