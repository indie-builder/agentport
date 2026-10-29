import type { RuntimeEnvironment, Server } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { ServersPage } from '../src/pages/servers.js';

const state = vi.hoisted(() => ({
  search: {} as Record<string, string | undefined>,
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: 'a',
  useSearch: () => state.search,
  useNavigate: () => state.navigate,
}));

const defaultEnvironment: RuntimeEnvironment = {
  id: 'rte_default',
  name: '默认环境',
  dockerfile: 'FROM base',
  isDefault: true,
  onlineVersionId: 'rtev_default',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const namedEnvironment: RuntimeEnvironment = {
  ...defaultEnvironment,
  id: 'rte_named',
  name: '数据分析',
  isDefault: false,
  onlineVersionId: null,
};
const stdioServer: Server = {
  id: 'server-stdio',
  name: 'stdio-connector',
  description: '',
  kind: 'stdio',
  command: 'node',
  args: [],
  env: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const httpServer: Server = {
  id: 'server-http',
  name: 'http-connector',
  description: '',
  kind: 'http',
  url: 'https://example.com/mcp',
  headers: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const resolvedEnvironment = {
  environmentId: namedEnvironment.id,
  environmentName: namedEnvironment.name,
  versionId: 'rtev_1234abcd',
  imageId: 'sha256:image',
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(servers: Server[]): Promise<void> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  client.setQueryData(['servers'], servers);
  client.setQueryData(['agents'], []);
  client.setQueryData(['runtime-environments'], [defaultEnvironment, namedEnvironment]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(ServersPage)));
  });
  await flush();
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flush();
}

function serverCard(name: string): HTMLElement {
  const card = [...document.querySelectorAll<HTMLElement>('[data-slot="server-card"]')].find(
    (item) => item.textContent?.includes(name),
  );
  if (!card) throw new Error(`Missing server card: ${name}`);
  return card;
}

async function openTest(name: string): Promise<HTMLButtonElement> {
  const trigger = serverCard(name).querySelector<HTMLButtonElement>(`[aria-label="操作 ${name}"]`);
  if (!trigger) throw new Error(`Missing server menu: ${name}`);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  });
  await flush();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent?.trim() === '测试连接',
  );
  if (!item) throw new Error('Missing test menu item');
  await click(item);
  return trigger;
}

function dialog(title: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
  if (!element) throw new Error(`Missing dialog: ${title}`);
  return element;
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

async function selectEnvironment(name: string): Promise<void> {
  const trigger = document.getElementById('server-test-environment');
  if (!trigger) throw new Error('Missing environment select');
  await click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === name,
  );
  if (!option) throw new Error(`Missing environment option: ${name}`);
  await click(option);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
  vi.spyOn(api, 'agents').mockResolvedValue([]);
  vi.spyOn(api, 'runtimeEnvironments').mockResolvedValue([defaultEnvironment, namedEnvironment]);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('server test environment identity', () => {
  it('returns focus to the server menu after cancelling or confirming the stdio test dialog', async () => {
    vi.spyOn(api, 'servers').mockResolvedValue([stdioServer]);
    const testServer = vi
      .spyOn(api, 'testServer')
      .mockResolvedValue({ ok: true, tools: [], durationMs: 10 });
    await mount([stdioServer]);

    const trigger = await openTest(stdioServer.name);
    await click(button('取消', dialog(`测试 ${stdioServer.name}`)));
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));

    const reopened = await openTest(stdioServer.name);
    await click(button('开始测试', dialog(`测试 ${stdioServer.name}`)));
    expect(testServer).toHaveBeenCalledWith(stdioServer.id, null);
    await vi.waitFor(() => expect(document.activeElement).toBe(reopened));
  });

  it('does not carry a stdio environment into a later HTTP retest', async () => {
    vi.spyOn(api, 'servers').mockResolvedValue([stdioServer, httpServer]);
    const testServer = vi
      .spyOn(api, 'testServer')
      .mockResolvedValueOnce({
        ok: true,
        tools: [{ name: 'stdio-tool' }],
        runtimeEnvironment: resolvedEnvironment,
        durationMs: 40,
      })
      .mockResolvedValueOnce({ ok: true, tools: [{ name: 'http-tool' }], durationMs: 20 });
    await mount([stdioServer, httpServer]);

    await openTest(stdioServer.name);
    await selectEnvironment(namedEnvironment.name);
    await click(button('开始测试', dialog(`测试 ${stdioServer.name}`)));
    expect(testServer).toHaveBeenNthCalledWith(1, stdioServer.id, namedEnvironment.id);

    await openTest(httpServer.name);
    expect(testServer).toHaveBeenNthCalledWith(2, httpServer.id, null);

    await click(button(`查看 ${httpServer.name} 工具与测试详情`));
    const tools = dialog(`工具与试连「${httpServer.name}」`);
    expect(tools.textContent).toContain('http-tool');
    expect(tools.textContent).not.toContain(namedEnvironment.name);
    expect(tools.textContent).toContain('只代表这一个环境版本');
  });

  it('shows the persisted last-test environment after refresh', async () => {
    const refreshed: Server = {
      ...stdioServer,
      lastTestedAt: '2026-10-29T08:00:00.000Z',
      lastTestOk: true,
      lastToolCount: 1,
      lastTestRuntimeEnvironment: resolvedEnvironment,
    };
    vi.spyOn(api, 'servers').mockResolvedValue([refreshed]);
    await mount([refreshed]);

    const card = serverCard(stdioServer.name);
    expect(card.textContent).toContain(`上次试连通过 · ${namedEnvironment.name}`);
    expect(card.textContent).not.toContain('未测试');

    await click(button(`查看 ${stdioServer.name} 工具与测试详情`));
    const tools = dialog(`工具与试连「${stdioServer.name}」`);
    expect(tools.textContent).toContain(`环境 ${namedEnvironment.name} · 1234abcd`);
    expect(tools.textContent).toContain('重新测试后查看工具目录。');
  });
});
