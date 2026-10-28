import type { PublicRunQuestion } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { historyToItems } from '../src/lib/chat-state.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { runQuestionsQueryKey } from '../src/lib/queries.js';
import { useChatStream } from '../src/lib/use-chat-stream.js';
import { MessagePane } from '../src/pages/chat.js';

vi.mock('@agentport/shared', async () => import('../../shared/src/index.js'));

const at = '2026-10-28T00:00:00.000Z';

function runQuestion(overrides: Partial<PublicRunQuestion> = {}): PublicRunQuestion {
  return {
    requestId: 'qreq_1',
    runId: 'run_1',
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
    ...overrides,
  };
}

function pane(items: Parameters<typeof MessagePane>[0]['items'], extra: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MessagePane, {
        items,
        loading: false,
        error: null,
        onRetry() {},
        hasOlder: false,
        loadingOlder: false,
        onLoadOlder() {},
        olderDisabled: false,
        welcome: null,
        approvals: { pending: null, onApprove() {} },
        approvalItems: [],
        lastRun: null,
        historyMetrics: new Map(),
        onBranchMessage() {},
        branchingMessageId: null,
        running: Boolean(extra.liveRunId),
        openUi: false,
        streaming: false,
        onAction() {},
        ...extra,
      }),
    ),
  );
}

describe('question snapshots in history', () => {
  it('keeps the snapshot when a cancelled run has no tool_result', () => {
    const question = runQuestion();
    const items = historyToItems([
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'assistant',
        runId: 'run_1',
        createdAt: at,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'AskUserQuestion',
            input: { questions: question.questions },
            question,
          },
        ],
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool', question });
  });

  it('uses the resolved snapshot from the tool result', () => {
    const pending = runQuestion();
    const closed = runQuestion({ status: 'closed', closeReason: 'run_cancelled', resolvedAt: at });
    const items = historyToItems([
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'assistant',
        runId: 'run_1',
        createdAt: at,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'AskUserQuestion',
            input: { questions: pending.questions },
            question: pending,
          },
        ],
      },
      {
        id: 'm2',
        conversationId: 'c1',
        role: 'assistant',
        runId: 'run_1',
        createdAt: '2026-10-28T00:01:00.000Z',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_1',
            content: 'cancelled',
            question: closed,
          },
        ],
      },
    ]);

    expect(items[0]).toMatchObject({ kind: 'tool', question: closed });
  });
});

describe('question placement in chat', () => {
  it('renders the answer form at the AskUserQuestion tool position while live', () => {
    const question = runQuestion();
    const html = pane(
      [{ kind: 'tool', toolUseId: 'toolu_1', name: 'AskUserQuestion', startedAt: 1 }],
      { questionsByToolUseId: new Map([[question.toolUseId, question]]), liveRunId: 'run_1' },
    );

    expect(html).toContain('需要你的回答');
    expect(html).toContain('提交回答');
    expect(html).toContain('暂不回答');
  });

  it('keeps a forked history snapshot read-only', () => {
    const question = runQuestion({ runId: 'source_run' });
    const html = pane(
      [
        {
          kind: 'tool',
          toolUseId: 'toolu_1',
          name: 'AskUserQuestion',
          startedAt: 1,
          endedAt: 2,
          result: '',
          question,
        },
      ],
      { liveRunId: null },
    );

    expect(html).toContain('待回答');
    expect(html).toContain('请在发起该提问的会话中回答。');
    expect(html).not.toContain('提交回答');
  });
});

describe('question SSE updates the query cache', () => {
  let client: QueryClient;
  let root: Root;
  let source: Source;
  let stream: ReturnType<typeof useChatStream>;

  class Source {
    static instance: Source;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {
      Source.instance = this;
    }
    close() {
      this.closed = true;
    }
    emit(event: unknown) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }

  function Probe() {
    stream = useChatStream({ agentId: 'a1', onAccepted: () => {} });
    return null;
  }

  beforeEach(() => {
    client = new QueryClient();
    root = createRoot(document.createElement('div'));
    useChatStore.getState().reset();
    vi.spyOn(api, 'sendChat').mockResolvedValue({ runId: 'run_1', conversationId: 'c1' });
    vi.stubGlobal('EventSource', Source);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes question_updated into the run question query', async () => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    const question = runQuestion();
    await act(async () => {
      useChatStore.getState().setInput('hi');
      await stream.send();
    });
    source = Source.instance;
    expect(source).toBeDefined();

    await act(async () => {
      source.emit({ type: 'question_updated', question });
    });

    expect(client.getQueryData(runQuestionsQueryKey('run_1'))).toEqual({ items: [question] });
  });

  it('keeps the resolved status when a pending snapshot is replayed on reconnect', async () => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    await act(async () => {
      useChatStore.getState().setInput('hi');
      await stream.send();
    });
    source = Source.instance;

    const answered = runQuestion({
      status: 'answered',
      answers: { 0: '预发' },
      resolvedAt: at,
    });
    await act(async () => {
      source.emit({ type: 'question_updated', question: answered });
      source.emit({ type: 'question_updated', question: runQuestion() });
    });

    expect(
      client.getQueryData<{ items: PublicRunQuestion[] }>(runQuestionsQueryKey('run_1')),
    ).toEqual({
      items: [answered],
    });
  });

  it('keeps the terminal question snapshot on the tool after the run ends', async () => {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    await act(async () => {
      useChatStore.getState().setInput('hi');
      await stream.send();
    });
    source = Source.instance;
    const question = runQuestion({ status: 'answered', answers: { 0: '预发' } });

    await act(async () => {
      source.emit({ type: 'tool_start', toolUseId: 'toolu_1', name: 'AskUserQuestion' });
      source.emit({ type: 'question_updated', question });
      source.emit({ type: 'run_finished', status: 'succeeded' });
    });

    const tool = useChatStore
      .getState()
      .items.find((item) => item.kind === 'tool' && item.toolUseId === 'toolu_1');
    expect(tool).toMatchObject({ question });
  });
});
