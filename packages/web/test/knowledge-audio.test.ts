import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { HttpResponse, http } from 'msw';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  KnowledgeProfilesDialog,
  KnowledgeSettingsDialog,
} from '../src/components/knowledge-settings.js';
import { locatorLabel } from '../src/components/knowledge-shared.js';
import { toastError } from '../src/lib/toast.js';
import { KnowledgePage } from '../src/pages/knowledge.js';
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail.js';
import { allAccessMe } from './me-fixture.js';
import { createMsw, runCleanup } from './msw.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const base = {
  id: 'kb_1',
  slug: 'handbook',
  name: '产品手册',
  description: '',
  serverId: 'srv_1',
  status: 'active',
  embeddingProfileId: 'profile_embed',
  rerankProfileId: null,
  asrProfileId: 'profile_asr',
  settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const embeddingProfile = {
  id: 'profile_embed',
  kind: 'embedding',
  name: 'bge-m3',
  endpointUrl: 'https://models.example.com',
  model: 'bge-m3',
  dimensions: 1024,
  enabled: true,
  hasSecret: true,
  embeddingProtocol: 'openai',
  imageInputEnabled: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const asrProfile = {
  id: 'profile_asr',
  kind: 'asr',
  name: 'whisper-1',
  endpointUrl: 'https://api.example.com/v1/audio/transcriptions',
  model: 'whisper-1',
  dimensions: null,
  enabled: true,
  hasSecret: false,
  embeddingProtocol: 'openai',
  imageInputEnabled: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const disabledAsrProfile = {
  ...asrProfile,
  id: 'profile_asr_off',
  name: 'whisper-off',
  enabled: false,
};

function profileSelection(profile: { id: string; name: string; kind: string; enabled: boolean }) {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    enabled: profile.enabled,
    supportsImageVectors: false,
  };
}

/** `/model-profiles` 按 view=selection 返回安全的精简选择项，管理视图才返回完整 profile。 */
function profilesHandler(
  profiles: Array<{
    id: string;
    name: string;
    kind: string;
    enabled: boolean;
    imageInputEnabled: boolean;
  }>,
) {
  return http.get('/api/knowledge/model-profiles', ({ request }) =>
    new URL(request.url).searchParams.get('view') === 'selection'
      ? HttpResponse.json(profiles.map(profileSelection))
      : HttpResponse.json(profiles),
  );
}

const audioDocument = {
  id: 'kdoc_1',
  baseId: 'kb_1',
  folderId: null,
  title: '会议录音',
  sourceType: 'upload',
  sourceUrl: null,
  sourcePath: null,
  mimeType: 'audio/mpeg',
  sizeBytes: 1024,
  status: 'ready',
  currentVersionId: 'kdv_2',
  tags: [],
  lastSyncedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const audioMetadata = {
  protocol: 'openai_transcriptions',
  profileName: 'whisper-1',
  model: 'whisper-1',
  durationMs: 1500,
  segments: [],
};

const audioVersion = {
  id: 'kdv_2',
  documentId: 'kdoc_1',
  version: 2,
  origin: 'source',
  parentVersionId: null,
  metadata: { audio: audioMetadata },
  sourceRevision: null,
  parseStatus: 'parsed',
  originalFilename: 'meeting.mp3',
  mimeType: 'audio/mpeg',
  sizeBytes: 1024,
  isCurrent: true,
  createdAt: '2026-01-02T00:00:00Z',
};

const timedAudioVersion = {
  ...audioVersion,
  id: 'kdv_old',
  version: 1,
  isCurrent: false,
  metadata: {
    audio: {
      ...audioMetadata,
      segments: [{ startOffset: 0, endOffset: 4, timeFromMs: 0, timeToMs: 1500 }],
    },
  },
  createdAt: '2026-01-01T00:00:00Z',
};

function markdownResponse(text: string) {
  return HttpResponse.text(text, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}

function apiHandlers() {
  server.use(
    http.get('/api/auth/me', () => HttpResponse.json(allAccessMe)),
    http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [base], nextCursor: null })),
    http.get('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)),
    http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/tags', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/documents', () =>
      HttpResponse.json({ items: [audioDocument], nextCursor: null }),
    ),
    http.get('/api/knowledge/bases/kb_1/sources', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/documents/kdoc_1', () => HttpResponse.json(audioDocument)),
    http.get('/api/knowledge/documents/kdoc_1/versions', () =>
      HttpResponse.json({ items: [audioVersion, timedAudioVersion], nextCursor: null }),
    ),
    http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/versions/:versionId/markdown', () =>
      markdownResponse('会议转录正文。'),
    ),
    http.get('/api/knowledge/versions/:versionId/details', ({ params }) =>
      HttpResponse.json({
        id: params.versionId,
        documentId: 'kdoc_1',
        version: 2,
        originalFilename: 'meeting.mp3',
        mimeType: 'audio/mpeg',
        sizeBytes: 1024,
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [],
        createdAt: '2026-01-02T00:00:00Z',
      }),
    ),
    http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/knowledge/wiki-pages/:pageId/links', () =>
      HttpResponse.json({ outgoing: [], incoming: [] }),
    ),
    http.get('/api/knowledge/model-profiles', () => HttpResponse.json([])),
    http.get('/api/agents', () => HttpResponse.json([])),
    http.put('/api/knowledge/bases/kb_1/documents/upload', () =>
      HttpResponse.json({ documentId: 'kdoc_new', jobId: 'kjob_new' }),
    ),
  );
}

const msw = createMsw();
const { server, calls } = msw;

beforeAll(() => msw.listen());

afterAll(() => msw.close());

beforeEach(() => {
  msw.reset();
  server.use(http.get('/api/auth/me', () => HttpResponse.json(allAccessMe)));
  vi.mocked(toastError).mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

let client: QueryClient | undefined;
let host: HTMLDivElement | undefined;
let root: Root | undefined;

async function cleanup() {
  const mountedRoot = root,
    mountedClient = client,
    mountedHost = host;
  root = client = host = undefined;
  await runCleanup([
    () => mountedRoot && act(async () => mountedRoot.unmount()),
    () => mountedClient?.clear(),
    () => mountedHost?.remove(),
    () => msw.waitForRequests(),
    () => vi.restoreAllMocks(),
    () => vi.unstubAllGlobals(),
    () => msw.assertClean(),
  ]);
}

afterEach(() => cleanup());

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await msw.waitForRequests();
}

async function waitFor(probe: () => boolean, tries = 60): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (probe()) return;
    await flush();
  }
  expect(probe()).toBe(true);
}

async function mountRoute(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const list = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/',
    validateSearch: z.object({
      q: z.string().optional(),
      sort: z.enum(['newest', 'name']).optional(),
    }),
    component: KnowledgePage,
  });
  const detail = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/$baseId',
    validateSearch: z.object({ panel: z.string().optional(), document: z.string().optional() }),
    component: KnowledgeDetailPage,
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([list, detail])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return router;
}

async function mountElement(element: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute({ component: () => element });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

function dialog(title: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
  if (!element) throw new Error(`Missing dialog: ${title}`);
  return element;
}

async function fill(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing field: ${id}`);
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function chooseOption(id: string, optionLabel: string) {
  const trigger = document.getElementById(id);
  if (!trigger) throw new Error(`Missing select: ${id}`);
  await click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent?.trim() === optionLabel,
  );
  if (!option) throw new Error(`Missing option: ${optionLabel}`);
  await click(option);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function chooseFile(input: HTMLInputElement, file: File) {
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

describe('knowledge audio locator label', () => {
  it('prints the real millisecond range, keeps zero and aligns hours on both ends', () => {
    expect(locatorLabel({ timeFromMs: 0, timeToMs: 1500 })).toBe('00:00.000–00:01.500');
    expect(locatorLabel({ timeFromMs: 0, timeToMs: 0 })).toBe('00:00.000–00:00.000');
    expect(locatorLabel({ timeFromMs: 3_599_999, timeToMs: 3_600_000 })).toBe(
      '00:59:59.999–01:00:00.000',
    );
  });

  it('does not invent time when the locator has none', () => {
    expect(locatorLabel({ pageFrom: 2 })).toBe('第 2 页');
    expect(locatorLabel(null)).toBeNull();
  });
});

describe('knowledge audio base binding', () => {
  it('creates a base with the selected ASR profile and guards an ASR-only draft', async () => {
    apiHandlers();
    server.use(
      profilesHandler([embeddingProfile, asrProfile, disabledAsrProfile]),
      http.post('/api/knowledge/bases', () =>
        HttpResponse.json({ ...base, id: 'kb_new', slug: 'new-base', name: '新库' }),
      ),
      // 创建成功后主 #132 会直接进入详情，详情查询也要有对应 handler。
      http.get('/api/knowledge/bases/kb_new', () =>
        HttpResponse.json({ ...base, id: 'kb_new', slug: 'new-base', name: '新库' }),
      ),
      http.get('/api/knowledge/bases/kb_new/folders', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_new/tags', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_new/documents', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    await mountRoute('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    // 主 #132 的建库弹层把模型与分块参数收进高级设置。
    await click(button('高级设置', creator));
    const asrSelect = document.getElementById('knowledge-asr');
    expect(asrSelect).not.toBeNull();
    await chooseOption('knowledge-asr', 'whisper-1');
    expect(asrSelect?.textContent).toContain('whisper-1');

    // 只改音频转录也算草稿，取消要先确认。
    await click(button('取消', creator));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('取消', dialog('放弃未保存的更改？')));

    await fill('knowledge-name', '新库');
    await fill('knowledge-slug', 'new-base');
    // 只有一个启用的 embedding 时是只读展示，不渲染可选控件。
    expect(document.getElementById('knowledge-embedding')).toBeNull();
    expect(creator.textContent).toContain('bge-m3');
    expect(calls.some((item) => item.path === '/api/knowledge/model-profiles?view=selection')).toBe(
      true,
    );
    await click(button('创建', creator));
    expect(
      calls.find((item) => item.method === 'POST' && item.path === '/api/knowledge/bases')?.body,
    ).toMatchObject({ asrProfileId: 'profile_asr', embeddingProfileId: 'profile_embed' });
  });

  it('keeps a bound disabled ASR visible as disabled and saves null when turned off', async () => {
    const boundBase = { ...base, asrProfileId: disabledAsrProfile.id };
    server.use(
      profilesHandler([embeddingProfile, asrProfile, disabledAsrProfile]),
      http.patch('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ ...boundBase, asrProfileId: null }),
      ),
    );
    await mountElement(
      createElement(KnowledgeSettingsDialog, {
        base: boundBase,
        onClose: vi.fn(),
        finalFocus: () => null,
      }),
    );
    const asrSelect = document.getElementById('knowledge-settings-asr');
    expect(asrSelect?.textContent).toContain('whisper-off');
    await click(asrSelect as HTMLElement);
    const disabledOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.includes('whisper-off'),
    );
    expect(
      disabledOption?.getAttribute('aria-disabled') === 'true' ||
        disabledOption?.hasAttribute('data-disabled'),
    ).toBe(true);
    const noneOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === '不启用',
    );
    if (!noneOption) throw new Error('Missing ASR off option');
    await click(noneOption);

    await click(button('取消'));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('取消', dialog('放弃未保存的更改？')));

    await click(button('保存设置'));
    expect(
      calls.find((item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1')
        ?.body,
    ).toMatchObject({ asrProfileId: null });
  });
});

describe('knowledge ASR model profile', () => {
  it('shows the fixed protocol without a paid test call and submits only ASR fields', async () => {
    const request = deferred<void>();
    server.use(
      profilesHandler([asrProfile]),
      http.post('/api/knowledge/model-profiles', async () => {
        await request.promise;
        return HttpResponse.json(asrProfile);
      }),
    );
    await mountElement(
      createElement(KnowledgeProfilesDialog, { onClose: vi.fn(), finalFocus: () => null }),
    );

    expect(document.body.textContent).toContain('OpenAI 转录（段级时间）');
    expect(document.body.textContent).toContain('请通过上传音频验证');
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('button')].some(
        (item) => item.textContent?.trim() === '测试',
      ),
    ).toBe(false);
    expect(
      calls.some(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/model-profiles/profile_asr/test',
      ),
    ).toBe(false);

    await click(button('新增 profile'));
    await chooseOption('knowledge-profile-kind', 'ASR 转录');
    expect(document.getElementById('knowledge-profile-protocol')).toBeNull();
    expect(document.getElementById('knowledge-profile-image-input')).toBeNull();
    expect(document.getElementById('knowledge-profile-enabled')).not.toBeNull();
    expect(document.body.textContent).toContain('协议固定为 OpenAI 转录（段级时间）。');

    await click(button('保存'));
    expect(document.body.textContent).toContain('请填写 profile 名称');
    expect(document.body.textContent).toContain('请填写 Endpoint URL');
    expect(document.body.textContent).toContain('请填写模型 ID');
    expect(
      calls.some((item) => item.method === 'POST' && item.path === '/api/knowledge/model-profiles'),
    ).toBe(false);

    await fill('knowledge-profile-name', 'whisper-1');
    await fill('knowledge-profile-endpoint', 'https://api.example.com/v1/audio/transcriptions');
    await fill('knowledge-profile-model', 'whisper-1');
    await fill('knowledge-profile-key', 'sk-test');
    await click(document.getElementById('knowledge-profile-enabled') as HTMLElement);
    await click(button('保存'));
    expect(button('保存中…').disabled).toBe(true);
    expect(button('取消').disabled).toBe(true);
    expect(
      calls.some(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/model-profiles/profile_asr/test',
      ),
    ).toBe(false);

    await act(async () => request.resolve());
    await flush();
    expect(
      calls.find((item) => item.method === 'POST' && item.path === '/api/knowledge/model-profiles')
        ?.body,
    ).toEqual({
      kind: 'asr',
      name: 'whisper-1',
      endpointUrl: 'https://api.example.com/v1/audio/transcriptions',
      model: 'whisper-1',
      apiKey: 'sk-test',
      enabled: false,
    });
  });
});

describe('knowledge audio upload', () => {
  it('keeps both generic upload inputs open to every format and checks 25 MB for audio', async () => {
    apiHandlers();
    server.use(http.get('/api/knowledge/model-profiles', () => HttpResponse.json([asrProfile])));
    await mountRoute('/knowledge/kb_1');
    expect(document.body.textContent).toContain('上传后会调用已配置的转录模型');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="选择要上传的文件"]');
    const folderInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="选择要上传的文件夹"]',
    );
    if (!input || !folderInput) throw new Error('Missing upload inputs');
    // 通用入口不能收窄成音频；DOM 上没有 accept 说明 PDF/Markdown 等格式仍可选。
    expect(input.getAttribute('accept')).toBeNull();
    expect(folderInput.getAttribute('accept')).toBeNull();

    const oversized = new File(['a'], 'meeting.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(oversized, 'size', { value: 25_000_001 });
    await chooseFile(input, oversized);
    await waitFor(() => vi.mocked(toastError).mock.calls.length > 0);
    expect(String(vi.mocked(toastError).mock.calls[0]?.[0])).toContain('音频超过 25 MB');
    expect(
      calls.some(
        (item) =>
          item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
      ),
    ).toBe(false);

    vi.mocked(toastError).mockClear();
    const atLimit = new File(['a'], 'meeting.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(atLimit, 'size', { value: 25_000_000 });
    await chooseFile(input, atLimit);
    await waitFor(() =>
      calls.some(
        (item) =>
          item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
      ),
    );
    expect(
      calls.find(
        (item) =>
          item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
      )?.body,
    ).toMatchObject({ filename: 'meeting.mp3', mimeType: 'audio/mpeg' });
  });
});

describe('knowledge audio reading', () => {
  it('downloads the exact version and marks no-time audio only when segments are absent', async () => {
    apiHandlers();
    await mountRoute('/knowledge/kb_1');
    await click(button('会议录音'));
    const viewer = dialog('会议录音');
    await flush();
    expect(viewer.textContent).toContain('会议转录正文。');
    expect(viewer.textContent).toContain('无时码');
    const current = viewer.querySelector<HTMLAnchorElement>('a[aria-label="下载音频原件"]');
    expect(current?.getAttribute('href')).toBe('/api/knowledge/versions/kdv_2/content');
    expect(current?.textContent).toContain('下载原件');

    const versionTrigger = viewer.querySelector<HTMLElement>('[aria-label="选择文档版本"]');
    if (!versionTrigger) throw new Error('Missing version picker');
    await click(versionTrigger);
    const oldOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === 'v1 · 来源解析',
    );
    if (!oldOption) throw new Error('Missing old audio version');
    await click(oldOption);
    await flush();
    expect(viewer.textContent).not.toContain('无时码');
    expect(
      viewer.querySelector<HTMLAnchorElement>('a[aria-label="下载音频原件"]')?.getAttribute('href'),
    ).toBe('/api/knowledge/versions/kdv_old/content');
  });

  it('shows the real chunk time code and keeps the page fallback', async () => {
    apiHandlers();
    server.use(
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({
          items: [
            {
              id: 'kchunk_audio',
              documentId: 'kdoc_1',
              versionId: 'kdv_2',
              ordinal: 0,
              kind: 'text',
              heading: null,
              content: '录音片段。',
              enabled: true,
              editedByUser: false,
              pageFrom: null,
              pageTo: null,
              locator: { timeFromMs: 0, timeToMs: 1500 },
              metadata: {},
            },
            {
              id: 'kchunk_page',
              documentId: 'kdoc_1',
              versionId: 'kdv_2',
              ordinal: 1,
              kind: 'text',
              heading: null,
              content: '分页片段。',
              enabled: true,
              editedByUser: false,
              pageFrom: 2,
              pageTo: 3,
              locator: null,
              metadata: {},
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    await mountRoute('/knowledge/kb_1');
    await click(button('会议录音'));
    const viewer = dialog('会议录音');
    await flush();
    expect(viewer.textContent).toContain('00:00.000–00:01.500');
    expect(viewer.textContent).toContain('第 2–3 页');
  });
});
