import { agentInputSchema, DEFAULT_ROLES } from '@agentport/shared';
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
import { api, type ChatAccepted, type ConversationDetail } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
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
const other = {
  ...agentInputSchema.parse({ slug: 'other', name: 'Other Expert' }),
  id: 'agent-b',
  parentId: null,
  createdAt: '',
  updatedAt: '',
};

function conversationDetail(id: string, agentId = 'agent-a'): ConversationDetail {
  return {
    conversation: { id, agentId, title: id, createdAt: '' },
    runMetrics: [],
    nextBefore: null,
    messages: [
      {
        id: `user-${id}`,
        conversationId: id,
        role: 'user',
        content: `prompt ${id}`,
        runId: null,
        createdAt: '',
      },
    ],
  };
}

const DRAFTS_KEY = 'pace.chat.drafts';
function savedDrafts(): Record<string, string> {
  return JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, string>;
}

class Source {
  onopen = null;
  onmessage = null;
  onerror = null;
  close() {}
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof makeRouter>;

function deferredSend() {
  let resolve!: (accepted: ChatAccepted) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ChatAccepted>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  vi.spyOn(api, 'sendChat').mockReturnValue(promise);
  return { resolve, reject };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function makeRouter(initialEntry: string) {
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
  return createRouter({
    routeTree: route.addChildren([shell.addChildren([chat])]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

async function mount(initialEntry = '/chat?agent=agent-a&conversation=conversation-a') {
  router = makeRouter(initialEntry);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

function message() {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]');
  if (!input) throw new Error('Missing message input');
  return input;
}

async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(message(), text);
    message().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function send() {
  await act(async () => message().focus());
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click(),
  );
  await flush();
}

async function openConversation(conversation: string) {
  await act(async () => {
    await router.navigate({ to: '/chat', search: { agent: 'agent-a', conversation } });
  });
  await flush();
}

async function reload() {
  await act(async () => root.unmount());
  useChatStore.setState({
    conversationId: null,
    input: '',
    items: [],
    run: null,
    lastRun: null,
    lastRunId: null,
  });
  root = createRoot(host);
}

beforeEach(() => {
  useChatStore.getState().reset();
  sessionStorage.clear();
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['me'], adminMe);
  client.setQueryData(['agents'], [agent, other]);
  vi.spyOn(api, 'agents').mockResolvedValue([agent, other]);
  vi.spyOn(api, 'conversations').mockResolvedValue([]);
  vi.spyOn(api, 'conversation').mockImplementation(async (id: string) => conversationDetail(id));
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

describe('conversation drafts', () => {
  it('restores the current conversation draft after a reload', async () => {
    await mount();
    await type('draft in A');
    expect(savedDrafts()).toEqual({ 'conversation-a': 'draft in A' });

    // 刷新等价于内存状态清空后按 URL 重新载入会话。
    await act(async () => root.unmount());
    useChatStore.setState({ conversationId: null, input: '', items: [] });
    root = createRoot(host);
    await mount();

    expect(message().value).toBe('draft in A');
  });

  it('keeps drafts separate per conversation', async () => {
    await mount();
    await type('draft in A');
    await act(async () => {
      await router.navigate({
        to: '/chat',
        search: { agent: 'agent-a', conversation: 'conversation-b' },
      });
    });
    await flush();
    expect(message().value).toBe('');
    await type('draft in B');

    await act(async () => {
      await router.navigate({
        to: '/chat',
        search: { agent: 'agent-a', conversation: 'conversation-a' },
      });
    });
    await flush();
    expect(message().value).toBe('draft in A');
    expect(savedDrafts()).toEqual({
      'conversation-a': 'draft in A',
      'conversation-b': 'draft in B',
    });
  });

  it('does not carry the current draft into a new conversation', async () => {
    await mount();
    await type('draft in A');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]')?.click(),
    );
    await flush();
    const newConversation = host.querySelector<HTMLButtonElement>('button[aria-label="新建会话"]');
    if (!newConversation) throw new Error('Missing new conversation button');
    await act(async () => newConversation.click());
    await flush();

    expect(message().value).toBe('');
    expect(router.state.location.search).toEqual({ agent: 'agent-a' });
    expect(savedDrafts()).toEqual({ 'conversation-a': 'draft in A' });
  });

  it('clears the conversation draft after a successful send', async () => {
    vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-new',
      conversationId: 'conversation-a',
    });
    await mount();
    await type('send me');
    await act(async () => message().focus());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click(),
    );
    await flush();

    expect(message().value).toBe('');
    expect(savedDrafts()).toEqual({});
  });

  it('keeps the conversation draft when the send fails', async () => {
    vi.spyOn(api, 'sendChat').mockRejectedValue(new Error('Send rejected'));
    await mount();
    await type('send me');
    await act(async () => message().focus());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')?.click(),
    );
    await flush();

    expect(message().value).toBe('send me');
    expect(savedDrafts()).toEqual({ 'conversation-a': 'send me' });
  });

  it('keeps the pending draft while another conversation is open', async () => {
    const pending = deferredSend();
    await mount();
    await type('draft in A');
    await send();

    // 发送尚未被接受：输入框先清空，但原稿仍留在 A 的槽里，失败后才能还回来。
    expect(message().value).toBe('');
    expect(savedDrafts()).toEqual({ 'conversation-a': 'draft in A' });

    await openConversation('conversation-b');
    await type('draft in B');
    await act(async () => pending.reject(new Error('Send rejected')));
    await flush();

    expect(savedDrafts()).toEqual({
      'conversation-a': 'draft in A',
      'conversation-b': 'draft in B',
    });
    await openConversation('conversation-a');
    expect(message().value).toBe('draft in A');
  });

  it.each([
    ['conversation-a', 'conversation-a'],
    [null, 'conversation-new'],
  ] as const)('removes the pending draft only after acceptance from %s', async (open, accepted) => {
    const pending = deferredSend();
    await mount(open ? `/chat?agent=agent-a&conversation=${open}` : '/chat?agent=agent-a');
    await type('pending draft');
    await send();

    expect(savedDrafts()).toEqual({ [open ?? '']: 'pending draft' });
    await act(async () => pending.resolve({ runId: 'run-new', conversationId: accepted }));
    await flush();

    expect(message().value).toBe('');
    expect(savedDrafts()).toEqual({});
  });

  it.each([
    ['conversation-a', 'conversation-a'],
    [null, 'conversation-new'],
  ] as const)('keeps a draft typed while the send is pending from %s', async (open, accepted) => {
    const pending = deferredSend();
    await mount(open ? `/chat?agent=agent-a&conversation=${open}` : '/chat?agent=agent-a');
    await type('original');
    await send();
    await type('typed while waiting');
    await act(async () => pending.resolve({ runId: 'run-new', conversationId: accepted }));
    await flush();

    expect(message().value).toBe('typed while waiting');
    expect(savedDrafts()).toEqual({ [accepted]: 'typed while waiting' });
  });

  it.each([
    ['conversation-a', 'conversation-a'],
    [null, 'conversation-new'],
  ] as const)(
    'keeps an identical draft retyped before acceptance from %s',
    async (open, accepted) => {
      const pending = deferredSend();
      await mount(open ? `/chat?agent=agent-a&conversation=${open}` : '/chat?agent=agent-a');
      await type('same draft');
      await send();
      expect(message().value).toBe('');
      await type('same draft');

      await act(async () => pending.resolve({ runId: 'run-new', conversationId: accepted }));
      await flush();

      expect(router.state.location.search).toEqual({ agent: 'agent-a', conversation: accepted });
      expect(message().value).toBe('same draft');
      expect(savedDrafts()).toEqual({ [accepted]: 'same draft' });

      await openConversation('conversation-b');
      await openConversation(accepted);
      expect(message().value).toBe('same draft');

      await reload();
      await mount(`/chat?agent=agent-a&conversation=${accepted}`);
      expect(message().value).toBe('same draft');
      expect(savedDrafts()).toEqual({ [accepted]: 'same draft' });
    },
  );

  it('restores the pending draft after reloading its conversation URL', async () => {
    deferredSend();
    await mount();
    await type('unsent before reload');
    await send();
    // 刷新后仍停在同一会话 URL；静置着等待被接受的请求随着页面一起消失。

    await reload();
    await mount('/chat?agent=agent-a&conversation=conversation-a');

    expect(message().value).toBe('unsent before reload');
    expect(savedDrafts()).toEqual({ 'conversation-a': 'unsent before reload' });
  });

  it('restores the pending welcome draft when the page reloads', async () => {
    deferredSend();
    await mount('/chat?agent=agent-a');
    await type('welcome draft');
    await send();

    // 真刷新会重新初始化 store 模块；新会话没有 URL 会话 id，只能靠模块初始化读空槽。
    await reload();
    vi.resetModules();
    const fresh = await import('../src/lib/chat-store.js');
    expect(fresh.useChatStore.getState().input).toBe('welcome draft');
  });

  it('keeps every draft when the acceptance lands after switching away', async () => {
    const pending = deferredSend();
    await mount();
    await type('draft in A');
    await send();
    await openConversation('conversation-b');
    await type('draft in B');

    await act(async () => pending.resolve({ runId: 'run-new', conversationId: 'conversation-a' }));
    await flush();

    expect(router.state.location.search).toEqual({
      agent: 'agent-a',
      conversation: 'conversation-b',
    });
    expect(message().value).toBe('draft in B');
    expect(savedDrafts()).toEqual({
      'conversation-a': 'draft in A',
      'conversation-b': 'draft in B',
    });

    await openConversation('conversation-a');
    expect(message().value).toBe('draft in A');
    expect(savedDrafts()).toEqual({
      'conversation-a': 'draft in A',
      'conversation-b': 'draft in B',
    });
  });

  it.each(['accept', 'reject'] as const)(
    'keeps the new expert’s identical pending draft on late acceptance, then handles %s',
    async (outcome) => {
      vi.mocked(api.conversation).mockImplementation(async (id: string) =>
        conversationDetail(id, id === 'conversation-new' ? 'agent-b' : 'agent-a'),
      );
      const oldRequest = deferredSend();
      await mount('/chat?agent=agent-a');
      await type('same draft');
      await send();
      expect(savedDrafts()).toEqual({ '': 'same draft' });

      await act(async () =>
        host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]')?.click(),
      );
      await flush();
      const picker = host.querySelector<HTMLButtonElement>('button[aria-label^="选择专家"]');
      if (!picker) throw new Error('Missing expert picker');
      await act(async () => picker.click());
      await flush();
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
        entry.textContent?.includes('Other Expert'),
      );
      if (!option) throw new Error('Missing expert option');
      await act(async () => option.click());
      await flush();
      expect(router.state.location.search).toEqual({ agent: 'agent-b' });
      expect(message().value).toBe('same draft');

      const newRequest = deferredSend();
      await send();
      expect(vi.mocked(api.sendChat).mock.calls.at(-1)?.[0]).toMatchObject({
        agentId: 'agent-b',
        message: 'same draft',
      });
      expect(message().value).toBe('');
      expect(savedDrafts()).toEqual({ '': 'same draft' });

      await act(async () =>
        oldRequest.resolve({ runId: 'run-old', conversationId: 'conversation-old' }),
      );
      await flush();
      expect(router.state.location.search).toEqual({ agent: 'agent-b' });
      expect(message().value).toBe('');
      expect(savedDrafts()).toEqual({ '': 'same draft' });

      await act(async () => {
        if (outcome === 'accept') {
          newRequest.resolve({ runId: 'run-new', conversationId: 'conversation-new' });
        } else {
          newRequest.reject(new Error('Send rejected'));
        }
      });
      await flush();

      if (outcome === 'accept') {
        expect(router.state.location.search).toEqual({
          agent: 'agent-b',
          conversation: 'conversation-new',
        });
        expect(message().value).toBe('');
        expect(savedDrafts()).toEqual({});
      } else {
        expect(router.state.location.search).toEqual({ agent: 'agent-b' });
        expect(message().value).toBe('same draft');
        expect(savedDrafts()).toEqual({ '': 'same draft' });
      }
    },
  );

  it.each(['reject', 'accept'] as const)(
    'treats surrounding spaces as part of the draft on %s',
    async (outcome) => {
      const pending = deferredSend();
      await mount();
      await type('  padded text  ');
      await send();

      expect(vi.mocked(api.sendChat).mock.calls[0]?.[0].message).toBe('padded text');
      expect(savedDrafts()).toEqual({ 'conversation-a': '  padded text  ' });

      await act(async () => {
        if (outcome === 'reject') pending.reject(new Error('Send rejected'));
        else pending.resolve({ runId: 'run-new', conversationId: 'conversation-a' });
      });
      await flush();

      if (outcome === 'reject') {
        expect(message().value).toBe('  padded text  ');
        expect(savedDrafts()).toEqual({ 'conversation-a': '  padded text  ' });
      } else {
        expect(message().value).toBe('');
        expect(savedDrafts()).toEqual({});
      }
    },
  );
});

it('restores the welcome draft when the module initializes on reload', async () => {
  sessionStorage.setItem(DRAFTS_KEY, JSON.stringify({ '': 'welcome draft' }));
  vi.resetModules();
  const fresh = await import('../src/lib/chat-store.js');
  expect(fresh.useChatStore.getState().input).toBe('welcome draft');
});
