import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ConversationDetail, type RunDetail } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { useConversation, useConversations, useRunApprovals } from '../src/lib/queries.js';
import { useChatStream } from '../src/lib/use-chat-stream.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn() }));

class Source {
  static instances: Source[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    Source.instances.push(this);
  }
  close() {}
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const history: ConversationDetail = {
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: 'History', createdAt: '' },
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
      content: 'partial',
      runId: 'run-a',
      createdAt: '',
    },
  ],
};
const run: RunDetail = {
  run: {
    id: 'run-a',
    conversationId: 'conversation-a',
    agentId: 'agent-a',
    agentName: 'A',
    status: 'running',
    startedAt: null,
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
  steps: [],
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: 'History' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let root: Root;
let client: QueryClient;
let stream: ReturnType<typeof useChatStream>;
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function mount(probe: () => null) {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(probe)));
  });
  await flush();
}
function ChatProbe() {
  const id = useChatStore((state) => state.conversationId);
  const active = useChatStore((state) => state.run);
  const last = useChatStore((state) => state.lastRunId);
  const detail = useConversation(id);
  useRunApprovals(active?.runId || last, Boolean(active));
  useConversations('agent-a');
  stream = useChatStream({ agentId: 'agent-a', onAccepted() {}, history: detail });
  return null;
}
beforeEach(() => {
  useChatStore.getState().reset();
  Source.instances = [];
  vi.stubGlobal('EventSource', Source);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  root = createRoot(document.createElement('div'));
  vi.spyOn(api, 'run').mockResolvedValue(run);
  vi.spyOn(api, 'conversation').mockResolvedValue(history);
  vi.spyOn(api, 'runApprovals').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'conversations').mockResolvedValue({ supported: true, items: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('history restoration', () => {
  it('waits for this opening to refresh cached history and blocks sending until run status is known', async () => {
    const pending = deferred<ConversationDetail>();
    vi.mocked(api.conversation).mockReturnValue(pending.promise);
    client.setQueryData(['conversation', 'conversation-a'], {
      pages: [{ ...history, messages: [] }],
      pageParams: [null],
    });
    useChatStore.getState().resetConversation('conversation-a');
    useChatStore.getState().setInput('next');
    const send = vi.spyOn(api, 'sendChat');
    await mount(ChatProbe);
    await act(async () => stream.send());
    expect(send).not.toHaveBeenCalled();
    expect(useChatStore.getState().items).toEqual([]);
    await act(async () => pending.resolve(history));
    await flush();
    expect(useChatStore.getState().items).toContainEqual({
      id: '1:0',
      kind: 'user',
      text: 'prompt',
      messageId: '1',
    });
    expect(useChatStore.getState().run).toMatchObject({ runId: 'run-a', status: 'reconnecting' });
  });

  it('keeps earlier turns once and replaces the latest partial answer when SSE replays', async () => {
    vi.mocked(api.conversation).mockResolvedValue({
      ...history,
      messages: [
        {
          id: 'old-u',
          conversationId: 'conversation-a',
          role: 'user',
          content: 'old prompt',
          runId: 'old-run',
          createdAt: '',
        },
        {
          id: 'old-a',
          conversationId: 'conversation-a',
          role: 'assistant',
          content: 'old reply',
          runId: 'old-run',
          createdAt: '',
        },
        ...history.messages,
      ],
    });
    useChatStore.getState().resetConversation('conversation-a');
    await mount(ChatProbe);
    expect(Source.instances).toHaveLength(1);
    await act(async () =>
      Source.instances[0]?.emit({ type: 'text_delta', text: 'complete reply' }),
    );
    expect(useChatStore.getState().items).toEqual([
      { id: 'old-u:0', kind: 'user', text: 'old prompt', messageId: 'old-u' },
      { id: 'old-a:0', kind: 'text', text: 'old reply' },
      { id: '1:0', kind: 'user', text: 'prompt', messageId: '1' },
      { kind: 'text', text: 'complete reply' },
    ]);
  });

  it('restores the latest terminal run for approvals without opening a stream', async () => {
    vi.mocked(api.run).mockResolvedValue({ ...run, run: { ...run.run, status: 'failed' } });
    useChatStore.getState().resetConversation('conversation-a');
    await mount(ChatProbe);
    expect(useChatStore.getState().lastRunId).toBe('run-a');
    expect(useChatStore.getState().run).toBeNull();
    expect(Source.instances).toHaveLength(0);
    expect(useChatStore.getState().items).toContainEqual({
      id: '2:0',
      kind: 'text',
      text: 'partial',
    });
    expect(api.runApprovals).toHaveBeenCalledWith('run-a');
  });

  it.each(['succeeded', 'failed', 'cancelled', 'timeout'] as const)(
    'restores the latest %s outcome, error and persisted metrics',
    async (status) => {
      vi.mocked(api.run).mockResolvedValue({
        ...run,
        run: {
          ...run.run,
          status,
          latencyMs: 2400,
          turns: 3,
          inputTokens: 12,
          outputTokens: 8,
          costUsd: '0.025',
          error: status === 'succeeded' ? null : 'Stopped by server',
        },
      });
      useChatStore.getState().resetConversation('conversation-a');
      await mount(ChatProbe);
      expect(useChatStore.getState().lastRun).toEqual({
        runId: 'run-a',
        status,
        durationMs: 2400,
        turns: 3,
        tokens: 20,
        costUsd: 0.025,
        ...(status === 'succeeded' ? {} : { error: 'Stopped by server' }),
      });
      expect(useChatStore.getState().run).toBeNull();
      expect(Source.instances).toHaveLength(0);
    },
  );

  it('keeps absent terminal metrics unknown and preserves measured zero values', async () => {
    vi.mocked(api.run).mockResolvedValue({ ...run, run: { ...run.run, status: 'failed' } });
    useChatStore.getState().resetConversation('conversation-a');
    await mount(ChatProbe);
    expect(useChatStore.getState().lastRun).toEqual({
      runId: 'run-a',
      status: 'failed',
    });
    await act(async () => {
      stream.closeStream();
      stream.hydratedRef.current = null;
      useChatStore.getState().resetConversation(null);
    });
    vi.mocked(api.run).mockResolvedValue({
      ...run,
      run: {
        ...run.run,
        status: 'succeeded',
        latencyMs: 0,
        turns: 0,
        inputTokens: null,
        outputTokens: 0,
        costUsd: '0',
      },
    });
    await act(async () => useChatStore.getState().resetConversation('conversation-a'));
    await flush();
    expect(useChatStore.getState().lastRun).toEqual({
      runId: 'run-a',
      status: 'succeeded',
      durationMs: 0,
      turns: 0,
      tokens: 0,
      costUsd: 0,
    });
  });

  it('blocks sending while the latest run lookup is pending', async () => {
    const pending = deferred<RunDetail>();
    vi.mocked(api.run).mockReturnValue(pending.promise);
    const send = vi.spyOn(api, 'sendChat');
    useChatStore.getState().resetConversation('conversation-a');
    useChatStore.getState().setInput('next');
    await mount(ChatProbe);
    await act(async () => stream.send());
    expect(send).not.toHaveBeenCalled();
    expect(stream.hydratedRef.current).toBeNull();
    await act(async () => pending.resolve({ ...run, run: { ...run.run, status: 'succeeded' } }));
    await flush();
    expect(stream.hydratedRef.current).toBe('conversation-a');
  });

  it('retains a stop and retry target when the run lookup fails', async () => {
    vi.mocked(api.run).mockRejectedValue(new Error('offline'));
    useChatStore.getState().resetConversation('conversation-a');
    await mount(ChatProbe);
    expect(useChatStore.getState().run).toMatchObject({ runId: 'run-a', status: 'detached' });
    await act(async () => stream.retryStream());
    expect(Source.instances).toHaveLength(1);
    expect(useChatStore.getState().items).toEqual([
      { id: '1:0', kind: 'user', text: 'prompt', messageId: '1' },
    ]);
  });

  it('restores history without a run and allows sending', async () => {
    vi.mocked(api.conversation).mockResolvedValue({
      ...history,
      messages: history.messages.map((message) => ({ ...message, runId: null })),
    });
    useChatStore.getState().resetConversation('conversation-a');
    await mount(ChatProbe);
    expect(api.run).not.toHaveBeenCalled();
    expect(stream.hydratedRef.current).toBe('conversation-a');
    expect(useChatStore.getState().items).toHaveLength(2);
  });

  it('does not hydrate a previous conversation response after switching', async () => {
    const pending = deferred<ConversationDetail>();
    vi.mocked(api.conversation)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        ...history,
        conversation: { ...history.conversation, id: 'conversation-b' },
        messages: [],
      });
    useChatStore.getState().resetConversation('conversation-a');
    await mount(ChatProbe);
    await act(async () => {
      stream.closeStream();
      stream.hydratedRef.current = null;
      useChatStore.getState().resetConversation('conversation-b');
    });
    await flush();
    await act(async () => pending.resolve(history));
    await flush();
    expect(useChatStore.getState().conversationId).toBe('conversation-b');
    expect(useChatStore.getState().items).toEqual([]);
    expect(api.run).not.toHaveBeenCalled();
  });

  it('ignores a late run lookup after switching away and back', async () => {
    const pending = deferred<RunDetail>();
    vi.mocked(api.run).mockReturnValueOnce(pending.promise);
    useChatStore.getState().resetConversation('conversation-a');
    await mount(ChatProbe);
    await act(async () => {
      stream.closeStream();
      stream.hydratedRef.current = null;
      useChatStore.getState().resetConversation('conversation-b');
    });
    vi.mocked(api.run).mockResolvedValue({ ...run, run: { ...run.run, status: 'succeeded' } });
    await act(async () => {
      stream.closeStream();
      stream.hydratedRef.current = null;
      useChatStore.getState().resetConversation('conversation-a');
    });
    await flush();
    const current = useChatStore.getState();
    await act(async () => pending.resolve(run));
    await flush();
    expect(useChatStore.getState()).toBe(current);
    expect(Source.instances).toHaveLength(0);
  });
});

describe('approval final refresh', () => {
  it('reads approvals once more when active becomes false even while the previous request is pending', async () => {
    const first = deferred<{ items: [] }>();
    vi.mocked(api.runApprovals).mockReturnValueOnce(first.promise);
    const approval = {
      id: 'approval-a',
      serverId: 'server-a',
      serverName: 'A',
      toolName: 'write',
      approvedAt: null,
      createdAt: '',
    };
    vi.mocked(api.runApprovals).mockResolvedValue({ items: [approval] });
    let active = true;
    let items: unknown;
    function Probe() {
      items = useRunApprovals('run-a', active).data?.items;
      return null;
    }
    await mount(Probe);
    active = false;
    await mount(Probe);
    await act(async () => first.resolve({ items: [] }));
    await flush();
    expect(items).toEqual([approval]);
    expect(api.runApprovals).toHaveBeenCalledTimes(2);
    await mount(Probe);
    expect(api.runApprovals).toHaveBeenCalledTimes(2);
  });

  it('refreshes approvals after disconnected terminal reconciliation', async () => {
    useChatStore.getState().resetConversation('conversation-a');
    await mount(ChatProbe);
    const approval = {
      id: 'approval-a',
      serverId: 'server-a',
      serverName: 'A',
      toolName: 'write',
      approvedAt: null,
      createdAt: '',
    };
    vi.mocked(api.runApprovals).mockResolvedValue({ items: [approval] });
    await act(async () => {
      useChatStore.getState().setRun((value) => value && { ...value, status: 'detached' });
      await stream.reconcileRun({ ...run.run, status: 'failed' });
    });
    await flush();
    expect(useChatStore.getState().run).toBeNull();
    expect(client.getQueryData(['run-approvals', 'run-a'])).toEqual({ items: [approval] });
  });

  it('refreshes approvals and the expert conversation list after normal SSE completion', async () => {
    await mount(ChatProbe);
    const approval = {
      id: 'approval-a',
      serverId: 'server-a',
      serverName: 'A',
      toolName: 'write',
      approvedAt: null,
      createdAt: '',
    };
    vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-a',
      conversationId: 'conversation-a',
    });
    vi.mocked(api.conversations).mockResolvedValue({
      supported: true,
      items: [{ ...history.conversation, updatedAt: 'now' }],
    });
    await act(async () => {
      useChatStore.getState().setInput('prompt');
      await stream.send();
    });
    await flush();
    expect(client.getQueryData(['conversations', 'agent-a'])).toMatchObject({
      items: [{ id: 'conversation-a' }],
    });
    vi.mocked(api.runApprovals).mockResolvedValue({ items: [approval] });
    const before = vi.mocked(api.conversations).mock.calls.length;
    await act(async () => Source.instances[0]?.emit({ type: 'run_finished', status: 'failed' }));
    await flush();
    expect(client.getQueryData(['run-approvals', 'run-a'])).toEqual({ items: [approval] });
    expect(vi.mocked(api.conversations).mock.calls.length).toBe(before + 1);
  });
});
