import type {
  MemoryFileContent,
  MemoryFileList,
  OutputStyle,
  Rule,
  WorkspaceFiles,
} from '@agentport/shared';
import { type Agent, agentInputSchema, PERMISSIONS } from '@agentport/shared';
import { EditorView } from '@codemirror/view';
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
import { toastError } from '../src/lib/toast.js';
import { AgentDetailPage } from '../src/pages/agents.js';
import { agentDetailSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  parentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const restrictedPermissions = [
  'agents.read',
  'agents.use',
  'agents.memory.read',
  'agents.memory.write',
  'agents.rules.read',
  'agents.rules.write',
  'agents.styles.read',
  'agents.styles.write',
  'agents.files.read',
  'agents.delete',
] as const;

const me = {
  authenticated: true as const,
  user: { businessId: 'maintainer', username: 'maintainer', name: '维护者' },
  roles: [],
  grants: PERMISSIONS.filter((permission) =>
    restrictedPermissions.includes(permission.id as (typeof restrictedPermissions)[number]),
  ).map((permission) => ({
    permissionId: permission.id,
    scope: 'platform' as const,
  })),
};

const memoryList: MemoryFileList = {
  files: [{ name: 'MEMORY.md', size: 5, updatedAt: '2026-01-01T00:00:00Z' }],
  initialized: true,
};
const memoryFile: MemoryFileContent = {
  name: 'MEMORY.md',
  content: '# 记忆',
  updatedAt: '2026-01-01T00:00:00Z',
};
const rule: Rule = {
  id: 'rule-1',
  agentId: agent.id,
  slug: 'no-console',
  content: '# 规则',
  globs: '',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const style: OutputStyle = {
  id: 'style-1',
  agentId: agent.id,
  slug: 'concise',
  description: '简短',
  keepCodingInstructions: false,
  body: '# 风格',
  isSelected: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const files: WorkspaceFiles = {
  mcpJson: '{}',
  claudeMd: '# CLAUDE',
  agentMd: '# Expert',
  settingsJson: null,
  skills: [],
  subAgents: [],
  rules: [],
  outputStyles: [],
  selectedOutputStyle: null,
  plugins: [],
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createBrowserHistory>;
let configGet: ReturnType<typeof vi.spyOn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function waitFor<T>(probe: () => T, tries = 60): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 路由或懒加载还没落地，继续等。
    }
    await flush();
  }
  return probe();
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
function tab(text: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing tab: ${text}`);
  return element;
}
function menuItem(text: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing menu item: ${text}`);
  return element;
}
function dialog(title: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
}
function editorView(id: string): EditorView {
  const element = document.getElementById(id);
  if (!element?.classList.contains('cm-content')) throw new Error(`Editor not mounted: ${id}`);
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error(`Editor view not found: ${id}`);
  return view;
}
async function replaceContent(id: string, value: string) {
  await act(async () => {
    const view = editorView(id);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
  await flush();
}
function currentFile(): string | undefined {
  return document.querySelector<HTMLElement>('[aria-current="true"]')?.textContent?.trim();
}

async function mount(initialEntries: string[] = ['/agents/expert?tab=memory']) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const list = createRoute({
    getParentRoute: () => shell,
    path: '/agents/',
    component: () => createElement('h1', null, 'Agents'),
  });
  const detail = createRoute({
    getParentRoute: () => shell,
    path: '/agents/$agentId',
    validateSearch: agentDetailSearchSchema,
    component: AgentDetailPage,
  });
  const away = createRoute({
    getParentRoute: () => rootRoute,
    path: '/away',
    component: () => createElement('h1', null, 'Away'),
  });
  history = createBrowserHistory();
  history.replace(initialEntries[0] ?? '/agents/expert?tab=memory');
  history.flush();
  for (const entry of initialEntries.slice(1)) {
    history.push(entry);
    history.flush();
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([list, detail]), away]),
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
  configGet = vi.spyOn(api, 'agent').mockRejectedValue(new Error('config GET is not allowed'));
  vi.spyOn(api, 'me').mockResolvedValue(me);
  vi.spyOn(api, 'agentAccess').mockResolvedValue({
    agentId: agent.id,
    permissionIds: [...restrictedPermissions],
  });
  vi.spyOn(api, 'agentMemory').mockResolvedValue(memoryList);
  vi.spyOn(api, 'agentMemoryFile').mockResolvedValue(memoryFile);
  vi.spyOn(api, 'writeAgentMemoryFile').mockResolvedValue(memoryFile);
  vi.spyOn(api, 'agentRules').mockResolvedValue([rule]);
  vi.spyOn(api, 'agentOutputStyles').mockResolvedValue([style]);
  vi.spyOn(api, 'agentFiles').mockResolvedValue(files);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  client.setQueryData(['me'], me);
  client.setQueryData(['agents'], [agent]);
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

describe('restricted expert task navigation', () => {
  it('confirms before switching a dirty task and keeps the draft and URL on cancel', async () => {
    const router = await mount();
    await waitFor(() => editorView('memory-content'));
    await replaceContent('memory-content', '# 未保存的记忆');

    await click(tab('项目规则'));
    expect(dialog('放弃未保存的修改并切换？')).toBeDefined();
    expect(router.state.location.search.tab).toBe('memory');
    expect(editorView('memory-content').state.doc.toString()).toBe('# 未保存的记忆');

    await click(button('取消', dialog('放弃未保存的修改并切换？')));
    expect(dialog('放弃未保存的修改并切换？')).toBeUndefined();
    expect(router.state.location.search.tab).toBe('memory');
    expect(editorView('memory-content').state.doc.toString()).toBe('# 未保存的记忆');

    await click(tab('项目规则'));
    await click(button('放弃并切换'));
    await waitFor(() => router.state.location.search.tab === 'rules');
    expect(document.getElementById('memory-content')).toBeNull();
    expect(button('新建规则')).toBeDefined();
    expect(configGet).not.toHaveBeenCalled();
  });

  it('confirms before leaving the page and keeps the draft when the route change is cancelled', async () => {
    const router = await mount();
    await waitFor(() => editorView('memory-content'));
    await replaceContent('memory-content', '# 未保存的记忆');

    await click(button('返回列表'));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('取消', dialog('放弃未保存的更改？')));
    expect(router.state.location.pathname).toBe('/agents/expert');
    expect(editorView('memory-content').state.doc.toString()).toBe('# 未保存的记忆');

    await click(button('返回列表'));
    await click(button('放弃并离开'));
    await waitFor(() => router.state.location.pathname === '/agents');
  });

  it('blocks task switches and route changes while a restricted save is pending', async () => {
    const saved = deferred<MemoryFileContent>();
    vi.spyOn(api, 'writeAgentMemoryFile').mockReturnValue(saved.promise);
    const router = await mount();
    await waitFor(() => editorView('memory-content'));
    await replaceContent('memory-content', '# 保存中的记忆');
    await click(button('记忆保存'));

    expect(button('返回列表').disabled).toBe(true);
    await click(tab('项目规则'));
    expect(router.state.location.search.tab).toBe('memory');
    expect(editorView('memory-content').state.doc.toString()).toBe('# 保存中的记忆');

    const navigation = router.navigate({ to: '/away' });
    await flush();
    expect(dialog('当前操作尚未完成')).toBeDefined();
    expect(button('放弃并离开').disabled).toBe(true);
    expect(router.state.location.pathname).toBe('/agents/expert');

    saved.resolve({ ...memoryFile, content: '# 保存中的记忆' });
    await flush();
    await waitFor(() => !button('返回列表').disabled);
    await click(button('取消', dialog('当前操作尚未完成')));
    await flush();
    void navigation;
    expect(router.state.location.pathname).toBe('/agents/expert');

    await click(tab('项目规则'));
    await waitFor(() => router.state.location.search.tab === 'rules');
    expect(dialog('当前操作尚未完成')).toBeUndefined();
  });

  it('settles a navigation blocked by a pending delete before returning to the list', async () => {
    const deletion = deferred<void>();
    vi.spyOn(api, 'deleteAgent').mockReturnValue(deletion.promise);
    const router = await mount();
    await waitFor(() => editorView('memory-content'));

    // 直接记录 blockerFn 返回的 Promise：后续返回列表的导航可能完成 navigate Promise，掩盖这里。
    let blockerSettled = false;
    const realBlock = history.block.bind(history);
    history.block = (blocker) =>
      realBlock({
        ...blocker,
        blockerFn: (args) => {
          const result = blocker.blockerFn(args);
          void Promise.resolve(result).then(() => {
            blockerSettled = true;
          });
          return result;
        },
      });

    await click(button('专家管理操作'));
    await click(menuItem('删除专家'));
    await click(button('删除', dialog('删除专家「Expert」')));
    expect(button('返回列表').disabled).toBe(true);

    // 删除在途时离开被拦下；不取消，等删除成功。
    const navigation = router.navigate({ to: '/away' });
    await flush();
    expect(dialog('当前操作尚未完成')).toBeDefined();
    expect(blockerSettled).toBe(false);

    await act(async () => deletion.resolve());
    await flush();
    await waitFor(() => router.state.location.pathname === '/agents');
    expect(dialog('当前操作尚未完成')).toBeUndefined();
    expect(blockerSettled).toBe(true);
    void navigation;
  });

  it('keeps a failed save as a draft and still protects the task switch', async () => {
    vi.spyOn(api, 'writeAgentMemoryFile').mockRejectedValue(new Error('save failed'));
    const router = await mount();
    await waitFor(() => editorView('memory-content'));
    await replaceContent('memory-content', '# 保存失败的记忆');
    await click(button('记忆保存'));
    await waitFor(() => vi.mocked(toastError).mock.calls.length > 0);

    expect(editorView('memory-content').state.doc.toString()).toBe('# 保存失败的记忆');
    await click(tab('项目规则'));
    expect(dialog('放弃未保存的修改并切换？')).toBeDefined();
    expect(router.state.location.search.tab).toBe('memory');
    await click(button('取消', dialog('放弃未保存的修改并切换？')));
    expect(editorView('memory-content').state.doc.toString()).toBe('# 保存失败的记忆');
  });

  it('blocks a same-path browser back while dirty', async () => {
    const router = await mount(['/agents/expert?tab=rules', '/agents/expert?tab=memory']);
    await waitFor(() => editorView('memory-content'));
    await replaceContent('memory-content', '# 未保存的记忆');

    await act(async () => {
      router.history.back();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(dialog('放弃未保存的修改并切换？')).toBeDefined();
    await click(button('取消', dialog('放弃未保存的修改并切换？')));
    expect(router.state.location.search.tab).toBe('memory');

    await act(async () => {
      router.history.back();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await click(button('放弃并切换'));
    await waitFor(() => router.state.location.search.tab === 'rules');
    expect(button('新建规则')).toBeDefined();
  });

  it('restores a permitted task from the URL and falls back without loading the config body', async () => {
    const rulesRouter = await mount(['/agents/expert?tab=rules']);
    await waitFor(() => button('新建规则'));
    expect(rulesRouter.state.location.search.tab).toBe('rules');
    expect(configGet).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    history.destroy();
    root = createRoot(host);
    client.clear();
    client.setQueryData(['me'], me);
    client.setQueryData(['agents'], [agent]);
    const fallbackRouter = await mount(['/agents/expert?tab=config']);
    await waitFor(() => editorView('memory-content'));
    expect(document.getElementById('agent-name')).toBeNull();
    expect(fallbackRouter.state.location.search.tab).toBe('config');
    expect(configGet).not.toHaveBeenCalled();
  });

  it('keeps the selected workspace file in the URL', async () => {
    const router = await mount(['/agents/expert?tab=files&file=CLAUDE.md']);
    await waitFor(() => currentFile() === 'CLAUDE.md');
    expect(router.state.location.search.file).toBe('CLAUDE.md');

    await click(button('.mcp.json'));
    await waitFor(() => router.state.location.search.file === '.mcp.json');
    expect(currentFile()).toBe('.mcp.json');
  });
});
