import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAccepted, RunDetail } from '../src/lib/api.js';

let root: Root;
let client: QueryClient;
const harness = vi.hoisted(() => ({
  sendChat: vi.fn(),
  conversation: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@agentport/shared', async () => import('../../shared/src/index.js'));
vi.mock('../src/lib/api.js', async (original) => ({
  ...(await original<typeof import('../src/lib/api.js')>()),
  api: { sendChat: harness.sendChat, conversation: harness.conversation },
}));
vi.mock('../src/lib/toast.js', () => ({ toastError: harness.toastError }));

import { useChatStore } from '../src/lib/chat-store.js';
import { useChatStream } from '../src/lib/use-chat-stream.js';

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

function sourceAt(index: number) {
  const source = Source.instances.at(index);
  if (!source) throw new Error('Expected an open event source');
  return source;
}

const accepted: ChatAccepted = { runId: 'run-a', conversationId: 'conversation-a' };
let currentStream: ReturnType<typeof useChatStream>;
function Probe({
  agentId,
  onAccepted,
}: {
  agentId: string;
  onAccepted: (accepted: ChatAccepted, text: string) => void;
}) {
  currentStream = useChatStream({ agentId, onAccepted });
  return null;
}
function render(agentId = 'agent-a', onAccepted = vi.fn()) {
  act(() =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe, { agentId, onAccepted })),
    ),
  );
  return currentStream;
}
function unmount() {
  act(() => root.unmount());
}
function deferred() {
  let resolve!: (value: ChatAccepted) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ChatAccepted>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  harness.sendChat.mockReturnValue(promise);
  return { resolve, reject };
}

beforeEach(() => {
  client = new QueryClient();
  root = createRoot(document.createElement('div'));
  harness.sendChat.mockReset().mockResolvedValue(accepted);
  harness.conversation.mockReset().mockResolvedValue({
    conversation: { id: 'conversation-a', agentId: 'agent-a', title: '', createdAt: '' },
    messages: [],
  });
  harness.toastError.mockReset();
  Source.instances = [];
  useChatStore.getState().reset();
  useChatStore.getState().setInput('original message');
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Source);
});
afterEach(() => {
  unmount();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chat request ownership', () => {
  it.each(['switch', 'agent', 'unmount'])('ignores late acceptance after %s', async (action) => {
    const pending = deferred();
    const onAccepted = vi.fn();
    const stream = render('agent-a', onAccepted);
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    if (action === 'unmount') unmount();
    else if (action === 'agent') render('agent-b');
    else stream.closeStream();
    act(() => {
      useChatStore.getState().resetConversation('conversation-b');
      useChatStore.getState().setItems([{ kind: 'user', text: 'other history' }]);
    });
    const expected = useChatStore.getState();
    await act(async () => {
      pending.resolve(accepted);
      await sending;
    });
    expect(useChatStore.getState()).toBe(expected);
    expect(Source.instances).toHaveLength(0);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('ignores a late rejection after a new conversation starts', async () => {
    const pending = deferred();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    stream.closeStream();
    useChatStore.getState().resetConversation(null);
    useChatStore.getState().setInput('new draft');
    const expected = useChatStore.getState();
    pending.reject(new Error('old request failed'));
    await sending;
    expect(useChatStore.getState()).toBe(expected);
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it('ignores queued SSE callbacks after detachment', async () => {
    const stream = render();
    await act(async () => {
      await stream.send();
    });
    const source = sourceAt(0);
    stream.closeStream();
    act(() => useChatStore.getState().resetConversation('conversation-b'));
    const expected = useChatStore.getState();
    source.emit({ type: 'text_delta', text: 'stale answer' });
    source.emit({ type: 'run_finished', status: 'succeeded' });
    source.onerror?.();
    source.onopen?.();
    expect(useChatStore.getState()).toBe(expected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('blocks sending until the selected history has hydrated', async () => {
    useChatStore.getState().resetConversation('history');
    const stream = render();
    await act(async () => {
      await stream.send();
    });
    expect(useChatStore.getState().input).toBe('original message');
    expect(useChatStore.getState().items).toEqual([]);
    expect(useChatStore.getState().run).toBeNull();
    expect(harness.sendChat).not.toHaveBeenCalled();
  });
});

describe('disconnected runs', () => {
  it('does not detach an in-flight request on ordinary rerenders', async () => {
    const pending = deferred();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    render();
    await act(async () => {
      pending.resolve(accepted);
      await sending;
    });
    expect(useChatStore.getState().run?.runId).toBe('run-a');
  });

  it('keeps loaded history when sending and replaying a response', async () => {
    const stream = render();
    act(() => {
      useChatStore.getState().resetConversation('conversation-a');
      useChatStore.getState().setItems([
        { kind: 'user', text: 'old prompt' },
        { kind: 'text', text: 'old reply' },
      ]);
    });
    stream.hydratedRef.current = 'conversation-a';
    await act(async () => {
      await stream.send();
    });
    sourceAt(0).emit({ type: 'text_delta', text: 'partial' });
    sourceAt(0).onerror?.();
    await vi.advanceTimersByTimeAsync(1500);
    sourceAt(1).emit({ type: 'text_delta', text: 'complete' });
    expect(useChatStore.getState().items).toEqual([
      { kind: 'user', text: 'old prompt' },
      { kind: 'text', text: 'old reply' },
      { kind: 'user', text: 'original message' },
      { kind: 'text', text: 'complete' },
    ]);
  });
  it('keeps the run cancellable after retry exhaustion', async () => {
    const stream = render();
    await act(async () => {
      await stream.send();
    });
    for (let i = 0; i < 4; i++) {
      sourceAt(-1).onerror?.();
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(useChatStore.getState().run).toMatchObject({ runId: 'run-a', status: 'detached' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['succeeded', 'failed', 'cancelled', 'timeout'] as const)(
    'reconciles disconnected %s runs from server state',
    async (status) => {
      const stream = render();
      await act(async () => {
        await stream.send();
      });
      sourceAt(0).emit({ type: 'error', message: 'connection lost' });
      sourceAt(0).onerror?.();
      const detail: RunDetail['run'] = {
        id: 'run-a',
        conversationId: 'conversation-a',
        agentId: 'agent-a',
        agentName: 'A',
        status,
        startedAt: null,
        endedAt: null,
        latencyMs: 1200,
        turns: 2,
        inputTokens: 10,
        outputTokens: 20,
        costUsd: '0.01',
        error: null,
        sessionId: null,
        sandboxId: null,
      };
      expect(typeof stream.reconcileRun).toBe('function');
      if (status === 'succeeded') {
        useChatStore.getState().setRun((run) => run && { ...run, status: 'streaming' });
        await stream.reconcileRun(detail);
        expect(useChatStore.getState().run?.runId).toBe('run-a');
        useChatStore.getState().setRun((run) => run && { ...run, status: 'detached' });
      }
      await stream.reconcileRun(detail);
      expect(useChatStore.getState().run).toBeNull();
      expect(useChatStore.getState().lastRun).toMatchObject({
        runId: 'run-a',
        status,
        tokens: 30,
        durationMs: 1200,
      });
      sourceAt(0).emit({ type: 'text_delta', text: 'late' });
      expect(useChatStore.getState().items).not.toContainEqual({ kind: 'text', text: 'late' });
    },
  );

  it('can explicitly retry a detached event stream', async () => {
    const stream = render();
    await act(async () => {
      await stream.send();
    });
    sourceAt(0).emit({ type: 'error', message: 'connection lost' });
    sourceAt(0).onerror?.();
    expect(typeof stream.retryStream).toBe('function');
    stream.retryStream();
    expect(Source.instances).toHaveLength(2);
    expect(useChatStore.getState().items).toEqual([{ kind: 'user', text: 'original message' }]);
    expect(useChatStore.getState().run?.status).toBe('reconnecting');
  });

  it('keeps a server error cancellable until a confirmed terminal status', async () => {
    const stream = render();
    await act(async () => {
      await stream.send();
    });
    sourceAt(0).emit({ type: 'error', message: 'connection lost' });
    sourceAt(0).onerror?.();
    expect(useChatStore.getState().run).toMatchObject({ runId: 'run-a', status: 'detached' });
  });
});
