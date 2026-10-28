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
import { api } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { ChatPage } from '../src/pages/chat.js';

const expert = (slug: string, name: string, id: string) => ({
  ...agentInputSchema.parse({ slug, name }),
  id,
  parentId: null,
  createdAt: '',
  updatedAt: '',
});
const agentA = expert('expert-a', '专家 A', 'agent-a');
const agentB = expert('expert-b', '专家 B', 'agent-b');

class Source {
  onopen = null;
  onmessage = null;
  onerror = null;
  close() {}
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function press(input: HTMLInputElement, key: string, keyCode: number): Promise<void> {
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'which', { value: keyCode });
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    input.dispatchEvent(event);
  });
  await flush();
}

async function mount(initialEntry: string) {
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
  const run = createRoute({
    getParentRoute: () => route,
    path: '/runs/$runId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: route.addChildren([shell.addChildren([chat]), run]),
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
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['agents'], [agentA, agentB]);
  vi.spyOn(api, 'agents').mockResolvedValue([agentA, agentB]);
  vi.spyOn(api, 'conversations').mockResolvedValue([]);
  vi.spyOn(api, 'conversation').mockImplementation(async (conversationId) => ({
    conversation: { id: conversationId, agentId: 'agent-b', title: '目标会话' },
    runMetrics: [],
    nextBefore: null,
    messages: [
      {
        id: 'message-b',
        conversationId,
        role: 'user',
        content: '目标会话的历史',
        runId: null,
        createdAt: '',
      },
    ],
  }));
  vi.spyOn(api, 'searchConversations').mockResolvedValue({
    items: [
      {
        id: 'conversation-b',
        agentId: 'agent-b',
        agentName: '专家 B',
        title: '跨专家会话',
        updatedAt: '2026-10-29T00:00:00.000Z',
        match: { kind: 'title' as const, excerpt: '跨专家' },
      },
    ],
    nextBefore: null,
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

describe('cross-expert conversation search', () => {
  it('opens the target conversation with a single navigation and keeps drafts isolated', async () => {
    useChatStore.getState().setInput('当前草稿');
    const drafts = JSON.parse(sessionStorage.getItem('pace.chat.drafts') ?? '{}');
    drafts['conversation-b'] = '目标草稿';
    sessionStorage.setItem('pace.chat.drafts', JSON.stringify(drafts));

    const router = await mount('/chat?agent=agent-a');

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="搜索会话"]');
    if (!trigger) throw new Error('Missing search trigger');
    await act(async () => trigger.click());
    await flush();

    expect(document.body.textContent).toContain('跨专家会话');
    const option = document.querySelector('[role="option"]');
    if (!option) throw new Error('Missing search result');
    await act(async () => (option as HTMLElement).click());
    await flush();
    await flush();

    expect(router.state.location.search).toMatchObject({
      agent: 'agent-b',
      conversation: 'conversation-b',
    });
    expect(useChatStore.getState()).toMatchObject({
      conversationId: 'conversation-b',
      input: '目标草稿',
    });
    const stored = JSON.parse(sessionStorage.getItem('pace.chat.drafts') ?? '{}');
    expect(stored['']).toBe('当前草稿');
    expect(stored['conversation-b']).toBe('目标草稿');
    expect(vi.mocked(api.conversations)).toHaveBeenCalledWith('agent-b', expect.anything());
  });

  it('navigates once with agent and conversation when Enter opens the highlighted result', async () => {
    const router = await mount('/chat?agent=agent-a');

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="搜索会话"]');
    if (!trigger) throw new Error('Missing search trigger');
    await act(async () => trigger.click());
    await flush();

    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索会话"]');
    if (!input) throw new Error('Missing search input');
    await press(input, 'ArrowDown', 40);
    await press(input, 'Enter', 13);
    await flush();

    expect(router.state.location.search).toMatchObject({
      agent: 'agent-b',
      conversation: 'conversation-b',
    });
    // 合成 click 与显式 Enter 只能合成一次导航。
    expect(router.history.length).toBe(2);
  });
});
