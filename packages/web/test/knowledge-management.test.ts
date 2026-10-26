import { EditorView } from '@codemirror/view';
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
import { toastError } from '../src/lib/toast.js';
import { KnowledgePage } from '../src/pages/knowledge.js';
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const base = {
  id: 'kb_1',
  slug: 'handbook',
  name: '产品手册',
  description: '内部知识',
  serverId: 'srv_1',
  status: 'active',
  embeddingProfileId: 'profile_1',
  rerankProfileId: null,
  settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const doc = {
  id: 'kdoc_1',
  baseId: 'kb_1',
  folderId: null,
  title: '上线流程',
  sourceType: 'upload',
  sourceUrl: null,
  sourcePath: null,
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  status: 'ready',
  currentVersionId: 'kdv_1',
  tags: ['流程'],
  lastSyncedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const chunk = {
  id: 'kchk_1',
  documentId: 'kdoc_1',
  versionId: 'kdv_1',
  ordinal: 0,
  kind: 'text',
  heading: '发布前检查',
  content: '发布前需要产品与研发双方确认。',
  enabled: true,
  editedByUser: true,
  pageFrom: 2,
  pageTo: 2,
  metadata: {},
};

const source = {
  id: 'ksrc_1',
  baseId: 'kb_1',
  type: 'gitlab',
  name: '产品仓库',
  config: {
    baseUrl: 'https://gitlab.example.com',
    projectId: '12',
    ref: 'main',
    syncDeletions: true,
  },
  hasSecret: true,
  status: 'active',
  syncCron: null,
  lastSyncAt: null,
  lastSyncStatus: null,
  lastError: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  ranges: [
    {
      id: 'krng_1',
      kind: 'gitlab_project',
      externalId: '12',
      ref: 'main',
      paths: ['docs'],
      enabled: true,
    },
  ],
};

const wikiPage = {
  id: 'kwp_1',
  baseId: 'kb_1',
  slug: 'release',
  title: '发布指南',
  status: 'published',
  currentVersionId: 'kwv_2',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  versions: [
    {
      id: 'kwv_2',
      pageId: 'kwp_1',
      version: 2,
      markdown: '## 当前\n\n第二步。',
      sourceChunkIds: ['kchk_1'],
      model: 'manual',
      generatedBy: 'manual',
      createdAt: '2026-01-02T00:00:00Z',
    },
    {
      id: 'kwv_1',
      pageId: 'kwp_1',
      version: 1,
      markdown: '## 旧版\n\n第一步。',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  nextCursor: null,
};

const { versions: _wikiVersions, nextCursor: _wikiNextCursor, ...wikiPageSummary } = wikiPage;

const state = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; body: unknown }>,
  handlers: {} as Record<
    string,
    (call: { method: string; path: string; body: unknown }) => unknown
  >,
  failures: {} as Record<string, { status: number; message: string }>,
}));

function handler(
  method: string,
  path: string,
  body: unknown | ((call: { method: string; path: string; body: unknown }) => unknown),
) {
  state.handlers[`${method} ${path}`] =
    typeof body === 'function'
      ? (body as (call: { method: string; path: string; body: unknown }) => unknown)
      : () => body;
}

function text(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
}

beforeEach(() => {
  state.calls.length = 0;
  state.handlers = {};
  state.failures = {};
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
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : null;
    const body =
      raw === null
        ? init?.body instanceof Blob
          ? { __blob: init.body.type }
          : undefined
        : (JSON.parse(raw) as unknown);
    state.calls.push({ method, path, body });
    const failure = state.failures[`${method} ${path}`];
    if (failure) {
      return Response.json(
        { code: 'CONFLICT', message: failure.message },
        { status: failure.status },
      );
    }
    const bare = path.split('?')[0] ?? path;
    const found = state.handlers[`${method} ${path}`] ?? state.handlers[`${method} ${bare}`];
    if (found) {
      const value = found({ method, path, body });
      return value instanceof Response ? value : Response.json(value);
    }
    return Response.json({ items: [], nextCursor: null });
  });
});

let client: QueryClient | undefined;
let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function mount(path: string, search: Record<string, string> = {}) {
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
    validateSearch: z.object({
      panel: z.string().optional(),
      page: z.string().optional(),
      folder: z.string().optional(),
    }),
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
    history: createMemoryHistory({
      initialEntries: [
        Object.keys(search).length ? `${path}?${new URLSearchParams(search)}` : path,
      ],
    }),
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

function dialog(title: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
  if (!element) throw new Error(`Missing dialog: ${title}`);
  return element;
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

async function openMenu(label: string) {
  const trigger = button(label);
  // Base UI 用 mousedown 打开菜单，jsdom 的 click() 不会触发。
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await flush();
}

async function chooseMenuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!item) throw new Error(`Missing menu item: ${label}`);
  await click(item);
}

async function fill(id: string, value: string) {
  const element = document.getElementById(id);
  if (element?.classList.contains('cm-content')) {
    // 手写正文用项目现成的 CodeMirror 编辑器，走它的 dispatch 才算真实输入。
    const view = EditorView.findFromDOM(element);
    if (!view) throw new Error(`Editor view not found: ${id}`);
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    });
    await flush();
    return;
  }
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing field: ${id}`);
  }
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function baseHandlers() {
  handler('GET', '/api/knowledge/bases', { items: [base], nextCursor: null });
  handler('GET', '/api/knowledge/bases/kb_1', base);
  handler('GET', '/api/knowledge/bases/kb_1/folders', []);
  handler('GET', '/api/knowledge/bases/kb_1/tags', [
    { id: 'ktag_1', baseId: 'kb_1', name: '流程', createdAt: '' },
  ]);
  handler('GET', '/api/knowledge/bases/kb_1/sources', { items: [source], nextCursor: null });
  handler('GET', '/api/knowledge/bases/kb_1/wiki-pages', {
    items: [wikiPageSummary],
    nextCursor: null,
  });
  handler('GET', '/api/knowledge/jobs', { items: [], nextCursor: null });
  handler('GET', '/api/knowledge/model-profiles', []);
  handler('GET', '/api/agents', []);
}

function patchBody(path: string) {
  return state.calls.find((item) => item.method === 'PATCH' && item.path === path)?.body;
}

describe('knowledge polling window', () => {
  it('keeps polling an active recent job but stops past its type timeout', async () => {
    const { knowledgeShouldPoll } = await import('../src/lib/queries.js');
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    expect(knowledgeShouldPoll(undefined)).toBe(false);
    expect(knowledgeShouldPoll([{ status: 'running', startedAt: now, createdAt: stale }])).toBe(
      true,
    );
    expect(knowledgeShouldPoll([{ status: 'running', startedAt: null, createdAt: stale }])).toBe(
      false,
    );
    expect(knowledgeShouldPoll([{ status: 'succeeded', startedAt: now, createdAt: now }])).toBe(
      false,
    );
  });

  it('uses the per-type timeout so a long ingest is not cut off at ten minutes', async () => {
    const { knowledgeShouldPoll } = await import('../src/lib/queries.js');
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
    // ingest 硬超时 30 分钟：20 分钟时仍在合法窗口内。
    expect(
      knowledgeShouldPoll([
        {
          status: 'running',
          type: 'ingest',
          startedAt: twentyMinutesAgo,
          createdAt: twentyMinutesAgo,
        },
      ]),
    ).toBe(true);
    // wiki_generate 硬超时 15 分钟：20 分钟时已不可能还在跑。
    expect(
      knowledgeShouldPoll([
        {
          status: 'running',
          type: 'wiki_generate',
          startedAt: twentyMinutesAgo,
          createdAt: twentyMinutesAgo,
        },
      ]),
    ).toBe(false);
  });
});

describe('knowledge library list', () => {
  it('offers creation and shows a single h1 when there is no base', async () => {
    handler('GET', '/api/knowledge/bases', { items: [], nextCursor: null });
    await mount('/knowledge');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.body.textContent).toContain('还没有知识库');
    expect(button('新建知识库')).toBeDefined();
  });

  it('links each base to its detail route with status and count', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', { items: [doc], nextCursor: null });
    await mount('/knowledge');
    const link = document.querySelector<HTMLAnchorElement>('a[href="/knowledge/kb_1"]');
    expect(link?.textContent).toContain('产品手册');
    expect(document.body.textContent).toContain('启用');
    expect(document.body.textContent).toContain('共 1 个知识库');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    // 列表不再逐库拉 200 条文档只为算数量。
    expect(
      state.calls.some(
        (item) =>
          item.path.startsWith('/api/knowledge/bases/kb_1/documents') &&
          item.path.includes('limit=200'),
      ),
    ).toBe(false);
  });

  it('pulls the remaining base pages so the count covers the whole library', async () => {
    handler('GET', '/api/knowledge/bases', ({ path }) =>
      path.includes('cursor=kb_cursor')
        ? {
            items: [{ ...base, id: 'kb_2', name: '研发手册', slug: 'engineering' }],
            nextCursor: null,
          }
        : { items: [base], nextCursor: 'kb_cursor' },
    );
    await mount('/knowledge');
    expect(document.body.textContent).toContain('研发手册');
    expect(document.body.textContent).toContain('共 2 个知识库');
    expect(state.calls.some((item) => item.path.includes('cursor=kb_cursor'))).toBe(true);
  });
});

describe('knowledge library lifecycle', () => {
  it('renames a base', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/bases/kb_1', { ...base, name: '研发手册' });
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('重命名');
    await fill('knowledge-base-name', '研发手册');
    await click(button('保存', dialog('重命名知识库')));
    expect(patchBody('/api/knowledge/bases/kb_1')).toEqual({ name: '研发手册' });
  });

  it('toggles base status without resending other settings', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/bases/kb_1', { ...base, status: 'disabled' });
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('停用');
    expect(patchBody('/api/knowledge/bases/kb_1')).toEqual({ status: 'disabled' });
  });

  it('names the experts that lose the binding before deleting', async () => {
    baseHandlers();
    handler('GET', '/api/agents', [
      { id: 'agent_1', name: '产品专家', serverIds: ['srv_1'] },
      { id: 'agent_2', name: '无关专家', serverIds: [] },
    ]);
    handler('DELETE', '/api/knowledge/bases/kb_1', {});
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('删除');
    const confirmation = dialog('删除知识库');
    expect(confirmation.textContent).toContain('产品专家');
    expect(confirmation.textContent).not.toContain('无关专家');
    await click(button('删除', confirmation));
    expect(
      state.calls.some(
        (item) => item.method === 'DELETE' && item.path === '/api/knowledge/bases/kb_1',
      ),
    ).toBe(true);
  });
});

describe('knowledge folder and tag management', () => {
  function folderHandlers() {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', {
      items: [doc],
      nextCursor: null,
    });
  }

  it('creates, renames and deletes folders', async () => {
    folderHandlers();
    handler('POST', '/api/knowledge/bases/kb_1/folders', {
      id: 'kfd_1',
      baseId: 'kb_1',
      parentId: null,
      name: '规范',
      path: '/规范',
      createdAt: '',
    });
    handler('PATCH', '/api/knowledge/folders/kfd_1', {
      id: 'kfd_1',
      baseId: 'kb_1',
      parentId: null,
      name: '研发规范',
      path: '/研发规范',
      createdAt: '',
    });
    handler('DELETE', '/api/knowledge/folders/kfd_1', {});
    await mount('/knowledge/kb_1');
    await click(button('新建文件夹'));
    await fill('knowledge-folder-name', '规范');
    await click(button('创建', dialog('新建文件夹')));
    expect(
      state.calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/folders',
      )?.body,
    ).toEqual({ parentId: null, name: '规范' });

    handler('GET', '/api/knowledge/bases/kb_1/folders', [
      { id: 'kfd_1', baseId: 'kb_1', parentId: null, name: '规范', path: '/规范', createdAt: '' },
    ]);
    await client.invalidateQueries({ queryKey: ['knowledge', 'folders', 'kb_1'] });
    await flush();
    await openMenu('文件夹操作 规范');
    await chooseMenuItem('重命名');
    await fill('knowledge-folder-name', '研发规范');
    await click(button('保存', dialog('重命名文件夹')));
    expect(patchBody('/api/knowledge/folders/kfd_1')).toEqual({ name: '研发规范' });

    await openMenu('文件夹操作 规范');
    await chooseMenuItem('删除');
    await click(button('删除', dialog('删除文件夹')));
    expect(
      state.calls.some(
        (item) => item.method === 'DELETE' && item.path === '/api/knowledge/folders/kfd_1',
      ),
    ).toBe(true);
  });

  it('adds and removes a tag', async () => {
    folderHandlers();
    handler('POST', '/api/knowledge/bases/kb_1/tags', {
      id: 'ktag_2',
      baseId: 'kb_1',
      name: '合规',
      createdAt: '',
    });
    handler('DELETE', '/api/knowledge/tags/ktag_1', {});
    await mount('/knowledge/kb_1');
    await click(button('管理标签'));
    await fill('knowledge-tag-name', '合规');
    await click(button('添加', dialog('管理标签')));
    expect(
      state.calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/tags',
      )?.body,
    ).toEqual({ name: '合规' });
    await click(button('删除标签 流程', dialog('管理标签')));
    await click(button('删除', dialog('删除标签')));
    expect(
      state.calls.some(
        (item) => item.method === 'DELETE' && item.path === '/api/knowledge/tags/ktag_1',
      ),
    ).toBe(true);
  });
});

describe('knowledge document inspection', () => {
  function documentHandlers() {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', {
      items: [doc],
      nextCursor: null,
    });
    handler('GET', '/api/knowledge/documents/kdoc_1', doc);
    handler('GET', '/api/knowledge/documents/kdoc_1/chunks', {
      items: [chunk],
      nextCursor: null,
    });
    handler('GET', '/api/knowledge/versions/kdv_1/markdown', () =>
      text('## 发布前检查\n\n发布前需要产品与研发双方确认。'),
    );
  }

  it('shows the original file, parsed text and toggles a chunk', async () => {
    documentHandlers();
    handler('PATCH', '/api/knowledge/chunks/kchk_1', { ...chunk, enabled: false });
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    expect(
      viewer.querySelector<HTMLAnchorElement>('a[href="/api/knowledge/versions/kdv_1/content"]'),
    ).not.toBeNull();
    await flush();
    expect(viewer.textContent).toContain('发布前需要产品与研发双方确认。');
    await click(button('停用分块 1', viewer));
    expect(patchBody('/api/knowledge/chunks/kchk_1')).toEqual({ enabled: false });
  });

  it('warns that reprocessing drops manually edited chunks and confirms it', async () => {
    documentHandlers();
    handler('POST', '/api/knowledge/documents/kdoc_1/reprocess', { jobId: 'kjob_1' });
    await mount('/knowledge/kb_1');
    await openMenu('操作 上线流程');
    await chooseMenuItem('重新解析');
    const confirmation = dialog('重新解析文档');
    expect(confirmation.textContent).toContain('人工编辑');
    await click(button('重新解析', confirmation));
    expect(
      state.calls.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/documents/kdoc_1/reprocess',
      )?.body,
    ).toEqual({ confirmOverwriteManualChunks: true });
  });

  it('keeps the edited chunk draft after a conflict and reloads only on request', async () => {
    documentHandlers();
    state.failures['PATCH /api/knowledge/chunks/kchk_1'] = {
      status: 409,
      message: '分块已被其他修改更新',
    };
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('编辑分块 1', dialog('上线流程')));
    const editor = dialog('编辑分块');
    await fill('knowledge-chunk-content', '修改后的内容');
    await click(button('保存', editor));
    expect(patchBody('/api/knowledge/chunks/kchk_1')).toEqual({ content: '修改后的内容' });
    expect(editor.textContent).toContain('分块已被其他修改更新');
    expect(button('重新加载', editor)).toBeDefined();
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-chunk-content')?.value).toBe(
      '修改后的内容',
    );
  });

  it('deletes a chunk after confirmation', async () => {
    documentHandlers();
    handler('DELETE', '/api/knowledge/chunks/kchk_1', {});
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('删除分块 1', dialog('上线流程')));
    await click(button('删除', dialog('删除分块')));
    expect(
      state.calls.some(
        (item) => item.method === 'DELETE' && item.path === '/api/knowledge/chunks/kchk_1',
      ),
    ).toBe(true);
  });

  it('labels image chunk roles and keeps image vectors out of text editing', async () => {
    documentHandlers();
    const imageMetadata = {
      image: { name: '图 1.png', mimeType: 'image/png', page: 3 },
      imageRole: 'vector',
    };
    handler('GET', '/api/knowledge/documents/kdoc_1/chunks', {
      items: [
        {
          ...chunk,
          id: 'kchk_ocr',
          kind: 'image',
          metadata: { ...imageMetadata, imageRole: 'ocr' },
        },
        {
          ...chunk,
          id: 'kchk_cap',
          kind: 'image',
          metadata: { ...imageMetadata, imageRole: 'caption' },
        },
        { ...chunk, id: 'kchk_vec', kind: 'image', metadata: imageMetadata },
      ],
      nextCursor: null,
    });
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    expect(viewer.textContent).toContain('OCR');
    expect(viewer.textContent).toContain('图片描述');
    expect(viewer.textContent).toContain('图片向量');
    await click(button('编辑分块 3', viewer));
    const editor = dialog('编辑分块');
    expect(editor.textContent).toContain('图片向量分块只能启停');
    expect(editor.querySelector('#knowledge-chunk-content')).toBeNull();
  });
});

describe('knowledge source editing', () => {
  it('deletes with an explicit choice between keeping and removing documents', async () => {
    baseHandlers();
    handler('DELETE', '/api/knowledge/sources/ksrc_1', {});
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('删除来源 产品仓库'));
    const confirmation = dialog('删除来源');
    expect(confirmation.textContent).toContain('保留但停用');
    await click(button('删除', confirmation));
    expect(
      state.calls.some(
        (item) =>
          item.method === 'DELETE' && item.path === '/api/knowledge/sources/ksrc_1?documents=keep',
      ),
    ).toBe(true);
  });

  it('keeps the stored credential when the field is left empty', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/sources/ksrc_1', source);
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    const secret = editor.querySelector<HTMLInputElement>('#knowledge-source-secret');
    expect(secret?.placeholder).toBe('留空保持原凭证');
    await click(button('保存', editor));
    const patch = patchBody('/api/knowledge/sources/ksrc_1') as {
      secrets?: unknown;
      config?: { syncDeletions?: boolean };
    };
    expect(patch).not.toHaveProperty('secrets');
    expect(patch.config?.syncDeletions).toBe(true);
  });

  it('rotates the credential when a new value is entered', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/sources/ksrc_1', source);
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    await fill('knowledge-source-secret', 'glpat-new');
    await click(button('保存', dialog('编辑来源')));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      secrets: { token: 'glpat-new' },
    });
  });

  it('sends the edited range instead of echoing the stored one back', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/sources/ksrc_1', source);
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await fill('source-range-0-external', '34');
    await click(button('保存', editor));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      ranges: [
        {
          kind: 'gitlab_project',
          externalId: '34',
          ref: 'main',
          paths: ['docs'],
          enabled: true,
        },
      ],
    });
  });

  it('adds a second range and saves both', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/sources/ksrc_1', source);
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(button('添加范围', editor));
    await fill('source-range-1-external', '56');
    await fill('source-range-1-ref', 'release');
    await fill('source-range-1-paths', 'src, docs');
    await click(button('保存', editor));
    expect(
      (patchBody('/api/knowledge/sources/ksrc_1') as { ranges: unknown[] }).ranges,
    ).toHaveLength(2);
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      ranges: [
        { externalId: '12', ref: 'main', paths: ['docs'], enabled: true },
        { externalId: '56', ref: 'release', paths: ['src', 'docs'], enabled: true },
      ],
    });
  });

  it('keeps the surviving range value and focus after deleting the first row', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/sources/ksrc_1', source);
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(button('添加范围', editor));
    await fill('source-range-1-external', '56');
    await fill('source-range-1-ref', 'release');
    const second = document.getElementById('source-range-1-external') as HTMLInputElement;
    await act(async () => second.focus());
    await click(button('删除范围 1', editor));
    const survivor = document.getElementById('source-range-0-external') as HTMLInputElement;
    expect(survivor.value).toBe('56');
    expect(document.activeElement).toBe(survivor);
    await click(button('保存', editor));
    const patch = patchBody('/api/knowledge/sources/ksrc_1') as {
      ranges: Array<Record<string, unknown>>;
    };
    expect(patch.ranges).toHaveLength(1);
    expect(patch.ranges[0]).toMatchObject({ externalId: '56', ref: 'release', paths: [] });
    expect(patch.ranges[0]).not.toHaveProperty('clientId');
  });

  it('blocks saving after the last range is removed', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/sources/ksrc_1', source);
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(button('删除范围 1', editor));
    expect(editor.textContent).toContain('至少需要一个范围');
    expect(button('保存', editor).disabled).toBe(true);
    await click(button('保存', editor));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toBeUndefined();
  });

  it('blocks saving when every remaining range is disabled', async () => {
    baseHandlers();
    handler('PATCH', '/api/knowledge/sources/ksrc_1', source);
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(editor.querySelector<HTMLElement>('#source-range-0-enabled') as HTMLElement);
    expect(editor.textContent).toContain('至少需要一个启用的范围');
    expect(button('保存', editor).disabled).toBe(true);
  });

  it('does not offer eviction-based deletion for a feed', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/sources', {
      items: [
        {
          ...source,
          id: 'ksrc_2',
          type: 'feed',
          name: '行业资讯',
          config: {},
          hasSecret: false,
          ranges: [
            {
              id: 'krng_2',
              kind: 'feed',
              externalId: 'https://example.com/feed.xml',
              ref: null,
              paths: [],
              enabled: true,
            },
          ],
        },
      ],
      nextCursor: null,
    });
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 行业资讯'));
    const editor = dialog('编辑来源');
    expect(editor.textContent).toContain('不会把条目滚出窗口当作删除');
    expect(editor.querySelector('#knowledge-source-sync-deletions')).toBeNull();
  });
  it('creates a source with the range entered in its single row', async () => {
    baseHandlers();
    handler('POST', '/api/knowledge/bases/kb_1/sources', { ...source, id: 'ksrc_new' });
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    const creator = dialog('新建来源');
    await fill('source-name', '研发空间');
    await fill('source-range-0-external', 'spc_9');
    await fill('source-app-id', 'cli_x');
    await fill('source-app-secret', 'secret');
    await click(button('创建', creator));
    expect(
      state.calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
      )?.body,
    ).toMatchObject({
      type: 'feishu_wiki',
      ranges: [{ kind: 'wiki_space', externalId: 'spc_9', enabled: true }],
    });
  });
});

describe('knowledge document metadata', () => {
  it('opens document properties from the viewer without losing the list', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', { items: [doc], nextCursor: null });
    handler('GET', '/api/knowledge/documents/kdoc_1/chunks', {
      items: [chunk],
      nextCursor: null,
    });
    handler('GET', '/api/knowledge/versions/kdv_1/markdown', () => text('正文'));
    handler('PATCH', '/api/knowledge/documents/kdoc_1', { ...doc, title: '上线流程 v2' });
    handler('GET', '/api/knowledge/bases/kb_1/tags', [
      { id: 'ktag_1', baseId: 'kb_1', name: '流程', createdAt: '' },
    ]);
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('编辑属性', dialog('上线流程')));
    const editor = dialog('编辑文档');
    await fill('document-title', '上线流程 v2');
    await click(button('保存', editor));
    expect(patchBody('/api/knowledge/documents/kdoc_1')).toMatchObject({
      title: '上线流程 v2',
      tags: ['流程'],
    });
  });
});

describe('knowledge manual and url import', () => {
  function documentList() {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', { items: [doc], nextCursor: null });
  }

  it('creates a manual document with title, content, folder and tags', async () => {
    documentList();
    handler('POST', '/api/knowledge/bases/kb_1/documents/manual', {
      documentId: 'kdoc_2',
      jobId: 'kjob_2',
    });
    await mount('/knowledge/kb_1');
    await click(button('导入文档'));
    await chooseMenuItem('手写文档');
    const editor = dialog('手写文档');
    await fill('knowledge-manual-title', '发布检查');
    await fill('knowledge-manual-content', '# 发布检查\n\n先确认');
    await fill('knowledge-manual-tags', '流程, 发布');
    await click(button('导入', editor));
    expect(
      state.calls.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/documents/manual',
      )?.body,
    ).toEqual({
      title: '发布检查',
      content: '# 发布检查\n\n先确认',
      folderId: null,
      tags: ['流程', '发布'],
    });
  });

  it('imports a URL into the current folder and keeps a readable error', async () => {
    documentList();
    handler('POST', '/api/knowledge/bases/kb_1/documents/url', {
      documentId: 'kdoc_3',
      jobId: 'kjob_3',
    });
    state.failures['POST /api/knowledge/bases/kb_1/documents/url'] = {
      status: 400,
      message: '目标地址返回重定向；请直接填写最终地址',
    };
    await mount('/knowledge/kb_1');
    await click(button('导入文档'));
    await chooseMenuItem('导入网址');
    const editor = dialog('导入网址');
    await fill('knowledge-url', 'https://example.com/docs');
    await click(button('导入', editor));
    expect(
      state.calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/documents/url',
      )?.body,
    ).toEqual({ url: 'https://example.com/docs', folderId: null });
    expect(toastError).toHaveBeenCalled();
  });
});

describe('knowledge package export and import', () => {
  it('downloads the exported zip through the normal api request', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/export', () => new Response(new Blob(['zip'])));
    const createObjectURL = vi.fn(() => 'blob:kit');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('导出知识包');
    await flush();
    expect(state.calls.some((item) => item.path === '/api/knowledge/bases/kb_1/export')).toBe(true);
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('shows the recoverable conflict when the imported profile is missing', async () => {
    handler('GET', '/api/knowledge/bases', { items: [], nextCursor: null });
    handler('POST', '/api/knowledge/bases/import', {});
    state.failures['POST /api/knowledge/bases/import'] = {
      status: 409,
      message: '缺少 embedding 模型 profile「bge-m3」；请先创建同名 profile 再导入',
    };
    await mount('/knowledge');
    await click(button('导入知识包'));
    const file = new File(['zip'], 'handbook.zip', { type: 'application/zip' });
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error('Missing file input');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(state.calls.find((item) => item.path === '/api/knowledge/bases/import')?.body).toEqual({
      __blob: 'application/zip',
    });
    // 文件留在页面上，说明原因并可原地重试。
    expect(document.body.textContent).toContain('知识包没有导入');
    expect(document.body.textContent).toContain('缺少 embedding 模型 profile');
    expect(button('重试')).toBeDefined();
  });
});

describe('knowledge source configuration check', () => {
  it('labels the local check as a configuration check, not a connection test', async () => {
    baseHandlers();
    handler('POST', '/api/knowledge/sources/ksrc_1/test', { ok: true, issues: [] });
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('检查配置'));
    expect(
      state.calls.some(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/sources/ksrc_1/test',
      ),
    ).toBe(true);
  });
});

describe('knowledge pagination', () => {
  it('loads the next document page and appends it', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', ({ path }) =>
      path.includes('cursor=kdoc_cursor')
        ? {
            items: [{ ...doc, id: 'kdoc_2', title: '第二页文档' }],
            nextCursor: null,
          }
        : { items: [doc], nextCursor: 'kdoc_cursor' },
    );
    await mount('/knowledge/kb_1');
    await click(button('加载更多文档'));
    expect(document.body.textContent).toContain('第二页文档');
    expect(state.calls.some((item) => item.path.includes('cursor=kdoc_cursor'))).toBe(true);
  });

  it('loads the next chunk page inside the document viewer', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', { items: [doc], nextCursor: null });
    handler('GET', '/api/knowledge/versions/kdv_1/markdown', () => text('正文'));
    handler('GET', '/api/knowledge/documents/kdoc_1/chunks', ({ path }) =>
      path.includes('cursor=kchk_cursor')
        ? {
            items: [{ ...chunk, id: 'kchk_2', ordinal: 1, content: '第二页分块内容' }],
            nextCursor: null,
          }
        : { items: [chunk], nextCursor: 'kchk_cursor' },
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('加载更多分块', dialog('上线流程')));
    expect(dialog('上线流程').textContent).toContain('第二页分块内容');
  });
});

describe('knowledge document viewer', () => {
  it('says a document without a parsed version has no chunks instead of querying an empty version', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', {
      items: [{ ...doc, status: 'pending', currentVersionId: null }],
      nextCursor: null,
    });
    await mount('/knowledge/kb_1');
    // 文档列表按需轮询，等待首屏数据落定再打开查看器。
    for (
      let attempt = 0;
      attempt < 20 &&
      ![...document.querySelectorAll('button')].some(
        (item) => item.textContent?.trim() === '上线流程',
      );
      attempt += 1
    ) {
      await flush();
    }
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    expect(viewer.textContent).toContain('还没有解析完成的版本');
    expect(viewer.textContent).toContain('还没有分块');
    expect(
      state.calls.some((item) => item.path.startsWith('/api/knowledge/documents/kdoc_1/chunks')),
    ).toBe(false);
  });

  it('surfaces a failed chunk toggle without pretending it succeeded', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', { items: [doc], nextCursor: null });
    handler('GET', '/api/knowledge/documents/kdoc_1/chunks', {
      items: [chunk],
      nextCursor: null,
    });
    handler('GET', '/api/knowledge/versions/kdv_1/markdown', () => text('正文'));
    state.failures['PATCH /api/knowledge/chunks/kchk_1'] = {
      status: 409,
      message: '分块已属于旧版本',
    };
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('停用分块 1', dialog('上线流程')));
    expect(toastError).toHaveBeenCalled();
  });
});

describe('knowledge search citations', () => {
  it('opens the parsed text of a hit with the quote highlighted and an original link', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/search', {
      hits: [
        {
          chunkId: 'kchk_1',
          documentId: 'kdoc_1',
          versionId: 'kdv_1',
          title: '上线流程',
          heading: '发布前检查',
          quote: '发布前需要产品与研发双方确认。',
          pageFrom: 2,
          pageTo: 2,
          sourceUrl: null,
          score: 0.82,
        },
      ],
      degraded: false,
    });
    handler('GET', '/api/knowledge/versions/kdv_1/markdown', () =>
      text('## 发布前检查\n\n发布前需要产品与研发双方确认。'),
    );
    await mount('/knowledge/kb_1', { panel: 'search' });
    await fill('knowledge-search', '发布');
    await act(async () => {
      document
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    await click(button('查看原文'));
    const viewer = dialog('引用原文');
    expect(
      viewer.querySelector<HTMLAnchorElement>('a[href="/api/knowledge/versions/kdv_1/content"]'),
    ).not.toBeNull();
    expect(viewer.querySelector('mark')?.textContent).toBe('发布前需要产品与研发双方确认。');
  });

  it('shows the hit image with the quote as alt text and explains a failed load', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/search', {
      hits: [
        {
          chunkId: 'kchk_img',
          documentId: 'kdoc_1',
          versionId: 'kdv_1',
          title: '上线流程',
          heading: null,
          quote: '发布前需要产品与研发双方确认。',
          pageFrom: 3,
          pageTo: 3,
          sourceUrl: null,
          score: 0.72,
          image: { name: '图 1.png', mimeType: 'image/png', page: 3 },
        },
      ],
      degraded: false,
    });
    handler('GET', '/api/knowledge/versions/kdv_1/markdown', () => text('正文'));
    handler(
      'GET',
      '/api/knowledge/versions/kdv_1/images/%E5%9B%BE%201.png',
      () => new Response(new Blob(['png'], { type: 'image/png' })),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await mount('/knowledge/kb_1', { panel: 'search' });
    await fill('knowledge-search', '发布');
    await act(async () => {
      document
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    await click(button('查看原文'));
    const viewer = dialog('引用原文');
    const image = viewer.querySelector<HTMLImageElement>('img');
    expect(image?.getAttribute('src')).toBe('blob:image');
    expect(image?.getAttribute('alt')).toBe('发布前需要产品与研发双方确认。');
    expect(viewer.textContent).not.toContain('无权读取');
  });

  it('explains a revoked image with the 403 message instead of a generic failure', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/search', {
      hits: [
        {
          chunkId: 'kchk_img',
          documentId: 'kdoc_1',
          versionId: 'kdv_1',
          title: '上线流程',
          heading: null,
          quote: '发布前需要产品与研发双方确认。',
          pageFrom: 3,
          pageTo: 3,
          sourceUrl: null,
          score: 0.72,
          image: { name: '图 1.png', mimeType: 'image/png', page: 3 },
        },
      ],
      degraded: false,
    });
    handler('GET', '/api/knowledge/versions/kdv_1/markdown', () => text('正文'));
    handler('GET', '/api/knowledge/versions/kdv_1/images/%E5%9B%BE%201.png', () =>
      Response.json({ code: 'FORBIDDEN', message: '无权读取' }, { status: 403 }),
    );
    await mount('/knowledge/kb_1', { panel: 'search' });
    await fill('knowledge-search', '发布');
    await act(async () => {
      document
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    await click(button('查看原文'));
    const viewer = dialog('引用原文');
    expect(viewer.textContent).toContain('无权读取这张图片，或知识库已停用。');
    expect(viewer.querySelector('img')).toBeNull();
    expect(
      viewer.querySelector<HTMLAnchorElement>('a[href="/api/knowledge/versions/kdv_1/content"]'),
    ).not.toBeNull();
  });
});

describe('knowledge document upload', () => {
  function uploadHandlers() {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', { items: [doc], nextCursor: null });
  }

  it('uploads every selected file, reports failed ones and keeps going', async () => {
    uploadHandlers();
    handler('PUT', '/api/knowledge/bases/kb_1/documents/upload', ({ body }) => {
      const filename = (body as { filename: string }).filename;
      if (filename === 'bad.pdf') {
        return new Response(JSON.stringify({ code: 'CONFLICT', message: '同名文档已存在' }), {
          status: 409,
        });
      }
      return { documentId: 'kdoc_new', jobId: 'kjob_new' };
    });
    await mount('/knowledge/kb_1');
    await click(button('导入文档'));
    await chooseMenuItem('上传文件');
    const good = new File(['a'], 'good.txt', { type: 'text/plain' });
    const bad = new File(['b'], 'bad.pdf', { type: 'application/pdf' });
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="选择要上传的文件"]',
      );
      if (!input) throw new Error('Missing upload input');
      Object.defineProperty(input, 'files', { value: [good, bad], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // 等 FileReader 读完两个文件。
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await flush();
    const uploads = state.calls.filter(
      (item) => item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
    );
    expect(uploads).toHaveLength(2);
    expect(toastError).toHaveBeenCalled();
  });

  it('keeps the folder path visible when uploading a directory', async () => {
    uploadHandlers();
    handler('PUT', '/api/knowledge/bases/kb_1/documents/upload', {
      documentId: 'kdoc_new',
      jobId: 'kjob_new',
    });
    await mount('/knowledge/kb_1');
    await click(button('导入文档'));
    await chooseMenuItem('上传文件夹');
    const nested = new File(['a'], 'spec.txt', { type: 'text/plain' });
    Object.defineProperty(nested, 'webkitRelativePath', { value: 'docs/spec.txt' });
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="选择要上传的文件夹"]',
      );
      if (!input) throw new Error('Missing folder input');
      Object.defineProperty(input, 'files', { value: [nested], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await flush();
    const body = state.calls.find(
      (item) => item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
    )?.body as { filename: string; title?: string } | undefined;
    // 相对路径保留为文件名，并写进标题；后端不会按路径自动建目录树。
    expect(body?.filename).toBe('docs/spec.txt');
    expect(body?.title).toBe('docs/spec');
  });
});

describe('knowledge wiki versions', () => {
  it('lists the real version shape and rolls back to an older version', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/wiki-pages/kwp_1', () => wikiPage);
    handler('POST', '/api/knowledge/wiki-pages/kwp_1/rollback', wikiPage.versions[1]);
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    expect(document.body.textContent).toContain('v2');
    expect(document.body.textContent).toContain('v1');
    await click(button('回退到此版本'));
    await click(button('回退', dialog('回退 Wiki 版本')));
    expect(
      state.calls.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/wiki-pages/kwp_1/rollback',
      )?.body,
    ).toEqual({ versionId: 'kwv_1' });
  });

  it('keeps the version captured on open even after a background refetch, and keeps the draft on 409', async () => {
    baseHandlers();
    let currentVersionId = 'kwv_2';
    handler('GET', '/api/knowledge/wiki-pages/kwp_1', () => ({
      ...wikiPage,
      currentVersionId,
      versions:
        currentVersionId === 'kwv_2'
          ? wikiPage.versions
          : [
              {
                id: 'kwv_3',
                pageId: 'kwp_1',
                version: 3,
                markdown: '## 别人刚发布\n\n第三步。',
                sourceChunkIds: [],
                model: 'manual',
                generatedBy: 'manual',
                createdAt: '2026-01-03T00:00:00Z',
              },
              ...wikiPage.versions,
            ],
    }));
    state.failures['PATCH /api/knowledge/wiki-pages/kwp_1'] = {
      status: 409,
      message: 'Wiki 页面已被修改，请刷新后重试',
    };
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    await fill('knowledge-wiki-markdown', '## 我的草稿');

    // 另一个窗口发布了 v3：后台刷新把页面当前版本推进到 v3。
    currentVersionId = 'kwv_3';
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'wiki-page', 'kwp_1'] });
    });
    await flush();
    expect(document.body.textContent).toContain('v3');
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 我的草稿',
    );

    await click(button('保存', editor));
    expect(patchBody('/api/knowledge/wiki-pages/kwp_1')).toEqual({
      markdown: '## 我的草稿',
      expectedVersion: 'kwv_2',
    });
    expect(editor.textContent).toContain('Wiki 页面已被修改，请刷新后重试');
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 我的草稿',
    );
    expect(toastError).not.toHaveBeenCalled();

    const detailCalls = () =>
      state.calls.filter((item) => item.path === '/api/knowledge/wiki-pages/kwp_1').length;
    const before = detailCalls();
    await click(button('重新加载', editor));
    await click(button('重新加载', dialog('重新加载 Wiki 正文')));
    expect(detailCalls()).toBeGreaterThan(before);
    expect(document.querySelector('#knowledge-wiki-markdown')).toBeNull();
    expect(document.body.textContent).toContain('第三步。');
  });

  it('loads every wiki page page so older pages stay selectable', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/wiki-pages', ({ path }) =>
      path.includes('cursor=kwp_cursor')
        ? {
            items: [{ ...wikiPageSummary, id: 'kwp_old', title: '旧页面', slug: 'old' }],
            nextCursor: null,
          }
        : { items: [wikiPageSummary], nextCursor: 'kwp_cursor' },
    );
    await mount('/knowledge/kb_1', { panel: 'wiki' });
    expect(state.calls.some((item) => item.path.includes('cursor=kwp_cursor'))).toBe(true);
    expect(document.body.textContent).toContain('旧页面');
  });
});

describe('knowledge source pagination', () => {
  it('loads every source page so older sources can still be edited or synced', async () => {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/sources', ({ path }) =>
      path.includes('cursor=ksrc_cursor')
        ? {
            items: [{ ...source, id: 'ksrc_old', name: '旧仓库' }],
            nextCursor: null,
          }
        : { items: [source], nextCursor: 'ksrc_cursor' },
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    expect(state.calls.some((item) => item.path.includes('cursor=ksrc_cursor'))).toBe(true);
    expect(document.body.textContent).toContain('旧仓库');
    expect(document.body.textContent).toContain('2 个来源');
  });
});

describe('knowledge version images', () => {
  function imageDocHandlers() {
    baseHandlers();
    handler('GET', '/api/knowledge/bases/kb_1/documents', { items: [doc], nextCursor: null });
    handler('GET', '/api/knowledge/documents/kdoc_1/chunks', { items: [chunk], nextCursor: null });
    handler('GET', '/api/knowledge/versions/kdv_1/markdown', () => text('正文'));
    handler('GET', '/api/knowledge/versions/kdv_1/details', {
      id: 'kdv_1',
      documentId: 'kdoc_1',
      version: 1,
      originalFilename: 'release.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      sourceRevision: null,
      parseStatus: 'parsed',
      pageMap: [{ page: 2, startOffset: 0, endOffset: 4 }],
      images: [
        { name: '白图 1.png', sha256: 'abc', mimeType: 'image/png', page: 2 },
        { name: 'chart.png', sha256: 'def', mimeType: 'image/png', page: 5 },
      ],
      createdAt: '2026-01-01T00:00:00Z',
    });
  }

  it('renders the extracted images with their page numbers and the whitelisted image URL', async () => {
    imageDocHandlers();
    for (const name of ['%E7%99%BD%E5%9B%BE%201.png', 'chart.png']) {
      handler(
        'GET',
        `/api/knowledge/versions/kdv_1/images/${name}`,
        () => new Response(new Blob(['png'], { type: 'image/png' })),
      );
    }
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:one').mockReturnValue('blob:two');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    await flush();
    const images = [...viewer.querySelectorAll<HTMLImageElement>('img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual(['blob:one', 'blob:two']);
    expect(state.calls.some((call) => call.path.includes('/images/chart.png'))).toBe(true);
    expect(viewer.textContent).toContain('第 2 页');
    expect(viewer.textContent).toContain('第 5 页');
    expect(
      viewer.querySelector<HTMLAnchorElement>('a[href="/api/knowledge/versions/kdv_1/content"]'),
    ).not.toBeNull();
  });

  it('states a missing image instead of leaving a blank placeholder and keeps the original link', async () => {
    imageDocHandlers();
    handler('GET', '/api/knowledge/versions/kdv_1/images/%E7%99%BD%E5%9B%BE%201.png', () =>
      Response.json({ code: 'NOT_FOUND', message: '图片不存在' }, { status: 404 }),
    );
    handler('GET', '/api/knowledge/versions/kdv_1/images/chart.png', () =>
      Response.json({ code: 'NOT_FOUND', message: '图片不存在' }, { status: 404 }),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    await flush();
    expect(viewer.textContent).toContain('图片已删除或不存在，请重新解析该版本。');
    expect(viewer.querySelectorAll('img')).toHaveLength(0);
  });
});
