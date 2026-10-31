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
import { api, type ConversationDetail, type RunDetail } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { useRun } from '../src/lib/queries.js';
import { ChatPage } from '../src/pages/chat.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const adminMe = {
  authenticated: true as const,
  user: { businessId: 'admin', username: 'admin', name: '管理员' },
  roles: [],
  grants: [...(DEFAULT_ROLES.find((role) => role.systemKey === 'admin')?.grants ?? [])],
};
const agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'agent-a',
  parentId: null,
  createdAt: '',
  updatedAt: '',
};
const running: RunDetail = {
  run: {
    id: 'run-a',
    conversationId: 'conversation-a',
    agentId: 'agent-a',
    agentName: 'Expert',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    latencyMs: null,
    turns: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: null,
    sessionId: null,
    sandboxId: null,
  },
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: 'History' },
  steps: [],
};
const history: ConversationDetail = {
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: 'History', createdAt: '' },
  runMetrics: [],
  nextBefore: null,
  messages: [
    {
      id: 'message-a',
      conversationId: 'conversation-a',
      role: 'user',
      content: 'prompt',
      runId: 'run-a',
      createdAt: '',
    },
  ],
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

async function flush(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount() {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const chat = createRoute({
    getParentRoute: () => shell,
    path: '/chat',
    validateSearch: z.object({
      agent: z.string().min(1).optional().catch(undefined),
      conversation: z.string().min(1).optional().catch(undefined),
    }),
    component: ChatPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([chat])]),
    history: createMemoryHistory({
      initialEntries: ['/chat?agent=agent-a&conversation=conversation-a'],
    }),
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

function source(): Source {
  const first = Source.instances[0];
  if (!first) throw new Error('Expected an event source');
  return first;
}

function runReads(): number {
  return vi.mocked(api.run).mock.calls.length;
}

beforeEach(() => {
  useChatStore.getState().reset();
  Source.instances = [];
  localStorage.clear();
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
  client.setQueryData(['me'], adminMe);
  client.setQueryData(['agents'], [agent]);
  vi.spyOn(api, 'agents').mockResolvedValue([agent]);
  vi.spyOn(api, 'conversations').mockResolvedValue([]);
  vi.spyOn(api, 'conversation').mockResolvedValue(history);
  vi.spyOn(api, 'run').mockResolvedValue(running);
  vi.spyOn(api, 'runApprovals').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'runQuestions').mockResolvedValue({ items: [] });
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

describe('healthy stream detail polling', () => {
  it('stops full run detail reads while the stream stays healthy', async () => {
    await mount();
    expect(source()).toBeDefined();
    expect(runReads()).toBe(1);

    source().onopen?.();
    await flush();
    expect(useChatStore.getState().run?.status).toBe('streaming');

    const before = runReads();
    await flush(6_200);
    expect(runReads()).toBe(before);

    source().emit({ type: 'text_delta', text: 'streamed answer' });
    source().emit({ type: 'run_finished', status: 'succeeded' });
    await flush();
    const texts = useChatStore
      .getState()
      .items.filter((item) => item.kind === 'text')
      .map((item) => item.text);
    expect(texts).toContain('streamed answer');
  });

  it('keeps the fallback read until the stream opens, then stops it', async () => {
    await mount();
    expect(runReads()).toBe(1);

    await flush(2_200);
    expect(runReads()).toBeGreaterThan(1);

    source().onopen?.();
    await flush();
    const before = runReads();
    await flush(2_400);
    expect(runReads()).toBe(before);
  });

  it('drops health on a protocol error before onerror fires and resumes polling', async () => {
    await mount();
    source().onopen?.();
    await flush();
    expect(useChatStore.getState().run?.status).toBe('streaming');

    source().emit({ type: 'error', message: 'run failed' });
    expect(useChatStore.getState().run?.status).toBe('detached');

    vi.mocked(api.run).mockResolvedValue({
      ...running,
      run: { ...running.run, status: 'succeeded', latencyMs: 1 },
    });
    const before = runReads();
    await flush(2_400);
    expect(runReads()).toBeGreaterThan(before);
    expect(useChatStore.getState().run).toBeNull();
    expect(useChatStore.getState().lastRun?.status).toBe('succeeded');
  });
});

describe('run detail observer', () => {
  it('polls every 2 seconds by default and stops at a terminal status', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.run).mockResolvedValue(running);
      function Probe() {
        useRun('run-a');
        return null;
      }
      await act(async () => {
        root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(runReads()).toBe(1);

      vi.mocked(api.run).mockResolvedValue({
        ...running,
        run: { ...running.run, status: 'succeeded' },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(runReads()).toBe(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(runReads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still refetches on manual invalidation while periodic polling is off', async () => {
    client.setQueryData(['run', 'run-a'], running);
    vi.mocked(api.run).mockResolvedValue({
      ...running,
      run: { ...running.run, status: 'cancelled' },
    });
    function Probe() {
      useRun('run-a', false);
      return null;
    }
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    const before = runReads();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['run', 'run-a'] });
    });
    expect(runReads()).toBe(before + 1);
    expect(client.getQueryData<RunDetail>(['run', 'run-a'])?.run.status).toBe('cancelled');
  });
});
