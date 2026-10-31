import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ConversationDetail, type RunDetail } from '../src/lib/api.js';
import { applyEvent, type ChatItem } from '../src/lib/chat-state.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { useChatStream } from '../src/lib/use-chat-stream.js';

vi.mock('@agentport/shared', async () => import('../../shared/src/index.js'));
vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn() }));

function mountStream() {
  let stream!: ReturnType<typeof useChatStream>;
  function Probe() {
    stream = useChatStream({ agentId: 'agent-a', onAccepted() {} });
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)),
  );
  return stream;
}

const terminal: RunDetail['run'] = {
  id: 'run-a',
  conversationId: 'conversation-a',
  agentId: 'agent-a',
  agentName: 'A',
  status: 'failed',
  startedAt: null,
  endedAt: null,
  latencyMs: 100,
  turns: 1,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  error: 'stopped',
  sessionId: null,
  sandboxId: null,
};
const history: ConversationDetail = {
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: '', createdAt: '' },
  runMetrics: [],
  nextBefore: null,
  messages: [
    {
      id: '1',
      conversationId: 'conversation-a',
      role: 'user',
      content: 'prompt',
      runId: 'run-a',
      createdAt: '',
    },
    {
      id: '2',
      conversationId: 'conversation-a',
      role: 'assistant',
      content: [{ type: 'text', text: 'authoritative reply' }],
      runId: 'run-a',
      createdAt: '',
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  useChatStore.getState().reset();
});

function detail(
  messages: ConversationDetail['messages'],
  options: { nextBefore?: string | null } = {},
): ConversationDetail {
  return {
    conversation: { id: 'conversation-a', agentId: 'agent-a', title: '', createdAt: '' },
    messages,
    runMetrics: [],
    nextBefore: options.nextBefore ?? null,
  };
}

function userMessage(id: string): ConversationDetail['messages'][number] {
  return {
    id,
    conversationId: 'conversation-a',
    role: 'user',
    content: 'prompt',
    runId: 'run-a',
    createdAt: id,
  };
}

function assistantMessage(id: string, text: string): ConversationDetail['messages'][number] {
  return {
    id,
    conversationId: 'conversation-a',
    role: 'assistant',
    content: [{ type: 'text', text }],
    runId: 'run-a',
    createdAt: id,
  };
}

function disconnected() {
  const stream = mountStream();
  const store = useChatStore.getState();
  store.resetConversation('conversation-a');
  store.setRun({
    runId: 'run-a',
    conversationId: 'conversation-a',
    status: 'detached',
    startedAt: 0,
  });
  store.setItems([{ kind: 'text', text: 'partial' }]);
  stream.hydratedRef.current = 'conversation-a';
  return stream;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('branch request ownership', () => {
  it('revokes older branches and rejects responses after switching away and back', () => {
    const stream = mountStream();
    useChatStore.getState().resetConversation('a');
    const first = stream.captureRequest();
    const second = stream.captureRequest();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    stream.closeStream();
    useChatStore.getState().resetConversation('b');
    stream.closeStream();
    useChatStore.getState().resetConversation('a');
    expect(second()).toBe(false);
    expect(stream.captureRequest()()).toBe(true);
  });
});

describe('authoritative disconnected recovery', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'timeout'] as const)(
    'hydrates missed messages for %s',
    async (status) => {
      const stream = disconnected();
      vi.spyOn(api, 'conversation').mockResolvedValue(history);
      await stream.reconcileRun({ ...terminal, status });
      expect(useChatStore.getState().items).toEqual([
        { id: '1:0', kind: 'user', text: 'prompt', messageId: '1', runId: 'run-a' },
        { id: '2:0', kind: 'text', text: 'authoritative reply', runId: 'run-a' },
      ]);
      expect(useChatStore.getState().run).toBeNull();
      expect(useChatStore.getState().lastRun?.status).toBe(status);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores late recovery %s after switching away and back',
    async (outcome) => {
      const stream = disconnected();
      const pending = deferred<ConversationDetail>();
      vi.spyOn(api, 'conversation').mockReturnValue(pending.promise);
      const recovery = stream.reconcileRun(terminal);
      stream.closeStream();
      useChatStore.getState().resetConversation('b');
      stream.closeStream();
      useChatStore.getState().resetConversation('conversation-a');
      useChatStore.getState().setItems([{ kind: 'text', text: 'new history' }]);
      const expected = useChatStore.getState();
      if (outcome === 'resolve') pending.resolve(history);
      else pending.reject(new Error('offline'));
      await recovery;
      expect(useChatStore.getState()).toBe(expected);
    },
  );

  it('blocks another send until recovery completes and coalesces repeated reconciliation', async () => {
    const stream = disconnected();
    const pending = deferred<ConversationDetail>();
    const fetchHistory = vi.spyOn(api, 'conversation').mockReturnValue(pending.promise);
    const send = vi.spyOn(api, 'sendChat').mockRejectedValue(new Error('unexpected send'));
    const recovery = stream.reconcileRun(terminal);
    await stream.reconcileRun(terminal);
    useChatStore.getState().setInput('next prompt');
    await stream.send();
    expect(send).not.toHaveBeenCalled();
    expect(fetchHistory).toHaveBeenCalledExactlyOnceWith('conversation-a', { limit: 100 });
    pending.resolve(history);
    await recovery;
    expect(useChatStore.getState().input).toBe('next prompt');
  });

  it('does not let an old recovery release a newer recovery of the same run', async () => {
    const stream = disconnected();
    const oldHistory = deferred<ConversationDetail>();
    const newHistory = deferred<ConversationDetail>();
    vi.spyOn(api, 'conversation')
      .mockReturnValueOnce(oldHistory.promise)
      .mockReturnValueOnce(newHistory.promise);
    const oldRecovery = stream.reconcileRun(terminal);
    stream.closeStream();
    const newRecovery = stream.reconcileRun(terminal);
    oldHistory.resolve(history);
    await oldRecovery;
    expect(useChatStore.getState().run?.runId).toBe('run-a');
    expect(useChatStore.getState().items).toEqual([{ kind: 'text', text: 'partial' }]);
    newHistory.resolve(history);
    await newRecovery;
    expect(useChatStore.getState().run).toBeNull();
    expect(useChatStore.getState().items).toContainEqual({
      id: '2:0',
      kind: 'text',
      text: 'authoritative reply',
      runId: 'run-a',
    });
  });

  it('loads the complete run and keeps the already loaded older prefix', async () => {
    const stream = mountStream();
    const store = useChatStore.getState();
    store.resetConversation('conversation-a');
    store.setItems([
      { id: 'old:0', kind: 'text', text: 'older reply' },
      { kind: 'user', text: 'prompt', runId: 'run-a' },
      { kind: 'text', text: 'partial' },
    ]);
    store.setRun({
      runId: 'run-a',
      conversationId: 'conversation-a',
      status: 'detached',
      startedAt: 0,
    });
    stream.hydratedRef.current = 'conversation-a';
    // 最新页只剩本轮助手消息；本 run 的第一条用户消息在前一页。
    vi.spyOn(api, 'conversation')
      .mockResolvedValueOnce(detail([assistantMessage('m3', 'later')], { nextBefore: 'm3' }))
      .mockResolvedValueOnce(
        detail([userMessage('u1'), assistantMessage('m2', 'earlier')], { nextBefore: 'u1' }),
      );

    await stream.reconcileRun({ ...terminal, status: 'succeeded' });

    expect(useChatStore.getState().items.map((item) => ('text' in item ? item.text : ''))).toEqual([
      'older reply',
      'prompt',
      'earlier',
      'later',
    ]);
    expect(useChatStore.getState().run).toBeNull();
  });

  it('keeps a healthy stream in control of buffered messages', async () => {
    const stream = disconnected();
    useChatStore.getState().setRun((run) => run && { ...run, status: 'streaming' });
    const fetchHistory = vi.spyOn(api, 'conversation').mockResolvedValue(history);
    const expected = useChatStore.getState();
    await stream.reconcileRun(terminal);
    expect(useChatStore.getState()).toBe(expected);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it('retains partial content and ends unresolved tools when history recovery fails', async () => {
    const stream = disconnected();
    useChatStore.getState().setItems([
      { kind: 'text', text: 'partial' },
      { kind: 'tool', toolUseId: 'tool-a', name: 'read', startedAt: 1 },
    ]);
    vi.spyOn(api, 'conversation').mockRejectedValue(new Error('offline'));
    await stream.reconcileRun(terminal);
    expect(useChatStore.getState().run).toBeNull();
    expect(useChatStore.getState().items).toEqual([
      { kind: 'text', text: 'partial' },
      expect.objectContaining({ kind: 'tool', toolUseId: 'tool-a', endedAt: expect.any(Number) }),
    ]);
    expect(useChatStore.getState().items[1]).not.toHaveProperty('result');
  });
});

describe('terminal tools', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'timeout'] as const)(
    'ends unresolved tools on %s without fabricating results',
    (status) => {
      const completed: ChatItem = {
        kind: 'tool',
        toolUseId: 'done',
        name: 'read',
        result: '',
        endedAt: 5,
      };
      const items: ChatItem[] = [
        completed,
        { kind: 'tool', toolUseId: 'pending', name: 'write', startedAt: 1 },
      ];
      const result = applyEvent(items, { type: 'run_finished', status });
      expect(result[0]).toBe(completed);
      expect(result[1]).toMatchObject({ toolUseId: 'pending', endedAt: expect.any(Number) });
      expect(result[1]).not.toHaveProperty('result');
      expect(applyEvent(result, { type: 'run_finished', status })[1]).toBe(result[1]);
    },
  );
});
