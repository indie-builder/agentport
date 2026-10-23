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
        { kind: 'user', text: 'prompt' },
        { kind: 'text', text: 'authoritative reply' },
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
    expect(fetchHistory).toHaveBeenCalledExactlyOnceWith('conversation-a');
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
      kind: 'text',
      text: 'authoritative reply',
    });
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
