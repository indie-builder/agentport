import { agentInputSchema } from '@agentport/shared';
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
import { z } from 'zod';
import {
  ApiError,
  type ApprovalRequest,
  api,
  type ChatAccepted,
  type RunDetail,
} from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { toastError } from '../src/lib/toast.js';
import { ChatPage } from '../src/pages/chat.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'agent-a',
  parentId: null,
  createdAt: '',
  updatedAt: '',
};
const terminal: RunDetail = {
  run: {
    id: 'run-old',
    conversationId: 'conversation-a',
    agentId: 'agent-a',
    agentName: 'Expert',
    status: 'failed',
    startedAt: null,
    endedAt: null,
    latencyMs: null,
    turns: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: 'Connector refused the request',
    sessionId: null,
    sandboxId: null,
  },
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: 'History' },
  steps: [],
};
class Source {
  onopen = null;
  onmessage = null;
  onerror = null;
  close() {}
}
let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function mount(initialEntry = '/chat') {
  const route = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => route, id: '_shell', component: Outlet });
  const chat = createRoute({
    getParentRoute: () => shell,
    path: '/chat',
    validateSearch: z.object({
      agent: z.string().min(1).optional().catch(undefined),
      conversation: z.string().min(1).optional().catch(undefined),
    }),
    component: ChatPage,
  });
  const away = createRoute({ getParentRoute: () => route, path: '/away', component: () => null });
  const run = createRoute({
    getParentRoute: () => route,
    path: '/runs/$runId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: route.addChildren([shell.addChildren([chat]), away, run]),
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
function message() {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]');
  if (!input) throw new Error('Missing message input');
  return input;
}
function runLink() {
  return [...host.querySelectorAll('a')].find((link) => link.textContent === '查看本次运行');
}
async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(message(), text);
    message().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  useChatStore.getState().reset();
  vi.mocked(toastError).mockClear();
  localStorage.clear();
  vi.stubGlobal('EventSource', Source);
  // jsdom 没有 ResizeObserver；这里只需要让分栏库能挂载，折叠/展开由按钮状态驱动。
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['agents'], [agent]);
  vi.spyOn(api, 'agents').mockResolvedValue([agent]);
  vi.spyOn(api, 'conversations').mockResolvedValue([]);
  vi.spyOn(api, 'conversation').mockResolvedValue({
    conversation: { ...terminal.conversation, createdAt: '' },
    runMetrics: [],
    nextBefore: null,
    messages: [
      {
        id: 'message-a',
        conversationId: 'conversation-a',
        role: 'user',
        content: 'old prompt',
        runId: 'run-old',
        createdAt: '',
      },
    ],
  });
  vi.spyOn(api, 'run').mockResolvedValue(terminal);
  vi.spyOn(api, 'runApprovals').mockResolvedValue({ items: [] });
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

it('shows the woodworker only in the conversation welcome state', async () => {
  await mount();
  const artwork = () => host.querySelector('img[src="/brand/pace-chat-woodworker.svg"]');
  expect(artwork()).not.toBeNull();
  expect(artwork()?.getAttribute('alt')).toBe('');
  await act(async () => {
    useChatStore.setState({ items: [{ kind: 'user', text: 'Help me plan a task' }] });
  });
  expect(artwork()).toBeNull();
  expect(host.textContent).toContain('Help me plan a task');
});

it('fills a suggested task and returns focus to the composer without sending', async () => {
  await mount();
  const suggestion = [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '制定计划',
  );
  if (!suggestion) throw new Error('Missing task suggestion');
  await act(async () => suggestion.click());
  expect(message().value).toBe('帮我把一个目标拆成可执行的步骤，先询问我需要完成什么。');
  expect(document.activeElement).toBe(message());
  expect(useChatStore.getState().run).toBeNull();
  expect(useChatStore.getState().items).toEqual([]);
});

describe('confirmed chat UX defects', () => {
  it('preserves the unsent draft across route teardown while clearing workspace state', async () => {
    const router = await mount();
    await type('unfinished draft');
    expect(message().value).toBe('unfinished draft');
    await act(async () => {
      useChatStore.setState({
        conversationId: 'conversation-a',
        items: [{ kind: 'text', text: 'old reply' }],
        run: {
          runId: 'run-old',
          conversationId: 'conversation-a',
          status: 'detached',
          startedAt: 1,
        },
        lastRun: { runId: 'run-old', status: 'failed', durationMs: 1 },
        lastRunId: 'run-old',
        historyOpen: true,
      });
      await router.navigate({ to: '/away' });
    });
    expect(useChatStore.getState()).toMatchObject({
      input: 'unfinished draft',
      conversationId: null,
      items: [],
      run: null,
      lastRun: null,
      lastRunId: null,
      historyOpen: false,
    });
    await act(async () => {
      await router.navigate({ to: '/chat' });
    });
    await flush();
    expect(message().value).toBe('unfinished draft');
    expect(host.textContent).not.toContain('old reply');
  });

  it('shows terminal history outcome and error without inventing missing metrics', async () => {
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    expect(host.textContent).toContain('失败');
    expect(host.textContent).toContain('Connector refused the request');
    expect(host.querySelector('a[href="/runs/run-old"]')).not.toBeNull();
    expect(host.textContent).not.toMatch(/0\.0s|0 tok|\$0\.000|NaNs/);
  });

  it('identifies ambiguous fallback approvals and their separate actions by connector', async () => {
    const approvals: ApprovalRequest[] = ['server-a', 'server-b'].map((serverId) => ({
      id: `approval-${serverId}`,
      serverId,
      serverName: null,
      toolName: 'write',
      approvedAt: null,
      createdAt: '',
    }));
    vi.mocked(api.runApprovals).mockResolvedValue({ items: approvals });
    let approvedServer: string | undefined;
    vi.spyOn(api, 'approveRun').mockImplementation(async (_runId, serverId) => {
      approvedServer = serverId;
      return { ok: true };
    });
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    const cards = [...host.querySelectorAll('[role="alert"]')];
    expect(cards).toHaveLength(2);
    for (const serverId of ['server-a', 'server-b']) {
      const card = cards.find((item) => item.textContent?.includes(serverId));
      expect(card, `approval identity for ${serverId}`).toBeDefined();
      expect(card?.querySelector('button')?.getAttribute('aria-label')).toBe(
        `批准 ${serverId} / write`,
      );
    }
    const second = host.querySelector<HTMLButtonElement>(
      'button[aria-label="批准 server-b / write"]',
    );
    await act(async () => second?.click());
    expect(approvedServer).toBe('server-b');
  });

  it.each(['reject', 'accept'] as const)(
    'clears the old run link before follow-up %s',
    async (outcome) => {
      let resolve!: (accepted: ChatAccepted) => void;
      let reject!: (error: Error) => void;
      vi.spyOn(api, 'sendChat').mockReturnValue(
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      await mount('/chat?agent=agent-a&conversation=conversation-a');
      expect(runLink()?.getAttribute('href')).toBe('/runs/run-old');
      await type('follow-up');
      await act(async () =>
        host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click(),
      );
      expect(runLink()).toBeUndefined();
      await act(async () => {
        if (outcome === 'reject') reject(new Error('Send rejected'));
        else resolve({ runId: 'run-new', conversationId: 'conversation-a' });
      });
      await flush();
      if (outcome === 'reject') {
        expect(runLink()).toBeUndefined();
        expect(message().value).toBe('follow-up');
        expect(host.textContent).toContain('Send rejected');
      } else expect(runLink()?.getAttribute('href')).toBe('/runs/run-new');
    },
  );
});

describe('chat shell layout', () => {
  it('keeps the expert picker inside the history area only', async () => {
    await mount();
    // 消息区页头没有专家选择；手机打开历史抽屉后才出现。
    expect(host.querySelector('[aria-label="选择专家"]')).toBeNull();
    await act(async () => {
      useChatStore.setState({ historyOpen: true });
    });
    await flush();
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.querySelector('h1')).toBeNull();
    expect(sheet?.querySelector('[aria-label="选择专家"]')).not.toBeNull();
    // 抽屉 portal 挂在 body 下，用整页计数确认全页只有这一处专家选择。
    expect(document.querySelectorAll('[aria-label="选择专家"]')).toHaveLength(1);
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);
  });

  it('hides history by default on desktop and toggles it from the header', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    await mount();
    expect(host.querySelector('aside[aria-label="会话历史"]')).toBeNull();
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]');
    if (!toggle) throw new Error('Missing history toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await act(async () => toggle.click());
    const history = host.querySelector('aside[aria-label="会话历史"]');
    expect(history).not.toBeNull();
    // 专家选择随历史面板一起出现，且只在历史内。
    expect(history?.querySelector('[aria-label="选择专家"]')).not.toBeNull();
    expect(host.querySelectorAll('[aria-label="选择专家"]')).toHaveLength(1);
    expect(
      host.querySelector('button[aria-label="隐藏会话历史"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);

    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="隐藏会话历史"]')?.click(),
    );
    expect(host.querySelector('aside[aria-label="会话历史"]')).toBeNull();
  });

  it('switches experts with an open conversation and starts fresh under the new expert', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    const other = {
      ...agentInputSchema.parse({ slug: 'other', name: 'Other Expert' }),
      id: 'agent-b',
      parentId: null,
      createdAt: '',
      updatedAt: '',
    };
    client.setQueryData(['agents'], [agent, other]);
    vi.mocked(api.agents).mockResolvedValue([agent, other]);
    vi.mocked(api.conversations).mockImplementation(async (agentId?: string) =>
      agentId === 'agent-a'
        ? [
            {
              id: 'conversation-a',
              agentId: 'agent-a',
              title: 'History',
              createdAt: '',
              updatedAt: '',
              lastMessage: null,
            },
          ]
        : [
            {
              id: 'conversation-b',
              agentId: 'agent-b',
              title: 'Other history',
              createdAt: '',
              updatedAt: '',
              lastMessage: null,
            },
          ],
    );
    const remove = vi.spyOn(api, 'deleteConversation');
    const router = await mount('/chat?agent=agent-a&conversation=conversation-a');
    await type('unfinished draft');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]')?.click(),
    );
    await flush();
    expect(host.textContent).toContain('old prompt');

    const picker = host.querySelector<HTMLButtonElement>('[aria-label="选择专家"]');
    if (!picker) throw new Error('Missing expert picker');
    expect(picker.disabled).toBe(false);
    await act(async () => picker.click());
    await flush();

    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索专家"]');
    if (!search) throw new Error('Missing expert search');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'Other');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const option = [...document.querySelectorAll('[role="option"]')].find((item) =>
      item.textContent?.includes('Other Expert'),
    );
    if (!option) throw new Error('Missing expert option');
    await act(async () => option.click());
    await flush();

    expect(router.state.location.search).toEqual({ agent: 'agent-b' });
    expect(useChatStore.getState().items).toEqual([]);
    expect(host.textContent).not.toContain('old prompt');
    expect(host.textContent).not.toContain('History');
    expect(host.textContent).toContain('Other history');
    expect(host.textContent).toContain('未命名会话');
    expect(vi.mocked(api.conversations)).toHaveBeenCalledWith('agent-b', expect.any(AbortSignal));
    expect(message().value).toBe('unfinished draft');
    expect(remove).not.toHaveBeenCalled();
  });

  it('shows a list failure in the history panel and never falls back to browser records', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    localStorage.setItem(
      'agentport:conversations',
      JSON.stringify([
        {
          id: 'conversation-local',
          agentId: 'agent-a',
          title: 'Local only',
          createdAt: '',
          updatedAt: '',
        },
      ]),
    );
    vi.mocked(api.conversations).mockRejectedValue(new ApiError(0, 'Failed to fetch'));
    await mount('/chat?agent=agent-a');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]')?.click(),
    );
    await flush();
    const history = host.querySelector('aside[aria-label="会话历史"]');
    expect(history?.textContent).toContain('连不上 API 服务');
    expect(history?.textContent).not.toContain('Local only');
    expect(host.textContent).not.toContain('历史列表来自本浏览器');
  });

  it('opens a workspace of conversation results without touching history', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    await mount();
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示工作区"]');
    if (!toggle) throw new Error('Missing workspace toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('chat-workspace');

    await act(async () => toggle.click());
    const workspace = host.querySelector('aside[aria-label="会话成果"]');
    expect(workspace).not.toBeNull();
    expect(workspace?.querySelector('h2')?.textContent).toBe('会话成果');
    expect(workspace?.textContent).toContain('当前会话没有成果文件');
    expect(workspace?.textContent).not.toMatch(/\.mcp\.json|CLAUDE\.md/);
    // 工作区与历史是两条独立状态：打开工作区不会把历史也打开。
    expect(useChatStore.getState().historyOpen).toBe(false);
    expect(host.querySelector('aside[aria-label="会话历史"]')).toBeNull();
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);

    const hide = host.querySelector<HTMLButtonElement>('button[aria-label="隐藏工作区"]');
    await act(async () => hide?.click());
    expect(host.querySelector('aside[aria-label="会话成果"]')).toBeNull();
    expect(host.querySelector('button[aria-label="显示工作区"]')).not.toBeNull();
  });

  it('keeps the draft and expert when the workspace opens', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    const router = await mount('/chat?agent=agent-a');
    await type('unfinished draft');
    // 专家选择在收起的历史面板里，面板打开前不可见：以 URL 上的专家为准。
    const expertBefore = router.state.location.search;
    expect(expertBefore).toMatchObject({ agent: 'agent-a' });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="显示工作区"]')?.click(),
    );
    expect(host.querySelector('aside[aria-label="会话成果"]')).not.toBeNull();
    expect(message().value).toBe('unfinished draft');
    expect(router.state.location.search).toEqual(expertBefore);
  });

  it('returns focus to the workspace toggle after closing the narrow-screen sheet', async () => {
    await mount();
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示工作区"]');
    if (!toggle) throw new Error('Missing workspace toggle');
    await act(async () => toggle.click());
    expect(document.querySelector('[role="dialog"] aside[aria-label="会话成果"]')).not.toBeNull();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="dialog"] [data-slot="sheet-close"]')
        ?.click(),
    );
    await flush();
    expect(document.activeElement).toBe(host.querySelector('button[aria-label="显示工作区"]'));
  });
});

describe('conversation header menu', () => {
  function headerTitle() {
    return host.querySelector('h1');
  }
  function menuButton() {
    return host.querySelector<HTMLButtonElement>('button[aria-label="会话操作"]');
  }
  async function openMenu() {
    const trigger = menuButton();
    if (!trigger) throw new Error('Missing conversation menu');
    // Base UI 用 mousedown 打开菜单，jsdom 的 click() 不会触发它。
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flush();
  }
  function menuItem(label: string) {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === label,
    );
  }
  function dialog() {
    return document.querySelector('[role="dialog"]');
  }
  function dialogButton(label: string) {
    return [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === label,
    );
  }

  it('keeps the full title while the menu button follows the truncated heading', async () => {
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    const heading = headerTitle();
    expect(heading?.textContent).toBe('History');
    expect(heading?.getAttribute('title')).toBe('History');
    expect(heading?.className).toContain('truncate');
    expect(heading?.className).toContain('lg:max-w-[8em]');
    // 「…」紧跟标题，而不是被推到最右侧。
    expect(heading?.nextElementSibling?.contains(menuButton())).toBe(true);
  });

  it('disables the menu until a conversation is saved', async () => {
    await mount();
    const button = menuButton();
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('title')).toContain('先发送消息');
  });

  it('offers rename, fork and delete for a saved conversation', async () => {
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    await openMenu();
    expect(menuItem('重命名')).toBeDefined();
    expect(menuItem('Fork 会话')).toBeDefined();
    expect(menuItem('删除会话')).toBeDefined();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    const remove = vi.spyOn(api, 'deleteConversation').mockResolvedValue();
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    await openMenu();
    await act(async () => menuItem('删除会话')?.click());
    await flush();
    expect(dialog()?.textContent).toContain('删除会话？');
    await act(async () => dialogButton('取消')?.click());
    await flush();
    expect(remove).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(headerTitle()?.textContent).toBe('History');
  });

  it('deletes after confirmation, keeps the draft and starts a new conversation', async () => {
    let finish!: () => void;
    const remove = vi.spyOn(api, 'deleteConversation').mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const router = await mount('/chat?agent=agent-a&conversation=conversation-a');
    await type('unfinished draft');
    await openMenu();
    await act(async () => menuItem('删除会话')?.click());
    await flush();
    await act(async () => dialogButton('删除会话')?.click());
    await flush();
    expect(remove).toHaveBeenCalledWith('conversation-a');
    // 请求未完成前不重复发送：确认按钮转 pending、取消禁用。
    expect(dialog()?.querySelector<HTMLButtonElement>('[aria-busy="true"]')?.disabled).toBe(true);
    expect(dialogButton('取消')?.disabled).toBe(true);
    await act(async () => finish());
    await flush();
    expect(dialog()).toBeNull();
    expect(router.state.location.search).not.toMatchObject({ conversation: 'conversation-a' });
    expect(headerTitle()?.textContent).toBe('未命名会话');
    expect(message().value).toBe('unfinished draft');
  });

  it('keeps the conversation and draft when deletion fails', async () => {
    vi.spyOn(api, 'deleteConversation').mockRejectedValue(new Error('still running'));
    const router = await mount('/chat?agent=agent-a&conversation=conversation-a');
    await type('unfinished draft');
    await openMenu();
    await act(async () => menuItem('删除会话')?.click());
    await flush();
    await act(async () => dialogButton('删除会话')?.click());
    await flush();
    expect(toastError).toHaveBeenCalled();
    // 失败后确认框仍打开可重试，当前会话与草稿不动。
    expect(dialog()?.textContent).toContain('删除会话？');
    expect(router.state.location.search).toMatchObject({ conversation: 'conversation-a' });
    expect(headerTitle()?.textContent).toBe('History');
    expect(message().value).toBe('unfinished draft');
  });
});
