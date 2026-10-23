import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import type { ChatAccepted, RunDetail } from '../src/lib/api.js';

let root: Root;
let client: QueryClient;
const harness = vi.hoisted(() => ({
  sendChat: vi.fn(),
  conversation: vi.fn(),
  run: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@agentport/shared', async () => import('../../shared/src/index.js'));
vi.mock('../src/lib/api.js', async (original) => ({
  ...(await original<typeof import('../src/lib/api.js')>()),
  api: { sendChat: harness.sendChat, conversation: harness.conversation, run: harness.run },
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
function deferredSend() {
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
  harness.run.mockReset();
  invalidate = vi.spyOn(client, 'invalidateQueries');
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
    const pending = deferredSend();
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
    const pending = deferredSend();
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
    const pending = deferredSend();
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

const TRUNCATED_NOTICE = '较早事件已截断，运行结束后将读取已保存结果。';
const apiMock = harness;
const toastMock = harness;
const events = { FakeEventSource: Source };
let invalidate: ReturnType<typeof vi.spyOn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function message(event: unknown): { data: string } {
  return { data: JSON.stringify(event) };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function startRun(hook: ReturnType<typeof useChatStream>, text = 'hi'): Promise<void> {
  useChatStore.getState().setInput(text);
  await act(async () => {
    await hook.send();
  });
}

function source(): Source {
  return sourceAt(-1);
}

test('丢弃等待期间已离开的运行：不写 store、不回调、不开流', async () => {
  const pending = deferred<ChatAccepted>();
  apiMock.sendChat.mockReturnValue(pending.promise);
  useChatStore.getState().setInput('hello');
  const onAccepted = vi.fn();
  const hook = render('a1', onAccepted);

  const sending = hook.send();
  expect(useChatStore.getState().run?.status).toBe('queued');

  // 等待期间切换会话：关闭流并清空状态。
  hook.closeStream();
  useChatStore.getState().resetConversation('other');

  pending.resolve({ runId: 'r1', conversationId: 'c1' });
  await sending;

  expect(onAccepted).not.toHaveBeenCalled();
  expect(events.FakeEventSource.instances).toHaveLength(0);
  expect(useChatStore.getState()).toMatchObject({
    conversationId: 'other',
    items: [],
    run: null,
    lastRunId: null,
  });
});

test('正常接受：保留用户气泡，开流，run_finished 后失效缓存且不请求运行详情', async () => {
  const pending = deferred<ChatAccepted>();
  apiMock.sendChat.mockReturnValue(pending.promise);
  useChatStore.getState().setInput('hi');
  const onAccepted = vi.fn();
  const hook = render('a1', onAccepted);

  const sending = hook.send();
  expect(apiMock.sendChat).toHaveBeenCalledWith({ agentId: 'a1', message: 'hi' });
  pending.resolve({ runId: 'r1', conversationId: 'c1' });
  await sending;

  expect(onAccepted).toHaveBeenCalledWith({ runId: 'r1', conversationId: 'c1' }, 'hi');
  expect(useChatStore.getState().items).toEqual([{ kind: 'user', text: 'hi' }]);
  const opened = source();
  expect(opened.url).toBe('/api/chat/r1/events');

  opened.onmessage?.(message({ type: 'text_delta', text: 'yo' }));
  expect(useChatStore.getState().items.at(-1)).toEqual({ kind: 'text', text: 'yo' });

  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  expect(useChatStore.getState().run).toBeNull();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversation', 'c1'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations'] });
  // 没有截断就只用流式结果，不为每次运行多发一次请求。
  expect(apiMock.run).not.toHaveBeenCalled();
});

test('replay_truncated 只追加 muted 通知，不改写回答文本，也不断流', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'text_delta', text: 'a' }));
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  // 通知之后的事件仍然生效：SSE 没有断开，回答文本没有被改写。
  opened.onmessage?.(message({ type: 'text_delta', text: 'b' }));

  expect(useChatStore.getState().items).toEqual([
    { kind: 'user', text: 'hi' },
    { kind: 'text', text: 'a' },
    { kind: 'notice', tone: 'muted', text: TRUNCATED_NOTICE },
    { kind: 'text', text: 'b' },
  ]);
  expect(apiMock.run).not.toHaveBeenCalled();
});

test('terminal_missing 提示未收到结束事件，run_finished 后仍用已保存结果替换', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  apiMock.run.mockResolvedValue({
    steps: [
      { kind: 'user', at: 't1', text: 'hi' },
      { kind: 'assistant', at: 't2', text: 'answer' },
    ],
    run: {},
    conversation: {},
  });
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'terminal_missing' }));
  expect(useChatStore.getState().items.at(-1)).toEqual({
    kind: 'notice',
    tone: 'muted',
    text: '结束事件未收到，正在读取已保存结果。',
  });

  opened.onmessage?.(message({ type: 'text_delta', text: 'partial answer' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();

  expect(apiMock.run).toHaveBeenCalledWith('r1');
  const { items } = useChatStore.getState();
  expect(items.some((item) => item.kind === 'text' && item.text === 'partial answer')).toBe(false);
  expect(items.some((item) => item.kind === 'text' && item.text === 'answer')).toBe(true);
});

test('截断后 run_finished 用已保存步骤重建尾部，不重复用户气泡', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  apiMock.run.mockResolvedValue({
    steps: [
      { kind: 'user', at: 't1', text: 'hi' },
      { kind: 'assistant', at: 't2', text: 'answer' },
      {
        kind: 'tool',
        at: 't3',
        name: 'search',
        toolUseId: 'tool-1',
        content: { q: 'x' },
        result: 'ok',
        parentToolUseId: 'parent-1',
      },
    ],
    run: { id: 'r1' },
    conversation: { id: 'c1', agentId: 'a1', title: '' },
  });
  useChatStore.getState().setItems([{ kind: 'text', text: 'old' }]);
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'bytes' }));
  opened.onmessage?.(message({ type: 'text_delta', text: 'partial answer' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();

  expect(apiMock.run).toHaveBeenCalledWith('r1');
  const { items, lastRun } = useChatStore.getState();
  expect(items[0]).toEqual({ kind: 'text', text: 'old' });
  const users = items.filter((item) => item.kind === 'user');
  expect(users).toEqual([{ id: 'r1:0:0', kind: 'user', text: 'hi' }]);
  expect(items.some((item) => item.kind === 'text' && item.text === 'partial answer')).toBe(false);
  expect(items.some((item) => item.kind === 'text' && item.text === 'answer')).toBe(true);
  expect(items.find((item) => item.kind === 'tool')).toMatchObject({
    toolUseId: 'tool-1',
    name: 'search',
    input: '{\n  "q": "x"\n}',
    result: 'ok',
    parentToolUseId: 'parent-1',
  });
  // 运行读数来自终态事件，不因回读而丢失。
  expect(lastRun).toMatchObject({ runId: 'r1', status: 'succeeded' });
});

test('切换会话后迟到的恢复结果被丢弃', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const recovery = deferred<unknown>();
  apiMock.run.mockReturnValue(recovery.promise);
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  expect(apiMock.run).toHaveBeenCalledWith('r1');

  hook.closeStream();
  useChatStore.getState().resetConversation('other');
  recovery.resolve({
    steps: [{ kind: 'assistant', at: 't2', text: 'late' }],
    run: {},
    conversation: {},
  });
  await settle();

  expect(useChatStore.getState()).toMatchObject({
    conversationId: 'other',
    items: [],
    run: null,
    lastRunId: null,
  });
});

test('新一轮发送开始后，上一轮的恢复结果不能改写当前会话', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const recovery = deferred<unknown>();
  apiMock.run.mockReturnValue(recovery.promise);
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'text_delta', text: 'partial' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));

  // 第二次发送停在 queued：此时 run 非空，旧恢复结果必须丢弃。
  apiMock.sendChat.mockReturnValue(new Promise(() => {}));
  useChatStore.getState().setInput('next');
  void hook.send();
  const afterSend = useChatStore.getState().items;
  expect(useChatStore.getState().run?.status).toBe('queued');

  recovery.resolve({
    steps: [{ kind: 'assistant', at: 't2', text: 'stale' }],
    run: {},
    conversation: {},
  });
  await settle();

  expect(useChatStore.getState().items).toBe(afterSend);
  expect(useChatStore.getState().items.at(-1)).toEqual({ kind: 'user', text: 'next' });
});

test('恢复等待期间加载的更早历史不会被旧发送快照覆盖', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const recovery = deferred<unknown>();
  apiMock.run.mockReturnValue(recovery.promise);
  useChatStore.getState().setItems([{ id: 'old:0', kind: 'text', text: '已加载历史' }]);
  const hook = render('a1');
  await startRun(hook);
  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'text_delta', text: 'partial' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  useChatStore
    .getState()
    .setItems((previous) => [
      { id: 'earlier:0', kind: 'text', text: '刚加载的更早历史' },
      ...previous,
    ]);
  recovery.resolve({
    steps: [
      { kind: 'user', at: 't1', text: 'hi' },
      { kind: 'assistant', at: 't2', text: '完整回答' },
    ],
    run: {},
    conversation: {},
  });
  await settle();
  expect(useChatStore.getState().items.map((item) => ('text' in item ? item.text : ''))).toEqual([
    '刚加载的更早历史',
    '已加载历史',
    'hi',
    '完整回答',
  ]);
});

test('恢复失败保留部分输出，并明确提示无法读取已保存结果', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  apiMock.run.mockRejectedValue(new Error('boom'));
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'text_delta', text: 'partial' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();

  const { items, run, lastRun } = useChatStore.getState();
  expect(run).toBeNull();
  expect(lastRun).toMatchObject({ runId: 'r1' });
  expect(items.some((item) => item.kind === 'text' && item.text === 'partial')).toBe(true);
  expect(items.at(-1)).toEqual({
    kind: 'notice',
    tone: 'error',
    text: '无法读取已保存结果，请刷新后重试。',
  });
});

test('仅保存用户消息时保留部分回答并提示输出未保存', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  apiMock.run.mockResolvedValue({
    steps: [{ kind: 'user', at: 't1', text: 'hi' }],
    run: {},
    conversation: {},
  });
  const hook = render('a1');
  await startRun(hook);
  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'text_delta', text: '仍有价值的部分回答' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();
  const { items } = useChatStore.getState();
  expect(items.filter((item) => item.kind === 'user')).toEqual([{ kind: 'user', text: 'hi' }]);
  expect(items.some((item) => item.kind === 'text' && item.text === '仍有价值的部分回答')).toBe(
    true,
  );
  expect(items.at(-1)).toEqual({
    kind: 'notice',
    tone: 'muted',
    text: '运行已结束，未找到已保存结果，请查看运行详情。',
  });
});

test('已保存步骤为空时保留部分输出，不冒充完整结果', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  apiMock.run.mockResolvedValue({ steps: [], run: {}, conversation: {} });
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();

  const { items } = useChatStore.getState();
  expect(items.filter((item) => item.kind === 'user')).toEqual([{ kind: 'user', text: 'hi' }]);
  expect(items.at(-1)).toEqual({
    kind: 'notice',
    tone: 'muted',
    text: '运行已结束，未找到已保存结果，请查看运行详情。',
  });
});

test('已关闭的流迟到的消息不能改写状态，也不能触发缓存失效', async () => {
  const pending = deferred<ChatAccepted>();
  apiMock.sendChat.mockReturnValue(pending.promise);
  useChatStore.getState().setInput('hi');
  const hook = render('a1');

  const sending = hook.send();
  pending.resolve({ runId: 'r1', conversationId: 'c1' });
  await sending;
  const opened = source();

  hook.closeStream();
  useChatStore.getState().resetConversation('other');
  invalidate.mockClear();

  opened.onmessage?.(message({ type: 'text_delta', text: 'late' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));

  expect(useChatStore.getState()).toMatchObject({ conversationId: 'other', items: [], run: null });
  expect(invalidate).not.toHaveBeenCalled();
});

test('run_unavailable 结束本轮：保留部分输出并释放 run，不重连', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'text_delta', text: 'partial' }));
  opened.onmessage?.(
    message({ type: 'run_unavailable', message: '运行记录已不存在，已停止接收。' }),
  );

  const state = useChatStore.getState();
  expect(state.items).toEqual([
    { kind: 'user', text: 'hi' },
    { kind: 'text', text: 'partial' },
    { kind: 'notice', tone: 'error', text: '运行记录已不存在，已停止接收。' },
  ]);
  expect(opened.closed).toBe(true);
  expect(state.run).toBeNull();
  expect(state.lastRun).toBeNull();
  expect(state.lastRunId).toBeNull();
  // 记录已经不存在：不回读已保存结果，也不凭空补运行读数。
  expect(apiMock.run).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversation', 'c1'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations'] });

  opened.onerror?.();
  expect(events.FakeEventSource.instances).toHaveLength(1);
  expect(useChatStore.getState()).toMatchObject({ run: null, lastRun: null });
});

test('run_unavailable 后可以继续发送，旧流迟到的事件不污染新一轮', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const hook = render('a1');
  await startRun(hook);
  const first = source();
  first.onmessage?.(message({ type: 'text_delta', text: 'partial' }));
  first.onmessage?.(
    message({ type: 'run_unavailable', message: '运行记录已不存在，已停止接收。' }),
  );

  apiMock.sendChat.mockResolvedValue({ runId: 'r2', conversationId: 'c1' });
  await startRun(hook, 'again');
  expect(apiMock.sendChat).toHaveBeenCalledTimes(2);
  const second = source();
  expect(second).not.toBe(first);
  expect(second.url).toBe('/api/chat/r2/events');

  first.onmessage?.(message({ type: 'text_delta', text: 'late' }));
  second.onmessage?.(message({ type: 'text_delta', text: 'next' }));
  expect(
    useChatStore
      .getState()
      .items.filter((item) => item.kind === 'text')
      .map((item) => item.text),
  ).toEqual(['partial', 'next']);
});

test('error 事件仍只是通知：断流后标记 detached，不结束本轮', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'error', message: '工具失败' }));
  expect(useChatStore.getState().run?.status).toBe('streaming');

  opened.onerror?.();
  expect(useChatStore.getState().run?.status).toBe('detached');
  expect(events.FakeEventSource.instances).toHaveLength(1);
  expect(useChatStore.getState().lastRun).toBeNull();
});

test('离开后请求失败：不恢复旧输入、不追加错误通知', async () => {
  const pending = deferred<ChatAccepted>();
  apiMock.sendChat.mockReturnValue(pending.promise);
  useChatStore.getState().setInput('old');
  const hook = render('a1');

  const sending = hook.send();
  hook.closeStream();
  useChatStore.getState().resetConversation('other');
  useChatStore.getState().setInput('draft');

  pending.reject(new Error('boom'));
  await sending;

  expect(useChatStore.getState()).toMatchObject({
    conversationId: 'other',
    input: 'draft',
    items: [],
    run: null,
  });
  expect(toastMock.toastError).not.toHaveBeenCalled();
});
