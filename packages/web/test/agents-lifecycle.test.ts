import { renderWorkspace } from '@agentport/core/workspace';
import { type Agent, agentInputSchema, type RuntimeEnvironment } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api.js';
import { useAgent } from '../src/lib/queries.js';
import { allAccessMe } from './me-fixture.js';
import { AgentDetailPage, AgentsPage } from '../src/pages/agents.js';

vi.mock('@agentport/core/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/core/workspace')>();
  return { ...actual, renderWorkspace: vi.fn(actual.renderWorkspace) };
});

const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  parentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const restored = { ...agent, name: 'Restored expert', updatedAt: '2026-02-01T00:00:00Z' };
const versions = [{ id: 'version-1', version: 1, note: null, createdAt: agent.createdAt }];
const defaultEnvironment: RuntimeEnvironment = {
  id: 'rte_default',
  name: '默认环境',
  dockerfile: 'FROM base',
  isDefault: true,
  onlineVersionId: 'rtev_default',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const namedEnvironment: RuntimeEnvironment = {
  ...defaultEnvironment,
  id: 'rte_named',
  name: '数据分析',
  isDefault: false,
  onlineVersionId: null,
};
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
function link(text: string, scope: ParentNode = document): HTMLAnchorElement {
  const element = [...scope.querySelectorAll<HTMLAnchorElement>('a')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing link: ${text}`);
  return element;
}
function menuItem(text: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing menu item: ${text}`);
  return element;
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
/** 详情页的完整配置来自独立详情查询；摘要与详情都指向同一个 fixture。 */
function useAgentAs(current: Agent): void {
  vi.mocked(api.agents).mockResolvedValue([current]);
  vi.mocked(api.agent).mockResolvedValue(current);
  client.setQueryData(['agents'], [current]);
  client.setQueryData(['agent-detail', current.id], current);
}
async function mountAgentProbe(id: string) {
  // 与真实详情页一样只读取 data；提交计数放在 effect 里，只统计 React 真正提交的渲染。
  const snapshot: { commits: number; data: Agent | null | undefined } = {
    commits: 0,
    data: undefined,
  };
  function Probe({ agentId }: { agentId: string }) {
    const { data } = useAgent(agentId);
    snapshot.data = data;
    useEffect(() => {
      snapshot.commits += 1;
    });
    return null;
  }
  const renderProbe = async (agentId: string) => {
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(Probe, { agentId })),
      );
    });
    await flush();
  };
  await renderProbe(id);
  return { snapshot, switchTo: renderProbe };
}

async function openHistory(dirty = false) {
  await click(link('Expert'));
  await waitFor(() => document.querySelector('#agent-name'));
  if (dirty) await editName('Unsaved draft');
  await click(button('版本历史'));
}
async function confirmRollback() {
  await click(button('回滚', dialog('版本历史')));
  const confirmation = dialog('回滚到 v1');
  await click(button('回滚', confirmation));
}
async function chooseFile(name: string, content = 'PK'): Promise<File> {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing import input');
  const file = new File([content], name, {
    type: name.toLowerCase().endsWith('.md') ? 'text/markdown' : 'application/zip',
  });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await flush();
  return file;
}
async function importFile(warnings: string[]) {
  vi.spyOn(api, 'importAgent').mockResolvedValue({
    agent,
    warnings,
    createdServers: [],
    reusedServers: [],
    createdSkills: [],
  });
  await chooseFile('expert.zip');
  await click(button('导入', dialog('导入专家包')));
  await waitFor(() => document.querySelector('#agent-name'));
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(api, 'agents').mockResolvedValue([agent]);
  vi.spyOn(api, 'agent').mockResolvedValue(agent);
  vi.spyOn(api, 'me').mockResolvedValue(allAccessMe);
  vi.spyOn(api, 'agentAccess').mockResolvedValue({
    agentId: agent.id,
    permissionIds: allAccessMe.grants.map((grant) => grant.permissionId),
  });
  vi.spyOn(api, 'servers').mockResolvedValue([]);
  vi.spyOn(api, 'skills').mockResolvedValue([]);
  vi.spyOn(api, 'runtimeEnvironments').mockResolvedValue([defaultEnvironment, namedEnvironment]);
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
  client.setQueryData(['me'], allAccessMe);
  client.setQueryData(['agent-detail', agent.id], agent);
  client.setQueryData(['agent-access', agent.id], {
    agentId: agent.id,
    permissionIds: allAccessMe.grants.map((grant) => grant.permissionId),
  });
  client.setQueryData(['servers'], []);
  client.setQueryData(['skills'], []);
  client.setQueryData(['runtime-environments'], [defaultEnvironment, namedEnvironment]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  history?.destroy();
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useAgent cache selection', () => {
  const other: Agent = { ...agent, id: 'other', slug: 'other', name: 'Other' };

  it('does not commit when another expert changes', async () => {
    client.setQueryData(['agents'], [agent, other]);
    const probe = await mountAgentProbe('expert');
    expect(probe.snapshot.data?.name).toBe('Expert');
    const commits = probe.snapshot.commits;

    await act(async () => {
      client.setQueryData(
        ['agents'],
        [agent, { ...other, name: 'Other updated', updatedAt: '2026-03-01T00:00:00Z' }],
      );
    });
    await flush();

    expect(probe.snapshot.commits).toBe(commits);
    expect(probe.snapshot.data?.name).toBe('Expert');
  });

  it('does not commit when a refetch returns the same experts', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([agent]));
    const probe = await mountAgentProbe('expert');
    const commits = probe.snapshot.commits;

    await act(async () => {
      await client.refetchQueries({ queryKey: ['agents'] });
    });
    await flush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(probe.snapshot.commits).toBe(commits);
    expect(probe.snapshot.data?.name).toBe('Expert');
  });

  it('reflects an update to the selected expert', async () => {
    const probe = await mountAgentProbe('expert');
    const commits = probe.snapshot.commits;

    await act(async () => {
      client.setQueryData(
        ['agents'],
        [{ ...agent, name: 'Renamed', updatedAt: '2026-03-01T00:00:00Z' }],
      );
    });
    await flush();

    expect(probe.snapshot.commits).toBe(commits + 1);
    expect(probe.snapshot.data?.name).toBe('Renamed');
  });

  it('returns null after the selected expert is removed', async () => {
    client.setQueryData(['agents'], [agent, other]);
    const probe = await mountAgentProbe('expert');

    await act(async () => {
      client.setQueryData(['agents'], [other]);
    });
    await flush();

    expect(probe.snapshot.data).toBeNull();
  });

  it('switches to the selected expert when the id changes', async () => {
    client.setQueryData(['agents'], [agent, other]);
    const probe = await mountAgentProbe('expert');
    expect(probe.snapshot.data?.name).toBe('Expert');

    await probe.switchTo('other');

    expect(probe.snapshot.data?.name).toBe('Other');
  });
});

describe('expert creation lifecycle', () => {
  it('puts the required name before the optional identifier and associates validation errors', async () => {
    const create = vi.spyOn(api, 'createAgent');
    await mount();
    await click(button('新建专家'));
    const setup = dialog('新建专家');
    const name = setup.querySelector<HTMLInputElement>('#new-agent-name');
    const slug = setup.querySelector<HTMLInputElement>('#new-agent-slug');
    if (!name || !slug) throw new Error('Missing creation fields');
    expect(name.compareDocumentPosition(slug)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(setup.querySelector('label[for="new-agent-slug"]')?.textContent).toBe('标识（可选）');
    expect(slug?.getAttribute('aria-required')).not.toBe('true');
    expect(name?.getAttribute('aria-required')).toBe('true');
    await click(button('创建', setup));
    expect(create).not.toHaveBeenCalled();
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    expect(name?.getAttribute('aria-describedby')).toBe('new-agent-name-error');
    expect(document.getElementById('new-agent-name-error')?.textContent).toBeTruthy();
    await editInput('new-agent-name', 'Expert');
    await editInput('new-agent-slug', 'INVALID slug');
    await click(button('创建', setup));
    expect(create).not.toHaveBeenCalled();
    expect(slug?.getAttribute('aria-invalid')).toBe('true');
    expect(slug?.getAttribute('aria-describedby')).toBe('new-agent-slug-error');
    expect(document.getElementById('new-agent-slug-error')?.textContent).toBeTruthy();
  });

  it('keeps the advanced draft while the folded panel animates closed', async () => {
    await mount();
    await click(button('新建专家'));
    const setup = dialog('新建专家');
    await click(button('高级设置', setup));
    await editInput('new-agent-model', 'gateway/custom-model');
    await editInput('new-agent-slug', 'draft');
    const advanced = setup.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
    if (!advanced) throw new Error('Missing advanced settings');
    expect(advanced.hasAttribute('inert')).toBe(false);

    await click(button('高级设置', setup));
    expect(advanced.getAttribute('hidden')).toBe('until-found');
    expect(advanced.hasAttribute('inert')).toBe(true);
    expect(setup.querySelector<HTMLInputElement>('#new-agent-model')?.value).toBe(
      'gateway/custom-model',
    );

    await click(button('高级设置', setup));
    expect(advanced.hasAttribute('hidden')).toBe(false);
    expect(advanced.hasAttribute('inert')).toBe(false);
    expect(setup.querySelector<HTMLInputElement>('#new-agent-slug')?.value).toBe('draft');
  });

  it.each([
    ['  Support Expert!  ', 'support-expert'],
    ['---QA__Expert---', 'qa__expert'],
    ['A'.repeat(100), 'a'.repeat(64)],
    ['客服专家', /^agent-[a-z0-9]{8}$/],
    ['✨---___', /^agent-[a-z0-9]{8}$/],
  ])(
    'creates from name %s with an automatically generated compliant identifier',
    async (name, slug) => {
      const created = { ...agent, id: 'created', name: name.trim() };
      const create = vi.spyOn(api, 'createAgent').mockResolvedValue(created);
      const success = vi.spyOn(toast, 'success');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([agent, created]));
      const router = await mount();
      await click(button('新建专家'));
      await editInput('new-agent-name', name);
      await click(button('创建', dialog('新建专家')));
      await waitFor(() => router.state.location.pathname === '/agents/created');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: name.trim(),
          slug: typeof slug === 'string' ? slug : expect.stringMatching(slug),
        }),
      );
      expect(success).toHaveBeenCalledWith('专家已创建');
    },
  );

  it('preserves the draft and reports API identifier conflicts', async () => {
    const conflict = new ApiError(409, '标识已存在，请换一个标识。', { code: 'CONFLICT' });
    const create = vi.spyOn(api, 'createAgent').mockRejectedValue(conflict);
    const error = vi.spyOn(toast, 'error');
    const router = await mount();
    await click(button('新建专家'));
    await editInput('new-agent-name', 'Support Expert');
    await click(button('创建', dialog('新建专家')));
    await waitFor(() => error.mock.calls.length > 0);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'support-expert' }));
    expect(error).toHaveBeenCalledWith(conflict.message, expect.anything());
    expect(router.state.location.pathname).toBe('/agents');
    const setup = dialog('新建专家');
    expect(setup.querySelector<HTMLInputElement>('#new-agent-name')?.value).toBe('Support Expert');
    expect(button('创建', setup).disabled).toBe(false);
    await click(button('取消', setup));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
  });

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
    vi.mocked(api.agent).mockImplementation(async (id) => (id === created.id ? created : agent));
    client.setQueryData(['agents'], [agent, created]);
    client.setQueryData(['agent-detail', created.id], created);
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
    const start = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (item) => item.textContent?.trim() === '开始对话',
    );
    expect(start?.getAttribute('href')).toBe('/chat?agent=new-expert');
    expect(start?.getAttribute('role')).not.toBe('button');
    expect(button('返回列表')).toBeDefined();
    expect(button('更多操作')).toBeDefined();
    await waitFor(() => document.querySelector('#agent-name'));
    expect(field().value).toBe('New expert');
  });

  it('explains connector preapproval separately from built-in tools and the sandbox default mode', async () => {
    await mount();
    await click(link('Expert'));
    await click(await waitFor(() => button('权限')));
    const section = document.getElementById('agent-permissions');
    expect(section?.textContent).toContain('内置工具');
    expect(section?.textContent).toContain('Bash');
    expect(section?.textContent).toContain('默认启用');
    expect(section?.textContent).toContain('Docker 挂载边界');
    expect(section?.textContent).toContain('绑定连接器的全部工具加入 SDK allowedTools 预批准');
    expect(section?.textContent).toContain('工具若设置 requiresApproval，仍须通过服务端审批');
    expect(section?.textContent).toContain('可挂起等待批准');
    expect(section?.textContent).not.toContain('无需逐次批准');
    expect(section?.textContent).not.toContain('留空表示全部已绑定工具');
    const allowedHint = document.getElementById('agent-allowed-tools-hint')?.textContent;
    expect(allowedHint).toContain('额外允许的工具名或模式');
    expect(allowedHint).toContain('不会限制已绑定连接器的工具');
    const mode = document.getElementById('agent-perm');
    expect(mode?.getAttribute('aria-describedby')).toBe('agent-perm-hint');
    const expectApprovalHint = () => {
      const hint = document.getElementById('agent-perm-hint')?.textContent;
      expect(hint).toContain('default 支持原生澄清问答');
      expect(hint).toContain('dontAsk 拒绝原生提问');
      expect(hint).toContain('其他未预批准的工具请求会被拒绝');
      expect(hint).toContain('连接器工具仍可能触发服务端审批');
      expect(hint).not.toContain('不会发起人工审批');
    };
    expectApprovalHint();
    await selectRole('default — 标准权限', 'agent-perm');
    expectApprovalHint();
    expect(button('Bash：已启用')).toBeDefined();
  });

  it('initializes twin defaults cleanly and protects edited working background', async () => {
    const router = await mount();
    // 数字分身是角色选项：从角色筛选新建时预填该角色，而不是另开一张入口卡。
    await act(async () => router.navigate({ to: '/agents', search: { role: '数字分身' } }));
    await flush();
    await click(button('新建专家'));
    let setup = dialog('创建数字分身');
    expect(setup.querySelector<HTMLInputElement>('#new-agent-name')?.value).toBe('我的分身');
    expect(setup.querySelector('#new-agent-role')?.textContent).toContain('数字分身');
    expect(setup.textContent).toContain('数字分身');
    expect(setup.querySelector<HTMLTextAreaElement>('#new-agent-prompt')?.value).toBe('');
    await click(button('取消', setup));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(button('新建专家'));
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
    await act(async () => router.navigate({ to: '/agents', search: { role: '数字分身' } }));
    await flush();
    await click(button('新建专家'));
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

describe('expert discovery', () => {
  const disabled = { ...agent, id: 'disabled', slug: 'disabled', name: 'Disabled', enabled: false };

  it('shows enabled experts by default and can show all or disabled experts', async () => {
    client.setQueryData(['agents'], [agent, disabled]);
    vi.mocked(api.agents).mockResolvedValue([agent, disabled]);
    const router = await mount();
    let list = host.querySelector('[aria-label="专家列表"]');
    expect(list?.textContent).toContain('Expert');
    expect(list?.textContent).not.toContain('Disabled');

    await act(async () => router.navigate({ to: '/agents', search: { status: 'all' } }));
    await flush();
    list = host.querySelector('[aria-label="专家列表"]');
    expect(list?.textContent).toContain('Expert');
    expect(list?.textContent).toContain('Disabled');

    await act(async () => router.navigate({ to: '/agents', search: { status: 'disabled' } }));
    await flush();
    list = host.querySelector('[aria-label="专家列表"]');
    expect(list?.textContent).not.toContain('Expert');
    expect(list?.textContent).toContain('Disabled');
  });

  it('clears every filter to all experts when only disabled experts are hidden by the default', async () => {
    client.setQueryData(['agents'], [disabled]);
    vi.mocked(api.agents).mockResolvedValue([disabled]);
    const router = await mount();
    expect(host.querySelector('[aria-label="专家列表"]')).toBeNull();
    expect(host.textContent).toContain('没有匹配的专家');

    await act(async () =>
      router.navigate({ to: '/agents', search: { q: 'missing', role: '数字分身' } }),
    );
    await flush();
    await click(button('清除筛选'));
    await flush();

    expect(router.state.location.search).toMatchObject({ status: 'all' });
    expect(router.state.location.search.q).toBeUndefined();
    expect(router.state.location.search.role).toBeUndefined();
    expect(host.querySelector('[aria-label="专家列表"]')?.textContent).toContain('Disabled');
  });

  it('restores status, sort and role filters after going back', async () => {
    const tester = { ...agent, id: 'tester', name: 'QA', role: '测试工程师' };
    client.setQueryData(['agents'], [agent, tester, disabled]);
    vi.mocked(api.agents).mockResolvedValue([agent, tester, disabled]);
    const router = await mount();
    await act(async () =>
      router.navigate({
        to: '/agents',
        search: { status: 'all', sort: 'name', role: '测试工程师' },
      }),
    );
    await flush();
    await act(async () => router.navigate({ to: '/away' }));
    await flush();
    await waitFor(() => router.state.location.pathname === '/away');

    await act(async () => history.back());
    await flush();
    await waitFor(() => router.state.location.pathname === '/agents');

    expect(router.state.location.search).toMatchObject({
      status: 'all',
      sort: 'name',
      role: '测试工程师',
    });
    const list = host.querySelector('[aria-label="专家列表"]');
    expect(list?.textContent).toContain('QA');
    expect(list?.textContent).not.toContain('Expert');
    expect(list?.textContent).not.toContain('Disabled');
  });

  it('links names to the definition page and only starts enabled experts', async () => {
    client.setQueryData(['agents'], [agent, disabled]);
    vi.mocked(api.agents).mockResolvedValue([agent, disabled]);
    const router = await mount();
    await act(async () => router.navigate({ to: '/agents', search: { status: 'all' } }));
    await flush();
    expect(link('Expert').getAttribute('href')).toBe('/agents/expert');
    expect(link('与 Expert 开始对话').getAttribute('aria-label')).toBe('与 Expert 开始对话');
    expect(host.querySelector('a[href="/chat?agent=expert"]')).not.toBeNull();
    expect(host.querySelector('a[href="/chat?agent=disabled"]')).toBeNull();
    const blocked = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.getAttribute('aria-label') === '与 Disabled 开始对话',
    );
    expect(blocked?.disabled).toBe(true);
    expect(blocked?.getAttribute('title')).toContain('已停用');
    expect(button('新建专家')).toBeDefined();
  });

  it('offers the first creation when empty and recovers from a filter miss', async () => {
    client.setQueryData(['agents'], []);
    vi.mocked(api.agents).mockResolvedValue([]);
    const router = await mount();
    expect(host.textContent).toContain('创建第一位专家');
    expect(host.textContent).not.toContain('创建数字分身');
    await click(button('创建第一位专家'));
    expect(dialog('新建专家')).toBeDefined();
    await click(button('取消', dialog('新建专家')));
    await flush();

    client.setQueryData(['agents'], [agent]);
    vi.mocked(api.agents).mockResolvedValue([agent]);
    await act(async () => router.navigate({ to: '/agents', search: { q: 'missing' } }));
    await flush();
    expect(host.textContent).toContain('没有匹配的专家');
    expect(button('新建专家')).toBeDefined();
    await click(button('清除筛选'));
    await flush();
    expect(host.querySelector('[aria-label="专家列表"]')?.textContent).toContain('Expert');
  });

  it('prefills the selected role without writing the search into the working style', async () => {
    const router = await mount();
    await act(async () =>
      router.navigate({ to: '/agents', search: { role: '测试工程师', q: 'QA' } }),
    );
    await flush();
    await click(button('新建专家'));
    const setup = dialog('新建专家');
    expect(document.getElementById('new-agent-role')?.textContent).toContain('测试工程师');
    expect(setup.querySelector<HTMLTextAreaElement>('#new-agent-prompt')?.value).toBe('');
  });

  it('puts name, role and working style before folded model and identifier', async () => {
    await mount();
    await click(button('新建专家'));
    const setup = dialog('新建专家');
    const name = setup.querySelector('#new-agent-name') as HTMLElement;
    const role = setup.querySelector('#new-agent-role') as HTMLElement;
    const prompt = setup.querySelector('#new-agent-prompt') as HTMLElement;
    const model = setup.querySelector('#new-agent-model') as HTMLElement;
    const slug = setup.querySelector('#new-agent-slug') as HTMLElement;
    expect(name.compareDocumentPosition(role)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(role.compareDocumentPosition(prompt)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(prompt.compareDocumentPosition(model)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(model.compareDocumentPosition(slug)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const advanced = setup.querySelector('[data-slot="collapsible-content"]');
    expect(advanced?.hasAttribute('inert')).toBe(true);
    expect(setup.textContent).toContain('高级设置');
  });
});

describe('expert detail navigation', () => {
  it('labels the memory task as expert memory and links run history out of the tabs', async () => {
    await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    expect(host.textContent).toContain('专家记忆');
    expect(host.textContent).not.toContain('运行统计');
    expect(link('查看运行').getAttribute('href')).toBe('/runs?agent=expert');
  });
});

describe('expert file tool permissions', () => {
  function toolToggle(tool: string): HTMLButtonElement {
    const element = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="toggle"]')].find(
      (item) => item.textContent?.trim().startsWith(tool),
    );
    if (!element) throw new Error(`Missing tool toggle: ${tool}`);
    return element;
  }
  async function openPermissions(): Promise<HTMLElement> {
    await click(await waitFor(() => link('Expert')));
    await click(await waitFor(() => button('权限')));
    await waitFor(() => document.getElementById('agent-permissions'));
    return document.getElementById('agent-permissions') as HTMLElement;
  }
  // 真实重载：卸载组件并清空查询缓存，重新 mount 后只能从持久化 store 恢复。
  async function remount(): Promise<void> {
    await act(async () => root.unmount());
    history?.destroy();
    client.clear();
    root = createRoot(host);
    await mount();
  }

  it('shows the three native file tools as enabled under path limits by default', async () => {
    await mount();
    const section = await openPermissions();
    for (const tool of ['Read', 'Write', 'Edit']) {
      const toggle = toolToggle(tool);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(toggle.textContent).toContain('已启用（受路径限制）');
    }
    expect(section.textContent).toContain('读写记忆 Markdown 与本轮成果');
    expect(section.textContent).toContain('Bash 仍受 Docker 挂载边界约束');
    expect(button('已保存').disabled).toBe(true);
  });

  it.each([
    ['parent', null],
    ['child', 'parent'],
  ] as const)(
    'lets a bare deny override a legacy allow on a %s without claiming unrestricted access',
    async (scope, parentId) => {
      const restricted = {
        ...agent,
        parentId,
        allowedTools: ['Read'],
        disallowedTools: ['Read'],
      };
      useAgentAs(restricted);
      await mount();
      const section = await openPermissions();
      expect(toolToggle('Read').getAttribute('aria-pressed')).toBe('false');
      expect(toolToggle('Read').textContent).toContain(scope === 'child' ? '已显式禁用' : '已禁用');
      expect(toolToggle('Write').getAttribute('aria-pressed')).toBe('true');
      expect(section.textContent).toContain(
        scope === 'child' ? '默认启用（仅自身记忆）' : '受路径限制',
      );
      expect(button('已保存').disabled).toBe(true);
    },
  );

  it.each([
    ['parent', 'Read', null],
    ['parent', 'Write', null],
    ['parent', 'Edit', null],
    ['child', 'Read', 'parent'],
    ['child', 'Write', 'parent'],
    ['child', 'Edit', 'parent'],
  ] as const)(
    'persists %s file tool %s disable and restore across a reload without rewriting path rules',
    async (scope, tool, parentId) => {
      const originalRules = [
        ...new Set([
          `${tool}(/target/**)`,
          'Edit(/secret/**)',
          'Write(/unknown/**)',
          'Grep',
          'mcp__crm__lookup',
        ]),
      ];
      const allowPathRules = [`${tool}(/target/**)`, 'Edit(/docs/**)'];
      // 模拟真实存储：保存写入 store，请求始终返回 store，重载后也只能读到它。
      const store = {
        current: {
          ...agent,
          parentId,
          allowedTools: [tool, 'Bash', ...allowPathRules],
          disallowedTools: originalRules,
        },
      };
      // agentsQuery 在模块加载时已捕获原始 api.agents，只有 fetch 层能影响重载读取。
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const path = String(input).split('?')[0];
        if (path === '/api/agents') return Response.json([store.current]);
        if (path === '/api/runtime-environments') {
          return Response.json([defaultEnvironment, namedEnvironment]);
        }
        // 知识库是分页对象，其它绑定来源是数组。
        if (path?.startsWith('/api/knowledge/bases')) {
          return Response.json({ items: [], nextCursor: null });
        }
        return Response.json([]);
      });
      client.setQueryData(['agents'], [store.current]);
      client.setQueryData(['agent-detail', store.current.id], store.current);
      vi.mocked(api.agent).mockImplementation(async () => store.current);
      const update = vi.spyOn(api, 'updateAgent').mockImplementation(async (_id, input) => {
        store.current = {
          ...store.current,
          allowedTools: input.allowedTools ?? store.current.allowedTools,
          disallowedTools: input.disallowedTools ?? store.current.disallowedTools,
          updatedAt: '2026-02-01T00:00:00Z',
        };
        return store.current;
      });

      await mount();
      const section = await openPermissions();
      // Edit(path) 对 Write 的覆盖与 Write(path) 的语义都不由平台判断，只原样保留。
      expect(toolToggle(tool).getAttribute('aria-pressed')).toBe('true');
      expect(section.textContent).toContain(
        scope === 'child' ? '自定义允许项不扩大文件范围' : '文件工具的自定义允许项不扩大平台范围',
      );
      if (scope === 'child') {
        expect(section.textContent).toContain('子级禁用规则带路径时也会禁用整个工具');
      }
      expect(section.textContent).not.toContain('额外路径限制');

      await click(toolToggle(tool));
      expect(toolToggle(tool).getAttribute('aria-pressed')).toBe('false');
      await click(button('保存更改'));
      await waitFor(() => update.mock.calls.length === 1, 10);
      // 关闭只删裸 allow，文件路径 allow 原样保留，不替用户改配置。
      expect(update.mock.calls[0]?.[1].allowedTools).toEqual(['Bash', ...allowPathRules]);
      expect(update.mock.calls[0]?.[1].disallowedTools).toEqual([...originalRules, tool]);

      // 重新进入表单必须从 store 恢复禁用状态，而不是沿用乐观缓存或上一次渲染。
      await remount();
      let reopened = await openPermissions();
      expect(toolToggle(tool).getAttribute('aria-pressed')).toBe('false');
      expect(reopened.textContent).toContain(scope === 'child' ? '已显式禁用' : '已禁用');
      expect(button('已保存').disabled).toBe(true);

      await click(toolToggle(tool));
      expect(toolToggle(tool).getAttribute('aria-pressed')).toBe('true');
      await click(button('保存更改'));
      await waitFor(() => update.mock.calls.length === 2, 10);
      // 恢复不写回裸 allow：未变的 allowedTools 不进入 PATCH，服务端合并不重写路径 allow；
      // 只删裸 deny，路径 deny、未知语义规则或其它工具规则都保留。
      expect(update.mock.calls[1]?.[1].allowedTools).toBeUndefined();
      expect(store.current.allowedTools).toEqual(['Bash', ...allowPathRules]);
      expect(update.mock.calls[1]?.[1].disallowedTools).toEqual(originalRules);

      await remount();
      reopened = await openPermissions();
      expect(toolToggle(tool).getAttribute('aria-pressed')).toBe('true');
      expect(reopened.textContent).toContain(
        scope === 'child' ? '默认启用（仅自身记忆）' : '已启用（受路径限制）',
      );
      expect(button('已保存').disabled).toBe(true);
    },
  );

  it('enables child file tools by default within its own memory scope', async () => {
    const child = {
      ...agent,
      parentId: 'parent',
      allowedTools: ['Read', 'Bash'],
      disallowedTools: [],
    };
    useAgentAs(child);
    const update = vi.spyOn(api, 'updateAgent');
    await mount();
    const section = await openPermissions();
    for (const tool of ['Read', 'Write', 'Edit']) {
      const toggle = toolToggle(tool);
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(toggle.disabled).toBe(false);
      expect(toggle.textContent).toContain('默认启用（仅自身记忆）');
    }
    expect(section.textContent).toContain('子智能体默认读写自身记忆目录内的 Markdown');
    expect(section.textContent).toContain('关闭工具不会关闭 MEMORY.md 自动加载');
    expect(section.textContent).toContain('Bash 可访问同一容器的可写挂载');
    expect(section.textContent).not.toContain('子智能体的原生文件工具由平台禁用');
    await click(toolToggle('Read'));
    expect(toolToggle('Read').getAttribute('aria-pressed')).toBe('false');
    expect(toolToggle('Read').textContent).toContain('已显式禁用');
    expect(update).not.toHaveBeenCalled();
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

describe('expert deletion lifecycle', () => {
  it('keeps the editor and draft until the server confirms deletion, then returns to the list once', async () => {
    const request = deferred<void>();
    vi.spyOn(api, 'deleteAgent').mockReturnValue(request.promise);
    const router = await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    await editName('Draft kept');
    await click(button('更多操作'));
    await waitFor(() => menuItem('删除专家'));
    await click(menuItem('删除专家'));
    await click(button('删除', dialog('删除专家「Expert」')));

    // 服务端未确认前：详情仍在、草稿还在，编辑/离开/刷新都被锁住。
    expect(field().value).toBe('Draft kept');
    expect(field().disabled).toBe(true);
    expect(button('返回列表').disabled).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => {
      void router.navigate({ to: '/away' });
    });
    await flush();
    expect(router.state.location.pathname).toBe('/agents/expert');
    const leave = dialog('放弃未保存的更改？');
    expect(button('放弃并离开', leave).disabled).toBe(true);
    await click(button('取消', leave));
    expect(field().value).toBe('Draft kept');

    vi.mocked(api.agents).mockResolvedValue([]);
    await act(async () => request.resolve());
    await flush();
    await waitFor(() => router.state.location.pathname === '/agents');
    expect(document.body.textContent).not.toContain('删除专家「Expert」');
    expect(document.querySelector('#agent-name')).toBeNull();
  });

  it('keeps the draft and delete confirmation when deletion fails', async () => {
    const request = deferred<void>();
    vi.spyOn(api, 'deleteAgent').mockReturnValue(request.promise);
    await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    await editName('Draft kept');
    await click(button('更多操作'));
    await waitFor(() => menuItem('删除专家'));
    await click(menuItem('删除专家'));
    await click(button('删除', dialog('删除专家「Expert」')));

    await act(async () => request.reject(new Error('Delete unavailable')));
    await flush();
    expect(field().value).toBe('Draft kept');
    expect(field().disabled).toBe(false);
    expect(dialog('删除专家「Expert」')).toBeDefined();
    expect(client.getQueryData<Agent[]>(['agents'])?.map((item) => item.id)).toEqual(['expert']);
    await click(button('取消', dialog('删除专家「Expert」')));
    expect(field().value).toBe('Draft kept');
  });
});

describe('expert same-page task guard', () => {
  it('asks before a same-path history move unmounts a dirty child panel and keeps the main draft', async () => {
    vi.spyOn(api, 'agentRules').mockResolvedValue([]);
    const router = await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    await editName('Main draft');
    // 直接 push 一个不同 tab 的同 pathname 记录，才能用 history.back 触发 POP。
    await act(async () => {
      await router.navigate({
        to: '/agents/$agentId',
        params: { agentId: 'expert' },
        search: { tab: 'rules' },
      });
    });
    await flush();
    await waitFor(() => document.getElementById('rule-slug'));
    await click(button('新建规则'));
    await editInput('rule-slug', 'no-console');

    await act(async () => {
      history.back();
    });
    await flush();
    await waitFor(() => document.querySelector('[role="dialog"]'));
    const confirmation = dialog('放弃未保存的修改并切换？');
    expect(document.getElementById('rule-slug')?.value).toBe('no-console');
    await click(button('取消', confirmation));
    await flush();
    expect(document.getElementById('rule-slug')?.value).toBe('no-console');
    expect(router.state.location.search).toMatchObject({ tab: 'rules' });

    await click(button('配置'));
    const again = dialog('放弃未保存的修改并切换？');
    expect(document.getElementById('rule-slug')?.value).toBe('no-console');
    await click(button('放弃并切换', again));
    await flush();
    await waitFor(() => router.state.location.search.tab === undefined);
    expect(document.getElementById('rule-slug')).toBeNull();
    expect(field().value).toBe('Main draft');
  });

  it('rejects same-path task changes while a child request is pending', async () => {
    vi.spyOn(api, 'agentRules').mockResolvedValue([]);
    const save = deferred<Awaited<ReturnType<typeof api.writeAgentRule>>>();
    vi.spyOn(api, 'writeAgentRule').mockReturnValue(save.promise);
    const router = await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    await act(async () => {
      await router.navigate({
        to: '/agents/$agentId',
        params: { agentId: 'expert' },
        search: { tab: 'rules' },
      });
    });
    await flush();
    await waitFor(() => document.getElementById('rule-slug'));
    await click(button('新建规则'));
    await editInput('rule-slug', 'no-console');
    await click(button('保存规则'));
    expect(document.getElementById('rule-slug')?.disabled).toBe(true);

    await act(async () => {
      void router.navigate({
        to: '/agents/$agentId',
        params: { agentId: 'expert' },
        search: { tab: 'config' },
      });
    });
    await flush();
    const confirmation = dialog('放弃未保存的修改并切换？');
    expect(button('放弃并切换', confirmation).disabled).toBe(true);
    expect(document.getElementById('rule-slug')?.value).toBe('no-console');
    await click(button('取消', confirmation));

    await act(async () => save.reject(new Error('Save unavailable')));
    await flush();
    expect(document.getElementById('rule-slug')?.value).toBe('no-console');
    expect(router.state.location.search).toMatchObject({ tab: 'rules' });
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
    useAgentAs(current);
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

  const fieldOnlyCases = [
    {
      label: '回复格式',
      current: { ...agent, uiFormat: 'openui' as const },
      target: { ...agent, uiFormat: 'markdown' as const },
      from: 'openui',
      to: 'markdown',
    },
    {
      label: '插件绑定',
      current: {
        ...agent,
        pluginBindings: [{ pluginId: 'plugin-1', allowHooks: true, allowMcp: true }],
      },
      target: {
        ...agent,
        pluginBindings: [{ pluginId: 'plugin-1', allowHooks: false, allowMcp: true }],
      },
      from: '"allowHooks": true',
      to: '"allowHooks": false',
    },
    {
      label: '运行环境',
      current: { ...agent, runtimeEnvironmentId: null },
      target: { ...agent, runtimeEnvironmentId: 'rte_default' },
      from: '空',
      to: 'rte_default',
    },
  ];

  it.each(fieldOnlyCases)(
    'reports a $label-only difference instead of claiming the fields are unchanged',
    async ({ label, current, target, from, to }) => {
      useAgentAs(current);
      vi.spyOn(api, 'agentVersion').mockResolvedValue({
        version: 1,
        snapshot: target,
        createdAt: agent.createdAt,
      });
      await mount();
      await openHistory();
      await click(button('查看差异'));
      await flush();
      const history = dialog('版本历史');
      expect(history.textContent).not.toContain('与当前配置一致');
      expect(history.textContent).toContain(label);
      expect(history.textContent).toContain(from);
      expect(history.textContent).toContain(to);

      await click(button('回滚', history));
      const confirmation = dialog('回滚到 v1');
      expect(confirmation.textContent).toContain(`将把 1 个字段改为该版本的值：${label}`);
      expect(confirmation.textContent).not.toContain('回滚不会改变字段');
    },
  );

  it.each([
    {
      name: '回复格式',
      section: '运行限制',
      current: { ...agent, uiFormat: 'openui' as const },
      target: { ...agent, uiFormat: 'markdown' as const, updatedAt: '2026-02-01T00:00:00Z' },
      restored: (): void =>
        expect(document.getElementById('agent-ui-format')?.textContent).toContain('Markdown'),
    },
    {
      name: '插件绑定',
      section: '能力',
      current: {
        ...agent,
        pluginBindings: [{ pluginId: 'plugin-1', allowHooks: true, allowMcp: true }],
      },
      target: {
        ...agent,
        pluginBindings: [{ pluginId: 'plugin-1', allowHooks: false, allowMcp: true }],
        updatedAt: '2026-02-01T00:00:00Z',
      },
      // hooks 授权被回滚掉，MCP 授权原样保留。
      restored: (): void => {
        expect(document.querySelector<HTMLInputElement>('#plugin-plugin-1-hooks')?.checked).toBe(
          false,
        );
        expect(document.querySelector<HTMLInputElement>('#plugin-plugin-1-mcp')?.checked).toBe(
          true,
        );
      },
    },
  ])('loads the rolled-back $name configuration and clears dirty', async (entry) => {
    const plugin = {
      id: 'plugin-1',
      slug: 'demo',
      runtimeName: 'demo',
      name: '演示插件',
      description: '',
      version: '1.0.0',
      sourceId: null,
      capabilities: { skills: [], agents: [], hasHooks: true, mcpServers: ['inline-server'] },
      files: [],
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      agentCount: 1,
    };
    vi.spyOn(api, 'plugins').mockResolvedValue([plugin]);
    client.setQueryData(['plugins'], [plugin]);
    client.setQueryData(['agents'], [entry.current]);
    vi.spyOn(api, 'agentVersion').mockResolvedValue({
      version: 1,
      snapshot: entry.target,
      createdAt: agent.createdAt,
    });
    vi.spyOn(api, 'rollbackAgent').mockResolvedValue(entry.target);
    vi.mocked(api.agents).mockResolvedValue([entry.target]);
    await mount();
    await openHistory(true);
    await confirmRollback();
    await flush();
    expect(document.body.textContent).not.toContain('未保存');
    expect(button('已保存').disabled).toBe(true);
    await click(button(entry.section));
    await flush();
    entry.restored();
  });

  it('loads a version snapshot only after the diff expands', async () => {
    const detail = vi.spyOn(api, 'agentVersion');
    await mount();
    await openHistory();
    expect(detail).not.toHaveBeenCalled();
    await click(button('查看差异'));
    await flush();
    expect(detail).toHaveBeenCalledWith('expert', 1);
    await click(button('收起差异'));
    expect(dialog('版本历史').textContent).toContain('查看差异');
    expect(detail).toHaveBeenCalledTimes(1);
    await click(button('查看差异'));
    await flush();
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it('waits for an explicit environment mapping before importing a ZIP and does nothing on cancel', async () => {
    await mount();
    const importZip = vi.spyOn(api, 'importAgent');
    await chooseFile('expert.zip');
    const setup = dialog('导入专家包');
    expect(setup.textContent).toContain('expert.zip');
    expect(setup.textContent).toContain('按包中名称匹配');
    expect(importZip).not.toHaveBeenCalled();
    await click(button('取消', setup));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(importZip).not.toHaveBeenCalled();
  });

  it('imports a ZIP by package name when no environment override is chosen', async () => {
    const importZip = vi.spyOn(api, 'importAgent').mockResolvedValue({
      agent,
      warnings: [],
      createdServers: [],
      reusedServers: [],
      createdSkills: [],
    });
    await mount();
    const file = await chooseFile('expert.zip');
    await click(button('导入', dialog('导入专家包')));
    await waitFor(() => document.querySelector('#agent-name'));
    expect(importZip).toHaveBeenCalledWith(file, undefined, undefined);
  });

  it.each([
    ['数据分析', 'rte_named'],
    ['默认环境', 'rte_default'],
  ])('maps a ZIP to the explicitly chosen environment %s', async (name, id) => {
    const importZip = vi.spyOn(api, 'importAgent').mockResolvedValue({
      agent,
      warnings: [],
      createdServers: [],
      reusedServers: [],
      createdSkills: [],
    });
    await mount();
    await chooseFile('expert.zip');
    await selectRole(name, 'agent-import-environment');
    await click(button('导入', dialog('导入专家包')));
    await waitFor(() => document.querySelector('#agent-name'));
    expect(importZip).toHaveBeenCalledWith(expect.any(File), undefined, id);
  });

  it('shows the default environment name for an explicitly mapped default after ZIP import', async () => {
    const imported = { ...agent, runtimeEnvironmentId: 'rte_default' };
    vi.spyOn(api, 'importAgent').mockResolvedValue({
      agent: imported,
      warnings: [],
      createdServers: [],
      reusedServers: [],
      createdSkills: [],
    });
    vi.mocked(api.agents).mockResolvedValue([imported]);
    await mount();
    await chooseFile('expert.zip');
    await selectRole('默认环境', 'agent-import-environment');
    await click(button('导入', dialog('导入专家包')));
    await waitFor(() => document.querySelector('#agent-name'));
    await click(button('运行限制'));
    await flush();
    const picker = document.getElementById('agent-runtime-environment');
    expect(picker?.textContent).toContain('默认环境');
    expect(picker?.textContent).not.toContain('平台默认环境');
    expect(picker?.textContent).not.toContain('rte_default');
  });

  it('keeps agent.md imports immediate without the environment mapping dialog', async () => {
    const importMd = vi.spyOn(api, 'importAgentFile').mockResolvedValue({
      agent,
      warnings: [],
    });
    await mount();
    await chooseFile('agent.md', '# Expert');
    expect(importMd).toHaveBeenCalledWith('# Expert');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await waitFor(() => document.querySelector('#agent-name'));
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

describe('expert draft previews', () => {
  it('does not render workspace files while previews are folded', async () => {
    const render = vi.mocked(renderWorkspace);
    render.mockClear();
    await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    expect(render).not.toHaveBeenCalled();

    await editName('每按键草稿');
    await click(button('行为'));
    await editInput('agent-prompt', '每按键提示词');
    await flush();
    expect(render).not.toHaveBeenCalled();
  });

  it('renders the draft only after expansion and follows later edits', async () => {
    const prompted = { ...agent, systemPrompt: '初始提示词' };
    useAgentAs(prompted);
    const render = vi.mocked(renderWorkspace);
    render.mockClear();
    await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    await click(button('行为'));
    expect(render).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLTextAreaElement>('#agent-prompt')?.value).toBe('初始提示词');

    await click(button('CLAUDE.md 草稿'));
    expect(render).toHaveBeenCalled();
    expect(host.textContent).toContain('初始提示词');

    await editInput('agent-prompt', '更新后的提示词');
    await flush();
    expect(host.textContent).toContain('更新后的提示词');
    expect(host.textContent).not.toContain('初始提示词');
  });

  it('keeps unsaved fields when switching config sections', async () => {
    await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    await editName('分区草稿');
    await click(button('行为'));
    expect(document.querySelector('#agent-name')).toBeNull();
    await click(button('身份'));
    await waitFor(() => document.querySelector('#agent-name'));
    expect(field().value).toBe('分区草稿');
  });

  it('clears the dirty state after saving edits made in different config sections', async () => {
    const saved = {
      ...agent,
      name: '配置验收草稿',
      systemPrompt: '验收用提示词',
      updatedAt: '2026-03-01T00:00:00Z',
    };
    const update = vi.spyOn(api, 'updateAgent').mockResolvedValue(saved);
    vi.mocked(api.agents).mockResolvedValue([saved]);
    await mount();
    await click(link('Expert'));
    await waitFor(() => document.querySelector('#agent-name'));
    await editName('配置验收草稿');
    await click(button('行为'));
    await waitFor(() => document.querySelector('#agent-prompt'));
    await editInput('agent-prompt', '验收用提示词');
    await click(button('CLAUDE.md 草稿'));
    await flush();
    await click(button('身份'));
    await waitFor(() => document.querySelector('#agent-name'));

    await click(button('保存更改'));
    await waitFor(() => document.querySelector('h1')?.textContent === '配置验收草稿');

    expect(update).toHaveBeenCalledOnce();
    expect(field().value).toBe('配置验收草稿');
    expect(document.body.textContent).not.toContain('未保存');
    expect(button('已保存').disabled).toBe(true);
  });
});
