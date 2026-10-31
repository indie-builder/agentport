import { agentInputSchema, DEFAULT_ROLES, type PublicRunQuestion } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
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
  type ConversationDetail,
  type RunDetail,
} from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { runQuestionsQueryKey } from '../src/lib/queries.js';
import { toastError } from '../src/lib/toast.js';
import { ChatPage } from '../src/pages/chat.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const adminMe = {
  authenticated: true as const,
  user: { businessId: 'admin', username: 'admin', name: '管理员' },
  roles: [],
  grants: [...DEFAULT_ROLES.find((role) => role.systemKey === 'admin')!.grants],
};

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
  static instances: Source[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    Source.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let browserHistory: ReturnType<typeof createBrowserHistory> | null = null;
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function mount(
  initialEntry = '/chat',
  history:
    | ReturnType<typeof createMemoryHistory>
    | ReturnType<typeof createBrowserHistory> = createMemoryHistory({
    initialEntries: [initialEntry],
  }),
) {
  const route = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => route, id: '_shell', component: Outlet });
  const chat = createRoute({
    getParentRoute: () => shell,
    path: '/chat',
    validateSearch: z.object({
      agent: z.string().min(1).optional().catch(undefined),
      conversation: z.string().min(1).optional().catch(undefined),
      outputRun: z.string().min(1).optional().catch(undefined),
      outputPath: z.string().min(1).optional().catch(undefined),
      outputMode: z.enum(['read', 'source']).optional().catch(undefined),
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
// 真实断点切换：只解析本页用到的 min-width 查询，并在跨过阈值时发 change。
function stubViewport(initialWidth: number) {
  let width = initialWidth;
  const entries = new Map<string, Set<() => void>>();
  const matches = (query: string) => {
    const min = /min-width:\s*([\d.]+)rem/.exec(query);
    return min ? width >= Number(min[1]) * 16 : false;
  };
  vi.stubGlobal('matchMedia', (query: string) => {
    const listeners = entries.get(query) ?? new Set<() => void>();
    entries.set(query, listeners);
    return {
      get matches() {
        return matches(query);
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      addListener() {},
      removeListener() {},
    };
  });
  return (next: number) => {
    const before = new Map([...entries.keys()].map((query) => [query, matches(query)]));
    width = next;
    for (const [query, listeners] of entries) {
      if (matches(query) !== before.get(query)) for (const fn of listeners) fn();
    }
  };
}
beforeEach(() => {
  useChatStore.getState().reset();
  Source.instances = [];
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
  client.setQueryData(['me'], adminMe);
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
  vi.spyOn(api, 'runQuestions').mockResolvedValue({ items: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  browserHistory?.destroy();
  browserHistory = null;
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
  // 建议任务只在已选定专家的欢迎态出现：裸 /chat 不替用户挑专家。
  await mount('/chat?agent=agent-a');
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
    // 这次运行没有产出回复，但已经结束：只显示失败原因，不再冒充仍在等待。
    expect(host.textContent).not.toContain('等待回复');
  });

  it('keeps the workspace, draft and attachments when refreshing experts fails', async () => {
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    await type('unfinished draft');
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Missing attachment input');
    await act(async () => {
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['hello'], 'notes.md', { type: 'text/markdown' })],
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('notes.md');

    // 走真实请求层：一次性网络失败，再让同一请求成功。
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['agents'] });
    });
    await flush();

    // 缓存仍在：后台刷新失败不能卸载工作区、清空附件/草稿或丢掉已打开会话。
    expect(host.textContent).toContain('old prompt');
    expect(message().value).toBe('unfinished draft');
    expect(host.textContent).toContain('notes.md');
    expect(useChatStore.getState().pendingAttachments).toHaveLength(1);
    // 真实刷新错误与重试入口同时可见。
    expect(host.textContent).toContain('专家列表刷新失败，保留当前会话');

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([agent]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '重试',
    );
    if (!retry) throw new Error('Missing expert refresh retry');
    await act(async () => retry.click());
    await flush();
    expect(host.textContent).not.toContain('专家列表刷新失败，保留当前会话');

    await type('still editable');
    expect(message().value).toBe('still editable');
    expect(useChatStore.getState().pendingAttachments).toHaveLength(1);
  });

  it.each([
    ['succeeded', '完成'],
    ['cancelled', '已停止'],
    ['timeout', '超时'],
  ] as const)(
    'does not show a waiting placeholder for a terminal %s run without output',
    async (status, label) => {
      vi.mocked(api.run).mockResolvedValue({
        ...terminal,
        run: { ...terminal.run, status, error: status === 'timeout' ? 'Run timed out' : null },
      });
      await mount('/chat?agent=agent-a&conversation=conversation-a');
      expect(host.textContent).toContain(label);
      expect(host.querySelector('a[href="/runs/run-old"]')).not.toBeNull();
      expect(host.textContent).not.toContain('等待回复');
    },
  );

  it.each([
    ['queued', '任务已提交，正在准备'],
    ['streaming', '等待回复'],
  ] as const)(
    'keeps feedback for a %s run that has not produced a reply yet',
    async (status, feedback) => {
      // 历史与运行详情都保持未决，让 store 里的活动运行直接驱动状态行。
      vi.mocked(api.conversation).mockReturnValue(new Promise(() => {}));
      vi.mocked(api.run).mockReturnValue(new Promise(() => {}));
      await act(async () => {
        useChatStore.setState({
          conversationId: 'conversation-a',
          items: [{ kind: 'user', text: 'old prompt', id: 'message-a' }],
          run: {
            runId: 'run-live',
            conversationId: 'conversation-a',
            status,
            startedAt: Date.now(),
          },
        });
      });
      await mount('/chat?agent=agent-a&conversation=conversation-a');
      expect(host.textContent).toContain(feedback);
      // 状态行是运行读数，不是那条终态才该消失的占位文案。
      expect(host.textContent).not.toContain('等待回复…');
    },
  );

  it.each([
    ['failed', '失败', 'First run exploded'],
    ['timeout', '超时', 'Run timed out'],
  ] as const)(
    'keeps a %s run outcome with its own prompt after a later turn replies',
    async (status, label, errorText) => {
      vi.mocked(api.conversation).mockResolvedValue({
        conversation: { ...terminal.conversation, createdAt: '' },
        nextBefore: null,
        messages: [
          {
            id: 'message-a',
            conversationId: 'conversation-a',
            role: 'user',
            content: 'first prompt',
            runId: 'run-a',
            uiFormat: 'markdown',
            uiProgram: null,
            uiState: null,
            createdAt: '2026-10-29T00:00:00.000Z',
          },
          {
            id: 'message-b',
            conversationId: 'conversation-a',
            role: 'user',
            content: 'second prompt',
            runId: 'run-b',
            uiFormat: 'markdown',
            uiProgram: null,
            uiState: null,
            createdAt: '2026-10-29T00:01:00.000Z',
          },
          {
            id: 'message-c',
            conversationId: 'conversation-a',
            role: 'assistant',
            content: [{ type: 'text', text: 'second reply' }],
            runId: 'run-b',
            uiFormat: 'markdown',
            uiProgram: null,
            uiState: null,
            createdAt: '2026-10-29T00:01:01.000Z',
          },
        ],
        // 失败/超时运行没有任何助手输出；后续轮次仍带完整读数。
        runMetrics: [
          {
            runId: 'run-a',
            status,
            turns: null,
            durationMs: null,
            endedAt: null,
            tokens: null,
            costUsd: null,
            error: errorText,
          },
          {
            runId: 'run-b',
            status: 'succeeded',
            turns: 1,
            durationMs: 2000,
            endedAt: null,
            tokens: 100,
            costUsd: 0.01,
            error: null,
          },
        ],
      });
      vi.mocked(api.run).mockResolvedValue({
        run: {
          id: 'run-b',
          conversationId: 'conversation-a',
          agentId: 'agent-a',
          agentName: 'Expert',
          status: 'succeeded',
          startedAt: '2026-10-29T00:01:00.000Z',
          endedAt: '2026-10-29T00:01:02.000Z',
          latencyMs: 2000,
          turns: 1,
          inputTokens: 60,
          outputTokens: 40,
          costUsd: 0.01,
          error: null,
          sessionId: null,
          sandboxId: null,
          runtimeEnvironment: null,
        },
        conversation: { ...terminal.conversation, createdAt: '' },
        steps: [],
      });
      await mount('/chat?agent=agent-a&conversation=conversation-a');

      // 没有助手输出的终态运行：结果留在它自己的用户轮里，并且常驻可见。
      const oldLink = host.querySelector('a[href="/runs/run-a"]');
      expect(oldLink).not.toBeNull();
      const oldTurn = oldLink?.closest('[data-message-id]');
      expect(oldTurn?.getAttribute('data-message-id')).toBe('message-a:0');
      expect(oldTurn?.textContent).toContain('first prompt');
      expect(oldTurn?.textContent).toContain(label);
      expect(oldTurn?.textContent).toContain(errorText);
      expect(oldTurn?.textContent).not.toContain('second reply');
      const oldWrapper = oldLink?.closest('[class*="transition-opacity"]');
      expect(oldWrapper?.className).toContain('opacity-100');

      // 后续轮次的回复与读数只属于自己：不串到旧轮，也不重复。
      const replyTurn = host.querySelector('[data-message-id="message-c:0"]');
      expect(replyTurn?.textContent).toContain('second reply');
      expect(replyTurn?.textContent).not.toContain(errorText);
      expect(host.querySelectorAll('a[href="/runs/run-a"]')).toHaveLength(1);
      // 最新轮的读数由运行详情驱动；消息区内只出现一次（输入框上方另有本次运行入口）。
      expect(replyTurn?.querySelectorAll('a[href="/runs/run-b"]')).toHaveLength(1);
      expect(replyTurn?.textContent).toContain('完成');
      // 终态运行不再显示仍在等待。
      expect(host.textContent).not.toContain('等待回复');

      // 继续对话时新用户项没有 runId：旧终态仍留在原轮，新的运行反馈照常出现。
      await act(async () => {
        useChatStore
          .getState()
          .setItems((items) => [...items, { kind: 'user', text: 'third prompt' }]);
        useChatStore.getState().setRun({
          runId: 'run-live',
          conversationId: 'conversation-a',
          status: 'streaming',
          startedAt: Date.now(),
        });
      });
      await flush();
      expect(host.textContent).toContain(errorText);
      expect(host.textContent).toContain('third prompt');
      expect(host.textContent).toContain('等待回复');
    },
  );

  it('keeps rendered history when a background refresh fails', async () => {
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    expect(host.textContent).toContain('old prompt');

    vi.mocked(api.conversation).mockRejectedValue(new Error('history refresh failed'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['conversation', 'conversation-a'] });
    });
    await flush();

    expect(host.textContent).toContain('old prompt');
    expect(host.textContent).toContain('history refresh failed');
  });

  it('keeps loaded history when loading an older page fails', async () => {
    vi.mocked(api.conversation)
      .mockResolvedValueOnce({
        conversation: { ...terminal.conversation, createdAt: '' },
        runMetrics: [],
        nextBefore: 'cursor-older',
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
      })
      .mockRejectedValueOnce(new Error('older page unavailable'));
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    const older = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === '加载更早消息',
    );
    if (!older) throw new Error('Missing older history button');

    await act(async () => older.click());
    await flush();

    expect(host.textContent).toContain('old prompt');
    expect(vi.mocked(toastError)).toHaveBeenCalled();
  });

  it('shows the full-page history error only when there is no content to keep', async () => {
    vi.mocked(api.conversation).mockRejectedValue(new Error('history unavailable'));
    await mount('/chat?agent=agent-a&conversation=conversation-a');

    expect(host.textContent).toContain('history unavailable');
    expect(
      [...host.querySelectorAll('button')].some((item) => item.textContent === '开始新对话'),
    ).toBe(true);
    expect(host.querySelector('textarea[aria-label="消息"]')).toBeNull();
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

describe('live terminal outcomes across a follow-up send', () => {
  const conversation: ConversationDetail = {
    conversation: { id: 'conversation-a', agentId: 'agent-a', title: 'History' },
    nextBefore: null,
    runMetrics: [],
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
  };

  async function send(text: string) {
    await type(text);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click();
    });
    await flush();
  }

  async function emit(event: unknown, index: number) {
    await act(async () => {
      const source = Source.instances.at(index);
      if (!source) throw new Error('Missing event source');
      source.emit(event);
    });
  }

  async function mountWithStalledRefresh() {
    vi.mocked(api.conversation).mockResolvedValue(conversation);
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    // 背景刷新一直不返回：旧轮读数只能来自终态事件写回的会话详情缓存。
    vi.mocked(api.conversation).mockReturnValue(new Promise(() => {}));
  }

  it.each([
    ['failed', 'first run exploded'],
    ['timeout', 'Run timed out'],
  ] as const)('keeps a %s turn without output after the next send', async (status, error) => {
    await mountWithStalledRefresh();
    vi.spyOn(api, 'sendChat')
      .mockResolvedValueOnce({ runId: 'run-a', conversationId: 'conversation-a' })
      .mockResolvedValueOnce({ runId: 'run-b', conversationId: 'conversation-a' });

    await send('first prompt');
    // 用户气泡在接受时归属本轮：没有助手输出时，终态读数只能挂在它身上。
    expect(useChatStore.getState().items.findLast((item) => item.kind === 'user')).toMatchObject({
      text: 'first prompt',
      runId: 'run-a',
    });
    await emit({ type: 'run_finished', status, error }, 0);
    await flush();
    expect(host.textContent).toContain(error);

    await send('second prompt');
    // 发送会清空最新读数，旧轮原因与链接必须仍从会话详情缓存读到，且不串到新轮。
    expect(useChatStore.getState().lastRun).toBeNull();
    expect(host.textContent).toContain(error);
    // 已接受但事件流尚未 onopen：沿用 reconnecting 文案，等连接打开才进入「等待回复」。
    expect(host.textContent).toContain('连接已中断，正在重连');
    const oldLink = host.querySelector('a[href="/runs/run-a"]');
    const oldTurn = oldLink?.closest('[data-message-id]');
    expect(oldTurn?.textContent).toContain('first prompt');
    expect(oldTurn?.textContent).not.toContain('second prompt');
    expect(oldLink?.closest('[class*="transition-opacity"]')?.className).toContain('opacity-100');
    expect(runLink()?.getAttribute('href')).toBe('/runs/run-b');

    await emit({ type: 'text_delta', text: 'second reply', blockIndex: 0 }, 1);
    await emit(
      {
        type: 'run_finished',
        status: 'succeeded',
        turns: 1,
        inputTokens: 6,
        outputTokens: 4,
        costUsd: 0.01,
      },
      1,
    );
    await flush();

    // 新轮回复与读数只属于自己；旧轮失败原因保留且唯一。
    expect(host.textContent).toContain('second reply');
    expect(host.textContent).not.toContain('等待回复');
    const replyTurn = [...host.querySelectorAll('[data-message-id]')].find((element) =>
      element.textContent?.includes('second reply'),
    );
    expect(replyTurn?.textContent).not.toContain(error);
    expect(replyTurn?.querySelectorAll('a[href="/runs/run-b"]')).toHaveLength(1);
    expect(replyTurn?.textContent).toContain('完成');
    expect(host.querySelectorAll('a[href="/runs/run-a"]')).toHaveLength(1);
    // 输入框上方的「查看本次运行」指向新运行，消息区里只有新轮一条读数链接。
    expect(host.querySelectorAll('a[href="/runs/run-b"]')).toHaveLength(2);
  });

  it('keeps a cancelled turn without output after the next send', async () => {
    await mountWithStalledRefresh();
    vi.spyOn(api, 'sendChat')
      .mockResolvedValueOnce({ runId: 'run-a', conversationId: 'conversation-a' })
      .mockResolvedValueOnce({ runId: 'run-b', conversationId: 'conversation-a' });

    await send('first prompt');
    await emit({ type: 'run_finished', status: 'cancelled' }, 0);
    await flush();

    await send('second prompt');
    const oldLink = host.querySelector('a[href="/runs/run-a"]');
    const oldTurn = oldLink?.closest('[data-message-id]');
    expect(oldTurn?.textContent).toContain('first prompt');
    expect(oldTurn?.textContent).toContain('已停止');
    expect(oldTurn?.textContent).not.toContain('second prompt');
    // 取消没有失败原因，读数沿用既有规则默认透明，但链接仍在 DOM 与 Tab 序里。
    expect(runLink()?.getAttribute('href')).toBe('/runs/run-b');
  });

  it('keeps a completed reply and its readout after the next send', async () => {
    await mountWithStalledRefresh();
    vi.spyOn(api, 'sendChat')
      .mockResolvedValueOnce({ runId: 'run-a', conversationId: 'conversation-a' })
      .mockResolvedValueOnce({ runId: 'run-b', conversationId: 'conversation-a' });

    await send('first prompt');
    await emit({ type: 'text_delta', text: 'first reply', blockIndex: 0 }, 0);
    await emit(
      {
        type: 'run_finished',
        status: 'succeeded',
        turns: 1,
        inputTokens: 3,
        outputTokens: 2,
        costUsd: 0.005,
      },
      0,
    );
    await flush();
    expect(host.textContent).toContain('first reply');

    await send('second prompt');
    // 已完成回复的读数从最新读数换成缓存里的历史读数，仍只出现一次并留在原轮。
    const oldLink = host.querySelector('a[href="/runs/run-a"]');
    const oldTurn = oldLink?.closest('[data-message-id]');
    expect(oldTurn?.textContent).toContain('first reply');
    expect(oldTurn?.textContent).toContain('完成');
    expect(oldTurn?.textContent).not.toContain('second prompt');

    await emit({ type: 'text_delta', text: 'second reply', blockIndex: 0 }, 1);
    await emit(
      {
        type: 'run_finished',
        status: 'succeeded',
        turns: 1,
        inputTokens: 6,
        outputTokens: 4,
        costUsd: 0.01,
      },
      1,
    );
    await flush();

    expect(host.querySelectorAll('a[href="/runs/run-a"]')).toHaveLength(1);
    const firstTurn = [...host.querySelectorAll('[data-message-id]')].find((element) =>
      element.textContent?.includes('first reply'),
    );
    expect(firstTurn?.querySelectorAll('a[href="/runs/run-a"]')).toHaveLength(1);
    const replyTurn = [...host.querySelectorAll('[data-message-id]')].find((element) =>
      element.textContent?.includes('second reply'),
    );
    expect(replyTurn?.querySelectorAll('a[href="/runs/run-b"]')).toHaveLength(1);
    expect(replyTurn?.textContent).not.toContain('first reply');
  });
});

describe('chat shell layout', () => {
  it('does not auto-pick an expert on bare /chat and disables the composer', async () => {
    await mount();
    // 裸 /chat 不替用户选 agents[0]：选择器停在「选择专家」，而不是显示 Expert。
    const picker = host.querySelector<HTMLButtonElement>('button[aria-label="选择专家"]');
    expect(picker).not.toBeNull();
    expect(picker?.textContent).toContain('选择专家');
    expect(picker?.textContent).not.toContain('Expert');
    // 没有明确归属时不能输入或发送。
    expect(message().disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.disabled).toBe(
      true,
    );
    // 未选专家时也不给建议任务，避免点了却没有可发送的对象。
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === '制定计划',
      ),
    ).toBe(false);
  });

  it('shows the current expert in the chat header without opening history', async () => {
    await mount('/chat?agent=agent-a');
    // 历史收起时头部直接显示当前专家，不用先展开历史抽屉。
    const welcomePicker = host.querySelector<HTMLButtonElement>('[aria-label^="选择专家"]');
    expect(welcomePicker).not.toBeNull();
    expect(welcomePicker?.textContent).toContain('Expert');
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);

    // 抽屉打开后由历史头部承担选择器，聊天头部不再重复一个。
    await act(async () => {
      useChatStore.setState({ historyOpen: true });
    });
    await flush();
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.querySelector('h1')).toBeNull();
    expect(sheet?.querySelector('[aria-label^="选择专家"]')).not.toBeNull();
    expect(host.querySelector('[aria-label^="选择专家"]')).toBeNull();
    expect(document.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);
  });

  it('keeps the current expert switchable from the header with existing messages', async () => {
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
    vi.mocked(api.conversations).mockResolvedValue([]);
    const router = await mount('/chat?agent=agent-a&conversation=conversation-a');
    await flush();

    expect(host.textContent).toContain('old prompt');
    expect(host.querySelector('aside[aria-label="会话历史"]')).toBeNull();
    const picker = host.querySelector<HTMLButtonElement>('button[aria-label="选择专家：Expert"]');
    if (!picker) throw new Error('Missing header expert picker');
    await act(async () => picker.click());
    await flush();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.includes('Other Expert'),
    );
    if (!option) throw new Error('Missing expert option');
    await act(async () => option.click());
    await flush();

    expect(router.state.location.search).toEqual({ agent: 'agent-b' });
    expect(host.textContent).not.toContain('old prompt');
    expect(host.textContent).toContain('未命名会话');
  });

  it('searches experts by slug in the header picker', async () => {
    const slugOnly = {
      ...agentInputSchema.parse({ slug: 'hidden-slug-x', name: 'Plain Name' }),
      id: 'agent-slug',
      parentId: null,
      createdAt: '',
      updatedAt: '',
    };
    client.setQueryData(['agents'], [agent, slugOnly]);
    vi.mocked(api.agents).mockResolvedValue([agent, slugOnly]);
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label^="选择专家"]')?.click(),
    );
    await flush();
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索专家"]');
    if (!search) throw new Error('Missing expert search');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, slugOnly.slug);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.some((item) => item.textContent?.includes('Plain Name'))).toBe(true);
    expect(options.some((item) => item.textContent?.includes('Expert'))).toBe(false);
  });

  it('moves the expert picker between the top bar and history header with history on desktop', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    const router = await mount('/chat?agent=agent-a');
    await type('unfinished draft');

    // 头部属于消息列的 Page：标题、历史开关、搜索与成果入口都随消息列渲染。
    const page = message().closest<HTMLElement>('[data-slot="page"]');
    if (!page) throw new Error('Missing message page');
    expect(host.querySelectorAll('[data-slot="page"]')).toHaveLength(1);
    expect(page.querySelector('h1')?.textContent).toBe('未命名会话');
    expect(page.querySelector('button[aria-label="打开会话成果"]')).not.toBeNull();

    // 收起时唯一选择器在消息头部，不属于任何历史 aside。
    expect(host.querySelector('aside[aria-label="会话历史"]')).toBeNull();
    const collapsedPicker = host.querySelector<HTMLButtonElement>('[aria-label^="选择专家"]');
    if (!collapsedPicker) throw new Error('Missing expert picker');
    expect(collapsedPicker.closest('aside')).toBeNull();
    expect(collapsedPicker.closest('[data-slot="page"]')).toBe(page);
    expect(collapsedPicker.textContent).toContain('Expert');
    expect(host.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
    expect(page.querySelector('button[aria-label="搜索会话"]')).not.toBeNull();
    const toggle = page.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]');
    if (!toggle) throw new Error('Missing history toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    // 展开后唯一选择器进入历史头部，与新建会话同排；消息头部不再保留搜索或选择器。
    await act(async () => toggle.click());
    await flush();
    const history = host.querySelector('aside[aria-label="会话历史"]');
    if (!history) throw new Error('Missing history panel');
    const expandedPicker = history.querySelector<HTMLButtonElement>('[aria-label^="选择专家"]');
    if (!expandedPicker) throw new Error('Missing history header expert picker');
    expect(expandedPicker.closest('aside')).toBe(history);
    expect(history.querySelector('button[aria-label="新建会话"]')).not.toBeNull();
    expect(host.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
    // 触发器仍显示头像、名称与 ComboboxTrigger 默认的下箭头。
    expect(expandedPicker.querySelector('img')).not.toBeNull();
    expect(expandedPicker.textContent).toContain('Expert');
    expect(expandedPicker.querySelectorAll('svg.lucide-chevron-down')).toHaveLength(1);
    expect(expandedPicker.getAttribute('aria-expanded')).toBe('false');
    // 搜索随头部卸载，展开态只在历史面板保留一处入口。
    expect(host.querySelector('button[aria-label="搜索会话"]')).toBeNull();
    expect(history.textContent).toContain('搜索全部会话');
    expect(page.querySelector('h1')?.textContent).toBe('未命名会话');
    expect(
      page.querySelector('button[aria-label="隐藏会话历史"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(message().value).toBe('unfinished draft');
    expect(router.state.location.search).toEqual({ agent: 'agent-a' });
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);

    // 再次收起：aside 消失，唯一选择器与搜索回到消息头部。
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="隐藏会话历史"]')?.click(),
    );
    await flush();
    expect(host.querySelector('aside[aria-label="会话历史"]')).toBeNull();
    const restoredPicker = host.querySelector<HTMLButtonElement>('[aria-label^="选择专家"]');
    if (!restoredPicker) throw new Error('Missing restored expert picker');
    expect(restoredPicker.closest('aside')).toBeNull();
    expect(restoredPicker.closest('[data-slot="page"]')).toBe(page);
    expect(host.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
    expect(restoredPicker.querySelector('img')).not.toBeNull();
    expect(restoredPicker.textContent).toContain('Expert');
    expect(restoredPicker.querySelectorAll('svg.lucide-chevron-down')).toHaveLength(1);
    expect(restoredPicker.getAttribute('aria-expanded')).toBe('false');
    expect(page.querySelector('button[aria-label="搜索会话"]')).not.toBeNull();
    expect(message().value).toBe('unfinished draft');
    expect(router.state.location.search).toEqual({ agent: 'agent-a' });
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);
  });

  it('keeps the expert picker reachable when resize crosses the desktop breakpoint', async () => {
    const resize = stubViewport(600);
    await mount('/chat?agent=agent-a');

    // 窄屏打开抽屉：选择器在抽屉里，欢迎态不重复。
    await act(async () => useChatStore.setState({ historyOpen: true }));
    await flush();
    expect(document.querySelector('[role="dialog"] [aria-label^="选择专家"]')).not.toBeNull();
    expect(host.querySelector('[aria-label^="选择专家"]')).toBeNull();

    // 放大到 lg：抽屉消失、桌面历史仍折叠，欢迎态必须重新给出选择器。
    await act(async () => resize(1024));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const welcomePicker = host.querySelector<HTMLButtonElement>('[aria-label^="选择专家"]');
    expect(welcomePicker).not.toBeNull();
    expect(welcomePicker?.textContent).toContain('Expert');
    expect(host.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);

    // 再缩回窄屏：historyOpen 仍为 true，抽屉恢复，欢迎态选择器让位给抽屉。
    await act(async () => resize(600));
    await flush();
    expect(document.querySelector('[role="dialog"] [aria-label^="选择专家"]')).not.toBeNull();
    expect(host.querySelector('[aria-label^="选择专家"]')).toBeNull();
    expect(document.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
  });

  it('restores the history header picker after narrowing with desktop history open', async () => {
    const resize = stubViewport(1024);
    await mount('/chat?agent=agent-a');

    // 桌面展开历史：唯一选择器在历史头部，顶栏不再重复。
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]')?.click(),
    );
    await flush();
    const history = host.querySelector('aside[aria-label="会话历史"]');
    if (!history) throw new Error('Missing history panel');
    expect(history.querySelector('[aria-label^="选择专家"]')?.textContent).toContain('Expert');
    expect(host.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);

    // 缩窄到 lg 以下且 historyOpen=false：没有抽屉，欢迎态必须给出选择器。
    await act(async () => resize(600));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('aside[aria-label="会话历史"]')).toBeNull();
    expect(host.querySelector('[aria-label^="选择专家"]')?.textContent).toContain('Expert');
    expect(host.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);

    // 再放大回去：桌面历史仍保持展开，选择器回到历史头部且恰好一处。
    await act(async () => resize(1024));
    await flush();
    const reopened = host.querySelector('aside[aria-label="会话历史"]');
    expect(reopened).not.toBeNull();
    expect(reopened?.querySelector('[aria-label^="选择专家"]')?.textContent).toContain('Expert');
    expect(host.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);
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

    // 历史展开时从历史头部切换专家，顶栏不再保留第二个选择器。
    const history = host.querySelector('aside[aria-label="会话历史"]');
    if (!history) throw new Error('Missing history panel');
    const picker = history.querySelector<HTMLButtonElement>('[aria-label^="选择专家"]');
    if (!picker) throw new Error('Missing history header expert picker');
    expect(host.querySelectorAll('[aria-label^="选择专家"]')).toHaveLength(1);
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
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="打开会话成果"]');
    if (!toggle) throw new Error('Missing workspace toggle');
    // 桌面端按钮带可见文字，不再只是一个无标签图标。
    expect(toggle.textContent).toContain('会话成果');
    expect(toggle.getAttribute('title')).toBe('打开会话成果');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('chat-workspace');

    await act(async () => toggle.click());
    const workspace = host.querySelector('aside[aria-label="会话成果"]');
    expect(workspace).not.toBeNull();
    expect(workspace?.querySelector('h2')?.textContent).toBe('会话成果');
    expect(workspace?.textContent).toContain('开始对话或打开已有会话后查看成果');
    expect(workspace?.textContent).not.toContain('当前会话没有成果文件');
    expect(workspace?.textContent).not.toMatch(/\.mcp\.json|CLAUDE\.md/);
    // 成果打开后头部仍属于消息列：标题、历史开关和成果开关都不进成果面板。
    const page = message().closest<HTMLElement>('[data-slot="page"]');
    if (!page) throw new Error('Missing message page');
    expect(page.contains(workspace)).toBe(false);
    expect(page.querySelector('h1')?.textContent).toBe('未命名会话');
    expect(page.querySelector('button[aria-label="显示会话历史"]')).not.toBeNull();
    expect(page.querySelector('button[aria-label="隐藏会话成果"]')).toBe(toggle);
    // 工作区与历史是两条独立状态：打开工作区不会把历史也打开。
    expect(useChatStore.getState().historyOpen).toBe(false);
    expect(host.querySelector('aside[aria-label="会话历史"]')).toBeNull();
    expect([...host.querySelectorAll('h1')].map((item) => item.textContent)).toEqual([
      '未命名会话',
    ]);

    const hide = host.querySelector<HTMLButtonElement>('button[aria-label="隐藏会话成果"]');
    await act(async () => hide?.click());
    // 折叠只收起宽度：子树保留，但收起后离开焦点顺序与无障碍树。
    const collapsed = host.querySelector('aside[aria-label="会话成果"]');
    expect(collapsed).not.toBeNull();
    expect(collapsed?.closest('[inert]')).not.toBeNull();
    expect(collapsed?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="打开会话成果"]')).not.toBeNull();
  });

  it('keeps the draft editable after the workspace width collapses', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    await mount();
    await type('workspace draft');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="打开会话成果"]')?.click(),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="隐藏会话成果"]')?.click(),
    );
    expect(message().value).toBe('workspace draft');
    await type('still editable');
    expect(message().value).toBe('still editable');
    expect(useChatStore.getState().input).toBe('still editable');
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
      host.querySelector<HTMLButtonElement>('button[aria-label="打开会话成果"]')?.click(),
    );
    expect(host.querySelector('aside[aria-label="会话成果"]')).not.toBeNull();
    expect(message().value).toBe('unfinished draft');
    expect(router.state.location.search).toEqual(expertBefore);
  });

  it('returns focus to the workspace toggle after closing the narrow-screen sheet', async () => {
    await mount();
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="打开会话成果"]');
    if (!toggle) throw new Error('Missing workspace toggle');
    await act(async () => toggle.click());
    expect(document.querySelector('[role="dialog"] aside[aria-label="会话成果"]')).not.toBeNull();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="dialog"] [data-slot="sheet-close"]')
        ?.click(),
    );
    await flush();
    expect(document.activeElement).toBe(host.querySelector('button[aria-label="打开会话成果"]'));
  });
});

describe('chat focus handoff and history detail reachability', () => {
  function threeTurnHistory() {
    const turns = ['run-1', 'run-2', 'run-3'];
    return {
      conversation: { ...terminal.conversation, createdAt: '' },
      nextBefore: null,
      messages: turns.flatMap((runId, index) => [
        {
          id: `user-${runId}`,
          conversationId: 'conversation-a',
          role: 'user',
          content: `prompt ${index + 1}`,
          runId,
          createdAt: '',
        },
        {
          id: `reply-${runId}`,
          conversationId: 'conversation-a',
          role: 'assistant',
          content: [{ type: 'text', text: `reply ${index + 1}` }],
          runId,
          createdAt: '',
        },
      ]),
      runMetrics: turns.map((runId) => ({
        runId,
        status: 'succeeded' as const,
        turns: 1,
        durationMs: 1000,
        endedAt: null,
        tokens: 10,
        costUsd: 0.001,
        error: null,
      })),
    };
  }

  it('keeps historical run details in the tab order instead of hiding them', async () => {
    vi.mocked(api.conversation).mockResolvedValue(threeTurnHistory());
    await mount('/chat?agent=agent-a&conversation=conversation-a');

    const links = [...host.querySelectorAll('a')].filter((link) => link.textContent === '查看详情');
    expect(links.length).toBeGreaterThanOrEqual(2);
    const oldest = links[0];
    if (!oldest) throw new Error('Missing history detail link');
    // 隐藏只靠 opacity：链接仍在可访问树与 Tab 序里，聚焦到它时本轮 group-focus-within 显影。
    const wrapper = oldest.closest('[class*="transition-opacity"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).not.toContain('invisible');
    expect(wrapper?.className).not.toContain('visibility');
    expect(oldest.closest('[inert]')).toBeNull();
    expect(oldest.closest('[aria-hidden="true"]')).toBeNull();
    oldest.focus();
    expect(document.activeElement).toBe(oldest);
    expect(oldest.getAttribute('href')).toBe('/runs/run-1');
  });

  it('keeps the same composer textarea and its focus after the first Enter send', async () => {
    vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-new',
      conversationId: 'conversation-a',
    });
    vi.mocked(api.conversation).mockResolvedValue(threeTurnHistory());
    await mount('/chat?agent=agent-a');
    await type('first question');
    message().focus();
    const welcomeInput = message();
    await act(async () => {
      welcomeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();

    // 欢迎态与会话态共用同一个输入节点：不重建、不丢焦点。
    const conversationInput = message();
    expect(conversationInput).toBe(welcomeInput);
    expect(welcomeInput.isConnected).toBe(true);
    expect(document.activeElement).toBe(conversationInput);
    await type('follow-up draft');
    expect(conversationInput.value).toBe('follow-up draft');
  });

  it('does not take focus back when another control submits', async () => {
    vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-new',
      conversationId: 'conversation-a',
    });
    vi.mocked(api.conversation).mockResolvedValue(threeTurnHistory());
    await mount('/chat?agent=agent-a');
    await type('mouse send');
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]');
    if (!toggle) throw new Error('Missing history toggle');
    toggle.focus();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click(),
    );
    await flush();

    expect(document.activeElement).toBe(toggle);
    expect(document.activeElement).not.toBe(message());
  });

  it('does not take focus back when the send button submits while another control has it', async () => {
    vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-new',
      conversationId: 'conversation-a',
    });
    vi.mocked(api.conversation).mockResolvedValue(threeTurnHistory());
    await mount('/chat?agent=agent-a');
    await type('actual body');
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]');
    if (!toggle) throw new Error('Missing history toggle');
    toggle.focus();
    const input = message();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click(),
    );
    await flush();

    expect(vi.mocked(api.sendChat)).toHaveBeenCalledTimes(1);
    // 输入节点保持挂载，但焦点留在用户最后操作的控制上。
    expect(message()).toBe(input);
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(document.activeElement).not.toBe(input);
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
  function discardDialog() {
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) =>
      element.textContent?.includes('放弃未保存的更改？'),
    );
  }
  function discardButton(label: string) {
    return [...(discardDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === label,
    );
  }
  async function openRename() {
    await openMenu();
    await act(async () => menuItem('重命名')?.click());
    await flush();
    const input = dialog()?.querySelector<HTMLInputElement>('#conversation-title');
    if (!input) throw new Error('Missing rename input');
    return input;
  }
  async function editTitle(input: HTMLInputElement, title: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('keeps the full title while the menu button follows the truncated heading', async () => {
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    const heading = headerTitle();
    expect(heading?.textContent).toBe('History');
    expect(heading?.getAttribute('title')).toBe('History');
    expect(heading?.className).toContain('truncate');
    expect(heading?.className).toContain('max-w-[8em]');
    expect(heading?.className).not.toContain('max-w-[10em]');
    expect(heading?.className).not.toContain('lg:max-w-');
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

  it('allows same-session search changes but blocks a conversation switch during rename', async () => {
    browserHistory = createBrowserHistory();
    browserHistory.push('/chat?agent=agent-a&conversation=conversation-a');
    const router = await mount('/chat', browserHistory);
    const input = await openRename();
    await editTitle(input, 'Renamed draft');

    // 同页只换成果：agent/conversation 没变，不卸载对话框，直接放行。
    await act(async () => {
      await router.navigate({
        to: '/chat',
        search: {
          agent: 'agent-a',
          conversation: 'conversation-a',
          outputRun: 'run-old',
          outputPath: 'report.md',
          outputMode: 'read',
        },
      });
    });
    expect(discardDialog()).toBeUndefined();
    expect(router.state.location.search).toMatchObject({ outputRun: 'run-old' });
    expect(dialog()?.querySelector<HTMLInputElement>('#conversation-title')?.value).toBe(
      'Renamed draft',
    );

    // 同页换专家同样会让工作区切走：也要拦下。
    let switching: Promise<void> | undefined;
    await act(async () => {
      switching = router.navigate({
        to: '/chat',
        search: { agent: 'agent-b' },
      }) as Promise<void>;
    });
    await flush();
    expect(discardDialog()).toBeDefined();
    expect(router.state.location.search).toMatchObject({ agent: 'agent-a' });
    await act(async () => discardButton('取消')?.click());
    await flush();
    expect(discardDialog()).toBeUndefined();

    // 同页换会话会让工作区切到别的对话：必须拦下。
    await act(async () => {
      switching = router.navigate({
        to: '/chat',
        search: { agent: 'agent-a', conversation: 'conversation-b' },
      }) as Promise<void>;
    });
    await flush();
    expect(discardDialog()).toBeDefined();
    expect(router.state.location.search).toMatchObject({ conversation: 'conversation-a' });

    // 取消：留在原会话，草稿不丢。被取消的导航不会提交，也不再等它的 promise。
    await act(async () => discardButton('取消')?.click());
    await flush();
    expect(switching).toBeDefined();
    expect(discardDialog()).toBeUndefined();
    expect(router.state.location.search).toMatchObject({ conversation: 'conversation-a' });
    expect(dialog()?.querySelector<HTMLInputElement>('#conversation-title')?.value).toBe(
      'Renamed draft',
    );

    // 放弃并离开：导航放行，对话框一起收起。
    await act(async () => {
      switching = router.navigate({
        to: '/chat',
        search: { agent: 'agent-a', conversation: 'conversation-b' },
      }) as Promise<void>;
    });
    await flush();
    await act(async () => discardButton('放弃并离开')?.click());
    await act(async () => {
      await switching;
    });
    expect(router.state.location.search).toMatchObject({ conversation: 'conversation-b' });
    expect(dialog()).toBeNull();
  });

  it('blocks browser back switching conversations during a dirty rename', async () => {
    vi.mocked(api.conversation).mockImplementation(async (id) => ({
      conversation: { id, agentId: 'agent-a', title: `History ${id}`, createdAt: '' },
      runMetrics: [],
      nextBefore: null,
      messages: [
        {
          id: `message-${id}`,
          conversationId: id,
          role: 'user',
          content: 'old prompt',
          runId: null,
          createdAt: '',
        },
      ],
    }));
    browserHistory = createBrowserHistory();
    browserHistory.push('/chat?agent=agent-a&conversation=conversation-a');
    browserHistory.flush();
    browserHistory.push('/chat?agent=agent-a&conversation=conversation-b');
    browserHistory.flush();
    const router = await mount('/chat?agent=agent-a&conversation=conversation-b', browserHistory);
    const input = await openRename();
    await editTitle(input, 'Draft on B');

    await act(async () => {
      router.history.back();
    });
    await flush();
    expect(discardDialog()).toBeDefined();
    expect(router.state.location.search).toMatchObject({ conversation: 'conversation-b' });

    await act(async () => discardButton('取消')?.click());
    await flush();
    expect(router.state.location.search).toMatchObject({ conversation: 'conversation-b' });
    expect(dialog()?.querySelector<HTMLInputElement>('#conversation-title')?.value).toBe(
      'Draft on B',
    );

    await act(async () => {
      router.history.back();
    });
    await flush();
    await act(async () => discardButton('放弃并离开')?.click());
    await flush();
    expect(router.state.location.search).toMatchObject({ conversation: 'conversation-a' });
  });

  it('blocks cross-page navigation and refresh during a dirty rename', async () => {
    browserHistory = createBrowserHistory();
    browserHistory.push('/chat?agent=agent-a&conversation=conversation-a');
    const router = await mount('/chat', browserHistory);
    const input = await openRename();
    await editTitle(input, 'Renamed draft');

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    let leaving: Promise<void> | undefined;
    await act(async () => {
      leaving = router.navigate({ to: '/away' }) as Promise<void>;
    });
    await flush();
    expect(discardDialog()).toBeDefined();
    await act(async () => discardButton('放弃并离开')?.click());
    await act(async () => {
      await leaving;
    });
    expect(router.state.location.pathname).toBe('/away');
  });

  it('keeps the save pending guarded and settles the blocked leave after success', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.renameConversation>>) => void;
    vi.spyOn(api, 'renameConversation').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    browserHistory = createBrowserHistory();
    browserHistory.push('/chat?agent=agent-a&conversation=conversation-a');
    const router = await mount('/chat', browserHistory);
    const input = await openRename();
    await editTitle(input, 'Renamed');
    await act(async () => dialogButton('保存')?.click());
    await flush();

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    let leaving: Promise<void> | undefined;
    await act(async () => {
      leaving = router.navigate({ to: '/away' }) as Promise<void>;
    });
    await flush();
    expect(discardDialog()?.textContent).toContain('正在保存，请等待请求完成。');
    expect(discardButton('放弃并离开')?.disabled).toBe(true);

    await act(async () => finish({ ...terminal.conversation, title: 'Renamed', createdAt: '' }));
    await flush();
    await act(async () => {
      await leaving;
    });
    expect(router.state.location.pathname).toBe('/away');
  });

  it('guards leaving while deletion is pending and never blocks its own navigation', async () => {
    let finish!: () => void;
    const remove = vi.spyOn(api, 'deleteConversation').mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    browserHistory = createBrowserHistory();
    browserHistory.push('/chat?agent=agent-a&conversation=conversation-a');
    const router = await mount('/chat', browserHistory);
    await type('unfinished draft');
    await openMenu();
    await act(async () => menuItem('删除会话')?.click());
    await flush();
    await act(async () => dialogButton('删除会话')?.click());
    await flush();
    expect(remove).toHaveBeenCalledWith('conversation-a');

    // 删除中刷新受保护。
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    // 删除中离开会被拦下，且不提供离开确认。
    let leaving: Promise<void> | undefined;
    await act(async () => {
      leaving = router.navigate({ to: '/away' }) as Promise<void>;
    });
    await flush();
    const pendingLeave = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
      (element) => element.textContent?.includes('正在删除会话'),
    );
    expect(pendingLeave).toBeDefined();
    const leaveButton = [
      ...(pendingLeave?.querySelectorAll<HTMLButtonElement>('button') ?? []),
    ].find((button) => button.textContent?.trim() === '放弃并离开');
    expect(leaveButton?.disabled).toBe(true);

    // 删除成功：内部切到新会话不被自身拦住，挂起的离开导航作废。
    await act(async () => finish());
    await flush();
    expect(leaving).toBeDefined();
    expect(router.state.location.pathname).toBe('/chat');
    expect(router.state.location.search).not.toMatchObject({ conversation: 'conversation-a' });
    expect(headerTitle()?.textContent).toBe('未命名会话');
    expect(message().value).toBe('unfinished draft');
  });

  it('settles the rename blocker after a successful save', async () => {
    vi.spyOn(api, 'renameConversation').mockResolvedValue({
      ...terminal.conversation,
      title: 'Renamed',
      createdAt: '',
    });
    const router = await mount('/chat?agent=agent-a&conversation=conversation-a');
    const input = await openRename();
    await editTitle(input, 'Renamed');
    await act(async () => dialogButton('保存')?.click());
    await flush();
    expect(dialog()).toBeNull();

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);

    await act(async () => {
      await router.navigate({ to: '/away' });
    });
    expect(router.state.location.pathname).toBe('/away');
  });
});

describe('live run question failures', () => {
  it('keeps the loaded question, tool step and stop control while questions fail', async () => {
    const question: PublicRunQuestion = {
      requestId: 'qreq_live',
      runId: 'run-live',
      toolUseId: 'toolu_1',
      questions: [
        {
          question: '选择部署环境',
          header: '环境',
          options: [
            { value: '0', label: '预发', description: '' },
            { value: '1', label: '生产', description: '' },
          ],
          multiSelect: false,
        },
      ],
      status: 'pending',
      answers: null,
      createdAt: '2026-10-28T00:00:00.000Z',
      resolvedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      closeReason: null,
    };
    vi.spyOn(api, 'runQuestions').mockRejectedValue(new Error('questions offline'));
    vi.mocked(api.runApprovals).mockResolvedValue({ items: [] });
    // 历史仍在加载：保留 store 里的实时项，不让历史回填覆盖本轮步骤。
    vi.mocked(api.conversation).mockReturnValue(new Promise(() => {}));
    client
      .getQueryCache()
      .build(client, { queryKey: runQuestionsQueryKey('run-live') })
      .setState({
        data: { items: [question] },
        dataUpdatedAt: 0,
        status: 'success',
        error: null,
        fetchStatus: 'idle',
      });
    useChatStore.setState({
      conversationId: 'conversation-a',
      items: [
        { kind: 'tool', toolUseId: 'toolu_1', name: 'AskUserQuestion', startedAt: 1 },
        { kind: 'tool', toolUseId: 'toolu_2', name: 'Read', startedAt: 2 },
      ],
      run: {
        runId: 'run-live',
        conversationId: 'conversation-a',
        status: 'streaming',
        startedAt: Date.now(),
      },
    });
    await mount('/chat?agent=agent-a&conversation=conversation-a');
    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain('questions offline'));
    });

    expect(host.textContent).toContain('提问状态没有加载出来');
    expect(host.textContent).toContain('选择部署环境');
    expect(host.textContent).toContain('Read');
    expect(host.querySelector('button[aria-label="停止运行"]')).not.toBeNull();
    expect(host.textContent).toContain('提交回答');

    const before = vi.mocked(api.runQuestions).mock.calls.length;
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '重试',
    );
    if (!retry) throw new Error('Missing question retry');
    await act(async () => retry.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(vi.mocked(api.runQuestions).mock.calls.length).toBeGreaterThan(before),
      );
    });
  });
});
