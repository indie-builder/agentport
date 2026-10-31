import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type ConversationDetail, type RunDetail } from '../src/lib/api.js';
import { mergeOlderHistory } from '../src/lib/chat-state.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { useConversation } from '../src/lib/queries.js';
import { useChatStream } from '../src/lib/use-chat-stream.js';

vi.mock('@agentport/shared', async () => import('../../shared/src/index.js'));
vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

type Message = ConversationDetail['messages'][number];

const conversation = { id: 'conversation-a', agentId: 'agent-a', title: '', createdAt: '' };

function detail(messages: Message[]): ConversationDetail {
  return { conversation, messages, runMetrics: [], nextBefore: null };
}

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  runId: string | null,
): Message {
  return {
    id,
    conversationId: conversation.id,
    role,
    content: role === 'user' ? text : [{ type: 'text', text }],
    runId,
    createdAt: `2026-01-01T00:00:${id.replace(/\D/g, '').padStart(2, '0')}Z`,
  };
}

function run(status: RunDetail['run']['status'], id = 'run-a'): RunDetail {
  return {
    run: {
      id,
      conversationId: conversation.id,
      agentId: 'agent-a',
      agentName: 'A',
      status,
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
    conversation: { id: conversation.id, agentId: 'agent-a', title: '' },
    steps: [],
  };
}

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let client: QueryClient;
let root: Root;
let stream: ReturnType<typeof useChatStream>;
let readConversation: ReturnType<typeof vi.spyOn<typeof api, 'conversation'>>;
let readRun: ReturnType<typeof vi.spyOn<typeof api, 'run'>>;

function visibleTexts(): string[] {
  return useChatStore
    .getState()
    .items.flatMap((item) => (item.kind === 'user' || item.kind === 'text' ? [item.text] : []));
}

function Probe() {
  const history = useConversation(conversation.id);
  stream = useChatStream({ agentId: 'agent-a', onAccepted() {}, history });
  return null;
}

async function flush(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await flush(5);
  }
  throw new Error(`等待超时：${label}`);
}

async function mount() {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await flush();
}

beforeEach(() => {
  sessionStorage.clear();
  useChatStore.getState().reset();
  useChatStore.getState().setConversationId(conversation.id);
  Source.instances = [];
  vi.stubGlobal('EventSource', Source);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  readConversation = vi.spyOn(api, 'conversation');
  readRun = vi.spyOn(api, 'run');
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  sessionStorage.clear();
  useChatStore.getState().reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('merging older pages after recovery', () => {
  it('keeps the replayed final answer when an active run finishes before older pages load', async () => {
    // 本 run 跨页：最新页只有助手半截回答，本轮用户消息与旧轮都在更早页。
    const latestPage: ConversationDetail = {
      ...detail([
        message('message-4', 'assistant', '旧的半截回答一', 'run-a'),
        message('message-5', 'assistant', '旧的半截回答二', 'run-a'),
      ]),
      nextBefore: 'message-4',
    };
    const olderPage = detail([
      message('message-1', 'user', '旧问题', 'run-old'),
      message('message-2', 'assistant', '旧回答', 'run-old'),
      message('message-3', 'user', '本轮问题', 'run-a'),
    ]);
    readConversation.mockImplementation(async (_id, options) => {
      if (options?.before === undefined) return latestPage;
      if (options.before === 'message-4') return olderPage;
      return detail([]);
    });
    readRun.mockResolvedValue(run('running'));

    await mount();
    await until(() => Source.instances.length === 1, 'event source');
    act(() => {
      const source = Source.instances[0] as Source;
      // 服务端完整回放：终态回答取代刷新时看到的半截内容。
      source.emit({
        type: 'assistant_text',
        text: '最终回答一',
        blockIndex: 0,
        streamBlockId: 'b0',
      });
      source.emit({
        type: 'assistant_text',
        text: '最终回答二',
        blockIndex: 1,
        streamBlockId: 'b1',
      });
      source.emit({ type: 'run_finished', status: 'succeeded' });
    });
    await flush();

    const snapshot = stream.historyPrefix;
    if (snapshot === null) throw new Error('缺少历史快照');
    const merged = mergeOlderHistory(
      snapshot,
      // 翻到更早页后，Query 的合并结果是最早页在前、最新页在后。
      detail([
        message('message-0', 'user', '更早问题', 'run-earlier'),
        ...olderPage.messages,
        ...latestPage.messages,
      ]),
      useChatStore.getState().items,
    );

    // 旧轮补在前面；最终回答保持一份；刷新时看到的半截回答不能复活。
    expect(merged).not.toBeNull();
    expect(
      merged?.items.flatMap((item) =>
        item.kind === 'user' || item.kind === 'text' ? [item.text] : [],
      ),
    ).toEqual(['更早问题', '旧问题', '旧回答', '本轮问题', '最终回答一', '最终回答二']);
  });

  it('keeps both rounds when a later disconnected run is reconciled', async () => {
    const initial = detail([
      message('message-1', 'user', '旧问题', null),
      message('message-2', 'assistant', '旧回答', null),
    ]);
    const secondRunPage = {
      ...detail([message('message-6', 'assistant', '第二轮回答', 'run-2')]),
      nextBefore: 'message-6',
    };
    // 历史查询（含缓存失效后的重取）读旧历史；断线补全读本轮消息。
    let reconciling = false;
    readConversation.mockImplementation(async (_id, options) => {
      if (options?.before === 'message-6') {
        return detail([message('message-5', 'user', '第二轮问题', 'run-2')]);
      }
      if (options?.before === undefined) return reconciling ? secondRunPage : initial;
      return detail([]);
    });
    const sendChat = vi.spyOn(api, 'sendChat');
    sendChat
      .mockResolvedValueOnce({ runId: 'run-1', conversationId: conversation.id })
      .mockResolvedValueOnce({ runId: 'run-2', conversationId: conversation.id });

    await mount();
    await until(() => visibleTexts().includes('旧回答'), 'old history');

    // 第一轮走普通 SSE 完成：只有 items，没有原始消息入库到快照。
    useChatStore.getState().setInput('第一轮问题');
    await act(async () => {
      await stream.send();
    });
    act(() => {
      const source = Source.instances[0] as Source;
      source.emit({ type: 'text_delta', text: '第一轮回答' });
      source.emit({ type: 'run_finished', status: 'succeeded' });
    });
    await flush();

    // 第二轮断线后由服务端终态补全。
    useChatStore.getState().setInput('第二轮问题');
    await act(async () => {
      await stream.send();
    });
    act(() => {
      (Source.instances[1] as Source).emit({ type: 'text_delta', text: '半截回答' });
    });
    reconciling = true;
    await act(async () => {
      await stream.reconcileRun(run('succeeded', 'run-2').run);
    });
    await flush();

    const snapshot = stream.historyPrefix;
    if (snapshot === null) throw new Error('缺少历史快照');
    const merged = mergeOlderHistory(
      snapshot,
      detail([message('message-0', 'user', '更早问题', null), ...initial.messages]),
      useChatStore.getState().items,
    );

    expect(merged).not.toBeNull();
    // 两轮的用户与助手消息各留一份：第一轮没有原始消息，也不能被补旧挤掉。
    expect(
      merged?.items.flatMap((item) =>
        item.kind === 'user' || item.kind === 'text' ? [item.text] : [],
      ),
    ).toEqual([
      '更早问题',
      '旧问题',
      '旧回答',
      '第一轮问题',
      '第一轮回答',
      '第二轮问题',
      '第二轮回答',
    ]);
  });
});

describe('reopening a conversation while its run state is ambiguous', () => {
  it('re-reads history when a suspended run lookup turns out terminal', async () => {
    const initial = detail([message('message-1', 'user', '请回答', 'run-a')]);
    const completed = detail([
      message('message-1', 'user', '请回答', 'run-a'),
      message('message-2', 'assistant', '最终回答', 'run-a'),
    ]);
    let reads = 0;
    readConversation.mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? initial : completed;
    });
    const lookup = deferred<RunDetail>();
    readRun.mockReturnValue(lookup.promise);

    await mount();
    await until(() => vi.mocked(readRun).mock.calls.length === 1, 'run lookup');

    // 服务端在这期间已完成并落库 canonical 助手消息，run 读回终态。
    lookup.resolve(run('succeeded'));
    await flush();

    expect(visibleTexts()).toEqual(['请回答', '最终回答']);
  });

  it('keeps saved history and releases a run that no longer exists', async () => {
    readConversation.mockResolvedValue(
      detail([
        message('message-1', 'user', '问题', 'run-a'),
        message('message-2', 'assistant', '已保存回答', 'run-a'),
      ]),
    );
    readRun.mockRejectedValue(new ApiError(404, '运行不存在', { code: 'NOT_FOUND' }));

    await mount();
    await until(() => visibleTexts().includes('已保存回答'), 'saved history');
    await flush();

    // 历史已经保存了回答：即使运行记录被清理，也要照常显示。
    expect(visibleTexts()).toEqual(['问题', '已保存回答']);
    // 不能再保留一个永远 detached、让页面继续等待/轮询的假运行。
    expect(useChatStore.getState().run).toBeNull();
  });

  it('rebuilds an active run from its own prompt when the loaded page starts mid-reply', async () => {
    // 本轮消息跨页：最新页只有本轮助手尾部，本轮用户消息和旧轮都在更早页。
    const latestPage: ConversationDetail = {
      ...detail([
        message('message-4', 'assistant', '已保存的前半段', 'run-a'),
        message('message-5', 'assistant', '已保存的后半段', 'run-a'),
      ]),
      nextBefore: 'message-4',
    };
    const olderPage = detail([
      message('message-1', 'user', '旧问题', 'run-old'),
      message('message-2', 'assistant', '旧回答', 'run-old'),
      message('message-3', 'user', '本轮问题', 'run-a'),
    ]);
    readConversation.mockImplementation(async (_id, options) => {
      if (options?.before === undefined) return latestPage;
      if (options.before === 'message-4') return olderPage;
      return detail([]);
    });
    readRun.mockResolvedValue(run('running'));

    await mount();
    await until(() => Source.instances.length === 1, 'event source');
    const whileReplaying = visibleTexts();

    act(() => {
      const source = Source.instances[0] as Source;
      // 服务端从头回放本轮事件；恢复时已从更早页补齐本轮用户消息与旧轮。
      source.emit({
        type: 'assistant_text',
        text: '已保存的前半段',
        blockIndex: 0,
        streamBlockId: 'b0',
      });
      source.emit({
        type: 'assistant_text',
        text: '已保存的后半段',
        blockIndex: 1,
        streamBlockId: 'b1',
      });
      source.emit({ type: 'text_delta', text: '新内容', blockIndex: 2, streamBlockId: 'b2' });
      source.emit({ type: 'run_finished', status: 'succeeded' });
    });
    await flush();

    // 建立事件流时已补齐本轮用户边界与旧轮；正在被回放替换的助手尾部不在保证范围内。
    expect(whileReplaying).toEqual(expect.arrayContaining(['旧问题', '旧回答', '本轮问题']));
    // 回放只替换本轮：旧轮、本轮用户、两段已保存助手内容与新增段各出现一次。
    expect(visibleTexts()).toEqual([
      '旧问题',
      '旧回答',
      '本轮问题',
      '已保存的前半段',
      '已保存的后半段',
      '新内容',
    ]);
  });
});
