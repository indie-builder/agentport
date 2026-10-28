import type { PublicRunQuestion } from '@agentport/shared';
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
import { api, type RunDetail } from '../src/lib/api.js';
import { RunDetailPage } from '../src/pages/run-detail.js';
import { runDetailSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const at = '2026-10-28T00:00:00Z';

const question: PublicRunQuestion = {
  requestId: 'qreq_1',
  runId: 'run-1',
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
  createdAt: at,
  resolvedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  closeReason: null,
};

const detail: RunDetail = {
  run: {
    id: 'run-1',
    agentId: 'agent-1',
    agentName: '专家',
    status: 'running',
    startedAt: at,
    endedAt: null,
    costUsd: null,
    turns: 1,
    latencyMs: 1000,
    error: null,
    inputTokens: null,
    outputTokens: null,
    conversationId: 'conv-1',
    sessionId: null,
    sandboxId: null,
  },
  steps: [
    { kind: 'user', at, text: '帮我部署' },
    {
      kind: 'tool',
      at,
      name: 'AskUserQuestion',
      toolUseId: 'toolu_1',
      // 运行步骤只保留工具参数；提问状态由该 run 的 questions 接口提供。
      content: { questions: question.questions },
      parentToolUseId: null,
    },
  ],
  conversation: { id: 'conv-1', agentId: 'agent-1', title: '会话' },
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createMemoryHistory>;

async function mount(data: RunDetail = detail) {
  vi.mocked(api.run).mockResolvedValue(data);
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const runs = createRoute({
    getParentRoute: () => shell,
    path: '/runs/',
    component: () => createElement('h1', null, '运行'),
  });
  const runDetail = createRoute({
    getParentRoute: () => shell,
    path: '/runs/$runId',
    validateSearch: runDetailSearchSchema,
    component: RunDetailPage,
  });
  history = createMemoryHistory({ initialEntries: ['/runs/run-1'] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([runs, runDetail])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'run').mockResolvedValue(detail);
  vi.spyOn(api, 'runApprovals').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'runQuestions').mockResolvedValue({ items: [question] });
  vi.spyOn(api, 'respondToQuestion').mockResolvedValue({
    ...question,
    status: 'answered',
    answers: { 0: '预发' },
    resolvedAt: at,
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
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
});

describe('run detail answers a live question', () => {
  it('renders the shared form and sends the official answer', async () => {
    await mount();
    await act(async () => {
      await vi.waitFor(() => expect(button('提交回答')).not.toBeUndefined());
    });

    await act(async () => {
      host.querySelector<HTMLElement>('[role="radio"]')?.click();
    });
    await act(async () => button('提交回答')?.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(api.respondToQuestion).toHaveBeenCalledWith('run-1', 'qreq_1', {
          answers: {},
          choices: { 0: ['0'] },
        }),
      );
    });
  });

  it('renders a live question that no step references', async () => {
    await mount({ ...detail, steps: [{ kind: 'user', at, text: '帮我部署' }] });

    await act(async () => {
      await vi.waitFor(() => expect(button('提交回答')).not.toBeUndefined());
    });
    expect(host.textContent).toContain('需要你的回答');
  });

  it('renders a live question when the run has no steps yet', async () => {
    await mount({ ...detail, steps: [] });

    await act(async () => {
      await vi.waitFor(() => expect(button('提交回答')).not.toBeUndefined());
    });
  });

  it('keeps the terminal question card from the step snapshot', async () => {
    vi.mocked(api.runQuestions).mockResolvedValue({ items: [] });
    const closed = {
      ...question,
      status: 'closed' as const,
      closeReason: 'run_finished',
      resolvedAt: at,
    };
    await mount({
      ...detail,
      run: { ...detail.run, status: 'succeeded', endedAt: at },
      steps: [
        { kind: 'user', at, text: '帮我部署' },
        {
          kind: 'tool',
          at,
          name: 'AskUserQuestion',
          toolUseId: 'toolu_1',
          content: { question: closed },
          parentToolUseId: null,
        },
      ],
    });

    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain('已关闭'));
    });
    expect(button('提交回答')).toBeUndefined();
  });

  it('prefers the final step snapshot over a stale pending list', async () => {
    const closed = {
      ...question,
      status: 'closed' as const,
      closeReason: 'run_finished',
      resolvedAt: at,
    };
    await mount({
      ...detail,
      run: { ...detail.run, status: 'succeeded', endedAt: at },
      steps: [
        { kind: 'user', at, text: '帮我部署' },
        {
          kind: 'tool',
          at,
          name: 'AskUserQuestion',
          toolUseId: 'toolu_1',
          content: { questions: question.questions },
          question: closed,
          parentToolUseId: null,
        },
      ],
    });

    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain('已关闭'));
    });
    expect(host.textContent).not.toContain('需要你的回答');
    expect(button('提交回答')).toBeUndefined();
  });
});
