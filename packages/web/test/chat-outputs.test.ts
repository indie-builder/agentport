import {
  agentInputSchema,
  type OutputContent,
  type OutputFile,
  type OutputList,
} from '@agentport/shared';
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
import { api, type ConversationDetail, type RunDetail } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { formatDateTime } from '../src/lib/format.js';
import { ChatPage } from '../src/pages/chat.js';
import { chatSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const sha = 'a'.repeat(64);
const agent = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'agent-a',
  parentId: null,
  createdAt: '',
  updatedAt: '',
};
const terminal: RunDetail = {
  run: {
    id: 'run-2',
    conversationId: 'conversation-a',
    agentId: 'agent-a',
    agentName: 'Expert',
    status: 'succeeded',
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
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: 'Outputs' },
  steps: [],
};
const history: ConversationDetail = {
  conversation: { id: 'conversation-a', agentId: 'agent-a', title: 'Outputs', createdAt: '' },
  runMetrics: [],
  nextBefore: null,
  messages: [
    {
      id: 'message-a',
      conversationId: 'conversation-a',
      role: 'user',
      content: 'write a report',
      runId: 'run-2',
      createdAt: '',
    },
  ],
};

function output(overrides: Partial<OutputFile> & Pick<OutputFile, 'runId' | 'path'>): OutputFile {
  return {
    size: 10,
    sha256: sha,
    mediaType: 'text/markdown',
    createdAt: '2026-10-28T10:00:00.000Z',
    status: 'succeeded',
    ...overrides,
  };
}

const reportLatest = output({
  runId: 'run-2',
  path: 'report.md',
  createdAt: '2026-10-28T10:00:00.000Z',
});
const reportOlder = output({
  runId: 'run-1',
  path: 'report.md',
  createdAt: '2026-10-28T09:00:00.000Z',
});
const dataFile = output({
  runId: 'run-2',
  path: 'data.json',
  mediaType: 'application/json',
  createdAt: '2026-10-28T10:00:00.000Z',
});
const htmlFile = output({
  runId: 'run-2',
  path: 'page.html',
  mediaType: 'text/html',
  createdAt: '2026-10-28T10:00:00.000Z',
});
const list: OutputList = {
  items: [reportLatest, dataFile, htmlFile, reportOlder],
  nextBefore: null,
};
const contents: Record<string, string> = {
  'run-2:report.md': '# Latest report\n\nbody',
  'run-1:report.md': '# Older report\n\nbody',
  'run-2:data.json': '{"ok":true}',
  'run-2:page.html': '<script>alert(1)</script>\n<img src="x" onerror="alert(1)">',
};

class Source {
  static instances: Source[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
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
let router: ReturnType<typeof createRouter>;
let viewportWidth: number;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(initialEntry = '/chat?agent=agent-a&conversation=conversation-a') {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const chat = createRoute({
    getParentRoute: () => shell,
    path: '/chat',
    validateSearch: chatSearchSchema,
    component: ChatPage,
  });
  const away = createRoute({
    getParentRoute: () => rootRoute,
    path: '/away',
    component: () => null,
  });
  const run = createRoute({
    getParentRoute: () => rootRoute,
    path: '/runs/$runId',
    component: () => null,
  });
  router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([chat]), away, run]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
}

function message() {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]');
  if (!input) throw new Error('Missing message input');
  return input;
}

async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(message(), text);
    message().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openWorkspace() {
  // 深链选中成果时面板已展开；只在仍是收起态时点开关。
  if (host.querySelector('button[aria-label="隐藏工作区"]')) return;
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示工作区"]');
  if (!toggle) throw new Error('Missing workspace toggle');
  await act(async () => toggle.click());
  await flush();
}

function workspace() {
  const aside = document.querySelector<HTMLElement>('aside[aria-label="会话成果"]');
  if (!aside) throw new Error('Missing workspace panel');
  return aside;
}

async function selectFile(path: string) {
  const row = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(path),
  );
  if (!row) throw new Error(`Missing output row: ${path}`);
  await act(async () => row.click());
  await flush();
}

async function pickVersion(createdAt: string) {
  const trigger = workspace().querySelector<HTMLButtonElement>('button[aria-label="选择版本"]');
  if (!trigger) throw new Error('Missing version trigger');
  await act(async () => trigger.click());
  await flush();
  const label = formatDateTime(createdAt);
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
    entry.textContent?.includes(label),
  );
  if (!item) throw new Error(`Missing version item: ${label}`);
  await act(async () => item.click());
  await flush();
}

beforeEach(() => {
  useChatStore.getState().reset();
  Source.instances = [];
  localStorage.clear();
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  viewportWidth = 1440;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      query === '(min-width: 64rem)'
        ? viewportWidth >= 1024
        : query === '(min-width: 80rem)' && viewportWidth >= 1280,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['agents'], [agent]);
  vi.spyOn(api, 'agents').mockResolvedValue([agent]);
  vi.spyOn(api, 'conversations').mockResolvedValue([]);
  vi.spyOn(api, 'conversation').mockResolvedValue(history);
  vi.spyOn(api, 'run').mockResolvedValue(terminal);
  vi.spyOn(api, 'runApprovals').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'outputs').mockResolvedValue(list);
  vi.spyOn(api, 'outputContent').mockImplementation(
    async (_conversationId: string, runId: string, path: string): Promise<OutputContent> => {
      const file =
        list.items.find((item) => item.runId === runId && item.path === path) ??
        output({ runId, path });
      return { file, content: contents[`${runId}:${path}`] ?? '' };
    },
  );
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

describe('conversation outputs list', () => {
  it('lists each path once with its latest version', async () => {
    await mount();
    await openWorkspace();
    expect(workspace().textContent).toContain('report.md');
    expect(workspace().textContent).toContain('data.json');
    expect(workspace().textContent).toContain('page.html');
    const reportRows = [...workspace().querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('report.md'),
    );
    expect(reportRows).toHaveLength(1);
    expect(vi.mocked(api.outputs)).toHaveBeenCalledWith(
      'conversation-a',
      { limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it('shows a real empty state and a retryable failure', async () => {
    vi.mocked(api.outputs).mockResolvedValueOnce({ items: [], nextBefore: null });
    await mount();
    await openWorkspace();
    expect(workspace().textContent).toContain('当前会话没有成果文件');

    vi.mocked(api.outputs).mockRejectedValueOnce(new Error('outputs unavailable'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['conversation-outputs', 'conversation-a'] });
    });
    await flush();
    expect(workspace().textContent).toContain('outputs unavailable');

    vi.mocked(api.outputs).mockResolvedValue(list);
    const retry = [...workspace().querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重试',
    );
    if (!retry) throw new Error('Missing retry action');
    await act(async () => retry.click());
    await flush();
    expect(workspace().textContent).toContain('report.md');
  });
});

describe('output preview and versions', () => {
  it('restores a selected version from the URL and switches versions without losing it', async () => {
    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-1&outputPath=report.md&outputMode=source',
    );
    await openWorkspace();
    expect(api.outputContent).toHaveBeenCalledWith(
      'conversation-a',
      'run-1',
      'report.md',
      expect.any(AbortSignal),
    );
    // 深链直接展开工作区，选中版本来自 URL 而不是列表最新一版。
    expect(host.querySelector('button[aria-label="隐藏工作区"]')).not.toBeNull();
    const pre = workspace().querySelector('pre');
    expect(pre?.textContent).toContain('# Older report');

    await pickVersion(reportLatest.createdAt);
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-2',
      outputPath: 'report.md',
      outputMode: 'source',
    });
    expect(workspace().querySelector('pre')?.textContent).toContain('# Latest report');
  });

  it('switches a Markdown file between reading and source modes through the URL', async () => {
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-2',
      outputPath: 'report.md',
      outputMode: 'read',
    });
    expect(workspace().textContent).toContain('Latest report');

    const source = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '源码',
    );
    if (!source) throw new Error('Missing source mode toggle');
    await act(async () => source.click());
    await flush();
    expect(router.state.location.search).toMatchObject({ outputMode: 'source' });
    expect(workspace().querySelector('pre')?.textContent).toContain('# Latest report');
  });

  it('keeps an explicitly chosen old version when the list refreshes with a new one', async () => {
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    await pickVersion(reportOlder.createdAt);
    expect(router.state.location.search).toMatchObject({ outputRun: 'run-1' });
    expect(workspace().textContent).toContain('Older report');

    const newer = output({
      runId: 'run-3',
      path: 'report.md',
      createdAt: '2026-10-28T11:00:00.000Z',
    });
    contents['run-3:report.md'] = '# Newest report\n\nbody';
    vi.mocked(api.outputs).mockResolvedValue({
      items: [newer, ...list.items],
      nextBefore: null,
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['conversation-outputs', 'conversation-a'] });
    });
    await flush();

    expect(router.state.location.search).toMatchObject({ outputRun: 'run-1' });
    expect(workspace().textContent).toContain('Older report');
    // 列表刷新不抢用户已选的旧版；点同一行才切到最新一版。
    await selectFile('report.md');
    expect(router.state.location.search).toMatchObject({ outputRun: 'run-3' });
    expect(workspace().textContent).toContain('Newest report');
  });

  it('shows HTML as literal source and never executes it', async () => {
    await mount();
    await openWorkspace();
    await selectFile('page.html');
    expect(workspace().querySelector('script, iframe, img')).toBeNull();
    expect(workspace().querySelector('pre')?.textContent).toContain('<script>alert(1)</script>');
  });

  it('shows SVG as literal source without creating executable elements', async () => {
    const file = output({ runId: 'run-svg', path: 'diagram.svg', mediaType: 'image/svg+xml' });
    const code = '<svg onload="alert(1)"><script>alert(1)</script></svg>';
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    vi.mocked(api.outputContent).mockResolvedValue({ file, content: code });
    await mount();
    await openWorkspace();
    await selectFile(file.path);
    expect(api.outputContent).toHaveBeenCalledWith(
      'conversation-a',
      file.runId,
      file.path,
      expect.any(AbortSignal),
    );
    expect(workspace().querySelector('pre')?.textContent).toBe(code);
    expect(workspace().querySelector('script, iframe, object, embed, [onload]')).toBeNull();
    expect(workspace().querySelector('svg:not(.lucide)')).toBeNull();
    expect(router.state.location.search).toMatchObject({ outputMode: 'source' });
  });

  it.each([
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/sql',
    'application/javascript',
    'application/json-seq',
    'image/svg+xml-invalid',
    'application/pdf',
    'image/png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ])('offers download without requesting unsupported %s content', async (mediaType) => {
    const file = output({ runId: 'run-download', path: 'files/original file', mediaType });
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    await mount();
    await openWorkspace();
    await selectFile(file.path);
    expect(api.outputContent).not.toHaveBeenCalled();
    expect(workspace().textContent).toContain('请下载后查看');
    expect(workspace().querySelector('pre')).toBeNull();
    const download = workspace().querySelector<HTMLAnchorElement>(
      'a[aria-label="下载 files/original file"]',
    );
    expect(download?.getAttribute('href')).toBe(
      '/api/conversations/conversation-a/outputs/run-download/download?path=files%2Foriginal%20file',
    );
    expect(download?.hasAttribute('download')).toBe(true);
  });

  it.each(['text/plain', 'text/csv', 'text/xml', 'application/json'])(
    'previews API-supported %s content and keeps its original download',
    async (mediaType) => {
      const file = output({ runId: 'run-text', path: 'notes/example', mediaType });
      vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
      vi.mocked(api.outputContent).mockResolvedValue({ file, content: 'original content' });
      await mount();
      await openWorkspace();
      await selectFile(file.path);
      expect(workspace().querySelector('pre')?.textContent).toBe('original content');
      const download = workspace().querySelector<HTMLAnchorElement>(
        'a[aria-label="下载 notes/example"]',
      );
      expect(download?.getAttribute('href')).toBe(
        '/api/conversations/conversation-a/outputs/run-text/download?path=notes%2Fexample',
      );
      expect(download?.hasAttribute('download')).toBe(true);
    },
  );

  it('offers the original download when a file cannot be previewed', async () => {
    vi.mocked(api.outputContent).mockRejectedValue(new Error('文件超过 1MiB，请下载后查看'));
    await mount();
    await openWorkspace();
    await selectFile('data.json');
    expect(workspace().textContent).toContain('这个文件无法在面板内预览');
    expect(workspace().textContent).toContain('文件超过 1MiB');
    const download = workspace().querySelector<HTMLAnchorElement>('a[aria-label="下载 data.json"]');
    expect(download?.getAttribute('href')).toBe(
      '/api/conversations/conversation-a/outputs/run-2/download?path=data.json',
    );
    expect(workspace().querySelector('pre')).toBeNull();
  });

  it('never shows host paths or the internal manifest', async () => {
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    expect(workspace().textContent).not.toMatch(/\/workspace|manifest\.json|conversation-outputs/);
  });
});

describe('feedback with an output version', () => {
  it.each([false, true])(
    'preserves feedback attached during a pending send with an existing reference: %s',
    async (hasReference) => {
      let accept!: (value: { runId: string; conversationId: string }) => void;
      const send = vi
        .spyOn(api, 'sendChat')
        .mockResolvedValue({ runId: 'run-next', conversationId: 'conversation-a' })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              accept = resolve;
            }),
        );
      await mount(
        '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-1&outputPath=report.md&outputMode=source',
      );
      const feedback = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '基于此版本修改',
      );
      if (!feedback) throw new Error('Missing feedback action');
      if (hasReference) await act(async () => feedback.click());
      await type('first message');
      const submit = host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]');
      if (!submit) throw new Error('Missing send button');
      await act(async () => submit.click());
      expect(send).toHaveBeenCalledExactlyOnceWith({
        agentId: 'agent-a',
        conversationId: 'conversation-a',
        message: 'first message',
        ...(hasReference ? { output: { runId: 'run-1', path: 'report.md' } } : {}),
      });

      await act(async () => feedback.click());
      expect(host.querySelector('button[aria-label="取消引用"]')).not.toBeNull();
      await act(async () => accept({ runId: 'run-new', conversationId: 'conversation-a' }));
      await flush();
      expect(host.querySelector('button[aria-label="取消引用"]')).not.toBeNull();

      const stream = Source.instances.at(-1);
      if (!stream) throw new Error('Missing accepted event stream');
      await act(async () => stream.emit({ type: 'run_finished', status: 'succeeded' }));
      await type('next message');
      await act(async () => submit.click());
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith({
        agentId: 'agent-a',
        conversationId: 'conversation-a',
        message: 'next message',
        output: { runId: 'run-1', path: 'report.md' },
      });
      expect(host.querySelector('button[aria-label="取消引用"]')).toBeNull();
    },
  );

  it('keeps the version selected while sending after delayed acceptance', async () => {
    let accept!: (value: { runId: string; conversationId: string }) => void;
    const send = vi.spyOn(api, 'sendChat').mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-1&outputPath=report.md&outputMode=source',
    );
    await type('tighten the summary');
    const feedback = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '基于此版本修改',
    );
    if (!feedback) throw new Error('Missing feedback action');
    await act(async () => feedback.click());
    const submit = host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]');
    if (!submit) throw new Error('Missing send button');
    await act(async () => submit.click());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ output: { runId: 'run-1', path: 'report.md' } }),
    );

    await pickVersion(reportLatest.createdAt);
    expect(router.state.location.search).toMatchObject({ outputRun: 'run-2' });
    await act(async () => accept({ runId: 'run-new', conversationId: 'conversation-a' }));
    await flush();
    expect(router.state.location.search).toMatchObject({
      conversation: 'conversation-a',
      outputRun: 'run-2',
      outputPath: 'report.md',
      outputMode: 'source',
    });
    expect(workspace().querySelector('pre')?.textContent).toContain('# Latest report');
  });

  it.each([960, 1152, 1440])(
    'hands feedback focus to the composer at %ipx and keeps inline results open',
    async (width) => {
      viewportWidth = width;
      await mount();
      await type('keep this draft');
      await openWorkspace();
      await selectFile('report.md');
      const sheet = document.querySelector('[role="dialog"]');
      expect(sheet !== null).toBe(width < 1280);
      const feedback = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '基于此版本修改',
      );
      if (!feedback) throw new Error('Missing feedback action');
      await act(async () => {
        feedback.focus();
        feedback.click();
      });
      await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(message());
      expect(message().value).toBe('keep this draft');
      expect(useChatStore.getState().outputRef).toEqual({ runId: 'run-2', path: 'report.md' });
      expect(host.querySelector('button[aria-label="隐藏工作区"]') !== null).toBe(width >= 1280);
      expect(host.querySelector('aside[aria-label="会话成果"]') !== null).toBe(width >= 1280);
    },
  );

  it('returns ordinary Sheet closes to the toggle even after feedback was used', async () => {
    viewportWidth = 1152;
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    const feedback = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '基于此版本修改',
    );
    if (!feedback) throw new Error('Missing feedback action');
    await act(async () => feedback.click());
    await flush();
    await openWorkspace();
    const close = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] [data-slot="sheet-close"]',
    );
    if (!close) throw new Error('Missing Sheet close action');
    await act(async () => close.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('button[aria-label="显示工作区"]'));
  });

  it('keeps the draft, sends the output reference and clears the chip after acceptance', async () => {
    const send = vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-new',
      conversationId: 'conversation-a',
    });
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    await pickVersion(reportOlder.createdAt);
    const source = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '源码',
    );
    if (!source) throw new Error('Missing source mode toggle');
    await act(async () => source.click());
    await flush();
    await type('tighten the summary');

    const feedback = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '基于此版本修改',
    );
    if (!feedback) throw new Error('Missing feedback action');
    await act(async () => feedback.click());
    await flush();
    expect(message().value).toBe('tighten the summary');
    expect(host.querySelector('button[aria-label="取消引用"]')).not.toBeNull();
    expect(useChatStore.getState().outputRef).toEqual({ runId: 'run-1', path: 'report.md' });

    const submit = host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]');
    if (!submit) throw new Error('Missing send button');
    await act(async () => submit.click());
    await flush();
    expect(send).toHaveBeenCalledWith({
      agentId: 'agent-a',
      conversationId: 'conversation-a',
      message: 'tighten the summary',
      output: { runId: 'run-1', path: 'report.md' },
    });
    expect(host.querySelector('button[aria-label="取消引用"]')).toBeNull();
    expect(useChatStore.getState().outputRef).toBeNull();
    expect(router.state.location.search).toEqual({
      agent: 'agent-a',
      conversation: 'conversation-a',
      outputRun: 'run-1',
      outputPath: 'report.md',
      outputMode: 'source',
    });
    expect(workspace().querySelector('pre')?.textContent).toContain('# Older report');

    const newer = output({
      runId: 'run-new',
      path: 'report.md',
      createdAt: '2026-10-28T11:00:00.000Z',
    });
    vi.mocked(api.outputs).mockResolvedValue({ items: [newer, ...list.items], nextBefore: null });
    const stream = Source.instances.at(-1);
    if (!stream) throw new Error('Missing accepted event stream');
    await act(async () => stream.emit({ type: 'run_finished', status: 'succeeded' }));
    await flush();
    expect(api.outputs).toHaveBeenCalledTimes(2);
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-1',
      outputPath: 'report.md',
      outputMode: 'source',
    });
    expect(workspace().querySelector('pre')?.textContent).toContain('# Older report');
  });

  it('lets the reference be cancelled without touching the draft', async () => {
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    await type('keep this draft');
    const feedback = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '基于此版本修改',
    );
    if (!feedback) throw new Error('Missing feedback action');
    await act(async () => feedback.click());
    await flush();
    const cancel = host.querySelector<HTMLButtonElement>('button[aria-label="取消引用"]');
    if (!cancel) throw new Error('Missing cancel action');
    await act(async () => cancel.click());
    expect(useChatStore.getState().outputRef).toBeNull();
    expect(message().value).toBe('keep this draft');
  });
});

describe('output refresh and conversation isolation', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'timeout'] as const)(
    'refreshes the list when the run reaches %s',
    async (status) => {
      vi.mocked(api.run).mockResolvedValue({
        ...terminal,
        run: { ...terminal.run, status: 'running' },
      });
      const outputs = vi.mocked(api.outputs);
      await mount();
      await openWorkspace();
      expect(outputs).toHaveBeenCalledTimes(1);
      const source = Source.instances[0];
      if (!source) throw new Error('Missing event stream');
      await act(async () => source.emit({ type: 'run_finished', status }));
      await flush();
      expect(outputs.mock.calls.length).toBeGreaterThanOrEqual(2);
    },
  );

  it('clears the output selection when opening another conversation from history', async () => {
    vi.mocked(api.conversations).mockResolvedValue([
      {
        id: 'conversation-b',
        agentId: agent.id,
        title: 'Other conversation',
        createdAt: '',
        updatedAt: '',
        lastMessage: null,
      },
    ]);
    vi.mocked(api.conversation).mockImplementation(async (id: string) => ({
      ...history,
      conversation: { ...history.conversation, id },
      messages: id === 'conversation-a' ? history.messages : [],
    }));
    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-1&outputPath=report.md&outputMode=source',
    );
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]');
    if (!toggle) throw new Error('Missing history toggle');
    await act(async () => toggle.click());
    await flush();
    const entry = [
      ...host.querySelectorAll<HTMLButtonElement>('aside[aria-label="会话历史"] button'),
    ].find((button) => button.textContent?.includes('Other conversation'));
    if (!entry) throw new Error('Missing conversation entry');
    vi.mocked(api.outputContent).mockClear();
    await act(async () => entry.click());
    await flush();
    expect(router.state.location.search).toEqual({
      agent: 'agent-a',
      conversation: 'conversation-b',
    });
    expect(workspace().querySelector('pre')).toBeNull();
    expect(api.outputContent).not.toHaveBeenCalled();
  });

  it('clears the output selection when creating a conversation', async () => {
    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-1&outputPath=report.md&outputMode=source',
    );
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]');
    if (!toggle) throw new Error('Missing history toggle');
    await act(async () => toggle.click());
    await flush();
    const create = host.querySelector<HTMLButtonElement>('button[aria-label="新建会话"]');
    if (!create) throw new Error('Missing new conversation action');
    await act(async () => create.click());
    await flush();
    expect(router.state.location.search).toEqual({ agent: 'agent-a' });
    expect(workspace().textContent).toContain('当前会话没有成果文件');
    expect(workspace().querySelector('pre')).toBeNull();
  });

  it('clears the output selection when switching experts', async () => {
    const other = { ...agent, id: 'agent-b', slug: 'other', name: 'Other Expert' };
    client.setQueryData(['agents'], [agent, other]);
    vi.mocked(api.agents).mockResolvedValue([agent, other]);
    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-1&outputPath=report.md&outputMode=source',
    );
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]');
    if (!toggle) throw new Error('Missing history toggle');
    await act(async () => toggle.click());
    await flush();
    const picker = host.querySelector<HTMLButtonElement>('button[aria-label="选择专家"]');
    if (!picker) throw new Error('Missing expert picker');
    await act(async () => picker.click());
    await flush();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.includes('Other Expert'),
    );
    if (!option) throw new Error('Missing expert option');
    await act(async () => option.click());
    await flush();
    expect(router.state.location.search).toEqual({ agent: 'agent-b' });
    expect(workspace().textContent).toContain('当前会话没有成果文件');
    expect(workspace().querySelector('pre')).toBeNull();
  });

  it('switches conversations without showing the previous outputs', async () => {
    let resolveFirst!: (value: OutputList) => void;
    vi.mocked(api.outputs).mockImplementation((conversationId: string) =>
      conversationId === 'conversation-a'
        ? new Promise<OutputList>((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve({
            items: [output({ runId: 'run-b', path: 'other.md' })],
            nextBefore: null,
          }),
    );
    vi.mocked(api.conversation).mockImplementation(async (conversationId: string) =>
      conversationId === 'conversation-b'
        ? {
            ...history,
            conversation: { ...history.conversation, id: 'conversation-b' },
            messages: [],
          }
        : history,
    );
    await mount();
    await openWorkspace();
    await act(async () => {
      await router.navigate({
        to: '/chat',
        search: { agent: 'agent-a', conversation: 'conversation-b' },
      });
    });
    await flush();
    expect(workspace().textContent).toContain('other.md');

    await act(async () => resolveFirst(list));
    await flush();
    expect(workspace().textContent).toContain('other.md');
    expect(workspace().textContent).not.toContain('report.md');
  });
});
