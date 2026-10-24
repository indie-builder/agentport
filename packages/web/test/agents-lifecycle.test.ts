import { type Agent, agentInputSchema } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
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
import { AgentDetailPage, AgentsPage } from '../src/pages/agents.js';

const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  parentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const restored = { ...agent, name: 'Restored expert', updatedAt: '2026-02-01T00:00:00Z' };
const versions = [{ id: 'version-1', version: 1, note: null, createdAt: agent.createdAt }];
let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createBrowserHistory>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
/** 导航是异步的：轮询直到谓词成立，避免固定 flush 撞上还没渲染的页面。 */
async function waitFor<T>(probe: () => T, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 页面切换过程中元素还没挂载，继续等。
    }
    await flush();
  }
  return probe();
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}
function field(): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>('#agent-name');
  if (!element) throw new Error('Missing name field');
  return element;
}
async function editName(value: string) {
  await editInput('agent-name', value);
}
async function editInput(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing input: ${id}`);
  }
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function selectRole(role: string, id = 'new-agent-role') {
  const trigger = document.getElementById(id);
  if (!trigger) throw new Error('Missing role select');
  await click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === role,
  );
  if (!option) throw new Error(`Missing role option: ${role}`);
  await click(option);
}
function dialog(title: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
  if (!element) throw new Error(`Missing dialog: ${title}`);
  return element;
}
async function mount() {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const experts = createRoute({
    getParentRoute: () => shell,
    path: '/agents/',
    component: AgentsPage,
  });
  const expertDetail = createRoute({
    getParentRoute: () => shell,
    path: '/agents/$agentId',
    component: AgentDetailPage,
  });
  const away = createRoute({
    getParentRoute: () => shell,
    path: '/away',
    component: () => createElement('h1', null, 'Away'),
  });
  window.history.replaceState(null, '', '/agents');
  history = createBrowserHistory();
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([experts, expertDetail, away])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
}
async function openHistory(dirty = false) {
  await click(button('配置 Expert'));
  await waitFor(() => document.querySelector('#agent-name'));
  if (dirty) await editName('Unsaved draft');
  await click(button('版本历史'));
}
async function confirmRollback() {
  await click(button('回滚', dialog('版本历史')));
  const confirmation = dialog('回滚到 v1');
  await click(button('回滚', confirmation));
}
async function importFile(warnings: string[]) {
  vi.spyOn(api, 'importAgent').mockResolvedValue({
    agent,
    warnings,
    createdServers: [],
    reusedServers: [],
    createdSkills: [],
  });
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing import input');
  const file = new File(['{}'], 'expert.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => '{}' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await flush();
  await waitFor(() => document.querySelector('#agent-name'));
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(api, 'agents').mockResolvedValue([agent]);
  vi.spyOn(api, 'servers').mockResolvedValue([]);
  vi.spyOn(api, 'skills').mockResolvedValue([]);
  vi.spyOn(api, 'agentVersions').mockResolvedValue(versions);
  vi.spyOn(api, 'agentVersion').mockResolvedValue({
    version: 1,
    snapshot: restored,
    createdAt: agent.createdAt,
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  client.setQueryData(['agents'], [agent]);
  client.setQueryData(['servers'], []);
  client.setQueryData(['skills'], []);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  history.destroy();
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('expert creation lifecycle', () => {
  it('submits the selected occupation and reaches the created expert without a discard prompt', async () => {
    const created = {
      ...agent,
      id: 'new-expert',
      slug: 'new-expert',
      name: 'New expert',
      role: '测试工程师',
    };
    const create = vi.spyOn(api, 'createAgent').mockResolvedValue(created);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([agent, created]));
    const router = await mount();
    await click(button('新建专家'));
    await editInput('new-agent-slug', 'new-expert');
    await editInput('new-agent-name', 'New expert');
    await selectRole('测试工程师');
    await click(button('创建', dialog('新建专家')));
    await waitFor(() => router.state.location.pathname === '/agents/new-expert');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ role: '测试工程师' }));
    expect(router.state.location.pathname).toBe('/agents/new-expert');
    expect(document.body.textContent).not.toContain('放弃未保存的更改？');
    await waitFor(() => document.querySelector('#agent-name'));
    expect(field().value).toBe('New expert');
  });

  it('initializes twin defaults cleanly and protects edited working background', async () => {
    await mount();
    await click(button('创建数字分身'));
    let setup = dialog('创建数字分身');
    expect(setup.querySelector<HTMLInputElement>('#new-agent-name')?.value).toBe('我的分身');
    expect(setup.querySelector('#new-agent-role')).toBeNull();
    expect(setup.textContent).toContain('数字分身');
    expect(setup.querySelector<HTMLTextAreaElement>('#new-agent-prompt')?.value).toBe('');
    await click(button('取消', setup));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(button('创建数字分身'));
    setup = dialog('创建数字分身');
    await editInput('new-agent-prompt', '我是产品经理，表达简洁。');
    await click(button('取消', setup));
    await click(button('取消', dialog('放弃未保存的更改？')));
    expect(setup.querySelector<HTMLTextAreaElement>('#new-agent-prompt')?.value).toBe(
      '我是产品经理，表达简洁。',
    );
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('switches general creation to a twin and persists its working background', async () => {
    const created = {
      ...agent,
      id: 'my-twin',
      slug: 'my-twin',
      name: '我的分身',
      role: '数字分身',
      systemPrompt: '我负责产品规划，先给结论。',
    };
    const create = vi.spyOn(api, 'createAgent').mockResolvedValue(created);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([agent, created]));
    const router = await mount();
    await click(button('新建专家'));
    await selectRole('数字分身');
    const setup = dialog('创建数字分身');
    expect(setup.textContent).toContain('工作背景与表达方式');
    await editInput('new-agent-slug', 'my-twin');
    await editInput('new-agent-prompt', '我负责产品规划，先给结论。');
    await click(button('创建', setup));
    await waitFor(() => router.state.location.pathname === '/agents/my-twin');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ role: '数字分身', systemPrompt: '我负责产品规划，先给结论。' }),
    );
    expect(router.state.location.pathname).toBe('/agents/my-twin');
  });

  it('protects a twin draft and in-flight creation before navigating on success', async () => {
    const created = { ...agent, id: 'twin', slug: 'twin', name: '我的分身', role: '数字分身' };
    const request = deferred<Agent>();
    vi.spyOn(api, 'createAgent').mockReturnValue(request.promise);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([agent, created]));
    const router = await mount();
    await click(button('创建数字分身'));
    await editInput('new-agent-slug', 'twin');
    await act(async () => {
      void router.navigate({ to: '/away' });
    });
    await flush();
    expect(router.state.location.pathname).toBe('/agents');
    await click(button('取消', dialog('放弃未保存的更改？')));
    await click(button('创建', dialog('创建数字分身')));
    const setup = dialog('创建数字分身');
    expect(setup.querySelector<HTMLInputElement>('#new-agent-name')?.disabled).toBe(true);
    expect(button('取消', setup).disabled).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await click(button('关闭', setup));
    expect(dialog('创建数字分身')).toBeDefined();
    await act(async () => request.resolve(created));
    await waitFor(() => router.state.location.pathname === '/agents/twin');
    expect(router.state.location.pathname).toBe('/agents/twin');
    expect(document.body.textContent).not.toContain('放弃未保存的更改？');
  });

  it('finds experts by occupation and displays a fallback for historical blank roles', async () => {
    client.setQueryData(
      ['agents'],
      [agent, { ...agent, id: 'tester', name: 'QA', role: '测试工程师' }],
    );
    const router = await mount();
    expect(host.querySelector('[aria-label="专家列表"]')?.textContent).toContain('通用助手');
    await act(async () => router.navigate({ to: '/agents', search: { q: '测试工程师' } }));
    await flush();
    const list = host.querySelector('[aria-label="专家列表"]');
    expect(list?.textContent).toContain('QA');
    expect(list?.textContent).not.toContain('Expert');
  });

  it('filters the list by standard occupation and clears the role filter', async () => {
    client.setQueryData(
      ['agents'],
      [
        agent,
        { ...agent, id: 'tester', name: 'QA', role: '测试工程师' },
        { ...agent, id: 'twin', name: '我的分身', role: '数字分身' },
      ],
    );
    const router = await mount();
    await act(async () => router.navigate({ to: '/agents', search: { role: '测试工程师' } }));
    await flush();
    let list = host.querySelector('[aria-label="专家列表"]');
    expect(list?.textContent).toContain('QA');
    expect(list?.textContent).not.toContain('我的分身');

    await act(async () => router.navigate({ to: '/agents', search: { role: '数字分身' } }));
    await flush();
    list = host.querySelector('[aria-label="专家列表"]');
    expect(list?.textContent).toContain('我的分身');
    expect(list?.textContent).not.toContain('QA');

    await act(async () => router.navigate({ to: '/agents', search: {} }));
    await flush();
    list = host.querySelector('[aria-label="专家列表"]');
    expect(list?.textContent).toContain('Expert');
    expect(list?.textContent).toContain('QA');
  });
});

describe('expert rollback lifecycle', () => {
  it('warns about losing unsaved changes and preserves the draft when cancelled', async () => {
    await mount();
    await openHistory(true);
    await click(button('回滚', dialog('版本历史')));
    const confirmation = dialog('回滚到 v1');
    expect(confirmation.textContent).toContain('未保存的更改会丢失');
    await click(button('取消', confirmation));
    await click(button('关闭', dialog('版本历史')));
    expect(field().value).toBe('Unsaved draft');
    expect(button('保存更改').disabled).toBe(false);
    await click(button('返回列表'));
    await flush();
  });

  it('protects a clean editor, both sheets, saves, navigation and unload during rollback', async () => {
    const request = deferred<Agent>();
    vi.spyOn(api, 'rollbackAgent').mockReturnValue(request.promise);
    const update = vi.spyOn(api, 'updateAgent');
    const router = await mount();
    await openHistory();
    await confirmRollback();
    expect(field().disabled).toBe(true);
    expect(document.querySelector('[role="switch"]')?.hasAttribute('data-disabled')).toBe(true);
    expect(button('关闭', dialog('版本历史')).disabled).toBe(true);
    await click(button('关闭', dialog('版本历史')));
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(dialog('版本历史')).toBeDefined();
    await act(async () =>
      field().form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(update).not.toHaveBeenCalled();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => {
      void router.navigate({ to: '/away' });
    });
    await flush();
    expect(router.state.location.pathname).toBe('/agents/expert');
    expect(button('放弃并离开').disabled).toBe(true);
    await click(button('取消', dialog('放弃未保存的更改？')));
    vi.mocked(api.agents).mockResolvedValue([restored]);
    await act(async () => request.resolve(restored));
    await flush();
    expect(field().value).toBe('Restored expert');
    expect(field().disabled).toBe(false);
    expect(button('已保存').disabled).toBe(true);
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    await click(button('返回列表'));
    await flush();
    await act(async () => router.navigate({ to: '/away' }));
    expect(host.textContent).toBe('Away');
  });

  it('preserves the dirty draft and its save baseline after rollback failure', async () => {
    const request = deferred<Agent>();
    vi.spyOn(api, 'rollbackAgent').mockReturnValue(request.promise);
    const update = vi
      .spyOn(api, 'updateAgent')
      .mockResolvedValue({ ...agent, name: 'Unsaved draft' });
    await mount();
    await openHistory(true);
    await confirmRollback();
    await act(async () => request.reject(new Error('Rollback unavailable')));
    await flush();
    await click(button('取消', dialog('回滚到 v1')));
    await click(button('关闭', dialog('版本历史')));
    expect(field().value).toBe('Unsaved draft');
    expect(field().disabled).toBe(false);
    await click(button('保存更改'));
    expect(update).toHaveBeenCalledWith(
      'expert',
      expect.objectContaining({ name: 'Unsaved draft' }),
      agent.updatedAt,
    );
  });

  it('loads a successful rollback as the baseline for the next edit', async () => {
    vi.spyOn(api, 'rollbackAgent').mockResolvedValue(restored);
    vi.mocked(api.agents).mockResolvedValue([restored]);
    const update = vi
      .spyOn(api, 'updateAgent')
      .mockResolvedValue({ ...restored, name: 'Next draft' });
    await mount();
    await openHistory(true);
    await confirmRollback();
    expect(field().value).toBe('Restored expert');
    await editName('Next draft');
    await click(button('保存更改'));
    expect(update).toHaveBeenCalledWith(
      'expert',
      expect.objectContaining({ name: 'Next draft' }),
      restored.updatedAt,
    );
  });
});

describe('expert review details', () => {
  it('exposes the entire old and target prompt and exact same-length binding arrays', async () => {
    const prefix = 'A long prompt shared by both versions with more than forty-eight characters.\n';
    const current = {
      ...agent,
      systemPrompt: `${prefix}CURRENT`,
      serverIds: ['server-current'],
      allowedTools: ['Read'],
    };
    const target = {
      ...agent,
      systemPrompt: `${prefix}TARGET`,
      serverIds: ['server-target'],
      allowedTools: ['Write'],
    };
    client.setQueryData(['agents'], [current]);
    vi.spyOn(api, 'agentVersion').mockResolvedValue({
      version: 1,
      snapshot: target,
      createdAt: agent.createdAt,
    });
    await mount();
    await openHistory();
    await click(button('查看差异'));
    const history = dialog('版本历史');
    expect(history.textContent).toContain(`${prefix}CURRENT`);
    expect(history.textContent).toContain(`${prefix}TARGET`);
    expect(history.textContent).toContain('server-current');
    expect(history.textContent).toContain('server-target');
    expect(history.textContent).toContain('Read');
    expect(history.textContent).toContain('Write');
  });

  it('retains every import warning until the user dismisses the result', async () => {
    await mount();
    const warnings = [
      '连接器 crm 缺少 API_TOKEN，请重新配置。',
      '技能 analytics 未导入，请手动绑定。',
    ];
    await importFile(warnings);
    const result = dialog('导入提示');
    for (const warning of warnings) expect(result.textContent).toContain(warning);
    await click(button('关闭', result));
    expect(document.body.textContent).not.toContain(warnings[0]);
    expect(field().value).toBe('Expert');
  });

  it('opens the imported editor directly when there are no warnings', async () => {
    await mount();
    await importFile([]);
    expect(field().value).toBe('Expert');
    expect(document.body.textContent).not.toContain('导入提示');
  });
});
