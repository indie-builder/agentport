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
const otherEnvironment: RuntimeEnvironment = {
  ...defaultEnvironment,
  id: 'rte_other',
  name: '浏览器工具',
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
const generatedServer: Server = {
  id: 'server-generated',
  name: 'generated-connector',
  description: '',
  kind: 'generated',
  baseUrl: 'https://api.example.com',
  headers: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const secondStdioServer: Server = {
  ...stdioServer,
  id: 'server-stdio-second',
  name: 'stdio-second',
};
const resolvedEnvironment = {
  environmentId: namedEnvironment.id,
  environmentName: namedEnvironment.name,
  versionId: 'rtev_1234abcd',
  imageId: 'sha256:image',
};
function resolved(environment: RuntimeEnvironment) {
  return {
    environmentId: environment.id,
    environmentName: environment.name,
    versionId: `rtev_${environment.id}`,
    imageId: `sha256:${environment.id}`,
  };
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(
  servers: Server[],
  { cacheEnvironments = true }: { cacheEnvironments?: boolean } = {},
): Promise<void> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  client.setQueryData(['servers'], servers);
  client.setQueryData(['agents'], []);
  if (cacheEnvironments) {
    client.setQueryData(
      ['runtime-environments'],
      [defaultEnvironment, namedEnvironment, otherEnvironment],
    );
  }
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

  it('does not carry a stdio environment into a later HTTP or generated retest', async () => {
    vi.spyOn(api, 'servers').mockResolvedValue([stdioServer, httpServer, generatedServer]);
    const testServer = vi
      .spyOn(api, 'testServer')
      .mockResolvedValueOnce({
        ok: true,
        tools: [{ name: 'stdio-tool' }],
        runtimeEnvironment: resolvedEnvironment,
        durationMs: 40,
      })
      .mockResolvedValueOnce({ ok: true, tools: [{ name: 'http-tool' }], durationMs: 20 })
      .mockResolvedValueOnce({ ok: true, tools: [{ name: 'generated-tool' }], durationMs: 20 });
    await mount([stdioServer, httpServer, generatedServer]);

    await openTest(stdioServer.name);
    await selectEnvironment(namedEnvironment.name);
    await click(button('开始测试', dialog(`测试 ${stdioServer.name}`)));
    expect(testServer).toHaveBeenNthCalledWith(1, stdioServer.id, namedEnvironment.id);

    await openTest(httpServer.name);
    expect(testServer).toHaveBeenNthCalledWith(2, httpServer.id, null);

    await openTest(generatedServer.name);
    expect(testServer).toHaveBeenNthCalledWith(3, generatedServer.id, null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await click(button(`查看 ${httpServer.name} 工具与测试详情`));
    const tools = dialog(`工具与试连「${httpServer.name}」`);
    expect(tools.textContent).toContain('http-tool');
    expect(tools.textContent).not.toContain(namedEnvironment.name);
    expect(tools.textContent).toContain('只代表这一个环境版本');
  });

  it('keeps each stdio server on its own last environment across tests and detail retests', async () => {
    vi.spyOn(api, 'servers').mockResolvedValue([stdioServer, secondStdioServer]);
    const testServer = vi
      .spyOn(api, 'testServer')
      .mockResolvedValueOnce({
        ok: true,
        tools: [{ name: 'first-tool' }],
        runtimeEnvironment: resolved(namedEnvironment),
        durationMs: 40,
      })
      .mockResolvedValueOnce({
        ok: true,
        tools: [{ name: 'second-tool' }],
        runtimeEnvironment: resolved(otherEnvironment),
        durationMs: 30,
      })
      .mockResolvedValueOnce({
        ok: true,
        tools: [{ name: 'first-tool' }],
        runtimeEnvironment: resolved(namedEnvironment),
        durationMs: 20,
      });
    await mount([stdioServer, secondStdioServer]);

    await openTest(stdioServer.name);
    await selectEnvironment(namedEnvironment.name);
    await click(button('开始测试', dialog(`测试 ${stdioServer.name}`)));
    expect(testServer).toHaveBeenNthCalledWith(1, stdioServer.id, namedEnvironment.id);

    await openTest(secondStdioServer.name);
    await selectEnvironment(otherEnvironment.name);
    await click(button('开始测试', dialog(`测试 ${secondStdioServer.name}`)));
    expect(testServer).toHaveBeenNthCalledWith(2, secondStdioServer.id, otherEnvironment.id);

    await click(button(`查看 ${stdioServer.name} 工具与测试详情`));
    const details = dialog(`工具与试连「${stdioServer.name}」`);
    await click(button('重新测试', details));
    const environmentDialog = dialog(`测试 ${stdioServer.name}`);
    expect(document.getElementById('server-test-environment')?.textContent).toContain(
      namedEnvironment.name,
    );
    await click(button('开始测试', environmentDialog));
    expect(testServer).toHaveBeenNthCalledWith(3, stdioServer.id, namedEnvironment.id);
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
    const testServer = vi.spyOn(api, 'testServer').mockResolvedValue({
      ok: true,
      tools: [],
      runtimeEnvironment: resolvedEnvironment,
      durationMs: 10,
    });
    await mount([refreshed]);

    const card = serverCard(stdioServer.name);
    expect(card.textContent).toContain(`上次试连通过 · ${namedEnvironment.name}`);
    expect(card.textContent).not.toContain('未测试');

    await click(button(`查看 ${stdioServer.name} 工具与测试详情`));
    const tools = dialog(`工具与试连「${stdioServer.name}」`);
    expect(tools.textContent).toContain(`环境 ${namedEnvironment.name} · 1234abcd`);
    expect(tools.textContent).toContain('重新测试后查看工具目录。');

    await click(button('重新测试', tools));
    const environmentDialog = dialog(`测试 ${stdioServer.name}`);
    expect(document.getElementById('server-test-environment')?.textContent).toContain(
      namedEnvironment.name,
    );
    expect(environmentDialog.textContent).not.toContain('上次使用的环境已不在当前列表中');
    await click(button('开始测试', environmentDialog));
    expect(testServer).toHaveBeenCalledWith(stdioServer.id, namedEnvironment.id);
  });

  it('explains when the last environment is gone and tests the preselected default after confirmation', async () => {
    const removedEnvironment = {
      ...resolvedEnvironment,
      environmentId: 'rte_removed',
      environmentName: '已删除环境',
    };
    const refreshed: Server = {
      ...stdioServer,
      lastTestedAt: '2026-10-29T08:00:00.000Z',
      lastTestOk: true,
      lastToolCount: 1,
      lastTestRuntimeEnvironment: removedEnvironment,
    };
    vi.spyOn(api, 'servers').mockResolvedValue([refreshed]);
    const testServer = vi
      .spyOn(api, 'testServer')
      .mockResolvedValue({ ok: true, tools: [], durationMs: 10 });
    await mount([refreshed]);

    await openTest(stdioServer.name);
    const environmentDialog = dialog(`测试 ${stdioServer.name}`);
    const select = document.getElementById('server-test-environment');
    expect(select?.textContent).toContain(defaultEnvironment.name);
    expect(select?.textContent).not.toContain(removedEnvironment.environmentName);
    expect(environmentDialog.textContent).toContain(
      '上次使用的环境已不在当前列表中，已预选默认环境',
    );
    expect(button('开始测试', environmentDialog).disabled).toBe(false);
    await click(button('开始测试', environmentDialog));
    expect(testServer).toHaveBeenCalledWith(stdioServer.id, null);
  });

  it('blocks starting when the cached environment list fails to refresh, and retries explicitly', async () => {
    vi.spyOn(api, 'servers').mockResolvedValue([stdioServer]);
    const testServer = vi
      .spyOn(api, 'testServer')
      .mockResolvedValue({ ok: true, tools: [], durationMs: 10 });
    await mount([stdioServer]);

    const fetchMock = vi.fn().mockRejectedValue(new Error('运行环境服务不可用'));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      await client.refetchQueries({ queryKey: ['runtime-environments'] });
    });
    await flush();

    await openTest(stdioServer.name);
    const environmentDialog = dialog(`测试 ${stdioServer.name}`);
    expect(environmentDialog.textContent).toContain('运行环境列表没有加载出来');
    expect(button('开始测试', environmentDialog).disabled).toBe(true);
    await click(button('开始测试', environmentDialog));
    expect(testServer).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      Response.json([defaultEnvironment, namedEnvironment, otherEnvironment]),
    );
    await click(button('重试', environmentDialog));
    await flush();
    expect(environmentDialog.textContent).not.toContain('运行环境列表没有加载出来');
    const start = button('开始测试', environmentDialog);
    expect(start.disabled).toBe(false);
    await click(start);
    expect(testServer).toHaveBeenCalledWith(stdioServer.id, null);
  });

  it('waits for the environment list and retries it before allowing a test', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(
        Response.json([defaultEnvironment, namedEnvironment, otherEnvironment]),
      );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(api, 'servers').mockResolvedValue([stdioServer]);
    const testServer = vi
      .spyOn(api, 'testServer')
      .mockResolvedValue({ ok: true, tools: [], durationMs: 10 });
    await mount([stdioServer], { cacheEnvironments: false });

    await openTest(stdioServer.name);
    const environmentDialog = dialog(`测试 ${stdioServer.name}`);
    expect(environmentDialog.textContent).toContain('正在加载运行环境');
    expect(button('开始测试', environmentDialog).disabled).toBe(true);
    await click(button('开始测试', environmentDialog));
    expect(testServer).not.toHaveBeenCalled();

    await act(async () => rejectFirst?.(new Error('运行环境服务不可用')));
    await flush();
    expect(environmentDialog.textContent).toContain('运行环境列表没有加载出来');
    expect(button('开始测试', environmentDialog).disabled).toBe(true);

    await click(button('重试', environmentDialog));
    await flush();
    expect(environmentDialog.textContent).not.toContain('运行环境列表没有加载出来');
    const start = button('开始测试', environmentDialog);
    expect(start.disabled).toBe(false);
    await click(start);
    expect(testServer).toHaveBeenCalledWith(stdioServer.id, null);
  });
});
