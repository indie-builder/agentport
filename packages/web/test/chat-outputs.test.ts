import {
  agentInputSchema,
  type OutputContent,
  type OutputFile,
  type OutputList,
  type OutputShare,
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
    userMessageId: `user-${overrides.runId}`,
    afterMessageId: `after-${overrides.runId}`,
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
  if (host.querySelector('button[aria-label="隐藏会话成果"]')) return;
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="打开会话成果"]');
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

let objectUrlSeed = 0;

/** 每个 blob 一个稳定地址；测试据此证明面板显示的是哪一次请求的字节。 */
function stubObjectUrls() {
  const urls = new Map<Blob, string>();
  const create = vi.fn((blob: Blob) => {
    const url = `blob:${++objectUrlSeed}`;
    urls.set(blob, url);
    return url;
  });
  const revoke = vi.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke, urls };
}

function previewImage(): HTMLImageElement {
  const image = workspace().querySelector<HTMLImageElement>('img');
  if (!image) throw new Error('Missing image preview');
  return image;
}

async function decodeImage(image: HTMLImageElement) {
  await act(async () => {
    image.dispatchEvent(new Event('load'));
  });
}

async function pickVersion(createdAt: string) {
  const trigger = workspace().querySelector<HTMLButtonElement>('button[aria-label="选择版本"]');
  if (!trigger) throw new Error('Missing version trigger');
  await act(async () => trigger.click());
  await flush();
  const label = formatDateTime(createdAt);
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((entry) =>
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
  objectUrlSeed = 0;
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
  vi.spyOn(api, 'outputFile').mockImplementation(
    async (_conversationId: string, runId: string, path: string) => ({
      file:
        list.items.find((item) => item.runId === runId && item.path === path) ??
        output({ runId, path }),
    }),
  );
  vi.spyOn(api, 'outputBlob').mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
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
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
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
    // 正文类型来自列表元信息：列表就绪后才会发起正文请求。
    await flush();
    expect(api.outputContent).toHaveBeenCalledWith(
      'conversation-a',
      'run-1',
      'report.md',
      expect.any(AbortSignal),
    );
    // 深链直接展开工作区，选中版本来自 URL 而不是列表最新一版。
    expect(host.querySelector('button[aria-label="隐藏会话成果"]')).not.toBeNull();
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

  it('copies the selected version content and keeps downloading the same file', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    // 两个版本的正文都已缓存：切版本不卸载工具条，能验证复制反馈随正文重置。
    client.setQueryData(['conversation-output-content', 'conversation-a', 'run-1', 'report.md'], {
      file: reportOlder,
      content: contents['run-1:report.md'],
    });
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    const copy = workspace().querySelector<HTMLButtonElement>(
      'button[aria-label="复制 report.md"]',
    );
    if (!copy) throw new Error('Missing copy action');
    await act(async () => copy.click());
    expect(writeText).toHaveBeenLastCalledWith('# Latest report\n\nbody');

    await pickVersion(reportOlder.createdAt);
    // 切到旧版后先看到可复制的动作，不能沿用上一版的「已复制」。
    const copied = workspace().querySelector<HTMLButtonElement>(
      'button[aria-label="复制 report.md"]',
    );
    if (!copied) throw new Error('Missing copy action after switching versions');
    await act(async () => copied.click());
    expect(writeText).toHaveBeenLastCalledWith('# Older report\n\nbody');
    expect(
      workspace()
        .querySelector<HTMLAnchorElement>('a[aria-label="下载 report.md"]')
        ?.getAttribute('href'),
    ).toBe('/api/conversations/conversation-a/outputs/run-1/download?path=report.md');
  });

  it('keeps every version operation inside the reader toolbar in a narrow panel', async () => {
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    const copy = workspace().querySelector<HTMLButtonElement>(
      'button[aria-label="复制 report.md"]',
    );
    if (!copy) throw new Error('Missing copy action');
    const actions = copy.parentElement;
    if (!actions) throw new Error('Missing toolbar actions');
    // jsdom 没有布局：这里守住宽度上限与可聚焦契约，320px 的实际几何由浏览器复核。
    expect(actions.className).toContain('max-w-full');
    expect(actions.contains(workspace().querySelector('button[aria-label="选择版本"]'))).toBe(true);

    for (const selector of [
      'button[aria-label="选择版本"]',
      'button[aria-label="复制 report.md"]',
      'a[aria-label="下载 report.md"]',
    ]) {
      const control = workspace().querySelector<HTMLElement>(selector);
      if (!control) throw new Error(`Missing toolbar control: ${selector}`);
      expect(actions.contains(control)).toBe(true);
      control.focus();
      expect(document.activeElement).toBe(control);
    }
    const feedback = [...actions.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '基于此版本修改',
    );
    if (!feedback) throw new Error('Missing feedback action');
    feedback.focus();
    expect(document.activeElement).toBe(feedback);
    for (const label of ['阅读', '源码']) {
      const mode = [...actions.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === label,
      );
      if (!mode) throw new Error(`Missing mode toggle: ${label}`);
      mode.focus();
      expect(document.activeElement).toBe(mode);
    }
  });

  it('pages through older output versions without dropping the selected file', async () => {
    const archived = output({
      runId: 'run-0',
      path: 'archived.md',
      createdAt: '2026-10-27T10:00:00.000Z',
    });
    vi.mocked(api.outputs)
      .mockResolvedValueOnce({ items: list.items, nextBefore: 'cursor-1' })
      .mockResolvedValueOnce({ items: [archived], nextBefore: null });
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    const more = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === '加载更多版本',
    );
    if (!more) throw new Error('Missing older versions action');
    await act(async () => more.click());
    await flush();
    expect(vi.mocked(api.outputs)).toHaveBeenLastCalledWith(
      'conversation-a',
      { limit: 50, before: 'cursor-1' },
      expect.any(AbortSignal),
    );
    expect(workspace().textContent).toContain('archived.md');
    expect(router.state.location.search).toMatchObject({ outputRun: 'run-2' });
  });

  it('keeps existing version labels when paging in an older version of the same path', async () => {
    const oldest = output({
      runId: 'run-0',
      path: 'report.md',
      createdAt: '2026-10-27T10:00:00.000Z',
    });
    vi.mocked(api.outputs)
      .mockResolvedValueOnce({ items: list.items, nextBefore: 'cursor-1' })
      .mockResolvedValueOnce({ items: [oldest], nextBefore: null });
    await mount();
    await openWorkspace();
    await selectFile('report.md');
    const more = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === '加载更多版本',
    );
    if (!more) throw new Error('Missing older versions action');
    await act(async () => more.click());
    await flush();

    const trigger = workspace().querySelector<HTMLButtonElement>('button[aria-label="选择版本"]');
    if (!trigger) throw new Error('Missing version trigger');
    await act(async () => trigger.click());
    await flush();
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map(
      (item) => item.textContent?.trim(),
    );
    // 追加更旧版本只应改变新出现项的位置名，已有两项仍是「最新」「上一版」。
    expect(labels).toEqual([
      `最新 · ${formatDateTime(reportLatest.createdAt)}`,
      `上一版 · ${formatDateTime(reportOlder.createdAt)}`,
      `前 2 版 · ${formatDateTime(oldest.createdAt)}`,
    ]);
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
    const copies = [...workspace().querySelectorAll<HTMLButtonElement>('button')].filter((item) =>
      item.getAttribute('aria-label')?.startsWith('复制'),
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.getAttribute('aria-label')).toBe('复制 report.md');
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

describe('image outputs', () => {
  const photo = (overrides: Partial<OutputFile> & Pick<OutputFile, 'runId' | 'path'>) =>
    output({ mediaType: 'image/png', ...overrides });

  it('previews a private image only after the blob decodes, without requesting text content', async () => {
    const file = photo({ runId: 'run-photo', path: 'photo.png' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    const blob = new Blob(['png'], { type: 'image/png' });
    vi.mocked(api.outputBlob).mockResolvedValue(blob);
    const { urls } = stubObjectUrls();

    await mount();
    await openWorkspace();
    await selectFile('photo.png');

    expect(api.outputContent).not.toHaveBeenCalled();
    expect(api.outputFile).not.toHaveBeenCalled();
    expect(api.outputBlob).toHaveBeenCalledWith(
      'conversation-a',
      'run-photo',
      'photo.png',
      expect.any(AbortSignal),
    );
    const image = previewImage();
    expect(image.getAttribute('src')).toBe(urls.get(blob));
    expect(image.getAttribute('alt')).toBe('photo.png');
    // decode 之前只是占位，不能把 DOM 里存在 img 当成图片已可用。
    expect(image.className).toContain('hidden');
    await decodeImage(image);
    const shown = previewImage();
    expect(shown.className).not.toContain('hidden');
    expect(workspace().querySelector<HTMLAnchorElement>('a[aria-label="下载 photo.png"]')).not.toBe(
      null,
    );
    expect(workspace().textContent).toContain('基于此版本修改');
  });

  it('ties the displayed blob URL to the selected version while switching', async () => {
    const latest = photo({
      runId: 'run-latest',
      path: 'photo.png',
      createdAt: '2026-10-28T11:00:00.000Z',
    });
    const older = photo({
      runId: 'run-older',
      path: 'photo.png',
      createdAt: '2026-10-28T10:00:00.000Z',
    });
    vi.mocked(api.outputs).mockResolvedValue({ items: [latest, older], nextBefore: null });
    const latestBlob = new Blob(['latest'], { type: 'image/png' });
    const olderBlob = new Blob(['older'], { type: 'image/png' });
    let resolveOlder!: (blob: Blob) => void;
    vi.mocked(api.outputBlob).mockImplementation((_conversationId, runId) =>
      runId === 'run-older'
        ? new Promise<Blob>((resolve) => {
            resolveOlder = resolve;
          })
        : Promise.resolve(latestBlob),
    );
    const { urls } = stubObjectUrls();

    await mount();
    await openWorkspace();
    await selectFile('photo.png');
    const first = previewImage();
    await decodeImage(first);
    expect(first.getAttribute('src')).toBe(urls.get(latestBlob));

    await pickVersion(older.createdAt);
    // 旧版字节还没回来：不能继续显示上一版的图片。
    expect(workspace().querySelector('img')).toBeNull();
    expect(api.outputBlob).toHaveBeenLastCalledWith(
      'conversation-a',
      'run-older',
      'photo.png',
      expect.any(AbortSignal),
    );

    await act(async () => resolveOlder(olderBlob));
    await flush();
    const second = previewImage();
    await decodeImage(second);
    expect(second.getAttribute('src')).toBe(urls.get(olderBlob));
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-older',
      outputPath: 'photo.png',
    });
  });

  it('labels versions by position and binds the old version to every file action', async () => {
    const latest = photo({
      runId: 'run-image-2',
      path: 'photo.png',
      createdAt: '2026-10-28T10:00:00.030Z',
    });
    const older = photo({
      runId: 'run-image-1',
      path: 'photo.png',
      createdAt: '2026-10-28T10:00:00.000Z',
    });
    vi.mocked(api.outputs).mockResolvedValue({ items: [latest, older], nextBefore: null });
    const latestBlob = new Blob(['latest'], { type: 'image/png' });
    const olderBlob = new Blob(['older'], { type: 'image/png' });
    vi.mocked(api.outputBlob).mockImplementation((_conversationId, runId) =>
      Promise.resolve(runId === older.runId ? olderBlob : latestBlob),
    );
    const share: OutputShare = {
      id: 'share-older',
      runId: older.runId,
      path: older.path,
      sha256: older.sha256,
      createdAt: '2026-10-28T10:01:00.000Z',
      revokedAt: null,
      urlPath: '/s/share-older#token',
    };
    vi.spyOn(api, 'outputShares').mockResolvedValue({ items: [] });
    const createShare = vi.spyOn(api, 'createOutputShare').mockResolvedValue(share);
    const { urls } = stubObjectUrls();

    await mount();
    await openWorkspace();
    await selectFile('photo.png');
    await decodeImage(previewImage());
    expect(previewImage().getAttribute('src')).toBe(urls.get(latestBlob));

    const trigger = workspace().querySelector<HTMLButtonElement>('button[aria-label="选择版本"]');
    if (!trigger) throw new Error('Missing version trigger');
    expect(trigger.textContent?.trim()).toBe(`最新 · ${formatDateTime(latest.createdAt)}`);
    await act(async () => trigger.click());
    await flush();

    // 两版同一秒相隔 30ms，时间文本相同；位置标签必须让可访问名唯一可区分。
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const labels = items.map((item) => item.textContent?.trim());
    expect(labels).toEqual([
      `最新 · ${formatDateTime(latest.createdAt)}`,
      `上一版 · ${formatDateTime(older.createdAt)}`,
    ]);
    expect(new Set(labels).size).toBe(2);
    const checked = items.filter((item) => item.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent?.trim()).toBe(labels[0]);

    // menuitemradio 的可访问名来自内容；按「上一版」选择，不依赖列表下标。
    const olderItem = items.find((item) => item.textContent?.trim().startsWith('上一版'));
    if (!olderItem) throw new Error('Missing older version item');
    await act(async () => olderItem.click());
    await flush();

    expect(router.state.location.search).toMatchObject({
      outputRun: older.runId,
      outputPath: 'photo.png',
    });
    expect(trigger.textContent?.trim()).toBe(`上一版 · ${formatDateTime(older.createdAt)}`);
    expect(api.outputBlob).toHaveBeenLastCalledWith(
      'conversation-a',
      older.runId,
      'photo.png',
      expect.any(AbortSignal),
    );
    await decodeImage(previewImage());
    expect(previewImage().getAttribute('src')).toBe(urls.get(olderBlob));
    expect(
      workspace()
        .querySelector<HTMLAnchorElement>('a[aria-label="下载 photo.png"]')
        ?.getAttribute('href'),
    ).toBe('/api/conversations/conversation-a/outputs/run-image-1/download?path=photo.png');

    const feedback = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '基于此版本修改',
    );
    if (!feedback) throw new Error('Missing feedback action');
    await act(async () => feedback.click());
    expect(useChatStore.getState().outputRef).toEqual({ runId: older.runId, path: 'photo.png' });

    const shareTrigger = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '分享',
    );
    if (!shareTrigger) throw new Error('Missing share trigger');
    await act(async () => shareTrigger.click());
    await flush();
    const create = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent?.trim() === '创建分享链接',
    );
    if (!create) throw new Error('Missing share create action');
    await act(async () => create.click());
    await flush();
    expect(createShare).toHaveBeenCalledWith('conversation-a', {
      runId: older.runId,
      path: 'photo.png',
    });
  });

  it('fetches metadata before the blob when an older version is not in the list page', async () => {
    const unrelated = output({ runId: 'run-other', path: 'other.md' });
    const archived = photo({ runId: 'run-archived', path: 'photo.png' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [unrelated], nextBefore: null });
    vi.mocked(api.outputFile).mockResolvedValue({ file: archived });
    const blob = new Blob(['archived'], { type: 'image/png' });
    vi.mocked(api.outputBlob).mockResolvedValue(blob);
    stubObjectUrls();

    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-archived&outputPath=photo.png&outputMode=source',
    );
    await openWorkspace();
    await flush();

    expect(api.outputFile).toHaveBeenCalledWith(
      'conversation-a',
      'run-archived',
      'photo.png',
      expect.any(AbortSignal),
    );
    // 没有列表元信息时先拿真实类型，绝不先猜成文本去请求正文。
    expect(api.outputContent).not.toHaveBeenCalled();
    expect(vi.mocked(api.outputFile).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.outputBlob).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    await decodeImage(previewImage());
    expect(workspace().textContent).toContain('photo.png');
  });

  it('loads text content only after metadata resolves for an older version', async () => {
    const unrelated = output({ runId: 'run-other', path: 'other.md' });
    const archived = output({ runId: 'run-archived', path: 'notes.txt', mediaType: 'text/plain' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [unrelated], nextBefore: null });
    vi.mocked(api.outputFile).mockResolvedValue({ file: archived });
    vi.mocked(api.outputContent).mockResolvedValue({ file: archived, content: 'archived notes' });

    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-archived&outputPath=notes.txt&outputMode=source',
    );
    await openWorkspace();
    await flush();

    expect(api.outputContent).toHaveBeenCalledWith(
      'conversation-a',
      'run-archived',
      'notes.txt',
      expect.any(AbortSignal),
    );
    expect(vi.mocked(api.outputFile).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.outputContent).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(workspace().querySelector('pre')?.textContent).toBe('archived notes');
  });

  it('retries metadata before showing an older image', async () => {
    const unrelated = output({ runId: 'run-other', path: 'other.md' });
    const archived = photo({ runId: 'run-archived', path: 'photo.png' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [unrelated], nextBefore: null });
    vi.mocked(api.outputFile)
      .mockRejectedValueOnce(new Error('元信息没有加载出来'))
      .mockResolvedValue({ file: archived });
    vi.mocked(api.outputBlob).mockResolvedValue(new Blob(['archived'], { type: 'image/png' }));
    stubObjectUrls();

    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-archived&outputPath=photo.png&outputMode=source',
    );
    await openWorkspace();
    await flush();
    expect(workspace().textContent).toContain('元信息没有加载出来');
    expect(api.outputBlob).not.toHaveBeenCalled();

    const retry = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '重试',
    );
    if (!retry) throw new Error('Missing metadata retry action');
    await act(async () => retry.click());
    await flush();
    expect(api.outputFile).toHaveBeenCalledTimes(2);
    await flush();
    await decodeImage(previewImage());
  });

  it('retries a failed image download and keeps the file actions', async () => {
    const file = photo({ runId: 'run-photo', path: 'photo.png' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    vi.mocked(api.outputBlob)
      .mockRejectedValueOnce(new Error('图片下载失败'))
      .mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    stubObjectUrls();

    await mount();
    await openWorkspace();
    await selectFile('photo.png');
    expect(workspace().textContent).toContain('图片下载失败');
    expect(workspace().querySelector('a[aria-label="下载 photo.png"]')).not.toBeNull();

    const retry = [...workspace().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '重试',
    );
    if (!retry) throw new Error('Missing image retry action');
    await act(async () => retry.click());
    await flush();
    expect(api.outputBlob).toHaveBeenCalledTimes(2);
    await decodeImage(previewImage());
  });

  it('reports a decode failure as real text and keeps the original download', async () => {
    const file = photo({ runId: 'run-photo', path: 'photo.png' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    vi.mocked(api.outputBlob).mockResolvedValue(new Blob(['broken'], { type: 'image/png' }));
    stubObjectUrls();

    await mount();
    await openWorkspace();
    await selectFile('photo.png');
    const image = previewImage();
    await act(async () => {
      image.dispatchEvent(new Event('error'));
    });

    expect(workspace().textContent).toContain('图片无法解码，请下载原件查看。');
    expect(workspace().querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(workspace().querySelector<HTMLImageElement>('img')?.className).toContain('hidden');
    expect(workspace().querySelector('a[aria-label="下载 photo.png"]')).not.toBeNull();
  });

  it('shows only the last selection when image blobs resolve out of order', async () => {
    const first = photo({
      runId: 'run-a',
      path: 'a.png',
      createdAt: '2026-10-28T11:00:00.000Z',
    });
    const second = photo({
      runId: 'run-b',
      path: 'b.png',
      createdAt: '2026-10-28T10:00:00.000Z',
    });
    vi.mocked(api.outputs).mockResolvedValue({ items: [first, second], nextBefore: null });
    const firstBlob = new Blob(['a'], { type: 'image/png' });
    const secondBlob = new Blob(['b'], { type: 'image/png' });
    let resolveFirst!: (blob: Blob) => void;
    let resolveSecond!: (blob: Blob) => void;
    vi.mocked(api.outputBlob).mockImplementation((_conversationId, _runId, path) =>
      path === 'a.png'
        ? new Promise<Blob>((resolve) => {
            resolveFirst = resolve;
          })
        : new Promise<Blob>((resolve) => {
            resolveSecond = resolve;
          }),
    );
    const { urls } = stubObjectUrls();

    await mount();
    await openWorkspace();
    await selectFile('a.png');
    await selectFile('b.png');
    await act(async () => resolveSecond(secondBlob));
    await flush();
    await decodeImage(previewImage());

    await act(async () => resolveFirst(firstBlob));
    await flush();
    const image = previewImage();
    expect(image.getAttribute('src')).toBe(urls.get(secondBlob));
    expect(image.getAttribute('alt')).toBe('b.png');
  });

  it('revokes the object URL when the image unmounts', async () => {
    const file = photo({ runId: 'run-photo', path: 'photo.png' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    const blob = new Blob(['png'], { type: 'image/png' });
    vi.mocked(api.outputBlob).mockResolvedValue(blob);
    const { revoke, urls } = stubObjectUrls();

    await mount();
    await openWorkspace();
    await selectFile('photo.png');
    await decodeImage(previewImage());
    const url = urls.get(blob);
    if (url === undefined) throw new Error('Missing object URL');

    await act(async () => root.unmount());
    root = createRoot(host);
    expect(revoke).toHaveBeenCalledWith(url);
  });
});

describe('pdf outputs', () => {
  const pdfFile = (overrides: Partial<OutputFile> & Pick<OutputFile, 'runId' | 'path'>) =>
    output({ mediaType: 'application/pdf', ...overrides });

  function stubPdfUrls() {
    let seed = 0;
    const create = vi.fn((_blob: Blob) => `blob:pdf-${++seed}`);
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    return { create, revoke };
  }

  function pdfPreview(): HTMLIFrameElement {
    const frame = workspace().querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error('Missing PDF preview');
    return frame;
  }

  beforeEach(() => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'pdfViewerEnabled');
  });

  it('previews a private PDF through the exact authenticated download entry', async () => {
    const file = pdfFile({ runId: 'run-pdf', path: 'report.pdf' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    const blob = new Blob(['%PDF-1.7\nbody'], { type: 'application/pdf' });
    vi.mocked(api.outputBlob).mockResolvedValue(blob);
    const { create } = stubPdfUrls();

    await mount();
    await openWorkspace();
    await selectFile('report.pdf');

    expect(api.outputContent).not.toHaveBeenCalled();
    expect(api.outputFile).not.toHaveBeenCalled();
    expect(api.outputBlob).toHaveBeenCalledWith(
      'conversation-a',
      'run-pdf',
      'report.pdf',
      expect.any(AbortSignal),
    );
    const frame = pdfPreview();
    expect(frame.getAttribute('src')).toBe('blob:pdf-1');
    expect(frame.getAttribute('title')).toBe('report.pdf');
    expect(frame.className).toContain('h-[50vh]');
    expect(create.mock.calls[0]?.[0]?.type).toBe('application/pdf');
    expect(
      workspace()
        .querySelector<HTMLAnchorElement>('a[aria-label="下载 report.pdf"]')
        ?.getAttribute('href'),
    ).toBe('/api/conversations/conversation-a/outputs/run-pdf/download?path=report.pdf');
  });

  it('keeps the download and skips the iframe when the browser has no PDF viewer', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: false });
    const file = pdfFile({ runId: 'run-pdf', path: 'report.pdf' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    vi.mocked(api.outputBlob).mockResolvedValue(
      new Blob(['%PDF-1.7\nbody'], { type: 'application/pdf' }),
    );
    const { create } = stubPdfUrls();

    await mount();
    await openWorkspace();
    await selectFile('report.pdf');

    expect(workspace().textContent).toContain('当前浏览器不支持 PDF 预览，请下载原件查看。');
    expect(workspace().querySelector('iframe')).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(
      workspace().querySelector<HTMLAnchorElement>('a[aria-label="下载 report.pdf"]'),
    ).not.toBeNull();
  });

  it('refuses bytes without the PDF header and keeps the download', async () => {
    const file = pdfFile({ runId: 'run-pdf', path: 'report.pdf' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [file], nextBefore: null });
    vi.mocked(api.outputBlob).mockResolvedValue(
      new Blob(['not really a pdf'], { type: 'application/pdf' }),
    );
    const { create } = stubPdfUrls();

    await mount();
    await openWorkspace();
    await selectFile('report.pdf');

    expect(workspace().textContent).toContain('文件不是可预览的 PDF，请下载原件查看。');
    expect(workspace().querySelector('iframe')).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(
      workspace().querySelector<HTMLAnchorElement>('a[aria-label="下载 report.pdf"]'),
    ).not.toBeNull();
  });

  it('switches to an older PDF version without showing the previous document', async () => {
    const latest = pdfFile({
      runId: 'run-pdf-2',
      path: 'report.pdf',
      createdAt: '2026-10-28T11:00:00.000Z',
    });
    const older = pdfFile({
      runId: 'run-pdf-1',
      path: 'report.pdf',
      createdAt: '2026-10-28T10:00:00.000Z',
    });
    vi.mocked(api.outputs).mockResolvedValue({ items: [latest, older], nextBefore: null });
    const latestBlob = new Blob(['%PDF-1.4 latest'], { type: 'application/pdf' });
    const olderBlob = new Blob(['%PDF-1.4 older'], { type: 'application/pdf' });
    let resolveOlder!: (blob: Blob) => void;
    vi.mocked(api.outputBlob).mockImplementation((_conversationId, runId) =>
      runId === older.runId
        ? new Promise<Blob>((resolve) => {
            resolveOlder = resolve;
          })
        : Promise.resolve(latestBlob),
    );
    const { create, revoke } = stubPdfUrls();

    await mount();
    await openWorkspace();
    await selectFile('report.pdf');
    expect(pdfPreview().getAttribute('src')).toBe('blob:pdf-1');

    await pickVersion(older.createdAt);
    expect(workspace().querySelector('iframe')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:pdf-1');
    expect(api.outputBlob).toHaveBeenLastCalledWith(
      'conversation-a',
      'run-pdf-1',
      'report.pdf',
      expect.any(AbortSignal),
    );
    expect(create).toHaveBeenCalledTimes(1);

    await act(async () => resolveOlder(olderBlob));
    await flush();
    expect(pdfPreview().getAttribute('src')).toBe('blob:pdf-2');
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-pdf-1',
      outputPath: 'report.pdf',
    });
    expect(
      workspace()
        .querySelector<HTMLAnchorElement>('a[aria-label="下载 report.pdf"]')
        ?.getAttribute('href'),
    ).toBe('/api/conversations/conversation-a/outputs/run-pdf-1/download?path=report.pdf');
  });

  it('resolves metadata before fetching bytes for an older PDF outside the list page', async () => {
    const unrelated = output({ runId: 'run-other', path: 'other.md' });
    const archived = pdfFile({ runId: 'run-archived', path: 'report.pdf' });
    vi.mocked(api.outputs).mockResolvedValue({ items: [unrelated], nextBefore: null });
    vi.mocked(api.outputFile).mockResolvedValue({ file: archived });
    vi.mocked(api.outputBlob).mockResolvedValue(
      new Blob(['%PDF-1.4 archived'], { type: 'application/pdf' }),
    );
    stubPdfUrls();

    await mount(
      '/chat?agent=agent-a&conversation=conversation-a&outputRun=run-archived&outputPath=report.pdf&outputMode=source',
    );
    await openWorkspace();
    await flush();

    expect(api.outputFile).toHaveBeenCalledWith(
      'conversation-a',
      'run-archived',
      'report.pdf',
      expect.any(AbortSignal),
    );
    expect(api.outputContent).not.toHaveBeenCalled();
    expect(vi.mocked(api.outputFile).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.outputBlob).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(api.outputBlob).toHaveBeenCalledWith(
      'conversation-a',
      'run-archived',
      'report.pdf',
      expect.any(AbortSignal),
    );
    expect(pdfPreview().getAttribute('title')).toBe('report.pdf');
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
      expect(host.querySelector('button[aria-label="隐藏会话成果"]') !== null).toBe(width >= 1280);
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
    expect(document.activeElement).toBe(host.querySelector('button[aria-label="打开会话成果"]'));
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

function turnWithText(text: string) {
  const turn = [...host.querySelectorAll<HTMLElement>('[data-message-id]')].find((element) =>
    element.textContent?.includes(text),
  );
  if (!turn) throw new Error(`Missing turn: ${text}`);
  return turn;
}

function runOutputButton(turn: HTMLElement, path: string) {
  const group = turn.querySelector<HTMLElement>('[aria-label="本轮成果"]');
  const button = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((item) =>
    item.textContent?.includes(path),
  );
  if (!button) throw new Error(`Missing run output: ${path}`);
  return button;
}

function multiTurnHistory(): ConversationDetail {
  return {
    conversation: { ...history.conversation, createdAt: '' },
    nextBefore: null,
    runMetrics: ['run-1', 'run-2'].map((runId) => ({
      runId,
      status: 'succeeded' as const,
      turns: 1,
      durationMs: 1000,
      endedAt: null,
      tokens: 10,
      costUsd: 0.001,
      error: null,
    })),
    messages: [
      {
        id: 'user-run-1',
        conversationId: 'conversation-a',
        role: 'user',
        content: 'first prompt',
        runId: 'run-1',
        createdAt: '',
      },
      {
        id: 'reply-run-1',
        conversationId: 'conversation-a',
        role: 'assistant',
        content: [{ type: 'text', text: 'first reply' }],
        runId: 'run-1',
        createdAt: '',
      },
      {
        id: 'user-run-2',
        conversationId: 'conversation-a',
        role: 'user',
        content: 'second prompt',
        runId: 'run-2',
        createdAt: '',
      },
      {
        id: 'reply-run-2',
        conversationId: 'conversation-a',
        role: 'assistant',
        content: [{ type: 'text', text: 'second reply' }],
        runId: 'run-2',
        createdAt: '',
      },
    ],
  };
}

describe('published outputs on message turns', () => {
  it('attaches each run to its own turn and opens the exact published version', async () => {
    vi.mocked(api.conversation).mockResolvedValue(multiTurnHistory());
    await mount();
    const first = turnWithText('first reply');
    const second = turnWithText('second reply');
    expect(first.querySelector('[aria-label="本轮成果"]')?.textContent).toContain('report.md');
    expect(second.querySelector('[aria-label="本轮成果"]')?.textContent).toContain('report.md');

    await act(async () => runOutputButton(first, 'report.md').click());
    await flush();
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-1',
      outputPath: 'report.md',
      outputMode: 'read',
    });
    expect(api.outputContent).toHaveBeenCalledWith(
      'conversation-a',
      'run-1',
      'report.md',
      expect.any(AbortSignal),
    );

    await act(async () => runOutputButton(second, 'report.md').click());
    await flush();
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-2',
      outputPath: 'report.md',
      outputMode: 'read',
    });
    expect(api.outputContent).toHaveBeenLastCalledWith(
      'conversation-a',
      'run-2',
      'report.md',
      expect.any(AbortSignal),
    );
  });

  it('keeps non-succeeded files with their real status instead of claiming delivery', async () => {
    vi.mocked(api.conversation).mockResolvedValue(multiTurnHistory());
    vi.mocked(api.outputs).mockResolvedValue({
      items: [
        reportLatest,
        output({ runId: 'run-2', path: 'failed.md', status: 'failed' }),
        output({ runId: 'run-2', path: 'cancelled.md', status: 'cancelled' }),
        output({ runId: 'run-2', path: 'timeout.md', status: 'timeout' }),
      ],
      nextBefore: null,
    });
    await mount();
    const group = turnWithText('second reply').querySelector('[aria-label="本轮成果"]');
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain('failed.md');
    expect(group?.textContent).toContain('失败');
    expect(group?.textContent).toContain('cancelled.md');
    expect(group?.textContent).toContain('已停止');
    expect(group?.textContent).toContain('timeout.md');
    expect(group?.textContent).toContain('超时');
    expect(group?.textContent).not.toContain('成功');
  });

  it('does not invent output entries for runs without published files', async () => {
    vi.mocked(api.conversation).mockResolvedValue(multiTurnHistory());
    vi.mocked(api.outputs).mockResolvedValue({ items: [reportLatest], nextBefore: null });
    await mount();
    expect(turnWithText('first reply').querySelector('[aria-label="本轮成果"]')).toBeNull();
    expect(
      turnWithText('second reply').querySelector('[aria-label="本轮成果"]')?.textContent,
    ).toContain('report.md');
  });

  it('keeps published outputs on their turns after maintenance cleared message run ids', async () => {
    const cleared = multiTurnHistory();
    vi.mocked(api.conversation).mockResolvedValue({
      ...cleared,
      messages: cleared.messages.map((message) => ({ ...message, runId: null })),
    });
    vi.mocked(api.outputs).mockResolvedValue({
      items: [
        output({
          runId: 'run-2',
          path: 'report.md',
          userMessageId: 'user-run-2',
          afterMessageId: 'reply-run-2',
          createdAt: '2026-10-28T10:00:00.000Z',
        }),
        output({
          runId: 'run-1',
          path: 'report.md',
          userMessageId: 'user-run-1',
          afterMessageId: 'reply-run-1',
          createdAt: '2026-10-28T09:00:00.000Z',
        }),
      ],
      nextBefore: null,
    });
    await mount();

    for (const text of ['first reply', 'second reply']) {
      expect(turnWithText(text).querySelector('[aria-label="本轮成果"]')?.textContent).toContain(
        'report.md',
      );
    }
    expect(turnWithText('first prompt').querySelector('[aria-label="本轮成果"]')).toBeNull();
    expect(turnWithText('second prompt').querySelector('[aria-label="本轮成果"]')).toBeNull();

    await act(async () => runOutputButton(turnWithText('first reply'), 'report.md').click());
    await flush();
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-1',
      outputPath: 'report.md',
      outputMode: 'read',
    });
  });

  it('shows an orphan failed user turn by its output anchor after run ids were cleared', async () => {
    const cleared = multiTurnHistory();
    vi.mocked(api.conversation).mockResolvedValue({
      ...cleared,
      runMetrics: [
        {
          runId: 'run-1',
          status: 'failed',
          turns: 1,
          durationMs: 1000,
          endedAt: null,
          tokens: 10,
          costUsd: 0.001,
          error: 'agent crashed',
        },
        ...(cleared.runMetrics ?? []).filter((metric) => metric.runId !== 'run-1'),
      ],
      messages: cleared.messages
        .filter((message) => message.id !== 'reply-run-1')
        .map((message) => ({ ...message, runId: null })),
    });
    vi.mocked(api.outputs).mockResolvedValue({
      items: [
        output({
          runId: 'run-2',
          path: 'report.md',
          userMessageId: 'user-run-2',
          afterMessageId: 'reply-run-2',
        }),
        output({
          runId: 'run-1',
          path: 'failed.md',
          status: 'failed',
          userMessageId: 'user-run-1',
          afterMessageId: 'user-run-1',
        }),
      ],
      nextBefore: null,
    });
    await mount();

    const failed = turnWithText('first prompt').querySelector('[aria-label="本轮成果"]');
    expect(failed?.textContent).toContain('failed.md');
    expect(failed?.textContent).toContain('失败');
    // 用户轮已就地显示成果，后续没有助手回复的那一轮不能重复出现。
    expect(turnWithText('second prompt').querySelector('[aria-label="本轮成果"]')).toBeNull();
    expect(
      turnWithText('second reply').querySelector('[aria-label="本轮成果"]')?.textContent,
    ).toContain('report.md');
  });

  it('maps branch message ids through manifest anchors after fork', async () => {
    vi.mocked(api.conversation).mockResolvedValue({
      conversation: { ...history.conversation, createdAt: '' },
      nextBefore: null,
      runMetrics: [],
      messages: [
        {
          id: 'branch-user-1',
          conversationId: 'conversation-a',
          role: 'user',
          content: 'first prompt',
          runId: null,
          createdAt: '',
        },
        {
          id: 'branch-reply-1',
          conversationId: 'conversation-a',
          role: 'assistant',
          content: [{ type: 'text', text: 'first reply' }],
          runId: null,
          createdAt: '',
        },
      ],
    });
    vi.mocked(api.outputs).mockResolvedValue({
      items: [
        output({
          runId: 'run-1',
          path: 'report.md',
          userMessageId: 'branch-user-1',
          afterMessageId: 'branch-reply-1',
        }),
      ],
      nextBefore: null,
    });
    await mount();

    const reply = turnWithText('first reply');
    expect(reply.querySelector('[aria-label="本轮成果"]')?.textContent).toContain('report.md');
    expect(turnWithText('first prompt').querySelector('[aria-label="本轮成果"]')).toBeNull();
    await act(async () => runOutputButton(reply, 'report.md').click());
    await flush();
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-1',
      outputPath: 'report.md',
    });
  });

  it('keeps a result-anchored output reachable on a tool turn after fork', async () => {
    vi.mocked(api.conversation).mockResolvedValue({
      conversation: { ...history.conversation, createdAt: '' },
      nextBefore: null,
      runMetrics: [],
      messages: [
        {
          id: 'branch-user',
          conversationId: 'conversation-a',
          role: 'user',
          content: 'write a report',
          runId: null,
          createdAt: '',
        },
        {
          id: 'branch-use',
          conversationId: 'conversation-a',
          role: 'tool',
          content: { type: 'tool_use', id: 'toolu-1', name: 'Write', input: {} },
          runId: null,
          createdAt: '',
        },
        {
          id: 'branch-result',
          conversationId: 'conversation-a',
          role: 'tool',
          content: { type: 'tool_result', toolUseId: 'toolu-1', name: 'Write', content: 'written' },
          runId: null,
          createdAt: '',
        },
      ],
    });
    vi.mocked(api.outputs).mockResolvedValue({
      items: [
        output({
          runId: 'run-1',
          path: 'report.md',
          userMessageId: 'branch-user',
          afterMessageId: 'branch-result',
        }),
      ],
      nextBefore: null,
    });
    await mount();

    // 用户轮后面还有工具轮，成果只能落在工具轮；结果消息锚点必须能命中，且只出现一次。
    const groups = host.querySelectorAll('[aria-label="本轮成果"]');
    expect(groups).toHaveLength(1);
    const toolTurn = host.querySelector<HTMLElement>('[data-message-id="branch-use:0"]');
    if (!toolTurn) throw new Error('Missing tool turn');
    expect(toolTurn.querySelector('[aria-label="本轮成果"]')).toBe(groups[0]);

    await act(async () => runOutputButton(toolTurn, 'report.md').click());
    await flush();
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-1',
      outputPath: 'report.md',
      outputMode: 'read',
    });
    expect(api.outputContent).toHaveBeenCalledWith(
      'conversation-a',
      'run-1',
      'report.md',
      expect.any(AbortSignal),
    );
  });

  it('keeps run id priority and shows a result-anchored output once', async () => {
    const messages = [
      {
        id: 'use-run-1',
        conversationId: 'conversation-a',
        role: 'tool',
        content: { type: 'tool_use', id: 'toolu-1', name: 'Write', input: {} },
        runId: 'run-1',
        createdAt: '',
      },
      {
        id: 'result-run-1',
        conversationId: 'conversation-a',
        role: 'tool',
        content: { type: 'tool_result', toolUseId: 'toolu-1', name: 'Write', content: 'written' },
        runId: 'run-1',
        createdAt: '',
      },
    ];
    vi.mocked(api.conversation).mockResolvedValue({
      conversation: { ...history.conversation, createdAt: '' },
      nextBefore: null,
      runMetrics: [],
      messages: [
        {
          id: 'user-run-1',
          conversationId: 'conversation-a',
          role: 'user',
          content: 'write a report',
          runId: 'run-1',
          createdAt: '',
        },
        ...messages,
      ],
    });
    vi.mocked(api.outputs).mockResolvedValue({
      items: [
        output({
          runId: 'run-1',
          path: 'report.md',
          userMessageId: 'use-run-1',
          afterMessageId: 'result-run-1',
        }),
      ],
      nextBefore: null,
    });
    await mount();

    // run_id 可用时按 run 归属，结果锚点不会再把同一份文件加一遍。
    expect(host.querySelectorAll('[aria-label="本轮成果"]')).toHaveLength(1);
    const toolTurn = host.querySelector<HTMLElement>('[data-message-id="use-run-1:0"]');
    if (!toolTurn) throw new Error('Missing tool turn');
    const rows = [...toolTurn.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('report.md'),
    );
    expect(rows).toHaveLength(1);

    await act(async () => runOutputButton(toolTurn, 'report.md').click());
    await flush();
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-1',
      outputPath: 'report.md',
    });
  });

  it('does not duplicate a turn output when run ids and anchors both match', async () => {
    vi.mocked(api.conversation).mockResolvedValue(multiTurnHistory());
    vi.mocked(api.outputs).mockResolvedValue({
      items: [
        output({
          runId: 'run-2',
          path: 'report.md',
          userMessageId: 'user-run-2',
          afterMessageId: 'reply-run-2',
        }),
        output({
          runId: 'run-1',
          path: 'report.md',
          userMessageId: 'user-run-1',
          afterMessageId: 'reply-run-1',
        }),
      ],
      nextBefore: null,
    });
    await mount();

    // 两个助手轮各一组，用户轮不重复显示同一份成果。
    expect(host.querySelectorAll('[aria-label="本轮成果"]')).toHaveLength(2);
    for (const text of ['first prompt', 'second prompt']) {
      expect(turnWithText(text).querySelector('[aria-label="本轮成果"]')).toBeNull();
    }
  });

  it('pages older published outputs only through the explicit load-more action', async () => {
    vi.mocked(api.conversation).mockResolvedValue(multiTurnHistory());
    vi.mocked(api.outputs)
      .mockResolvedValueOnce({ items: [reportLatest], nextBefore: 'cursor-1' })
      .mockResolvedValueOnce({ items: [reportOlder], nextBefore: null });
    await mount();
    expect(api.outputs).toHaveBeenCalledTimes(1);
    expect(turnWithText('first reply').querySelector('[aria-label="本轮成果"]')).toBeNull();

    const more = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '加载更多成果',
    );
    if (!more) throw new Error('Missing load-more outputs action');
    await act(async () => more.click());
    await flush();

    expect(vi.mocked(api.outputs)).toHaveBeenLastCalledWith(
      'conversation-a',
      { limit: 50, before: 'cursor-1' },
      expect.any(AbortSignal),
    );
    expect(api.outputs).toHaveBeenCalledTimes(2);
    expect(
      turnWithText('first reply').querySelector('[aria-label="本轮成果"]')?.textContent,
    ).toContain('report.md');
  });

  it.each([1440, 1152])(
    'opens the workspace when a turn output is selected at %ipx',
    async (width) => {
      viewportWidth = width;
      vi.mocked(api.conversation).mockResolvedValue(multiTurnHistory());
      await mount();
      // 收起状态下不预取正文：只有用户真的选中成果才请求。
      expect(host.querySelector('button[aria-label="打开会话成果"]')).not.toBeNull();
      expect(api.outputContent).not.toHaveBeenCalled();

      await act(async () => runOutputButton(turnWithText('first reply'), 'report.md').click());
      await flush();

      expect(host.querySelector('button[aria-label="隐藏会话成果"]')).not.toBeNull();
      expect(document.querySelector('[role="dialog"]') !== null).toBe(width < 1280);
      // 宽屏内联面板展开后不再 inert，正文对键盘与读屏都可见。
      expect(workspace().closest('[inert]')).toBeNull();
      expect(workspace().textContent).toContain('Older report');
    },
  );

  it('shows a failed run outputs on the user turn that never got an assistant reply', async () => {
    const historyWithUnansweredRun = multiTurnHistory();
    vi.mocked(api.conversation).mockResolvedValue({
      ...historyWithUnansweredRun,
      runMetrics: [
        {
          runId: 'run-1',
          status: 'failed',
          turns: 1,
          durationMs: 1000,
          endedAt: null,
          tokens: 10,
          costUsd: 0.001,
          error: 'agent crashed',
        },
        ...(historyWithUnansweredRun.runMetrics ?? []).filter((metric) => metric.runId !== 'run-1'),
      ],
      messages: [
        {
          id: 'user-run-1',
          conversationId: 'conversation-a',
          role: 'user',
          content: 'first prompt',
          runId: 'run-1',
          createdAt: '',
        },
        {
          id: 'user-run-2',
          conversationId: 'conversation-a',
          role: 'user',
          content: 'second prompt',
          runId: 'run-2',
          createdAt: '',
        },
        {
          id: 'reply-run-2',
          conversationId: 'conversation-a',
          role: 'assistant',
          content: [{ type: 'text', text: 'second reply' }],
          runId: 'run-2',
          createdAt: '',
        },
      ],
    });
    vi.mocked(api.outputs).mockResolvedValue({
      items: [output({ runId: 'run-1', path: 'failed.md', status: 'failed' }), reportLatest],
      nextBefore: null,
    });
    await mount();

    const firstTurn = turnWithText('first prompt');
    const failed = firstTurn.querySelector('[aria-label="本轮成果"]');
    expect(failed?.textContent).toContain('failed.md');
    expect(failed?.textContent).toContain('失败');
    // 只在没有助手行的那一轮补成果，避免同一份文件在相邻轮重复出现。
    expect(turnWithText('second prompt').querySelector('[aria-label="本轮成果"]')).toBeNull();
    expect(
      turnWithText('second reply').querySelector('[aria-label="本轮成果"]')?.textContent,
    ).toContain('report.md');
  });

  it('does not show an orphan load-more action when the latest turn has no outputs', async () => {
    vi.mocked(api.conversation).mockResolvedValue(multiTurnHistory());
    vi.mocked(api.outputs).mockResolvedValue({ items: [], nextBefore: 'cursor-1' });
    await mount();
    expect(host.querySelector('[aria-label="本轮成果"]')).toBeNull();
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button')].some(
        (button) => button.textContent?.trim() === '加载更多成果',
      ),
    ).toBe(false);
  });

  it('shows the current run outputs on the live turn once the run finishes', async () => {
    vi.spyOn(api, 'sendChat').mockResolvedValue({
      runId: 'run-3',
      conversationId: 'conversation-a',
    });
    await mount();
    await type('finish it');
    const submit = host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]');
    if (!submit) throw new Error('Missing send button');
    await act(async () => submit.click());
    await flush();

    const stream = Source.instances.at(-1);
    if (!stream) throw new Error('Missing event stream');
    vi.mocked(api.outputs).mockResolvedValue({
      items: [output({ runId: 'run-3', path: 'final.md', createdAt: '2026-10-28T12:00:00.000Z' })],
      nextBefore: null,
    });
    await act(async () => {
      stream.emit({ type: 'text_delta', text: 'finished reply' });
      stream.emit({ type: 'run_finished', status: 'succeeded' });
    });
    await flush();
    await flush();

    const turn = turnWithText('finished reply');
    expect(turn.querySelector('[aria-label="本轮成果"]')?.textContent).toContain('final.md');
    await act(async () => runOutputButton(turn, 'final.md').click());
    await flush();
    expect(router.state.location.search).toMatchObject({
      outputRun: 'run-3',
      outputPath: 'final.md',
      outputMode: 'read',
    });
  });

  it('keeps a failed outputs query retryable without faking an empty result', async () => {
    vi.mocked(api.conversation).mockResolvedValue(multiTurnHistory());
    vi.mocked(api.outputs).mockRejectedValue(new Error('outputs unavailable'));
    await mount();
    expect(host.querySelector('[aria-label="本轮成果"]')).toBeNull();
    await openWorkspace();
    expect(workspace().textContent).toContain('outputs unavailable');
    expect(
      [...workspace().querySelectorAll<HTMLButtonElement>('button')].some(
        (button) => button.textContent?.trim() === '重试',
      ),
    ).toBe(true);
  });
});

describe('default expert selection', () => {
  const other = { ...agent, id: 'agent-b', slug: 'other', name: 'Other Expert' };

  function useTwoAgents() {
    client.setQueryData(['agents'], [agent, other]);
    vi.mocked(api.agents).mockResolvedValue([agent, other]);
  }

  it('shows a real history empty state on bare /chat instead of a permanent skeleton', async () => {
    await mount('/chat');
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="显示会话历史"]');
    if (!toggle) throw new Error('Missing history toggle');
    await act(async () => toggle.click());
    await flush();

    const panel = host.querySelector<HTMLElement>('aside[aria-label="会话历史"]');
    if (!panel) throw new Error('Missing history panel');
    expect(panel.querySelector('[aria-busy="true"]')).toBeNull();
    expect(panel.textContent).toContain('先选择专家');
    expect(api.conversations).not.toHaveBeenCalled();

    // 专家选择随历史展开进入面板头部；历史仍显示真实空态。
    const picker = panel.querySelector<HTMLButtonElement>('button[aria-label="选择专家"]');
    if (!picker) throw new Error('Missing history header expert picker');
    expect(host.querySelectorAll('button[aria-label="选择专家"]')).toHaveLength(1);
    await act(async () => picker.click());
    await flush();
    const choice = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.includes(agent.name),
    );
    if (!choice) throw new Error('Missing expert option');
    await act(async () => choice.click());
    await flush();

    expect(api.conversations).toHaveBeenCalledWith(agent.id, expect.any(AbortSignal));
    expect(panel.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('waits for an explicit expert on bare /chat instead of selecting the first one', async () => {
    useTwoAgents();
    await mount('/chat');
    expect(router.state.location.search).toEqual({});
    const picker = host.querySelector<HTMLButtonElement>('button[aria-label="选择专家"]');
    expect(picker?.textContent).toContain('选择专家');
    expect(picker?.textContent).not.toContain(agent.name);
    expect(message().disabled).toBe(true);

    await act(async () => picker?.click());
    await flush();
    const choice = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.includes(other.name),
    );
    if (!choice) throw new Error('Missing expert option');
    await act(async () => choice.click());
    await flush();
    expect(router.state.location.search).toEqual({ agent: 'agent-b' });
    expect(message().disabled).toBe(false);
  });

  it('keeps the expert named in the URL when no conversation is open', async () => {
    useTwoAgents();
    await mount('/chat?agent=agent-b');
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="选择专家：Other Expert"]'),
    ).not.toBeNull();
    expect(router.state.location.search).toEqual({ agent: 'agent-b' });
  });

  it('keeps an existing conversation owned by its server-side expert', async () => {
    useTwoAgents();
    await mount('/chat?agent=agent-b&conversation=conversation-a');
    await flush();
    expect(router.state.location.search).toMatchObject({
      agent: 'agent-a',
      conversation: 'conversation-a',
    });
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="选择专家：Expert"]'),
    ).not.toBeNull();
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
