import { type Agent, agentInputSchema, PERMISSIONS, type PermissionId } from '@agentport/shared';
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
import { AgentsPage } from '../src/pages/agents.js';
import { ChatPage } from '../src/pages/chat.js';
import { agentsSearchSchema, chatSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const agent: Agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'expert',
  parentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function meWith(ids: PermissionId[]) {
  return {
    authenticated: true as const,
    user: { businessId: 'reader', username: 'reader', name: '只读账户' },
    roles: [],
    grants: PERMISSIONS.filter((permission) => ids.includes(permission.id)).map((permission) => ({
      permissionId: permission.id,
      scope: 'platform' as const,
    })),
  };
}

const readerMe = meWith(['conversations.read', 'agents.read', 'agents.use']);
const creatorMe = meWith(['conversations.read', 'agents.read', 'agents.create']);
const noAgentReadMe = meWith(['conversations.read', 'agents.use']);

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function waitFor<T>(probe: () => T, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 页面还没提交，继续等。
    }
    await flush();
  }
  return probe();
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function mount(component: typeof ChatPage | typeof AgentsPage, initialEntry: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const route =
    component === ChatPage
      ? createRoute({
          getParentRoute: () => shell,
          path: '/chat',
          validateSearch: chatSearchSchema,
          component: ChatPage,
        })
      : createRoute({
          getParentRoute: () => shell,
          path: '/agents/',
          validateSearch: agentsSearchSchema,
          component: AgentsPage,
        });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([route])]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('chat empty state follows agent permissions', () => {
  it('offers the original creation step to an account that can create experts', async () => {
    client.setQueryData(['agents'], []);
    client.setQueryData(['me'], creatorMe);
    await mount(ChatPage, '/chat');
    await waitFor(() => host.textContent?.includes('先创建一位专家'));
    expect(host.textContent).toContain('创建后即可在这里开始对话。');
    expect(host.textContent).toContain('前往专家');
  });

  it('does not tell a reader to create an expert and points to the expert list', async () => {
    client.setQueryData(['agents'], []);
    client.setQueryData(['me'], readerMe);
    await mount(ChatPage, '/chat');
    await waitFor(() => host.textContent?.includes('暂无可用专家'));
    expect(host.textContent).toContain('当前账户尚未分配可用专家，请联系管理员。');
    expect(host.textContent).not.toContain('先创建一位专家');
    expect(host.textContent).toContain('前往专家');
  });

  it('does not link to the expert list without agents.read', async () => {
    client.setQueryData(['agents'], []);
    client.setQueryData(['me'], noAgentReadMe);
    await mount(ChatPage, '/chat');
    await waitFor(() => host.textContent?.includes('暂无可用专家'));
    expect(host.textContent).not.toContain('前往专家');
  });

  it('does not show creation guidance while permissions are unknown', async () => {
    client.setQueryData(['agents'], []);
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    await mount(ChatPage, '/chat');
    await waitFor(() => host.querySelector('[role="status"][aria-label="加载中"]'));
    expect(host.textContent).not.toContain('先创建一位专家');
    expect(host.textContent).not.toContain('暂无可用专家');
  });
});

describe('agent list empty state follows agent permissions', () => {
  it('keeps the original creation step for an account that can create experts', async () => {
    client.setQueryData(['agents'], []);
    client.setQueryData(['me'], creatorMe);
    client.setQueryData(['runtime-environments'], []);
    await mount(AgentsPage, '/agents');
    await waitFor(() => host.textContent?.includes('新建专家'));
    expect(host.querySelector('button[aria-label="新建专家"]')).not.toBeNull();
    expect(host.textContent).toContain('创建数字分身');
    expect(host.textContent).not.toContain('还没有专家');
    expect(host.textContent).not.toContain('创建第一位专家');
    expect(host.textContent).not.toContain('暂无可用专家');
  });

  it('explains an unassigned reader without claiming the platform has no experts', async () => {
    client.setQueryData(['agents'], []);
    client.setQueryData(['me'], readerMe);
    client.setQueryData(['runtime-environments'], []);
    await mount(AgentsPage, '/agents');
    await waitFor(() => host.textContent?.includes('暂无可用专家'));
    expect(host.textContent).toContain('当前账户尚未分配可用专家，请联系管理员。');
    expect(host.textContent).not.toContain('还没有专家');
    expect(host.textContent).not.toContain('创建第一位专家');
    expect(host.textContent).not.toContain('创建数字分身');
  });

  it('lets an assigned reader open a digital employee badge without creation controls', async () => {
    const staff: Agent = {
      ...agent,
      id: 'staff',
      slug: 'staff',
      name: '客服专家',
      role: '群聊答疑专员',
      description: '处理群聊答疑。',
    };
    client.setQueryData(['agents'], [staff]);
    client.setQueryData(['me'], readerMe);
    client.setQueryData(['runtime-environments'], []);
    await mount(AgentsPage, '/agents');
    const trigger = await waitFor(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="查看 客服专家 工牌"]'),
    );
    if (!trigger) throw new Error('Missing badge trigger');
    // 创建入口卡不渲染；页头按钮按既有规则仅隐藏。
    expect(host.querySelector('button[aria-label="新建专家"]')).toBeNull();
    expect(host.textContent).not.toContain('创建数字分身');
    await click(trigger);
    const panel = await waitFor(() =>
      [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
        (item) => item.querySelector('h2')?.textContent === '客服专家 的工牌',
      ),
    );
    if (!panel) throw new Error('Missing badge dialog');
    expect(panel.textContent).toContain('数字员工');
    expect(panel.textContent).toContain('群聊答疑专员');
    expect(panel.textContent).toContain('处理群聊答疑。');
  });

  it('keeps the no-results state actionable when filters return nothing', async () => {
    client.setQueryData(['agents'], [agent]);
    client.setQueryData(['me'], readerMe);
    client.setQueryData(['runtime-environments'], []);
    const router = await mount(AgentsPage, '/agents?q=missing');
    await waitFor(() => host.textContent?.includes('没有匹配的专家'));
    expect(host.textContent).not.toContain('暂无可用专家');
    const clear = [...host.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === '清除筛选',
    );
    if (!clear) throw new Error('Missing clear filters button');
    await click(clear);
    await waitFor(() => router.state.location.search.q === undefined);
    expect(router.state.location.search.status).toBe('all');
  });
});
