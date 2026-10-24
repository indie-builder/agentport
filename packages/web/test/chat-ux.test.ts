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
import { type ApprovalRequest, api, type ChatAccepted, type RunDetail } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
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
  localStorage.clear();
  vi.stubGlobal('EventSource', Source);
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
  vi.spyOn(api, 'conversations').mockResolvedValue({ supported: true, items: [] });
  vi.spyOn(api, 'conversation').mockResolvedValue({
    conversation: { ...terminal.conversation, createdAt: '' },
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
