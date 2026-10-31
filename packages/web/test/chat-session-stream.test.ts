import { QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChatAccepted, type ConversationDetail } from '../src/lib/api.js';
import { bindChatIdentity, useChatStore } from '../src/lib/chat-store.js';
import { logoutAccount, meQuery, queryClient } from '../src/lib/queries.js';
import { useChatStream } from '../src/lib/use-chat-stream.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('../src/lib/api.js', async (original) => {
  const actual = await original<typeof import('../src/lib/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      me: vi.fn(),
      logout: vi.fn(),
      sendChat: vi.fn(),
      conversation: vi.fn(),
    },
  };
});

const DRAFTS_KEY = 'pace.chat.drafts';
const accepted: ChatAccepted = { runId: 'run-a', conversationId: 'conversation-a' };
const savedRecovery: ConversationDetail = {
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: '', createdAt: '' },
  messages: [
    {
      id: 'message-a',
      conversationId: 'conversation-a',
      role: 'assistant',
      content: 'PRIVATE A ANSWER',
      runId: 'run-a',
      createdAt: '',
    },
  ],
  runMetrics: [],
  nextBefore: null,
};

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

let root: Root;
let stream: ReturnType<typeof useChatStream>;

function Probe() {
  stream = useChatStream({ agentId: 'agent-a', onAccepted() {} });
  return null;
}

function render() {
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
}

function authenticated(businessId: string) {
  return {
    authenticated: true as const,
    user: { businessId, username: businessId, name: businessId },
    roles: [],
    grants: [],
  };
}

async function confirm(businessId: string) {
  vi.mocked(api.me).mockResolvedValueOnce(authenticated(businessId));
  await act(async () => {
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
  });
}

function savedDrafts(): Record<string, string> {
  return JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, string>;
}

async function startRun() {
  vi.mocked(api.sendChat).mockResolvedValueOnce(accepted);
  render();
  useChatStore.getState().setInput('A prompt');
  await act(async () => {
    await stream.send();
  });
  const source = Source.instances[0];
  if (!source) throw new Error('Expected the run event stream');
  return source;
}

beforeEach(() => {
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  queryClient.clear();
  sessionStorage.clear();
  useChatStore.getState().reset();
  bindChatIdentity('A');
  Source.instances = [];
  vi.stubGlobal('EventSource', Source);
  vi.mocked(api.me).mockReset();
  vi.mocked(api.logout).mockReset();
  vi.mocked(api.sendChat).mockReset();
  vi.mocked(api.conversation).mockReset();
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  sessionStorage.clear();
  useChatStore.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chat account switch while the stream stays mounted', () => {
  it('closes the old source and ignores its late events when /me confirms another account', async () => {
    const source = await startRun();

    await confirm('B');

    expect(source.closed).toBe(true);
    expect(useChatStore.getState()).toMatchObject({
      conversationId: null,
      items: [],
      input: '',
      run: null,
      lastRunId: null,
    });
    expect(savedDrafts()).toEqual({});

    await act(async () => {
      source.emit({ type: 'text_delta', text: 'PRIVATE A ANSWER' });
    });
    expect(useChatStore.getState().items).toEqual([]);
  });

  it('does not restore the old account draft when its send fails after the switch', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.sendChat).mockReturnValueOnce(
      new Promise<ChatAccepted>((_resolve, no) => {
        reject = no;
      }),
    );
    render();
    useChatStore.getState().setInput('PRIVATE A DRAFT');
    let sending!: Promise<void>;
    act(() => {
      sending = stream.send();
    });

    await confirm('B');
    expect(useChatStore.getState().input).toBe('');

    await act(async () => {
      reject(new Error('offline'));
      await sending;
    });
    expect(useChatStore.getState().input).toBe('');
    expect(savedDrafts()).toEqual({});
    expect(Source.instances).toHaveLength(0);
  });

  it('ignores a recovery response that arrives after the switch', async () => {
    const source = await startRun();
    let settleRecovery!: (detail: ConversationDetail) => void;
    vi.mocked(api.conversation).mockReturnValueOnce(
      new Promise<ConversationDetail>((resolve) => {
        settleRecovery = resolve;
      }),
    );

    // 截断后的 run_finished 会用落库消息异步重建尾部。
    await act(async () => {
      source.emit({ type: 'replay_truncated', reason: 'bytes' });
      source.emit({ type: 'run_finished', status: 'succeeded' });
    });

    await confirm('B');
    expect(useChatStore.getState().items).toEqual([]);

    await act(async () => {
      settleRecovery(savedRecovery);
    });
    expect(useChatStore.getState().items).toEqual([]);
    expect(useChatStore.getState().input).toBe('');
  });

  it('revokes the old source synchronously when the confirmed identity binds another account', async () => {
    const source = await startRun();

    act(() => {
      // 真实 meQuery 的 queryFn 在返回身份前同步调用这个绑定。
      bindChatIdentity('B');
      // 断言在 act 回调内：不依赖 React effect 或计时器稍后生效。
      expect(source.closed).toBe(true);
      expect(useChatStore.getState()).toMatchObject({
        conversationId: null,
        items: [],
        input: '',
        run: null,
        lastRunId: null,
      });
    });
  });

  it('revokes the mounted source, retry timer and late events on explicit sign-out', async () => {
    const source = await startRun();
    vi.mocked(api.logout).mockResolvedValue({ ok: true });
    vi.useFakeTimers();
    try {
      // 断线已进入有限重连，计时器尚未触发。
      act(() => source.onerror?.());
      expect(Source.instances).toHaveLength(1);

      // app-shell 的两个显式退出入口都走这个共享清理；401/改密不走这里。
      await act(async () => {
        await logoutAccount();
      });
      expect(source.closed).toBe(true);
      expect(useChatStore.getState()).toMatchObject({
        conversationId: null,
        items: [],
        input: '',
        run: null,
        lastRunId: null,
      });

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(Source.instances).toHaveLength(1);

      await act(async () => {
        source.emit({ type: 'text_delta', text: 'PRIVATE A ANSWER' });
      });
      expect(useChatStore.getState().items).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the live stream and draft when /me confirms the same account', async () => {
    const source = await startRun();

    await confirm('A');

    expect(source.closed).toBe(false);
    expect(useChatStore.getState().conversationId).toBe('conversation-a');
    expect(useChatStore.getState().run).not.toBeNull();

    await act(async () => {
      source.emit({ type: 'text_delta', text: 'still A' });
    });
    expect(JSON.stringify(useChatStore.getState().items)).toContain('still A');
  });
});
