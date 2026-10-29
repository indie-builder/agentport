import { ATTACHMENT_LIMITS, agentInputSchema } from '@agentport/shared';
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
import { z } from 'zod';
import { api, type ChatAccepted, type ConversationDetail } from '../src/lib/api.js';
import { historyToItems } from '../src/lib/chat-state.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { ChatPage } from '../src/pages/chat.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'agent-a',
  parentId: null,
  createdAt: '',
  updatedAt: '',
};
const other = {
  ...agentInputSchema.parse({ slug: 'other', name: 'Other Expert' }),
  id: 'agent-b',
  parentId: null,
  createdAt: '',
  updatedAt: '',
};

const attachmentId = '11111111-1111-4111-8111-111111111111';

function conversationDetail(
  id: string,
  messages: ConversationDetail['messages'] = [],
): ConversationDetail {
  return {
    conversation: { id, agentId: 'agent-a', title: id, createdAt: '' },
    runMetrics: [],
    nextBefore: null,
    messages,
  };
}

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

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof makeRouter>;

function deferredSend() {
  let resolve!: (accepted: ChatAccepted) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ChatAccepted>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  vi.spyOn(api, 'sendChat').mockReturnValue(promise);
  return { resolve, reject };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function makeRouter(initialEntry: string) {
  const route = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => route, id: '_shell', component: Outlet });
  const chat = createRoute({
    getParentRoute: () => shell,
    path: '/chat',
    validateSearch: z.object({
      agent: z.string().min(1).optional().catch(undefined),
      conversation: z.string().min(1).optional().catch(undefined),
    }),
    component: ChatPage,
  });
  return createRouter({
    routeTree: route.addChildren([shell.addChildren([chat])]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

async function mount(initialEntry = '/chat?agent=agent-a&conversation=conversation-a') {
  router = makeRouter(initialEntry);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

function fileInput() {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing file input');
  return input;
}

async function chooseFiles(...files: File[]) {
  const input = fileInput();
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await flush();
}

function sendButton() {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]');
  if (!button) throw new Error('Missing send button');
  return button;
}

async function send() {
  await act(async () => sendButton().click());
  await flush();
}

function fileOf(name: string, content = 'hello', type = '') {
  return new File([content], name, { type });
}

/** 只改 size 属性，不为超限校验真的分配大文件。 */
function sizedFile(name: string, size: number, type = '') {
  const file = fileOf(name, 'x', type);
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

function alertText(): string | null {
  return host.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  useChatStore.getState().reset();
  sessionStorage.clear();
  Source.instances = [];
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['agents'], [agent, other]);
  vi.spyOn(api, 'agents').mockResolvedValue([agent, other]);
  vi.spyOn(api, 'conversations').mockResolvedValue([]);
  vi.spyOn(api, 'conversation').mockImplementation(async (id: string) => conversationDetail(id));
  vi.spyOn(api, 'runApprovals').mockResolvedValue({ items: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('composer attachments', () => {
  it('adds and removes a supported file', async () => {
    vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-1',
      conversationId: 'conversation-a',
    });
    await mount('/chat?agent=agent-a');

    const add = host.querySelector<HTMLButtonElement>('button[aria-label="添加资料"]');
    expect(add).not.toBeNull();
    expect(fileInput().accept).toContain('.md');
    expect(fileInput().accept).toContain('.pdf');
    expect(sendButton().disabled).toBe(true);

    await chooseFiles(fileOf('notes.md', 'hello', 'text/markdown'));
    expect(host.textContent).toContain('notes.md');
    expect(host.textContent).toContain('5 B');
    expect(useChatStore.getState().pendingAttachments).toHaveLength(1);
    // 只有附件也能发送。
    expect(sendButton().disabled).toBe(false);

    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="移除 notes.md"]')?.click(),
    );
    await flush();
    expect(useChatStore.getState().pendingAttachments).toEqual([]);
    expect(host.textContent).not.toContain('notes.md');
  });

  it('rejects unsupported types, too many files, oversized files and an oversized total', async () => {
    await mount('/chat?agent=agent-a');

    await chooseFiles(fileOf('photo.heic', 'x', 'image/heic'));
    expect(alertText()).toContain('不支持');
    expect(host.querySelector('[aria-label="待发送资料"]')).toBeNull();

    await chooseFiles(...Array.from({ length: 6 }, (_, index) => fileOf(`note-${index}.md`)));
    expect(alertText()).toContain(`最多添加 ${ATTACHMENT_LIMITS.count} 个资料`);

    await chooseFiles(sizedFile('large.txt', ATTACHMENT_LIMITS.textBytes + 1, 'text/plain'));
    expect(alertText()).toContain('large.txt');
    expect(alertText()).toContain('超过');
    expect(useChatStore.getState().pendingAttachments).toEqual([]);

    await chooseFiles(sizedFile('large.png', ATTACHMENT_LIMITS.imageBytes + 1, 'image/png'));
    expect(alertText()).toContain('large.png');
    expect(alertText()).toContain('5 MB');

    // 两个 PDF 各自没超单文件上限，但合计超过 10MiB。
    await chooseFiles(
      sizedFile('one.pdf', 6 * 1024 * 1024, 'application/pdf'),
      sizedFile('two.pdf', 6 * 1024 * 1024, 'application/pdf'),
    );
    expect(alertText()).toContain('合计');

    // 报错后仍可继续操作，成功添加会清掉错误。
    await chooseFiles(fileOf('ok.md', 'ok', 'text/markdown'));
    expect(alertText()).toBeNull();
    expect(useChatStore.getState().pendingAttachments).toHaveLength(1);
  });

  it('sends attachments only, with base64 payload and optimistic metadata', async () => {
    const pending = deferredSend();
    await mount('/chat?agent=agent-a');

    await chooseFiles(fileOf('notes.md', 'hello', 'text/markdown'));
    expect(sendButton().disabled).toBe(false);
    await send();

    expect(api.sendChat).toHaveBeenCalledWith({
      agentId: 'agent-a',
      message: '',
      attachments: [{ filename: 'notes.md', dataBase64: btoa('hello') }],
    });
    const user = useChatStore.getState().items.at(-1);
    expect(user).toMatchObject({
      kind: 'user',
      text: '',
      attachments: [{ filename: 'notes.md', mimeType: 'text/markdown', size: 5 }],
    });
    const attachments = user?.kind === 'user' ? user.attachments : undefined;
    expect(attachments?.[0]).not.toHaveProperty('id');
    expect(attachments?.[0]).not.toHaveProperty('downloadUrl');

    await act(async () => pending.resolve({ runId: 'run-1', conversationId: 'conversation-a' }));
    await flush();
    expect(useChatStore.getState().pendingAttachments).toEqual([]);
    expect(host.querySelector('[aria-label="待发送资料"]')).toBeNull();
  });

  it('keeps the selection when the send fails', async () => {
    vi.spyOn(api, 'sendChat').mockRejectedValue(new Error('Send rejected'));
    await mount('/chat?agent=agent-a');

    await chooseFiles(fileOf('notes.md', 'hello', 'text/markdown'));
    await send();

    expect(useChatStore.getState().pendingAttachments).toHaveLength(1);
    expect(useChatStore.getState().pendingAttachments[0]?.name).toBe('notes.md');
    expect(host.querySelector('[aria-label="待发送资料"]')?.textContent).toContain('notes.md');
    expect(useChatStore.getState().run).toBeNull();
  });

  it('does not send a request when the conversation changes while reading attachments', async () => {
    const sendChat = vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-1',
      conversationId: 'conversation-a',
    });
    await mount('/chat?agent=agent-a&conversation=conversation-a');

    // FileReader 真正延迟到切换会话之后才完成，复现“读取期间 generation 失效”。
    const loads: Array<() => void> = [];
    class DelayedFileReader {
      result: string | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(file: File) {
        loads.push(() => {
          this.result = `data:${file.type || 'application/octet-stream'};base64,${btoa('hello')}`;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal('FileReader', DelayedFileReader);

    await chooseFiles(fileOf('notes.md', 'hello', 'text/markdown'));
    await send();
    expect(loads).toHaveLength(1);

    await act(async () => {
      await router.navigate({
        to: '/chat',
        search: { agent: 'agent-a', conversation: 'conversation-b' },
      });
    });
    await flush();

    await act(async () => {
      loads[0]?.();
      await Promise.resolve();
    });
    await flush();

    expect(sendChat).not.toHaveBeenCalled();
  });

  it('replaces optimistic attachment metadata with the accepted server response', async () => {
    const pending = deferredSend();
    await mount('/chat?agent=agent-a&conversation=conversation-a');

    act(() => useChatStore.getState().setInput('分析一下'));
    await flush();
    await chooseFiles(fileOf('notes.md', 'hello', 'text/markdown'));
    await send();

    const optimistic = useChatStore.getState().items.at(-1);
    expect(
      optimistic?.kind === 'user' ? optimistic.attachments?.[0] : undefined,
    ).not.toHaveProperty('id');

    await act(async () =>
      pending.resolve({
        runId: 'run-1',
        conversationId: 'conversation-a',
        attachments: [
          {
            id: attachmentId,
            filename: 'notes.md',
            mimeType: 'text/markdown',
            size: 5,
            sha256: 'a'.repeat(64),
          },
        ],
      }),
    );
    await flush();

    const items = useChatStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'user',
      text: '分析一下',
      attachments: [
        {
          id: attachmentId,
          filename: 'notes.md',
          mimeType: 'text/markdown',
          size: 5,
          downloadUrl: `/api/conversations/conversation-a/attachments/${attachmentId}/download`,
        },
      ],
    });
    expect(
      host.querySelector<HTMLAnchorElement>(
        `a[href="${`/api/conversations/conversation-a/attachments/${attachmentId}/download`}"]`,
      ),
    ).not.toBeNull();
  });

  it('restores the persisted run after replay_truncated when the 202 carries attachment metadata', async () => {
    const pending = deferredSend();
    const saved = conversationDetail('conversation-a', [
      {
        id: 'message-user',
        conversationId: 'conversation-a',
        role: 'user',
        content: {
          type: 'text',
          text: '分析一下',
          attachments: [
            {
              id: attachmentId,
              filename: 'notes.md',
              mimeType: 'text/markdown',
              size: 5,
              sha256: 'a'.repeat(64),
            },
          ],
        },
        runId: 'run-1',
        createdAt: '',
      },
      {
        id: 'message-assistant',
        conversationId: 'conversation-a',
        role: 'assistant',
        content: [{ type: 'text', text: '完整回答' }],
        runId: 'run-1',
        createdAt: '',
      },
    ]);
    // 首屏历史为空；只有截断恢复按 limit=100 翻页时才拿到已落库的本轮消息。
    vi.mocked(api.conversation).mockImplementation(async (id: string, options = {}) =>
      options.limit === 100 ? saved : conversationDetail(id),
    );
    await mount('/chat?agent=agent-a&conversation=conversation-a');

    act(() => useChatStore.getState().setInput('分析一下'));
    await flush();
    await chooseFiles(fileOf('notes.md', 'hello', 'text/markdown'));
    await send();
    await act(async () =>
      pending.resolve({
        runId: 'run-1',
        conversationId: 'conversation-a',
        attachments: [
          {
            id: attachmentId,
            filename: 'notes.md',
            mimeType: 'text/markdown',
            size: 5,
            sha256: 'a'.repeat(64),
          },
        ],
      }),
    );
    await flush();

    const opened = Source.instances.at(-1);
    if (!opened) throw new Error('Missing event stream');
    act(() => opened.emit({ type: 'replay_truncated', reason: 'bytes' }));
    act(() => opened.emit({ type: 'text_delta', text: 'partial answer' }));
    await act(async () => opened.emit({ type: 'run_finished', status: 'succeeded' }));
    await flush();

    expect(api.conversation).toHaveBeenCalledWith('conversation-a', { limit: 100 });
    expect(useChatStore.getState().items).toEqual([
      {
        id: 'message-user:0',
        kind: 'user',
        text: '分析一下',
        messageId: 'message-user',
        runId: 'run-1',
        attachments: [
          {
            id: attachmentId,
            filename: 'notes.md',
            mimeType: 'text/markdown',
            size: 5,
            downloadUrl: `/api/conversations/conversation-a/attachments/${attachmentId}/download`,
          },
        ],
      },
      { id: 'message-assistant:0', kind: 'text', text: '完整回答', runId: 'run-1' },
    ]);
  });

  it('does not clear a selection changed while the send is pending', async () => {
    const pending = deferredSend();
    await mount('/chat?agent=agent-a');

    await chooseFiles(fileOf('first.md', 'first', 'text/markdown'));
    await send();

    const replacement = fileOf('second.md', 'second', 'text/markdown');
    act(() => useChatStore.getState().setPendingAttachments([replacement]));
    await act(async () => pending.resolve({ runId: 'run-1', conversationId: 'conversation-a' }));
    await flush();

    expect(useChatStore.getState().pendingAttachments).toEqual([replacement]);
  });

  it('clears unsent attachments when the conversation changes', async () => {
    await mount();
    await chooseFiles(fileOf('notes.md', 'hello', 'text/markdown'));
    expect(useChatStore.getState().pendingAttachments).toHaveLength(1);

    await act(async () => {
      await router.navigate({
        to: '/chat',
        search: { agent: 'agent-a', conversation: 'conversation-b' },
      });
    });
    await flush();

    expect(useChatStore.getState().pendingAttachments).toEqual([]);
    expect(host.querySelector('[aria-label="待发送资料"]')).toBeNull();
  });

  it('clears unsent attachments when switching expert or starting a new conversation', async () => {
    await mount('/chat?agent=agent-a');

    await chooseFiles(fileOf('notes.md', 'hello', 'text/markdown'));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]')?.click(),
    );
    await flush();
    const picker = host.querySelector<HTMLButtonElement>('button[aria-label^="选择专家"]');
    if (!picker) throw new Error('Missing expert picker');
    await act(async () => picker.click());
    await flush();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.includes('Other Expert'),
    );
    if (!option) throw new Error('Missing expert option');
    await act(async () => option.click());
    await flush();
    expect(useChatStore.getState().pendingAttachments).toEqual([]);

    await chooseFiles(fileOf('again.md', 'hello', 'text/markdown'));
    const newConversation = host.querySelector<HTMLButtonElement>('button[aria-label="新建会话"]');
    if (!newConversation) throw new Error('Missing new conversation button');
    await act(async () => newConversation.click());
    await flush();
    expect(useChatStore.getState().pendingAttachments).toEqual([]);
  });
});

describe('history attachments', () => {
  it('reads validated metadata and builds the download URL from the message conversation', () => {
    const items = historyToItems([
      {
        id: 'message-1',
        conversationId: 'conversation-a',
        role: 'user',
        content: {
          type: 'text',
          text: '',
          attachments: [
            {
              id: attachmentId,
              filename: 'readme.md',
              mimeType: 'text/markdown',
              size: 12,
              sha256: 'a'.repeat(64),
            },
          ],
        },
        runId: 'run-1',
        createdAt: '',
      },
    ]);

    expect(items).toEqual([
      {
        id: 'message-1:0',
        kind: 'user',
        text: '',
        messageId: 'message-1',
        runId: 'run-1',
        attachments: [
          {
            id: attachmentId,
            filename: 'readme.md',
            mimeType: 'text/markdown',
            size: 12,
            downloadUrl: `/api/conversations/conversation-a/attachments/${attachmentId}/download`,
          },
        ],
      },
    ]);
  });

  it('drops malformed attachment data without losing the message text', () => {
    const items = historyToItems([
      {
        id: 'message-1',
        conversationId: 'conversation-a',
        role: 'user',
        content: {
          type: 'text',
          text: 'still readable',
          attachments: [{ id: 'not-a-uuid', filename: 'x.md' }],
        },
        runId: null,
        createdAt: '',
      },
    ]);

    expect(items).toEqual([
      { id: 'message-1:0', kind: 'user', text: 'still readable', messageId: 'message-1' },
    ]);
  });

  it('renders the historical attachment as an accessible download link', async () => {
    vi.mocked(api.conversation).mockImplementation(async (id: string) =>
      conversationDetail(id, [
        {
          id: 'message-1',
          conversationId: id,
          role: 'user',
          content: {
            type: 'text',
            text: '',
            attachments: [
              {
                id: attachmentId,
                filename: 'readme.md',
                mimeType: 'text/markdown',
                size: 12,
                sha256: 'a'.repeat(64),
              },
            ],
          },
          runId: null,
          createdAt: '',
        },
      ]),
    );
    await mount();

    const link = host.querySelector<HTMLAnchorElement>(`a[aria-label^="下载 readme.md"]`);
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(
      `/api/conversations/conversation-a/attachments/${attachmentId}/download`,
    );
    expect(link?.textContent).toContain('readme.md');
    expect(link?.textContent).toContain('12 B');
  });
});
