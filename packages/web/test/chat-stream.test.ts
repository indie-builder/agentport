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

const DRAFTS_KEY = 'pace.chat.drafts';
function savedDrafts(): Record<string, string> {
  return JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, string>;
}

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
    useChatStore.getState().setInput('original message');
    const stream = render();
    await act(async () => {
      await stream.send();
    });
    expect(useChatStore.getState().input).toBe('original message');
    expect(useChatStore.getState().items).toEqual([]);
    expect(useChatStore.getState().run).toBeNull();
    expect(harness.sendChat).not.toHaveBeenCalled();
  });

  it('sends an explicit action without touching the unsent draft', async () => {
    const stream = render();
    useChatStore.getState().setInput('还没发出去的草稿');
    const output = { runId: 'output-run', path: 'report.md' };
    useChatStore.getState().setOutputRef(output);
    const action = {
      type: 'continue_conversation' as const,
      params: { context: { chart: 'revenue' } },
      message: '看这个渠道',
      context: { chart: 'revenue' },
      formState: { booking: { city: { value: '上海' } } },
      formName: 'booking',
      messageId: 'message_1',
      blockKey: 's1',
    };
    await act(async () => {
      await stream.send(action.message, action);
    });

    expect(harness.sendChat).toHaveBeenCalledWith({
      agentId: 'agent-a',
      message: '看这个渠道',
      openuiAction: action,
    });
    // 动作不占输入框：草稿原样保留。
    expect(useChatStore.getState().input).toBe('还没发出去的草稿');
    expect(useChatStore.getState().items).toEqual([
      { kind: 'user', text: '看这个渠道', runId: 'run-a' },
    ]);
    expect(useChatStore.getState().outputRef).toEqual(output);

    await act(async () => {
      sourceAt(-1).emit({ type: 'run_finished', status: 'succeeded' });
      await currentStream.send();
    });
    expect(harness.sendChat).toHaveBeenLastCalledWith({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      message: '还没发出去的草稿',
      output,
    });
    expect(useChatStore.getState().input).toBe('');
    expect(useChatStore.getState().outputRef).toBeNull();
  });

  it.each([
    ['新输入', 'B'],
    ['只有空格', ' '],
  ])('请求失败时保留等待期间输入的%s，不用原消息覆盖', async (_label, draft) => {
    const pending = deferredSend();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    expect(useChatStore.getState().input).toBe('');
    useChatStore.getState().setInput(draft);
    pending.reject(new Error('request failed'));
    await sending;
    expect(useChatStore.getState().input).toBe(draft);
  });

  it('请求失败且没有新草稿时恢复原消息', async () => {
    const pending = deferredSend();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    pending.reject(new Error('request failed'));
    await sending;
    expect(useChatStore.getState().input).toBe('original message');
  });

  it('显式动作失败不回填动作正文，草稿原样保留', async () => {
    const pending = deferredSend();
    const stream = render();
    useChatStore.getState().setInput('还没发出去的草稿');
    const action = { type: 'continue_conversation' as const, params: {}, message: '看这个渠道' };
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send(action.message, action);
    });
    pending.reject(new Error('request failed'));
    await sending;
    expect(useChatStore.getState().input).toBe('还没发出去的草稿');
  });

  it('发送开始后输入框清空，原稿留在原槽直到这次请求被接受', () => {
    const pending = deferredSend();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    expect(useChatStore.getState().input).toBe('');
    expect(savedDrafts()).toEqual({ '': 'original message' });
    void sending;
    void pending;
  });

  it('接受发送时清掉原槽，没有新稿就不留任何草稿', async () => {
    const pending = deferredSend();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    await act(async () => {
      pending.resolve(accepted);
      await sending;
    });
    expect(useChatStore.getState().input).toBe('');
    expect(savedDrafts()).toEqual({});
  });

  it('等待期间写的新稿只迁移到新会话，原稿随接受清掉', async () => {
    const pending = deferredSend();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    useChatStore.getState().setInput('next draft');
    expect(savedDrafts()).toEqual({ '': 'next draft' });
    await act(async () => {
      pending.resolve(accepted);
      await sending;
    });
    expect(useChatStore.getState().conversationId).toBe('conversation-a');
    expect(useChatStore.getState().input).toBe('next draft');
    expect(savedDrafts()).toEqual({ 'conversation-a': 'next draft' });
  });

  it('切走后迟到的接受不改任何草稿，当前 store 对象完全不变', async () => {
    const pending = deferredSend();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    act(() => {
      stream.closeStream();
      useChatStore.getState().resetConversation('conversation-b');
    });
    useChatStore.getState().setInput('draft b');
    const expected = useChatStore.getState();
    await act(async () => {
      pending.resolve(accepted);
      await sending;
    });
    expect(useChatStore.getState()).toBe(expected);
    expect(savedDrafts()).toEqual({ '': 'original message', 'conversation-b': 'draft b' });
  });

  it('失败时按原文（含首尾空白）精确恢复草稿', async () => {
    useChatStore.getState().setInput('  原文  ');
    const pending = deferredSend();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    expect(harness.sendChat).toHaveBeenCalledWith({ agentId: 'agent-a', message: '原文' });
    expect(useChatStore.getState().input).toBe('');
    pending.reject(new Error('request failed'));
    await sending;
    expect(useChatStore.getState().input).toBe('  原文  ');
    expect(savedDrafts()).toEqual({ '': '  原文  ' });
  });

  it('新会话里切换专家不擦掉等待中仍留在原槽的原稿', () => {
    const pending = deferredSend();
    const stream = render();
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });
    expect(useChatStore.getState().input).toBe('');
    act(() => useChatStore.getState().resetConversation(null, true));
    expect(useChatStore.getState().input).toBe('original message');
    expect(savedDrafts()).toEqual({ '': 'original message' });
    void sending;
    void pending;
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
      useChatStore.getState().setInput('original message');
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
      { kind: 'user', text: 'original message', runId: 'run-a' },
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
    expect(useChatStore.getState().items).toEqual([
      { kind: 'user', text: 'original message', runId: 'run-a' },
    ]);
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

/** 会话分页：恢复只读真实会话消息，不再从运行详情伪造步骤。 */
function conversationPage(
  messages: unknown[],
  options: { id?: string; nextBefore?: string | null } = {},
) {
  return {
    conversation: {
      id: options.id ?? 'c1',
      agentId: 'a1',
      title: '',
      createdAt: '',
    },
    messages,
    runMetrics: [],
    nextBefore: options.nextBefore ?? null,
  };
}

function assistantMessage(
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    conversationId: 'c1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    runId: 'r1',
    createdAt: id,
    ...extra,
  };
}

const userMessage: Record<string, unknown> = {
  id: 'u1',
  conversationId: 'c1',
  role: 'user',
  content: { type: 'text', text: 'hi' },
  runId: 'r1',
  createdAt: 'u1',
};

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
  expect(useChatStore.getState().items).toEqual([{ kind: 'user', text: 'hi', runId: 'r1' }]);
  const opened = source();
  expect(opened.url).toBe('/api/chat/r1/events');

  opened.onmessage?.(message({ type: 'text_delta', text: 'yo' }));
  expect(useChatStore.getState().items.at(-1)).toEqual({ kind: 'text', text: 'yo' });

  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  expect(useChatStore.getState().run).toBeNull();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversation', 'c1'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['conversations'] });
  // 没有截断就只用流式结果，不为每次运行多发一次请求。
  expect(apiMock.conversation).not.toHaveBeenCalled();
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
    { kind: 'user', text: 'hi', runId: 'r1' },
    { kind: 'text', text: 'a' },
    { kind: 'notice', tone: 'muted', text: TRUNCATED_NOTICE },
    { kind: 'text', text: 'b' },
  ]);
  expect(apiMock.conversation).not.toHaveBeenCalled();
});

test('terminal_missing 提示未收到结束事件，run_finished 后仍用已保存结果替换', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  apiMock.conversation.mockResolvedValue(
    conversationPage([userMessage, assistantMessage('m2', 'answer')]),
  );
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

  expect(apiMock.conversation).toHaveBeenCalledWith('c1', { limit: 100 });
  const { items } = useChatStore.getState();
  expect(items.some((item) => item.kind === 'text' && item.text === 'partial answer')).toBe(false);
  expect(items.some((item) => item.kind === 'text' && item.text === 'answer')).toBe(true);
});

test('截断后 run_finished 用真实会话消息重建尾部，不重复用户气泡、不丢子文本', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  apiMock.conversation.mockResolvedValue(
    conversationPage([
      userMessage,
      // 同一条 SDK 消息的两块都用 blockIndex 0：只有 blockIndex 不足以区分。
      {
        ...assistantMessage('m2', 'answer'),
        content: [{ type: 'text', text: 'answer', blockIndex: 0 }],
      },
      {
        ...assistantMessage('m3', '子任务输出'),
        content: [{ type: 'text', text: '子任务输出', blockIndex: 0, parentToolUseId: 'tool-1' }],
      },
      {
        id: 'm4',
        conversationId: 'c1',
        role: 'tool',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'search', input: { q: 'x' } },
          { type: 'tool_result', toolUseId: 'tool-1', content: 'ok' },
        ],
        runId: 'r1',
        createdAt: 'm4',
      },
    ]),
  );
  useChatStore.getState().setItems([{ kind: 'text', text: 'old' }]);
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'bytes' }));
  opened.onmessage?.(message({ type: 'text_delta', text: 'partial answer' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();

  expect(apiMock.conversation).toHaveBeenCalledWith('c1', { limit: 100 });
  const { items, lastRun } = useChatStore.getState();
  expect(items[0]).toEqual({ kind: 'text', text: 'old' });
  const users = items.filter((item) => item.kind === 'user');
  // 真实会话消息的用户 id 回填，不再出现运行详情的合成 id。
  expect(users).toEqual([{ id: 'u1:0', kind: 'user', text: 'hi', messageId: 'u1', runId: 'r1' }]);
  expect(items.some((item) => item.kind === 'text' && item.text === 'partial answer')).toBe(false);
  expect(items.find((item) => item.kind === 'text' && item.text === 'answer')).toMatchObject({
    runId: 'r1',
    blockIndex: 0,
  });
  expect(items.find((item) => item.kind === 'text' && item.text === '子任务输出')).toMatchObject({
    parentToolUseId: 'tool-1',
  });
  expect(items.find((item) => item.kind === 'tool')).toMatchObject({
    toolUseId: 'tool-1',
    name: 'search',
    input: '{\n  "q": "x"\n}',
    result: 'ok',
  });
  // 运行读数来自终态事件，不因回读而丢失。
  expect(lastRun).toMatchObject({ runId: 'r1', status: 'succeeded' });
});

test('截断恢复按 runId 翻页直到本 run 完整，不无限拉更早历史', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  apiMock.conversation
    .mockResolvedValueOnce(
      conversationPage([assistantMessage('m3', '后半段')], { nextBefore: 'm3' }),
    )
    .mockResolvedValueOnce(
      conversationPage([userMessage, assistantMessage('m2', '前半段')], { nextBefore: 'u1' }),
    );
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'bytes' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();

  expect(apiMock.conversation).toHaveBeenCalledTimes(2);
  expect(apiMock.conversation).toHaveBeenLastCalledWith('c1', { limit: 100, before: 'm3' });
  expect(useChatStore.getState().items.map((item) => ('text' in item ? item.text : ''))).toEqual([
    'hi',
    '前半段',
    '后半段',
  ]);
});

test('切换会话后迟到的恢复结果被丢弃', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const recovery = deferred<unknown>();
  apiMock.conversation.mockReturnValue(recovery.promise);
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  expect(apiMock.conversation).toHaveBeenCalledWith('c1', { limit: 100 });

  hook.closeStream();
  useChatStore.getState().resetConversation('other');
  recovery.resolve(conversationPage([assistantMessage('m2', 'late')]));
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
  apiMock.conversation.mockReturnValue(recovery.promise);
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

  recovery.resolve(conversationPage([assistantMessage('m2', 'stale')]));
  await settle();

  expect(useChatStore.getState().items).toBe(afterSend);
  expect(useChatStore.getState().items.at(-1)).toEqual({ kind: 'user', text: 'next' });
});

test('恢复等待期间加载的更早历史不会被旧发送快照覆盖', async () => {
  apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
  const recovery = deferred<unknown>();
  apiMock.conversation.mockReturnValue(recovery.promise);
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
  recovery.resolve(conversationPage([userMessage, assistantMessage('m2', '完整回答')]));
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
  apiMock.conversation.mockRejectedValue(new Error('boom'));
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
  apiMock.conversation.mockResolvedValue(conversationPage([userMessage]));
  const hook = render('a1');
  await startRun(hook);
  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'text_delta', text: '仍有价值的部分回答' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();
  const { items } = useChatStore.getState();
  expect(items.filter((item) => item.kind === 'user')).toEqual([
    { kind: 'user', text: 'hi', runId: 'r1' },
  ]);
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
  apiMock.conversation.mockResolvedValue(conversationPage([]));
  const hook = render('a1');
  await startRun(hook);

  const opened = source();
  opened.onmessage?.(message({ type: 'replay_truncated', reason: 'retention' }));
  opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
  await settle();

  const { items } = useChatStore.getState();
  expect(items.filter((item) => item.kind === 'user')).toEqual([
    { kind: 'user', text: 'hi', runId: 'r1' },
  ]);
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
    { kind: 'user', text: 'hi', runId: 'r1' },
    { kind: 'text', text: 'partial' },
    { kind: 'notice', tone: 'error', text: '运行记录已不存在，已停止接收。' },
  ]);
  expect(opened.closed).toBe(true);
  expect(state.run).toBeNull();
  expect(state.lastRun).toBeNull();
  expect(state.lastRunId).toBeNull();
  // 记录已经不存在：不回读已保存结果，也不凭空补运行读数。
  expect(apiMock.conversation).not.toHaveBeenCalled();
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

describe('run_finished 回填', () => {
  const openUiProgram = '先说明\n\n```openui\nroot = Card([])\n```';

  async function streamBlocks() {
    apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
    const hook = render('a1');
    await startRun(hook, '两个块');
    const opened = source();
    // 两条独立 SDK 消息都从 blockIndex 0 开始，只有 streamBlockId 能区分。
    opened.onmessage?.(
      message({ type: 'text_delta', text: '第一段', blockIndex: 0, streamBlockId: 'b0' }),
    );
    opened.onmessage?.(
      message({ type: 'assistant_text', text: '第一段', blockIndex: 0, streamBlockId: 'b0' }),
    );
    opened.onmessage?.(
      message({
        type: 'text_delta',
        text: '子文本',
        blockIndex: 0,
        streamBlockId: 'b1',
        parentToolUseId: 'tool-1',
      }),
    );
    opened.onmessage?.(
      message({
        type: 'assistant_text',
        text: '子文本',
        blockIndex: 0,
        streamBlockId: 'b1',
        parentToolUseId: 'tool-1',
      }),
    );
    return opened;
  }

  test('同 blockIndex 的两条消息按 streamBlockId 各得自己的 id 与 canonical', async () => {
    const opened = await streamBlocks();
    opened.onmessage?.(
      message({
        type: 'run_finished',
        status: 'succeeded',
        messageIds: [
          {
            id: 'm2',
            blockIndex: 0,
            streamBlockId: 'b0',
            uiFormat: 'openui',
            uiProgram: openUiProgram,
          },
          {
            id: 'm3',
            blockIndex: 0,
            streamBlockId: 'b1',
            parentToolUseId: 'tool-1',
            uiFormat: 'markdown',
            uiProgram: null,
          },
        ],
      }),
    );

    const texts = useChatStore.getState().items.filter((item) => item.kind === 'text');
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatchObject({
      text: '第一段',
      id: 'm2',
      messageId: 'm2',
      runId: 'r1',
      uiFormat: 'openui',
      uiProgram: openUiProgram,
    });
    expect(texts[1]).toMatchObject({
      text: '子文本',
      parentToolUseId: 'tool-1',
      id: 'm3',
      messageId: 'm3',
      runId: 'r1',
      uiFormat: 'markdown',
    });
    expect(texts[1]).not.toHaveProperty('uiProgram');
  });

  test('canonical 快照能替换流式原文，终态后不再按流式段渲染', async () => {
    const opened = await streamBlocks();
    opened.onmessage?.(
      message({
        type: 'run_finished',
        status: 'succeeded',
        messageIds: [
          {
            id: 'm2',
            blockIndex: 0,
            streamBlockId: 'b0',
            uiFormat: 'openui',
            uiProgram: openUiProgram,
            uiState: { version: 1, blocks: { s0: { query: 'x' } } },
          },
        ],
      }),
    );
    const item = useChatStore.getState().items.find((entry) => entry.kind === 'text');
    expect(item).toMatchObject({ uiProgram: openUiProgram });
    expect(item).toMatchObject({ uiState: { version: 1, blocks: { s0: { query: 'x' } } } });
  });

  test('没有稳定 id 的旧事件按父调用与块序号顺序配对', async () => {
    apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
    const hook = render('a1');
    await startRun(hook, 'legacy');
    const opened = source();
    opened.onmessage?.(message({ type: 'text_delta', text: '主文本', blockIndex: 0 }));
    opened.onmessage?.(message({ type: 'assistant_text', text: '主文本', blockIndex: 0 }));
    opened.onmessage?.(
      message({ type: 'text_delta', text: '子文本', blockIndex: 0, parentToolUseId: 'tool-1' }),
    );
    opened.onmessage?.(
      message({
        type: 'assistant_text',
        text: '子文本',
        blockIndex: 0,
        parentToolUseId: 'tool-1',
      }),
    );
    opened.onmessage?.(
      message({
        type: 'run_finished',
        status: 'succeeded',
        messageIds: [
          { id: 'm2', blockIndex: 0, uiFormat: 'openui', uiProgram: 'root = Card([])' },
          {
            id: 'm3',
            blockIndex: 0,
            parentToolUseId: 'tool-1',
            uiFormat: 'markdown',
            uiProgram: null,
          },
        ],
      }),
    );
    const texts = useChatStore.getState().items.filter((item) => item.kind === 'text');
    expect(texts.map((item) => ('messageId' in item ? item.messageId : undefined))).toEqual([
      'm2',
      'm3',
    ]);
  });

  test('没有块元数据时不猜测消息 id', async () => {
    apiMock.sendChat.mockResolvedValue({ runId: 'r1', conversationId: 'c1' });
    const hook = render('a1');
    await startRun(hook, 'plain');
    const opened = source();
    opened.onmessage?.(message({ type: 'text_delta', text: '普通回答' }));
    opened.onmessage?.(message({ type: 'run_finished', status: 'succeeded' }));
    expect(useChatStore.getState().items).toEqual([
      { kind: 'user', text: 'plain', runId: 'r1' },
      { kind: 'text', text: '普通回答', runId: 'r1' },
    ]);
  });
});
