import type { KnowledgeJob } from '@agentport/shared';
import { PERMISSIONS } from '@agentport/shared';
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
import { delay, HttpResponse, http } from 'msw';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useKnowledgeSearch } from '../src/lib/queries.js';
import { toastError, toastSuccess } from '../src/lib/toast.js';
import { KnowledgePage } from '../src/pages/knowledge.js';
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail.js';
import { allAccessMe } from './me-fixture.js';
import { createMsw, runCleanup } from './msw.js';

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

function wikiJob(status: KnowledgeJob['status'], id = 'kjob_gen'): KnowledgeJob {
  const now = new Date().toISOString();
  return {
    id,
    type: 'wiki_generate',
    status,
    step: status === 'running' ? '生成中' : null,
    progress: status === 'succeeded' ? 100 : 0,
    attempts: 1,
    error: null,
    createdAt: now,
    startedAt: now,
    endedAt: status === 'succeeded' ? now : null,
    documentId: null,
    sourceId: null,
    documentTitle: null,
    sourceName: null,
  };
}

function syncJob(status: KnowledgeJob['status'], id = 'kjob_sync'): KnowledgeJob {
  const now = new Date().toISOString();
  return {
    id,
    type: 'sync',
    status,
    step: status === 'running' ? '同步中' : null,
    progress: status === 'succeeded' ? 100 : 0,
    attempts: 1,
    error: status === 'failed' ? '远端凭证失效' : null,
    createdAt: now,
    startedAt: now,
    endedAt: status === 'running' ? null : now,
    documentId: null,
    sourceId: null,
    documentTitle: null,
    sourceName: null,
  };
}

const msw = createMsw();
const { server, calls } = msw;

beforeAll(() => msw.listen());

afterAll(() => msw.close());

function mockMe() {
  server.use(http.get('/api/auth/me', () => HttpResponse.json(allAccessMe)));
}

beforeEach(() => {
  msw.reset();
  mockMe();
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

async function cleanup(unmount?: () => Promise<void>) {
  const mountedRoot = root,
    mountedClient = client,
    mountedHost = host;
  root = client = host = undefined;
  await runCleanup([
    unmount ?? (() => mountedRoot && act(async () => mountedRoot.unmount())),
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

/** 条件轮询推进真实异步（FileReader、请求），不靠固定睡眠猜时长。 */
async function waitFor(probe: () => boolean, tries = 60): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (probe()) return;
    await flush();
  }
  expect(probe()).toBe(true);
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
      document: z.string().optional(),
      source: z.string().optional(),
      q: z.string().optional(),
      folders: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      kinds: z.array(z.enum(['document', 'faq', 'wiki'])).optional(),
      rerank: z.boolean().optional(),
      minVectorScore: z.number().optional(),
      onlyRecommended: z.boolean().optional(),
      faqPriority: z.boolean().optional(),
      faqDirectAnswerThreshold: z.number().optional(),
      diagnostics: z.boolean().optional(),
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

function dialogShown(title: string): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
    (item) => item.querySelector('h2')?.textContent === title,
  );
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

/** 来源类型行按钮同时包含名称与能力说明，按包含匹配。 */
function sourceChoice(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!element) throw new Error(`Missing source choice: ${label}`);
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

async function chooseFilter(label: string, optionLabel: string) {
  const trigger = [...document.querySelectorAll<HTMLElement>('button')].find(
    (element) => element.getAttribute('aria-label') === label,
  );
  if (!trigger) throw new Error(`Missing filter: ${label}`);
  await click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent?.trim() === optionLabel,
  );
  if (!option) throw new Error(`Missing filter option: ${optionLabel}`);
  await click(option);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function markdownResponse(body: string): Response {
  return HttpResponse.text(body, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}

function detailsHandler() {
  return http.get('/api/knowledge/versions/kdv_1/details', () =>
    HttpResponse.json({
      id: 'kdv_1',
      documentId: 'kdoc_1',
      version: 1,
      originalFilename: 'release.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      sourceRevision: null,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      createdAt: '2026-01-01T00:00:00Z',
    }),
  );
}

function baseHandlers() {
  server.use(
    http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [base], nextCursor: null })),
    http.get('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)),
    http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/tags', () =>
      HttpResponse.json([{ id: 'ktag_1', baseId: 'kb_1', name: '流程', createdAt: '' }]),
    ),
    http.get('/api/knowledge/bases/kb_1/sources', () =>
      HttpResponse.json({ items: [source], nextCursor: null }),
    ),
    http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
      HttpResponse.json({ items: [wikiPageSummary], nextCursor: null }),
    ),
    http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/knowledge/model-profiles', () => HttpResponse.json([])),
    http.get('/api/knowledge/documents/:documentId/versions', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/versions/:versionId/details', ({ params }) =>
      HttpResponse.json({
        id: params.versionId,
        documentId: 'kdoc_1',
        version: 1,
        originalFilename: 'note.md',
        mimeType: 'text/markdown',
        sizeBytes: 10,
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [],
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ),
    http.get('/api/knowledge/wiki-pages/:pageId/links', () =>
      HttpResponse.json({ outgoing: [], incoming: [] }),
    ),
    http.get('/api/agents', () => HttpResponse.json([])),
  );
}

function patchBody(path: string) {
  return calls.find((item) => item.method === 'PATCH' && item.path === path)?.body;
}

/** 详情页基线：库、文件夹、标签、来源、Wiki、任务与专家摘要都可读。 */
function documentList(documents: unknown[] = [doc]) {
  baseHandlers();
  server.use(
    http.get('/api/knowledge/bases/kb_1/documents', () =>
      HttpResponse.json({ items: documents, nextCursor: null }),
    ),
    http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('# 正文')),
    detailsHandler(),
    http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
      HttpResponse.json({ items: [chunk], nextCursor: null }),
    ),
  );
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
    server.use(
      http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.body.textContent).toContain('还没有知识库');
    expect(button('新建知识库')).toBeDefined();
  });

  it('links each base to its detail route with status and count', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
    await mount('/knowledge');
    const card = document.querySelector<HTMLElement>('[data-slot="card"]');
    const links = card?.querySelectorAll<HTMLAnchorElement>('a[href="/knowledge/kb_1"]') ?? [];
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link.getAttribute('aria-label')).toContain('产品手册');
    expect(card?.textContent).toContain('产品手册');
    expect(card?.textContent).toContain('内部知识');
    expect(document.body.textContent).toContain('启用');
    expect(document.body.textContent).toContain('共 1 个知识库');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    // 列表不再逐库拉 200 条文档只为算数量。
    expect(
      calls.some(
        (item) =>
          item.path.startsWith('/api/knowledge/bases/kb_1/documents') &&
          item.path.includes('limit=200'),
      ),
    ).toBe(false);
  });

  it('covers the whole card with the detail link while keeping the action menu separate', async () => {
    baseHandlers();
    const router = await mount('/knowledge');
    const card = document.querySelector<HTMLElement>('[data-slot="card"]');
    const link = card?.querySelector<HTMLAnchorElement>('a[href="/knowledge/kb_1"]');
    // 覆盖整卡：入口是 Card 的直接子节点并铺满整卡，描述与页脚也在点击范围内，
    // 而不是只有标题可点。
    expect(link?.parentElement).toBe(card);
    expect(link?.className).toContain('absolute');
    expect(link?.className).toContain('inset-0');
    expect(card?.querySelectorAll('a')).toHaveLength(1);

    await openMenu('操作 产品手册');
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
    expect(router.state.location.pathname).toBe('/knowledge');
  });

  it('pulls the remaining base pages so the count covers the whole library', async () => {
    server.use(
      http.get('/api/knowledge/bases', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'kb_cursor'
          ? HttpResponse.json({
              items: [{ ...base, id: 'kb_2', name: '研发手册', slug: 'engineering' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [base], nextCursor: 'kb_cursor' }),
      ),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    expect(document.body.textContent).toContain('研发手册');
    expect(document.body.textContent).toContain('共 2 个知识库');
    expect(calls.some((item) => item.path.includes('cursor=kb_cursor'))).toBe(true);
  });
});

describe('knowledge library lifecycle', () => {
  it('renames a base', async () => {
    baseHandlers();
    server.use(
      http.patch('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ ...base, name: '研发手册' }),
      ),
    );
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('重命名');
    await fill('knowledge-base-name', '研发手册');
    await click(button('保存', dialog('重命名知识库')));
    expect(patchBody('/api/knowledge/bases/kb_1')).toEqual({ name: '研发手册' });
  });

  it('toggles base status without resending other settings', async () => {
    baseHandlers();
    server.use(
      http.patch('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ ...base, status: 'disabled' }),
      ),
    );
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('停用');
    expect(patchBody('/api/knowledge/bases/kb_1')).toEqual({ status: 'disabled' });
  });

  it('names the experts that lose the binding before deleting', async () => {
    baseHandlers();
    server.use(
      http.get('/api/agents', () =>
        HttpResponse.json([
          { id: 'agent_1', name: '产品专家', serverIds: ['srv_1'] },
          { id: 'agent_2', name: '无关专家', serverIds: [] },
        ]),
      ),
      http.delete('/api/knowledge/bases/kb_1', () => HttpResponse.json({})),
    );
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('删除');
    const confirmation = dialog('删除知识库');
    expect(confirmation.textContent).toContain('产品专家');
    expect(confirmation.textContent).not.toContain('无关专家');
    await click(button('删除', confirmation));
    expect(
      calls.some((item) => item.method === 'DELETE' && item.path === '/api/knowledge/bases/kb_1'),
    ).toBe(true);
  });

  it('deletes a base with no bound experts without mentioning unbound experts', async () => {
    baseHandlers();
    server.use(
      http.get('/api/agents', () =>
        HttpResponse.json([{ id: 'agent_2', name: '无关专家', serverIds: [] }]),
      ),
      http.delete('/api/knowledge/bases/kb_1', () => HttpResponse.json({})),
    );
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('删除');
    const confirmation = dialog('删除知识库');
    expect(confirmation.textContent).not.toContain('解除与');
    expect(confirmation.textContent).not.toContain('无关专家');
    await click(button('删除', confirmation));
    expect(
      calls.some((item) => item.method === 'DELETE' && item.path === '/api/knowledge/bases/kb_1'),
    ).toBe(true);
  });
});

describe('knowledge folder and tag management', () => {
  function folderHandlers() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
  }

  it('creates, renames and deletes folders', async () => {
    folderHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/folders', () =>
        HttpResponse.json({
          id: 'kfd_1',
          baseId: 'kb_1',
          parentId: null,
          name: '规范',
          path: '/规范',
          createdAt: '',
        }),
      ),
      http.patch('/api/knowledge/folders/kfd_1', () =>
        HttpResponse.json({
          id: 'kfd_1',
          baseId: 'kb_1',
          parentId: null,
          name: '研发规范',
          path: '/研发规范',
          createdAt: '',
        }),
      ),
      http.delete('/api/knowledge/folders/kfd_1', () => HttpResponse.json({})),
    );
    await mount('/knowledge/kb_1');
    await click(button('新建文件夹'));
    await fill('knowledge-folder-name', '规范');
    await click(button('创建', dialog('新建文件夹')));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/folders',
      )?.body,
    ).toEqual({ parentId: null, name: '规范' });

    server.use(
      http.get('/api/knowledge/bases/kb_1/folders', () =>
        HttpResponse.json([
          {
            id: 'kfd_1',
            baseId: 'kb_1',
            parentId: null,
            name: '规范',
            path: '/规范',
            createdAt: '',
          },
        ]),
      ),
    );
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
      calls.some(
        (item) => item.method === 'DELETE' && item.path === '/api/knowledge/folders/kfd_1',
      ),
    ).toBe(true);
  });

  it('adds and removes a tag', async () => {
    folderHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/tags', () =>
        HttpResponse.json({ id: 'ktag_2', baseId: 'kb_1', name: '合规', createdAt: '' }),
      ),
      http.delete('/api/knowledge/tags/ktag_1', () => HttpResponse.json({})),
    );
    await mount('/knowledge/kb_1');
    await click(button('管理标签'));
    await fill('knowledge-tag-name', '合规');
    await click(button('添加', dialog('管理标签')));
    expect(
      calls.find((item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/tags')
        ?.body,
    ).toEqual({ name: '合规' });
    await click(button('删除标签 流程', dialog('管理标签')));
    await click(button('删除', dialog('删除标签')));
    expect(
      calls.some((item) => item.method === 'DELETE' && item.path === '/api/knowledge/tags/ktag_1'),
    ).toBe(true);
  });
});

describe('knowledge document inspection', () => {
  function documentHandlers() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_1', () => HttpResponse.json(doc)),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [chunk], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () =>
        markdownResponse('## 发布前检查\n\n发布前需要产品与研发双方确认。'),
      ),
      detailsHandler(),
    );
  }

  it('shows the original file, parsed text and toggles a chunk', async () => {
    documentHandlers();
    server.use(
      http.patch('/api/knowledge/chunks/kchk_1', () =>
        HttpResponse.json({ ...chunk, enabled: false }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    expect(
      viewer.querySelector<HTMLAnchorElement>('a[href="/api/knowledge/versions/kdv_1/content"]'),
    ).not.toBeNull();
    await flush();
    expect(viewer.textContent).toContain('发布前需要产品与研发双方确认。');
    await click(button('停用分块 1', viewer));
    expect(patchBody('/api/knowledge/chunks/kchk_1')).toEqual({
      enabled: false,
      expectedVersionId: 'kdv_1',
    });
  });

  it('reads loaded documents in one toolbar and keeps the selection while copying, switching modes and files', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    documentHandlers();
    const second = { ...doc, id: 'kdoc_2', title: '部署流程', currentVersionId: 'kdv_2' };
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc, second], nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_2/chunks', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_2/markdown', () =>
        markdownResponse('## 部署\n\n第二篇正文。'),
      ),
      http.get('/api/knowledge/versions/kdv_2/details', () =>
        HttpResponse.json({
          id: 'kdv_2',
          documentId: 'kdoc_2',
          version: 1,
          originalFilename: 'deploy.md',
          mimeType: 'text/markdown',
          sizeBytes: 10,
          sourceRevision: null,
          parseStatus: 'parsed',
          pageMap: [],
          images: [],
          createdAt: '2026-01-01T00:00:00Z',
        }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    let viewer = dialog('上线流程');
    expect(viewer.textContent).toContain('发布前需要产品与研发双方确认。');
    const download = viewer.querySelector<HTMLAnchorElement>('a[aria-label="下载原件"]');
    expect(download?.getAttribute('href')).toBe('/api/knowledge/versions/kdv_1/content');
    expect(download?.hasAttribute('download')).toBe(true);

    const copy = viewer.querySelector<HTMLButtonElement>('button[aria-label="复制 上线流程"]');
    if (!copy) throw new Error('Missing copy action');
    await act(async () => copy.click());
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('## 发布前检查\n\n发布前需要产品与研发双方确认。');

    await click(button('源码', viewer));
    viewer = dialog('上线流程');
    expect(viewer.querySelector('pre')?.textContent).toContain('## 发布前检查');

    const target = [...viewer.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes('部署流程'),
    );
    if (!target) throw new Error('Missing loaded document row');
    await click(target);
    viewer = dialog('部署流程');
    expect(viewer.textContent).toContain('第二篇正文。');
    expect(viewer.querySelector('[aria-current="true"]')?.textContent).toContain('部署流程');

    // 换文档后先看到新文档的复制动作，再复制新正文。
    const switchedCopy = viewer.querySelector<HTMLButtonElement>(
      'button[aria-label="复制 部署流程"]',
    );
    if (!switchedCopy) throw new Error('Missing copy action after switching documents');
    const copies = [...viewer.querySelectorAll<HTMLButtonElement>('button')].filter((item) =>
      item.getAttribute('aria-label')?.startsWith('复制'),
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]).toBe(switchedCopy);
    await act(async () => switchedCopy.click());
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('## 部署\n\n第二篇正文。');
  });

  it('warns that reprocessing drops manually edited chunks and confirms it', async () => {
    documentHandlers();
    server.use(
      http.post('/api/knowledge/documents/kdoc_1/reprocess', () =>
        HttpResponse.json({ jobId: 'kjob_1' }),
      ),
    );
    await mount('/knowledge/kb_1');
    await openMenu('操作 上线流程');
    await chooseMenuItem('重新解析');
    const confirmation = dialog('重新解析文档');
    expect(confirmation.textContent).toContain('人工编辑');
    await click(button('重新解析', confirmation));
    expect(
      calls.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/documents/kdoc_1/reprocess',
      )?.body,
    ).toEqual({ confirmOverwriteManualChunks: true });
  });

  it('keeps the edited chunk draft after a conflict and reloads only on request', async () => {
    documentHandlers();
    server.use(
      http.patch('/api/knowledge/chunks/kchk_1', () =>
        HttpResponse.json({ code: 'CONFLICT', message: '分块已被其他修改更新' }, { status: 409 }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('编辑分块 1', dialog('上线流程')));
    const editor = dialog('编辑分块');
    await fill('knowledge-chunk-content', '修改后的内容');
    await click(button('保存', editor));
    expect(patchBody('/api/knowledge/chunks/kchk_1')).toEqual({
      content: '修改后的内容',
      heading: '发布前检查',
      expectedVersionId: 'kdv_1',
    });
    expect(editor.textContent).toContain('分块已被其他修改更新');
    expect(button('重新加载', editor)).toBeDefined();
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-chunk-content')?.value).toBe(
      '修改后的内容',
    );
  });

  it('keeps an edited chunk draft through cancel and Escape until it is discarded', async () => {
    documentHandlers();
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('编辑分块 1', dialog('上线流程')));
    const editor = dialog('编辑分块');
    await fill('knowledge-chunk-content', '修改后的内容');

    await click(button('取消', editor));
    let confirmation = dialog('放弃未保存的更改？');
    expect(confirmation.textContent).toContain('分块正文草稿会丢失');
    await click(button('取消', confirmation));
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-chunk-content')?.value).toBe(
      '修改后的内容',
    );

    await act(async () =>
      dialog('编辑分块').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await flush();
    confirmation = dialog('放弃未保存的更改？');
    await click(button('取消', confirmation));
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-chunk-content')?.value).toBe(
      '修改后的内容',
    );

    await click(button('关闭', dialog('编辑分块')));
    confirmation = dialog('放弃未保存的更改？');
    await click(button('放弃并关闭', confirmation));
    expect(document.getElementById('knowledge-chunk-content')).toBeNull();
    expect(
      calls.some((item) => item.method === 'PATCH' && item.path === '/api/knowledge/chunks/kchk_1'),
    ).toBe(false);
  });

  it('asks before reloading a conflicted chunk over its draft', async () => {
    documentHandlers();
    server.use(
      http.patch('/api/knowledge/chunks/kchk_1', () =>
        HttpResponse.json({ code: 'CONFLICT', message: '分块已被其他修改更新' }, { status: 409 }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('编辑分块 1', dialog('上线流程')));
    const editor = dialog('编辑分块');
    await fill('knowledge-chunk-content', '修改后的内容');
    await click(button('保存', editor));
    await click(button('重新加载', editor));
    const confirmation = dialog('放弃未保存的更改？');
    expect(confirmation.textContent).toContain('覆盖当前草稿');
    await click(button('取消', confirmation));
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-chunk-content')?.value).toBe(
      '修改后的内容',
    );
  });

  it('reloads the server chunk and closes the editor after confirming the discard', async () => {
    documentHandlers();
    let reloaded = false;
    server.use(
      http.patch('/api/knowledge/chunks/kchk_1', () =>
        HttpResponse.json({ code: 'CONFLICT', message: '分块已被其他修改更新' }, { status: 409 }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({
          items: [reloaded ? { ...chunk, content: '服务端最新内容' } : chunk],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('编辑分块 1', dialog('上线流程')));
    const editor = dialog('编辑分块');
    await fill('knowledge-chunk-content', '修改后的内容');
    await click(button('保存', editor));
    reloaded = true;
    const chunkRequests = () =>
      calls.filter(
        (item) =>
          item.method === 'GET' && item.path.startsWith('/api/knowledge/documents/kdoc_1/chunks'),
      ).length;
    const requestsBefore = chunkRequests();
    await click(button('重新加载', editor));
    await click(button('放弃并重新加载', dialog('放弃未保存的更改？')));
    expect(chunkRequests()).toBeGreaterThan(requestsBefore);
    expect(document.getElementById('knowledge-chunk-content')).toBeNull();
    expect(dialog('上线流程').textContent).toContain('服务端最新内容');
  });

  it('deletes a chunk after confirmation', async () => {
    documentHandlers();
    server.use(http.delete('/api/knowledge/chunks/kchk_1', () => HttpResponse.json({})));
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('删除分块 1', dialog('上线流程')));
    await click(button('删除', dialog('删除分块')));
    expect(
      calls.some(
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
    server.use(
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({
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
        }),
      ),
    );
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

describe('knowledge source skipped-only runs', () => {
  it('always offers the per-item expander when every recorded item was skipped', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/sources/ksrc_1/runs', () =>
        HttpResponse.json({
          items: [
            {
              id: 'ksyn_1',
              sourceId: 'ksrc_1',
              status: 'succeeded',
              startedAt: '2026-01-01T00:00:00Z',
              endedAt: '2026-01-01T00:01:00Z',
              cursorBefore: null,
              cursorAfter: null,
              stats: { listed: 1, created: 0, updated: 0, disabled: 0, failed: 0 },
              error: null,
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/sources/ksrc_1/runs/ksyn_1/items', () =>
        HttpResponse.json({
          items: [
            {
              id: 'ksync_item_1',
              syncRunId: 'ksyn_1',
              sourceId: 'ksrc_1',
              rangeId: 'krng_1',
              documentId: null,
              externalId: 'unsupported.bin',
              status: 'skipped',
              code: 'UNSUPPORTED',
              message: '暂不支持该类型',
              retryable: false,
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('产品仓库'));
    await waitFor(() => document.body.textContent?.includes('逐项结果') === true);
    expect(document.body.textContent).toContain('逐项结果');
    expect(document.body.textContent).toContain('unsupported.bin');
    expect(document.body.textContent).toContain('跳过');
    expect(document.body.textContent).toContain('UNSUPPORTED');
  });
});

describe('knowledge source editing', () => {
  it('deletes with an explicit choice between keeping and removing documents', async () => {
    baseHandlers();
    server.use(http.delete('/api/knowledge/sources/ksrc_1', () => HttpResponse.json({})));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('删除来源 产品仓库'));
    const confirmation = dialog('删除来源');
    expect(confirmation.textContent).toContain('保留但停用');
    await click(button('删除', confirmation));
    expect(
      calls.some(
        (item) =>
          item.method === 'DELETE' && item.path === '/api/knowledge/sources/ksrc_1?documents=keep',
      ),
    ).toBe(true);
  });

  it('keeps the stored credential when the field is left empty', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
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
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    await fill('knowledge-source-secret', 'glpat-new');
    await click(button('保存', dialog('编辑来源')));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      secrets: { token: 'glpat-new' },
    });
  });

  it('keeps an auth_error status when no new credential is entered', async () => {
    baseHandlers();
    const broken = { ...source, status: 'auth_error' };
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [broken], nextCursor: null }),
      ),
      http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(broken)),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    await click(button('保存', dialog('编辑来源')));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).not.toHaveProperty('status');
  });

  it('reactivates an auth_error source when a new credential is entered', async () => {
    baseHandlers();
    const broken = { ...source, status: 'auth_error' };
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [broken], nextCursor: null }),
      ),
      http.patch('/api/knowledge/sources/ksrc_1', () =>
        HttpResponse.json({ ...broken, status: 'active' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    await fill('knowledge-source-secret', 'glpat-new');
    await click(button('保存', dialog('编辑来源')));
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toMatchObject({
      status: 'active',
      secrets: { token: 'glpat-new' },
    });
  });

  it('disables manual sync for a non-active source and explains why', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [{ ...source, status: 'paused' }], nextCursor: null }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    const syncButton = button('立即同步');
    expect(syncButton.disabled).toBe(true);
    expect(syncButton.title).toBe('来源未启用，无法同步');
  });

  it('disables manual sync while the submission is in flight', async () => {
    baseHandlers();
    const response = deferred<void>();
    server.use(
      http.post('/api/knowledge/sources/ksrc_1/sync', async () => {
        await response.promise;
        return HttpResponse.json({ jobId: 'kjob_1', syncRunId: 'ksyn_1' }, { status: 202 });
      }),
      http.get('/api/knowledge/sources/ksrc_1/runs', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/jobs/kjob_1', () => HttpResponse.json(syncJob('running', 'kjob_1'))),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('立即同步'));
    const syncButton = button('立即同步');
    expect(syncButton.disabled).toBe(true);
    expect(syncButton.title).toBe('正在提交同步任务');
    await act(async () => response.resolve());
    await flush();
  });

  it('sends the edited range instead of echoing the stored one back', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
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
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
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
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
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

  it('explains a missing range on submit instead of disabling save', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(button('删除范围 1', editor));
    expect(editor.textContent).toContain('至少需要一个范围');
    const save = button('保存', editor);
    expect(save.disabled).toBe(false);
    await click(save);
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toBeUndefined();
  });

  it('explains that every range is disabled on submit instead of disabling save', async () => {
    baseHandlers();
    server.use(http.patch('/api/knowledge/sources/ksrc_1', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await click(editor.querySelector<HTMLElement>('#source-range-0-enabled') as HTMLElement);
    expect(editor.textContent).toContain('至少需要一个启用的范围');
    const save = button('保存', editor);
    expect(save.disabled).toBe(false);
    await click(save);
    expect(patchBody('/api/knowledge/sources/ksrc_1')).toBeUndefined();
  });

  it('does not offer eviction-based deletion for a feed', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({
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
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 行业资讯'));
    const editor = dialog('编辑来源');
    expect(editor.textContent).toContain('不会把条目滚出窗口当作删除');
    expect(editor.querySelector('#knowledge-source-sync-deletions')).toBeNull();
  });
  it('creates a source with the range entered in its single row', async () => {
    baseHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ ...source, id: 'ksrc_new' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    await click(sourceChoice('飞书知识库', dialog('新建来源')));
    const creator = dialog('新建来源');
    await fill('source-name', '研发空间');
    await fill('source-range-0-external', 'spc_9');
    await fill('source-app-id', 'cli_x');
    await fill('knowledge-source-secret', 'secret');
    await click(button('创建', creator));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
      )?.body,
    ).toMatchObject({
      type: 'feishu_wiki',
      ranges: [{ kind: 'wiki_space', externalId: 'spc_9', enabled: true }],
    });
  });

  it('starts a new source with five provider choices and shows only that provider fields', async () => {
    baseHandlers();
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    const creator = dialog('新建来源');
    // 连接 + 范围 + 计划三块并排时 560px 太挤，与定时任务弹窗同宽。
    expect(creator.classList.contains('max-w-[760px]')).toBe(true);
    for (const label of ['GitHub', 'GitLab', '飞书知识库', '飞书云盘', 'RSS']) {
      expect(creator.textContent).toContain(label);
    }
    // 选择前不显示任何配置字段。
    expect(creator.querySelector('#source-name')).toBeNull();

    await click(sourceChoice('GitHub', creator));
    expect(creator.textContent).toContain('API 地址');
    expect((creator.querySelector('#source-github-api') as HTMLInputElement).placeholder).toBe(
      'https://api.github.com',
    );
    expect(creator.textContent).toContain('Access Token');
    expect(creator.textContent).toContain('仓库');
    expect(creator.textContent).toContain('仅同步文本文件');
    expect(creator.textContent).toContain('留空读取整个仓库');
    expect(creator.textContent).not.toContain('整个项目');
    expect(creator.textContent).toContain('Contents 只读权限');
    expect(creator.querySelector('#source-app-id')).toBeNull();

    await click(button('更换来源', creator));
    await click(sourceChoice('GitLab', creator));
    expect(creator.textContent).toContain('实例 URL');
    expect(creator.textContent).not.toContain('API 地址');
    expect(creator.textContent).toContain('仅同步文本文件');
    expect(creator.textContent).toContain('留空读取整个项目');
    expect(creator.textContent).not.toContain('整个仓库');
    expect(creator.textContent).not.toContain('Contents 只读权限');
    expect(creator.querySelector('#source-app-id')).toBeNull();

    await click(button('更换来源', creator));
    await click(sourceChoice('飞书知识库', creator));
    expect(creator.querySelector('#source-app-id')).toBeTruthy();
    expect(creator.querySelector('#knowledge-source-secret')).toBeTruthy();
    expect(creator.textContent).toContain('知识空间');
    expect(creator.textContent).not.toContain('Access Token');
  });

  it('clears the previous provider credentials and connection fields when switching', async () => {
    baseHandlers();
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    const creator = dialog('新建来源');
    await click(sourceChoice('GitHub', creator));
    await fill('source-name', '仓库');
    await fill('source-github-api', 'https://ghe.example.com/api/v3');
    await fill('source-range-0-external', 'acme/docs');
    await fill('knowledge-source-secret', 'ghp_secret');

    await click(button('更换来源', creator));
    await click(button('放弃并切换', dialog('放弃未保存的更改？')));
    await click(sourceChoice('GitLab', creator));
    // GitHub PAT / Enterprise 地址不能带进 GitLab。
    expect((document.getElementById('knowledge-source-secret') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('source-gitlab-url') as HTMLInputElement).value).toBe('');
    // 名称与已选类型保留，步进仍在配置页。
    expect((document.getElementById('source-name') as HTMLInputElement).value).toBe('仓库');
    expect(document.getElementById('source-range-0-external')).toBeTruthy();

    await click(button('更换来源', creator));
    await click(sourceChoice('飞书知识库', creator));
    expect((document.getElementById('source-app-id') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('knowledge-source-secret') as HTMLInputElement).value).toBe('');
  });

  it('opens the stored configuration directly when editing an existing source', async () => {
    baseHandlers();
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    expect((editor.querySelector('#source-name') as HTMLInputElement).value).toBe('产品仓库');
    expect((editor.querySelector('#source-gitlab-url') as HTMLInputElement).value).toBe(
      'https://gitlab.example.com',
    );
    // 编辑不经过类型选择，避免把已有来源改成另一种类型。
    expect(
      [...editor.querySelectorAll('button')].some((item) => item.textContent?.includes('飞书云盘')),
    ).toBe(false);
  });

  it('creates a GitHub source with repo, per-range ref and Enterprise API root', async () => {
    baseHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ ...source, id: 'ksrc_gh', type: 'github' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    await click(sourceChoice('GitHub', dialog('新建来源')));
    const creator = dialog('新建来源');
    await fill('source-name', '仓库文档');
    await fill('source-github-api', 'https://ghe.example.com/api/v3');
    await fill('source-range-0-external', 'acme/docs');
    await fill('source-range-0-ref', 'release');
    await fill('source-range-0-paths', 'docs, README.md');
    await fill('knowledge-source-secret', 'ghp_x');
    await click(button('创建', creator));
    const body = calls.find(
      (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
    )?.body as Record<string, unknown> | undefined;
    expect(body).toMatchObject({
      type: 'github',
      name: '仓库文档',
      syncCron: null,
      ranges: [
        {
          kind: 'github_repo',
          externalId: 'acme/docs',
          ref: 'release',
          paths: ['docs', 'README.md'],
          enabled: true,
        },
      ],
      config: {
        baseUrl: 'https://ghe.example.com/api/v3',
        projectId: 'acme/docs',
        syncDeletions: false,
      },
      secrets: { token: 'ghp_x' },
    });
    // GitHub 的 ref 属于每个 range，多仓库时不能把第一条写进公共 config。
    expect(body?.config).not.toHaveProperty('ref');
  });

  it('keeps a GitHub range ref out of config when editing', async () => {
    baseHandlers();
    const githubSource = {
      ...source,
      id: 'ksrc_gh',
      type: 'github',
      config: {
        baseUrl: 'https://api.github.com',
        projectId: 'acme/docs',
        ref: 'main',
        syncDeletions: true,
      },
      ranges: [
        {
          id: 'krng_gh',
          kind: 'github_repo',
          externalId: 'acme/docs',
          ref: 'main',
          paths: ['docs'],
          enabled: true,
        },
      ],
    };
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [githubSource], nextCursor: null }),
      ),
      http.patch('/api/knowledge/sources/ksrc_gh', () => HttpResponse.json(githubSource)),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    const editor = dialog('编辑来源');
    await fill('source-range-0-ref', 'release');
    await click(button('保存', editor));
    const patch = patchBody('/api/knowledge/sources/ksrc_gh') as {
      config: Record<string, unknown>;
      ranges: Array<Record<string, unknown>>;
    };
    expect(patch.ranges[0]).toMatchObject({ ref: 'release' });
    expect(patch.config).not.toHaveProperty('ref');
  });

  it('creates a GitLab source with instance URL, project and ref', async () => {
    baseHandlers();
    server.use(http.post('/api/knowledge/bases/kb_1/sources', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    await click(sourceChoice('GitLab', dialog('新建来源')));
    const creator = dialog('新建来源');
    await fill('source-name', '研发仓库');
    await fill('source-gitlab-url', 'https://gitlab.example.com');
    await fill('source-range-0-external', 'group/docs');
    await fill('source-range-0-ref', 'main');
    await fill('knowledge-source-secret', 'glpat_x');
    await click(button('创建', creator));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
      )?.body,
    ).toMatchObject({
      type: 'gitlab',
      ranges: [{ kind: 'gitlab_project', externalId: 'group/docs', ref: 'main', enabled: true }],
      config: {
        baseUrl: 'https://gitlab.example.com',
        projectId: 'group/docs',
        ref: 'main',
        syncDeletions: false,
      },
      secrets: { token: 'glpat_x' },
    });
  });

  it('shows provider, target summary, cron and last sync status on each source row', async () => {
    baseHandlers();
    const synced = {
      ...source,
      syncCron: '0 3 * * *',
      lastSyncAt: '2026-01-02T00:00:00Z',
      lastSyncStatus: 'succeeded',
    };
    const githubSource = {
      ...source,
      id: 'ksrc_gh',
      type: 'github',
      name: '文档仓库',
      config: { baseUrl: 'https://api.github.com' },
      ranges: [
        {
          id: 'krng_gh',
          kind: 'github_repo',
          externalId: 'acme/docs',
          ref: 'main',
          paths: ['docs'],
          enabled: true,
        },
      ],
    };
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({ items: [synced, githubSource], nextCursor: null }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    const rows = [...document.querySelectorAll('li')];
    const gitlabRow = rows.find((item) => item.textContent?.includes('产品仓库'));
    expect(gitlabRow?.textContent).toContain('GitLab');
    expect(gitlabRow?.textContent).toContain('12@main');
    expect(gitlabRow?.textContent).toContain('cron 0 3 * * *');
    expect(gitlabRow?.textContent).toContain('上次同步 成功');
    const githubRow = rows.find((item) => item.textContent?.includes('文档仓库'));
    expect(githubRow?.textContent).toContain('GitHub');
    expect(githubRow?.textContent).toContain('acme/docs@main');
  });
});

describe('knowledge document metadata', () => {
  function documentHandlers() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [chunk], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('正文')),
      detailsHandler(),
      http.get('/api/knowledge/bases/kb_1/tags', () =>
        HttpResponse.json([{ id: 'ktag_1', baseId: 'kb_1', name: '流程', createdAt: '' }]),
      ),
    );
  }

  async function openProperties() {
    const router = await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('编辑属性', dialog('上线流程')));
    return { editor: dialog('编辑文档'), router };
  }

  it('opens document properties from the viewer without losing the list', async () => {
    documentHandlers();
    server.use(
      http.patch('/api/knowledge/documents/kdoc_1', () =>
        HttpResponse.json({ ...doc, title: '上线流程 v2' }),
      ),
    );
    const { editor } = await openProperties();
    await fill('document-title', '上线流程 v2');
    await click(button('保存', editor));
    expect(patchBody('/api/knowledge/documents/kdoc_1')).toMatchObject({
      title: '上线流程 v2',
      tags: ['流程'],
    });
  });

  it('keeps the properties draft through cancel, Escape and close until it is discarded', async () => {
    documentHandlers();
    const { editor } = await openProperties();
    await fill('document-title', '上线流程 v2');

    await click(button('取消', editor));
    let confirmation = dialog('放弃未保存的更改？');
    expect(document.body.textContent).toContain('文档属性草稿会丢失');
    await click(button('取消', confirmation));
    expect(document.getElementById('document-title')).toBeTruthy();
    expect(document.querySelector<HTMLInputElement>('#document-title')?.value).toBe('上线流程 v2');

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await flush();
    confirmation = dialog('放弃未保存的更改？');
    await click(button('取消', confirmation));
    expect(document.querySelector<HTMLInputElement>('#document-title')?.value).toBe('上线流程 v2');

    await click(button('关闭', editor));
    confirmation = dialog('放弃未保存的更改？');
    await click(button('放弃并关闭', confirmation));
    expect(document.querySelector<HTMLInputElement>('#document-title')).toBeNull();
  });

  it('blocks closing the properties dialog while the save is still running', async () => {
    documentHandlers();
    const request = deferred<void>();
    server.use(
      http.patch('/api/knowledge/documents/kdoc_1', async () => {
        await request.promise;
        return HttpResponse.json({ ...doc, title: '上线流程 v2' });
      }),
    );
    const { editor } = await openProperties();
    await fill('document-title', '上线流程 v2');
    await click(button('保存', editor));

    expect(button('取消', editor).disabled).toBe(true);
    expect(button('关闭', editor).disabled).toBe(true);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await flush();
    expect(dialog('编辑文档')).toBeDefined();
    expect(document.body.textContent).not.toContain('放弃未保存的更改？');

    await act(async () => request.resolve());
    await flush();
    expect(document.getElementById('document-title')).toBeNull();
  });

  it('asks before leaving the dirty properties dialog through the router', async () => {
    documentHandlers();
    const { router } = await openProperties();
    await fill('document-title', '上线流程 v2');

    let navigation: Promise<unknown> | undefined;
    await act(async () => {
      navigation = router.navigate({ to: '/knowledge/' });
    });
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('取消', dialog('放弃未保存的更改？')));
    expect(document.querySelector<HTMLInputElement>('#document-title')?.value).toBe('上线流程 v2');

    await act(async () => {
      navigation = router.navigate({ to: '/knowledge/' });
    });
    await click(button('放弃并离开', dialog('放弃未保存的更改？')));
    await act(async () => {
      await navigation;
    });
    expect(document.getElementById('document-title')).toBeNull();
    expect(router.state.location.pathname).toBe('/knowledge');
  });

  const blockedWhileSaving = [
    {
      name: 'properties',
      field: 'document-title',
      value: '上线流程 v2',
      patch: '/api/knowledge/documents/kdoc_1',
      async open() {
        const router = await mount('/knowledge/kb_1');
        await click(button('上线流程'));
        await click(button('编辑属性', dialog('上线流程')));
        return { router, editor: dialog('编辑文档') };
      },
    },
    {
      name: 'chunk',
      field: 'knowledge-chunk-content',
      value: '修改后的内容',
      patch: '/api/knowledge/chunks/kchk_1',
      async open() {
        const router = await mount('/knowledge/kb_1');
        await click(button('上线流程'));
        await click(button('编辑分块 1', dialog('上线流程')));
        return { router, editor: dialog('编辑分块') };
      },
    },
  ];

  for (const editorCase of blockedWhileSaving) {
    it(`closes the ${editorCase.name} editor after a blocked save without leaving a hanging resolver`, async () => {
      documentHandlers();
      const request = deferred<void>();
      server.use(
        http.patch(editorCase.patch, async () => {
          await request.promise;
          return HttpResponse.json(doc);
        }),
      );
      const { router, editor } = await editorCase.open();
      await fill(editorCase.field, editorCase.value);
      await click(button('保存', editor));

      let blocked: Promise<unknown> | undefined;
      await act(async () => {
        blocked = router.navigate({ to: '/knowledge/' });
        // 被拦的导航在界面上只表现为确认框；保存成功后会随编辑器一起被取消。
        void blocked.catch(() => undefined);
      });
      expect(dialog('放弃未保存的更改？')).toBeDefined();
      expect(router.state.location.pathname).toBe('/knowledge/kb_1');

      await act(async () => request.resolve());
      await flush();
      expect(document.getElementById(editorCase.field)).toBeNull();
      expect(document.body.textContent).not.toContain('放弃未保存的更改？');
      expect(router.state.location.pathname).toBe('/knowledge/kb_1');

      await act(async () => {
        await router.navigate({ to: '/knowledge/' });
      });
      expect(router.state.location.pathname).toBe('/knowledge');
    });
  }
});

describe('knowledge manual and url import', () => {
  function documentList() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
  }

  it('names the manual Markdown editor before and after CodeMirror loads', async () => {
    documentList();
    await mount('/knowledge/kb_1');
    await click(button('导入'));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === '手写文档',
    );
    if (!item) throw new Error('Missing menu item: 手写文档');
    // 不等待懒加载：先看到 Suspense 回退的 textarea，再看到 CodeMirror 的 contenteditable。
    // 本文件里这是首次挂载 SourceEditor，懒模块必然先回退；之后按真实 DOM 条件等它换入。
    await act(async () => item.click());
    const loading = document.getElementById('knowledge-manual-content');
    expect(loading?.tagName).toBe('TEXTAREA');
    expect(loading?.getAttribute('aria-label')).toBe('正文（Markdown）');

    await waitFor(
      () =>
        document.getElementById('knowledge-manual-content')?.getAttribute('contenteditable') ===
        'true',
    );
    const loaded = document.getElementById('knowledge-manual-content');
    expect(loaded?.getAttribute('aria-label')).toBe('正文（Markdown）');
  });

  it('creates a manual document with title, content, folder and tags', async () => {
    documentList();
    server.use(
      http.post('/api/knowledge/bases/kb_1/documents/manual', () =>
        HttpResponse.json({ documentId: 'kdoc_2', jobId: 'kjob_2' }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('导入'));
    await chooseMenuItem('手写文档');
    const editor = dialog('手写文档');
    await fill('knowledge-manual-title', '发布检查');
    await fill('knowledge-manual-content', '# 发布检查\n\n先确认');
    await fill('knowledge-manual-tags', '流程, 发布');
    await click(button('导入', editor));
    expect(
      calls.find(
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

  it('keeps an unsaved manual editor mounted when the base cache refresh fails', async () => {
    documentList();
    await mount('/knowledge/kb_1');
    await click(button('导入'));
    await chooseMenuItem('手写文档');
    const editor = dialog('手写文档');
    await fill('knowledge-manual-title', '发布检查');
    const body = '# 发布检查\n\n先确认';
    await fill('knowledge-manual-content', body);
    await waitFor(
      () =>
        document.getElementById('knowledge-manual-content')?.getAttribute('contenteditable') ===
        'true',
    );

    // 真实 Query：缓存 data 仍在，后台刷新失败后 status 变 error。
    server.use(
      http.get('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ code: 'INTERNAL', message: '知识库刷新失败' }, { status: 500 }),
      ),
    );
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'base', 'kb_1'] });
    });
    await flush();

    expect(dialogShown('手写文档')).toBe(true);
    const view = EditorView.findFromDOM(
      document.getElementById('knowledge-manual-content') as HTMLElement,
    );
    expect(view?.state.doc.toString()).toBe(body);
    expect(document.body.textContent).toContain('知识库信息没有刷新成功');

    server.use(http.get('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)));
    await click(button('重试'));
    expect(document.body.textContent).not.toContain('知识库信息没有刷新成功');
    expect(dialogShown('手写文档')).toBe(true);
    expect(
      EditorView.findFromDOM(
        document.getElementById('knowledge-manual-content') as HTMLElement,
      )?.state.doc.toString(),
    ).toBe(body);
    expect(editor.isConnected).toBe(true);
  });

  it('imports a URL into the current folder and keeps a readable error', async () => {
    documentList();
    server.use(
      http.post('/api/knowledge/bases/kb_1/documents/url', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: '目标地址返回重定向；请直接填写最终地址' },
          { status: 400 },
        ),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('导入'));
    await chooseMenuItem('导入网址');
    const editor = dialog('导入网址');
    await fill('knowledge-url', 'https://example.com/docs');
    await click(button('导入', editor));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/documents/url',
      )?.body,
    ).toEqual({ url: 'https://example.com/docs', folderId: null });
    expect(toastError).toHaveBeenCalled();
  });
});

describe('knowledge package export and import', () => {
  it('downloads the exported zip through the normal api request', async () => {
    baseHandlers();
    server.use(
      http.get(
        '/api/knowledge/bases/kb_1/export',
        () => new HttpResponse('zip', { headers: { 'content-type': 'application/zip' } }),
      ),
    );
    const createObjectURL = vi.fn(() => 'blob:kit');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    await mount('/knowledge');
    await openMenu('操作 产品手册');
    await chooseMenuItem('导出知识包');
    await flush();
    expect(calls.some((item) => item.path === '/api/knowledge/bases/kb_1/export')).toBe(true);
    expect(createObjectURL).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await blob.text()).toBe('zip');
  });

  it('shows the recoverable conflict when the imported profile is missing', async () => {
    let uploaded = '';
    server.use(
      http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('/api/agents', () => HttpResponse.json([])),
      http.post('/api/knowledge/bases/import', async ({ request }) => {
        uploaded = new TextDecoder().decode(await request.arrayBuffer());
        return HttpResponse.json(
          {
            code: 'CONFLICT',
            message: '缺少 embedding 模型 profile「bge-m3」；请先创建同名 profile 再导入',
          },
          { status: 409 },
        );
      }),
    );
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
    expect(calls.find((item) => item.path === '/api/knowledge/bases/import')?.body).toEqual({
      __blob: 'application/zip',
    });
    expect(uploaded).toBe('zip');
    // 文件留在页面上，说明原因并可原地重试。
    expect(document.body.textContent).toContain('知识包没有导入');
    expect(document.body.textContent).toContain('缺少 embedding 模型 profile');
    expect(button('重试')).toBeDefined();
  });
});

describe('knowledge source configuration check', () => {
  it('submits a read-only remote probe instead of claiming the local check tested connectivity', async () => {
    baseHandlers();
    server.use(
      http.post('/api/knowledge/sources/ksrc_1/test', () =>
        HttpResponse.json({ jobId: 'kjob_probe' }),
      ),
      http.get('/api/knowledge/jobs/kjob_probe', () =>
        HttpResponse.json({
          id: 'kjob_probe',
          type: 'source_probe',
          status: 'succeeded',
          step: null,
          progress: 100,
          attempts: 1,
          error: null,
          result: { ok: true, checks: [{ rangeId: 'krng_1', ok: true }] },
          createdAt: '2026-01-01T00:00:00Z',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:00:00Z',
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    const check = button('检查配置');
    expect(check.title).toContain('只读远程连接测试');
    await click(check);
    expect(
      calls.some(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/sources/ksrc_1/test',
      ),
    ).toBe(true);
    await waitFor(() => document.body.textContent?.includes('连接测试通过') === true);
    expect(document.body.textContent).toContain('krng_1 · 可读');
  });
});

describe('knowledge pagination', () => {
  it('loads the next document page and appends it', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'kdoc_cursor'
          ? HttpResponse.json({
              items: [{ ...doc, id: 'kdoc_2', title: '第二页文档' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [doc], nextCursor: 'kdoc_cursor' }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('加载更多文档'));
    expect(document.body.textContent).toContain('第二页文档');
    expect(calls.some((item) => item.path.includes('cursor=kdoc_cursor'))).toBe(true);
  });

  it('loads the next chunk page inside the document viewer', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('正文')),
      detailsHandler(),
      http.get('/api/knowledge/documents/kdoc_1/chunks', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'kchk_cursor'
          ? HttpResponse.json({
              items: [{ ...chunk, id: 'kchk_2', ordinal: 1, content: '第二页分块内容' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [chunk], nextCursor: 'kchk_cursor' }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('加载更多分块', dialog('上线流程')));
    expect(dialog('上线流程').textContent).toContain('第二页分块内容');
  });
});

describe('knowledge document search debounce', () => {
  it('echoes every keystroke but sends one query after the typing pause', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
    await mount('/knowledge/kb_1');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索文档"]');
    if (!input) throw new Error('Missing document search input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    for (const value of ['a', 'ab', 'abc']) {
      await act(async () => {
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    // 输入框立即回显，但请求要等防抖落定。
    expect(input.value).toBe('abc');
    await waitFor(() =>
      calls.some((item) => item.path.includes('/api/knowledge/bases/kb_1/documents?q=abc')),
    );
    const terms = calls
      .filter((item) => item.path.startsWith('/api/knowledge/bases/kb_1/documents?'))
      .map((item) => new URL(item.path, 'http://localhost').searchParams.get('q'))
      .filter((term) => term !== null);
    expect(terms).toEqual(['abc']);
  });

  it('keeps the previous search empty state while a cleared query is still debouncing', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', ({ request }) =>
        HttpResponse.json({
          items: new URL(request.url).searchParams.get('q') ? [] : [doc],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1');
    await waitFor(() => document.body.textContent?.includes('上线流程') === true);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索文档"]');
    if (!input) throw new Error('Missing document search input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const type = (value: string) =>
      act(async () => {
        setValue?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

    await type('不存在');
    await waitFor(() => document.body.textContent?.includes('没有匹配的文档') === true);

    await type('');
    // 清空后的防抖窗口里，搜索结果还没换回全量，不能误报“还没有文档”。
    expect(document.body.textContent).toContain('没有匹配的文档');
    expect(document.body.textContent).not.toContain('还没有文档');

    await waitFor(() => document.body.textContent?.includes('上线流程') === true);
  });
});

describe('knowledge search cache keys', () => {
  it('does not reuse cached results across different limits', async () => {
    server.use(
      http.get('/api/knowledge/bases/kb_1/search', () =>
        HttpResponse.json({ hits: [], degraded: false }),
      ),
    );
    function Probe({ limit }: { limit: number }) {
      useKnowledgeSearch('kb_1', { q: '发布', limit });
      return null;
    }
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const renderProbe = async (limit: number) => {
      await act(async () => {
        root?.render(
          createElement(QueryClientProvider, { client }, createElement(Probe, { limit })),
        );
      });
      await flush();
    };

    await renderProbe(10);
    await renderProbe(20);
    await renderProbe(10);

    const limits = calls
      .filter((item) => item.path.startsWith('/api/knowledge/bases/kb_1/search?'))
      .map((item) => new URL(item.path, 'http://localhost').searchParams.get('limit'));
    // limit 不同必须各请求一次；回到 limit 10 命中缓存，不再发请求。
    expect(limits).toEqual(['10', '20']);
  });
});

describe('knowledge document viewer', () => {
  it('says a document without a parsed version has no chunks instead of querying an empty version', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({
          items: [{ ...doc, status: 'pending', currentVersionId: null }],
          nextCursor: null,
        }),
      ),
    );
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
    // 禁用的查询永远停在 pending：没有版本时不能把骨架当成真实加载。
    expect(viewer.querySelector('[aria-label="加载中"]')).toBeNull();
    expect(
      calls.some((item) => item.path.startsWith('/api/knowledge/documents/kdoc_1/chunks')),
    ).toBe(false);
  });

  it('shows the parsed text once polling turns the open pending document ready', async () => {
    baseHandlers();
    let parsed = false;
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({
          items: [parsed ? doc : { ...doc, status: 'pending', currentVersionId: null }],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [chunk], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('解析后的正文')),
      detailsHandler(),
    );
    await mount('/knowledge/kb_1');
    await waitFor(() =>
      [...document.querySelectorAll('button')].some(
        (item) => item.textContent?.trim() === '上线流程',
      ),
    );
    await click(button('上线流程'));
    expect(dialog('上线流程').textContent).toContain('还没有解析完成的版本');

    parsed = true;
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'documents', 'kb_1'] });
    });
    await flush();
    const viewer = dialog('上线流程');
    expect(viewer.textContent).toContain('解析后的正文');
    expect(viewer.textContent).toContain('发布前需要产品与研发双方确认。');
  });

  it('keeps the newest parsed snapshot when the open document drops out of the list', async () => {
    baseHandlers();
    let state: 'pending' | 'ready' | 'missing' = 'pending';
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({
          items:
            state === 'missing'
              ? []
              : [state === 'ready' ? doc : { ...doc, status: 'pending', currentVersionId: null }],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [chunk], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('解析后的正文')),
      detailsHandler(),
    );
    await mount('/knowledge/kb_1');
    await waitFor(() =>
      [...document.querySelectorAll('button')].some(
        (item) => item.textContent?.trim() === '上线流程',
      ),
    );
    await click(button('上线流程'));
    expect(dialog('上线流程').textContent).toContain('还没有解析完成的版本');

    state = 'ready';
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'documents', 'kb_1'] });
    });
    await flush();
    expect(dialog('上线流程').textContent).toContain('解析后的正文');

    state = 'missing';
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'documents', 'kb_1'] });
    });
    await flush();
    const viewer = dialog('上线流程');
    expect(viewer.textContent).toContain('解析后的正文');
    expect(viewer.textContent).toContain('发布前需要产品与研发双方确认。');
    // 列表暂时不含当前文档时，目录仍保留当前快照并标出当前位置，不显示“没有文档”。
    const nav = viewer.querySelector('nav[aria-label="知识文档"]');
    const current = nav?.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain('上线流程');
    expect(nav?.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(nav?.textContent).not.toContain('当前筛选没有文档');
  });

  it('collapses and expands the document sidebar without losing the current document or focus', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [chunk], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('解析后的正文')),
      detailsHandler(),
    );
    await mount('/knowledge/kb_1');
    await waitFor(() =>
      [...document.querySelectorAll('button')].some(
        (item) => item.textContent?.trim() === '上线流程',
      ),
    );
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    const nav = viewer.querySelector('nav[aria-label="知识文档"]');
    if (!nav) throw new Error('Missing document sidebar');
    const toggle = button('收起文件列表', viewer);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const controls = toggle.getAttribute('aria-controls');
    if (!controls) throw new Error('Missing aria-controls target');
    expect(viewer.querySelector(`#${controls}`)).not.toBeNull();

    toggle.focus();
    await click(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(viewer.querySelector('nav[aria-label="知识文档"]')).toBeNull();
    expect(viewer.textContent).toContain('解析后的正文');

    await click(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const restored = viewer.querySelector('nav[aria-label="知识文档"]');
    expect(restored?.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(restored?.querySelector('[aria-current="true"]')?.textContent).toContain('上线流程');
  });

  it('surfaces a failed chunk toggle without pretending it succeeded', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [chunk], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('正文')),
      detailsHandler(),
      http.patch('/api/knowledge/chunks/kchk_1', () =>
        HttpResponse.json({ code: 'CONFLICT', message: '分块已属于旧版本' }, { status: 409 }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('停用分块 1', dialog('上线流程')));
    expect(toastError).toHaveBeenCalled();
  });
});

describe('knowledge search citations', () => {
  it('opens the parsed text of a hit with the quote highlighted and an original link', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/search', () =>
        HttpResponse.json({
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
        }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () =>
        markdownResponse('## 发布前检查\n\n发布前需要产品与研发双方确认。'),
      ),
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

  it('distinguishes same-title same-page hits by quote and opens each hit', async () => {
    baseHandlers();
    const sharedPrefix =
      '发布前需要产品与研发双方确认。发布前需要产品与研发双方确认。发布前需要产品与研发双方确认';
    const firstQuote = `${sharedPrefix}甲`;
    const secondQuote = `${sharedPrefix}乙`;
    server.use(
      http.get('/api/knowledge/bases/kb_1/search', () =>
        HttpResponse.json({
          hits: [
            {
              chunkId: 'kchk_1',
              documentId: 'kdoc_1',
              versionId: 'kdv_1',
              title: '上线流程',
              heading: '发布前检查',
              quote: firstQuote,
              pageFrom: 2,
              pageTo: 2,
              sourceUrl: null,
              score: 0.82,
            },
            {
              chunkId: 'kchk_2',
              documentId: 'kdoc_1',
              versionId: 'kdv_1',
              title: '上线流程',
              heading: '发布前检查',
              quote: secondQuote,
              pageFrom: 2,
              pageTo: 2,
              sourceUrl: null,
              score: 0.81,
            },
          ],
          degraded: false,
        }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () =>
        markdownResponse('## 发布前检查\n\n发布前需要产品与研发双方确认。'),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'search' });
    await fill('knowledge-search', '发布');
    await act(async () => {
      document
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    const triggers = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (item) => item.textContent?.trim() === '查看原文',
    );
    expect(triggers).toHaveLength(2);
    const names = triggers.map((item) => item.getAttribute('aria-label') ?? '');
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain('命中 1');
    expect(names[1]).toContain('命中 2');

    await click(triggers[0] as HTMLButtonElement);
    expect(dialog('引用原文').querySelector('mark')?.textContent).toBe(firstQuote);
    await click(button('关闭', dialog('引用原文')));
    expect(dialogShown('引用原文')).toBe(false);

    await click(triggers[1] as HTMLButtonElement);
    expect(dialog('引用原文').querySelector('mark')?.textContent).toBe(secondQuote);
  });

  it('shows the hit image with the quote as alt text and explains a failed load', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/search', () =>
        HttpResponse.json({
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
        }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('正文')),
      http.get(
        '/api/knowledge/versions/kdv_1/images/%E5%9B%BE%201.png',
        () =>
          new HttpResponse(Uint8Array.from([1, 2, 3]), {
            headers: { 'content-type': 'image/png' },
          }),
      ),
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
    server.use(
      http.get('/api/knowledge/bases/kb_1/search', () =>
        HttpResponse.json({
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
        }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('正文')),
      http.get('/api/knowledge/versions/kdv_1/images/%E5%9B%BE%201.png', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: '无权读取' }, { status: 403 }),
      ),
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
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
  }

  it('opens the file picker directly from the toolbar, not through the import menu', async () => {
    uploadHandlers();
    await mount('/knowledge/kb_1');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="选择要上传的文件"]');
    if (!input) throw new Error('Missing upload input');
    const open = vi.spyOn(input, 'click').mockImplementation(() => {});
    await click(button('上传文件'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it('uploads every selected file, reports failed ones and keeps going', async () => {
    uploadHandlers();
    server.use(
      http.put('/api/knowledge/bases/kb_1/documents/upload', async ({ request }) => {
        const filename = ((await request.json()) as { filename: string }).filename;
        if (filename === 'bad.pdf') {
          return HttpResponse.json(
            { code: 'CONFLICT', message: '同名文档已存在' },
            { status: 409 },
          );
        }
        return HttpResponse.json({ documentId: 'kdoc_new', jobId: 'kjob_new' });
      }),
    );
    await mount('/knowledge/kb_1');
    await click(button('上传文件'));
    const good = new File(['a'], 'good.txt', { type: 'text/plain' });
    const bad = new File(['b'], 'bad.pdf', { type: 'application/pdf' });
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="选择要上传的文件"]',
      );
      if (!input) throw new Error('Missing upload input');
      Object.defineProperty(input, 'files', { value: [good, bad], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // FileReader 读完两个文件后才发请求：按请求条件等待。
    await waitFor(
      () =>
        calls.filter(
          (item) =>
            item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
        ).length === 2,
    );
    await flush();
    const uploads = calls.filter(
      (item) => item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
    );
    expect(uploads).toHaveLength(2);
    expect(toastError).toHaveBeenCalled();
  });

  it('keeps the folder path visible when uploading a directory', async () => {
    uploadHandlers();
    server.use(
      http.put('/api/knowledge/bases/kb_1/documents/upload', () =>
        HttpResponse.json({ documentId: 'kdoc_new', jobId: 'kjob_new' }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('导入'));
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
    });
    // 等 FileReader 落定并发出上传请求，再读请求体。
    await waitFor(
      () =>
        calls.filter(
          (item) =>
            item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
        ).length === 1,
    );
    await flush();
    const body = calls.find(
      (item) => item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
    )?.body as { filename: string; relativePath?: string; title?: string } | undefined;
    // 相对路径交给后端建真实目录；不再把路径写进标题。
    expect(body?.filename).toBe('docs/spec.txt');
    expect(body?.relativePath).toBe('docs/spec.txt');
    expect(body?.title).toBeUndefined();
  });
});

describe('knowledge wiki versions', () => {
  it('lists the real version shape and rolls back to an older version', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(wikiPage)),
      http.post('/api/knowledge/wiki-pages/kwp_1/rollback', () =>
        HttpResponse.json(wikiPage.versions[1]),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    expect(document.body.textContent).toContain('v2');
    expect(document.body.textContent).toContain('v1');
    await click(button('回退到此版本'));
    await click(button('回退', dialog('回退 Wiki 版本')));
    expect(
      calls.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/wiki-pages/kwp_1/rollback',
      )?.body,
    ).toEqual({ versionId: 'kwv_1' });
  });

  it('loads the published version from the next version page before editing', async () => {
    baseHandlers();
    const older = {
      id: 'kwv_old',
      pageId: 'kwp_1',
      version: 1,
      markdown: '## 更早版本\n\n第二页正文。',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    };
    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json({
          ...wikiPage,
          currentVersionId: 'kwv_old',
          // 第一页不含当前发布版本：不能把它当成空白首版。
          versions: [wikiPage.versions[0]],
          nextCursor: 'kwv_cursor_old',
        }),
      ),
      http.get('/api/knowledge/wiki-pages/kwp_1/versions', () =>
        HttpResponse.json({ items: [older], nextCursor: null }),
      ),
      http.patch('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json({ ...wikiPageSummary, currentVersionId: 'kwv_old' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });

    // 当前发布版本不在第一页时自动取更早的版本页，读到正文后才允许编辑。
    await waitFor(() => document.body.textContent?.includes('第二页正文。') === true);
    expect(findButton('重新生成')).toBeDefined();
    expect(findButton('生成草稿')).toBeUndefined();
    expect(button('编辑正文').disabled).toBe(false);
    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    // 草稿从最新版本续写；当前发布版本只用于展示。
    expect(editor.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 当前\n\n第二步。',
    );
    await fill('knowledge-wiki-markdown', '## 修改后');
    await click(button('保存草稿', editor));
    expect(patchBody('/api/knowledge/wiki-pages/kwp_1')).toEqual({
      markdown: '## 修改后',
      expectedVersion: 'kwv_2',
    });
  });

  it('switches the current page between reading and source and copies it from the same toolbar', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    baseHandlers();
    server.use(http.get('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(wikiPage)));
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    expect(document.body.textContent).toContain('第二步。');

    await click(button('源码'));
    expect(document.querySelector('pre')?.textContent).toContain('## 当前');
    const copies = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((item) =>
      item.getAttribute('aria-label')?.startsWith('复制'),
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.getAttribute('aria-label')).toBe('复制 发布指南');

    const copy = document.querySelector<HTMLButtonElement>('button[aria-label="复制 发布指南"]');
    if (!copy) throw new Error('Missing copy action');
    await act(async () => copy.click());
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('## 当前\n\n第二步。');
  });

  it('keeps the version captured on open even after a background refetch, and keeps the draft on 409', async () => {
    baseHandlers();
    let currentVersionId = 'kwv_2';
    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json({
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
        }),
      ),
      http.patch('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json(
          { code: 'CONFLICT', message: 'Wiki 页面已被修改，请刷新后重试' },
          { status: 409 },
        ),
      ),
    );
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

    await click(button('保存草稿', editor));
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
      calls.filter((item) => item.path === '/api/knowledge/wiki-pages/kwp_1').length;
    const before = detailCalls();
    await click(button('重新加载', editor));
    await click(button('重新加载', dialog('重新加载 Wiki 正文')));
    expect(detailCalls()).toBeGreaterThan(before);
    expect(document.querySelector('#knowledge-wiki-markdown')).toBeNull();
    expect(document.body.textContent).toContain('第三步。');
  });

  it('tracks the submitted generation job and refreshes page and list once it finishes', async () => {
    baseHandlers();
    let jobs: KnowledgeJob[] = [];
    let pageCalls = 0;
    let listCalls = 0;
    server.use(
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: jobs, nextCursor: null })),
      http.get('/api/knowledge/wiki-pages/kwp_1', () => {
        pageCalls += 1;
        return HttpResponse.json(wikiPage);
      }),
      http.get('/api/knowledge/bases/kb_1/wiki-pages', () => {
        listCalls += 1;
        return HttpResponse.json({ items: [wikiPageSummary], nextCursor: null });
      }),
      http.post('/api/knowledge/wiki-pages/kwp_1/generate', () => {
        jobs = [wikiJob('queued'), ...jobs];
        return HttpResponse.json({ jobId: 'kjob_gen' });
      }),
    );
    // 其他页面或其他来源的终态任务留在列表里，但不显示在这一页。
    jobs = [wikiJob('succeeded', 'kjob_other')];
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    expect(document.body.textContent).not.toContain('生成任务');
    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    await fill('knowledge-wiki-markdown', '## 未保存的草稿');

    const pageBefore = pageCalls;
    const listBefore = listCalls;
    await click(button('重新生成'));
    await flush();
    // 提交后由产品自己刷新任务列表即可看到新任务，不靠测试手动刷新。
    expect(document.body.textContent).toContain('生成任务 排队中');
    // 任务仍在跑时只刷新任务列表，不重复拉当前页面与页面列表。
    expect(pageCalls).toBe(pageBefore);
    expect(listCalls).toBe(listBefore);

    // 任务终态刷新页面失败时保留页面数据与编辑草稿，只做局部报错。
    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () =>
        HttpResponse.json({ code: 'INTERNAL', message: '页面刷新失败' }, { status: 500 }),
      ),
    );
    jobs = [wikiJob('succeeded'), wikiJob('succeeded', 'kjob_other')];
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'jobs', 'kb_1'] });
    });
    await flush();
    expect(listCalls).toBe(listBefore + 1);
    expect(editor.isConnected).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 未保存的草稿',
    );
    expect(document.body.textContent).toContain('Wiki 页面没有刷新成功');

    server.use(
      http.get('/api/knowledge/wiki-pages/kwp_1', () => {
        pageCalls += 1;
        return HttpResponse.json(wikiPage);
      }),
    );
    await click(button('重试'));
    await flush();
    expect(editor.isConnected).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('#knowledge-wiki-markdown')?.value).toBe(
      '## 未保存的草稿',
    );
    expect(document.body.textContent).not.toContain('Wiki 页面没有刷新成功');
    expect(document.body.textContent).toContain('第二步。');

    // 终态后的轮询即使继续刷新任务列表，也不再重复失效页面与列表。
    const settledPage = pageCalls;
    const settledList = listCalls;
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'jobs', 'kb_1'] });
    });
    await flush();
    expect(pageCalls).toBe(settledPage);
    expect(listCalls).toBe(settledList);
    expect(editor.isConnected).toBe(true);
  });

  it('loads every wiki page page so older pages stay selectable', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/wiki-pages', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'kwp_cursor'
          ? HttpResponse.json({
              items: [{ ...wikiPageSummary, id: 'kwp_old', title: '旧页面', slug: 'old' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [wikiPageSummary], nextCursor: 'kwp_cursor' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki' });
    expect(calls.some((item) => item.path.includes('cursor=kwp_cursor'))).toBe(true);
    expect(document.body.textContent).toContain('旧页面');
  });
});

describe('knowledge source pagination', () => {
  it('loads every source page so older sources can still be edited or synced', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', ({ request }) =>
        new URL(request.url).searchParams.get('cursor') === 'ksrc_cursor'
          ? HttpResponse.json({
              items: [{ ...source, id: 'ksrc_old', name: '旧仓库' }],
              nextCursor: null,
            })
          : HttpResponse.json({ items: [source], nextCursor: 'ksrc_cursor' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'sources' });
    expect(calls.some((item) => item.path.includes('cursor=ksrc_cursor'))).toBe(true);
    expect(document.body.textContent).toContain('旧仓库');
    expect(document.body.textContent).toContain('2 个来源');
  });
});

describe('knowledge version images', () => {
  function imageDocHandlers() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [chunk], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('正文')),
      http.get('/api/knowledge/versions/kdv_1/details', () =>
        HttpResponse.json({
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
        }),
      ),
    );
  }

  it('renders the extracted images with their page numbers and the whitelisted image URL', async () => {
    imageDocHandlers();
    for (const name of ['%E7%99%BD%E5%9B%BE%201.png', 'chart.png']) {
      server.use(
        http.get(`/api/knowledge/versions/kdv_1/images/${name}`, async () => {
          // 两张图都挂载后按 DOM 顺序取对象 URL；让第二张稍后返回，保持映射稳定。
          if (name === 'chart.png') await delay(20);
          return new HttpResponse(Uint8Array.from([1, 2, 3]), {
            headers: { 'content-type': 'image/png' },
          });
        }),
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
    expect(calls.some((call) => call.path.includes('/images/chart.png'))).toBe(true);
    expect(viewer.textContent).toContain('第 2 页');
    expect(viewer.textContent).toContain('第 5 页');
    expect(
      viewer.querySelector<HTMLAnchorElement>('a[href="/api/knowledge/versions/kdv_1/content"]'),
    ).not.toBeNull();
  });

  it('states a missing image instead of leaving a blank placeholder and keeps the original link', async () => {
    imageDocHandlers();
    server.use(
      http.get('/api/knowledge/versions/kdv_1/images/%E7%99%BD%E5%9B%BE%201.png', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: '图片不存在' }, { status: 404 }),
      ),
      http.get('/api/knowledge/versions/kdv_1/images/chart.png', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: '图片不存在' }, { status: 404 }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    await flush();
    expect(viewer.textContent).toContain('图片已删除或不存在，请重新解析该版本。');
    expect(viewer.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('knowledge request transport', () => {
  it('turns a real network failure into the offline message', async () => {
    server.use(
      http.get('/api/knowledge/bases', () => HttpResponse.error()),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    expect(document.body.textContent).toContain('连不上 API 服务');
  });

  it('does not treat a jsdom cookie as a real logged-in session', async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom 没有 Cookie Store API，这里只验证不伪造登录。
    document.cookie = 'session=jsdom-only';
    let cookie: string | null = null;
    server.use(
      http.get('/api/knowledge/model-profiles', ({ request }) => {
        cookie = request.headers.get('cookie');
        return HttpResponse.json([]);
      }),
    );
    const { api } = await import('../src/lib/api.js');
    await api.knowledgeModelProfiles();
    // jsdom 的 cookie 没有真实登录会话，Node fetch 也不会自动带上；这里只守住「不伪造登录」。
    expect(cookie).toBeNull();
    // biome-ignore lint/suspicious/noDocumentCookie: 同上，清理 jsdom 测试 cookie。
    document.cookie = 'session=; Max-Age=0';
  });

  it('propagates an abort after the handler starts as AbortError instead of a network failure', async () => {
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releaseHandler = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/knowledge/versions/kdv_abort/markdown', async () => {
        entered();
        await releaseHandler;
        return markdownResponse('正文');
      }),
    );
    const { api } = await import('../src/lib/api.js');
    const controller = new AbortController();
    try {
      const pending = api.knowledgeMarkdown('kdv_abort', controller.signal);
      await handlerEntered;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      // 让被取消的 handler 及时结束，不留下挂起的 promise 或计时器。
      release();
    }
  });
});

describe('msw request body capture', () => {
  it('waits for a delayed request body and fails on a read error', async () => {
    // 流式 fetch 在 body 发送完前不会触发 request:start，这里直接发事件以控制读取时机。
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayedBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        await released;
        controller.enqueue(new TextEncoder().encode('{"delayed":true}'));
        controller.close();
      },
    });
    const delayed = new Request('http://localhost/api/msw/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: delayedBody,
      duplex: 'half',
    } as RequestInit);
    server.events.emit({ type: 'request:start', request: delayed } as never);
    // 未等 body 读完时这里就是 undefined；负向断言不能靠「看起来没有」通过。
    expect(calls[0]?.body).toBeUndefined();
    release();
    await msw.waitForRequests();
    expect(calls[0]?.body).toEqual({ delayed: true });

    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"broken":'));
        controller.error(new Error('body read failed'));
      },
    });
    const failed = new Request('http://localhost/api/msw/body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: failedBody,
      duplex: 'half',
    } as RequestInit);
    server.events.emit({ type: 'request:start', request: failed } as never);
    await expect(msw.waitForRequests()).rejects.toThrow('body read failed');
  });
});

describe('msw cleanup fault injection', () => {
  it('runs every shared cleanup step and rethrows the first failure', async () => {
    const steps: string[] = [];
    await expect(
      runCleanup([
        () => {
          steps.push('clear');
          throw new Error('clear failed');
        },
        () => {
          steps.push('remove');
          throw new Error('remove failed');
        },
        () => {
          steps.push('assertClean');
        },
      ]),
    ).rejects.toThrow('clear failed');
    expect(steps).toEqual(['clear', 'remove', 'assertClean']);
  });

  function expectRestored() {
    expect(server.listHandlers()).toHaveLength(0);
    expect('ResizeObserver' in globalThis).toBe(false);
    expect(vi.isMockFunction(window.scrollTo)).toBe(false);
    expect(root).toBeUndefined();
    expect(client).toBeUndefined();
    expect(host).toBeUndefined();
  }

  it('still restores handlers, globals and mocks after a body read rejection', async () => {
    server.use(http.get('/api/knowledge/bases', () => HttpResponse.json([])));
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"broken":'));
        controller.error(new Error('body read failed'));
      },
    });
    server.events.emit({
      type: 'request:start',
      request: new Request('http://localhost/api/msw/body', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: failedBody,
        duplex: 'half',
      } as RequestInit),
    } as never);
    await expect(cleanup()).rejects.toThrow('body read failed');
    expectRestored();
  });

  it('still restores handlers, globals and mocks when unmount throws', async () => {
    server.use(http.get('/api/knowledge/bases', () => HttpResponse.json([])));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const mountedRoot = root,
      mountedHost = host;
    await act(async () => mountedRoot.render(createElement('p', null, 'mounted')));
    expect(mountedHost.childNodes).toHaveLength(1);
    // cleanup 会先清空 root，回调必须用快照才能真正卸载；先卸载再抛错只替代「unmount 抛出」信号。
    await expect(
      cleanup(async () => {
        await act(async () => mountedRoot.unmount());
        throw new Error('unmount failed');
      }),
    ).rejects.toThrow('unmount failed');
    // host.remove() 只摘节点不清空子树：子节点消失才是 React root 真卸载的证据。
    expect(mountedHost.childNodes).toHaveLength(0);
    expectRestored();
  });
});

describe('knowledge UX guards', () => {
  const embeddingProfile = {
    id: 'profile_1',
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

  const rerankProfile = {
    ...embeddingProfile,
    id: 'profile_rerank',
    kind: 'rerank',
    name: 'bge-reranker',
    model: 'bge-reranker-v2',
    dimensions: null,
    hasSecret: false,
  };

  function listHandlers() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/model-profiles', () => HttpResponse.json([embeddingProfile])),
    );
  }

  function documentList() {
    listHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
  }

  it('shows exactly one of loading, failure, true empty and filtered empty', async () => {
    const pending = deferred<void>();
    server.use(
      http.get('/api/knowledge/bases', async () => {
        await pending.promise;
        return HttpResponse.json({ items: [base], nextCursor: null });
      }),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    expect(document.querySelector('[aria-label="加载中"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('还没有知识库');
    expect(document.body.textContent).not.toContain('没有匹配的知识库');

    await act(async () => pending.resolve());
    await flush();
    expect(document.querySelector('[aria-label="加载中"]')).toBeNull();
    expect(document.body.textContent).toContain('产品手册');

    await cleanup();
    mockMe();
    server.use(
      http.get('/api/knowledge/bases', () =>
        HttpResponse.json({ code: 'INTERNAL', message: '列表失败' }, { status: 500 }),
      ),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge');
    // 失败分支不再叠一个空态或骨架。
    expect(document.body.textContent).toContain('服务端暂时无法完成请求');
    expect(document.body.textContent).toContain('重试');
    expect(document.body.textContent).not.toContain('还没有知识库');
    expect(document.querySelector('[aria-label="加载中"]')).toBeNull();
  });

  it('keeps the loaded bases and offers a retry when refresh fails', async () => {
    listHandlers();
    await mount('/knowledge');
    expect(document.body.textContent).toContain('产品手册');
    server.use(
      http.get('/api/knowledge/bases', () =>
        HttpResponse.json({ code: 'INTERNAL', message: '刷新失败' }, { status: 500 }),
      ),
    );
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'bases'] });
    });
    await flush();
    expect(document.body.textContent).toContain('产品手册');
    expect(document.body.textContent).toContain('列表没有刷新成功');
    expect(document.body.textContent).not.toContain('还没有知识库');
    server.use(
      http.get('/api/knowledge/bases', () =>
        HttpResponse.json({ items: [base], nextCursor: null }),
      ),
    );
    await click(button('重试'));
    expect(document.body.textContent).not.toContain('列表没有刷新成功');
  });

  it('distinguishes a filtered empty list from a library with no bases', async () => {
    listHandlers();
    await mount('/knowledge');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索知识库"]');
    if (!input) throw new Error('Missing search input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '不存在',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain('没有匹配的知识库');
    expect(document.body.textContent).not.toContain('还没有知识库');
    await click(button('清除搜索'));
    expect(document.body.textContent).toContain('产品手册');
  });

  it('navigates to the newly created base only after its dialog unmounts', async () => {
    listHandlers();
    const createdBase = { ...base, id: 'kb_new', slug: 'new-base', name: '新库' };
    server.use(
      http.post('/api/knowledge/bases', () => HttpResponse.json(createdBase)),
      http.get('/api/knowledge/bases/kb_new', () => HttpResponse.json(createdBase)),
      http.get('/api/knowledge/bases/kb_new/folders', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_new/tags', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_new/documents', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const router = await mount('/knowledge', { q: '产品' });
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    await fill('knowledge-name', '新库');
    await fill('knowledge-slug', 'new-base');
    await click(button('创建', creator));
    await waitFor(() => router.state.location.pathname === '/knowledge/kb_new');
    expect(dialogShown('新建知识库')).toBe(false);
    expect(document.body.textContent).toContain('新库');
  });

  const createDraftChanges: Array<[string, () => Promise<void>]> = [
    ['rerank profile', () => chooseOption('knowledge-rerank', 'bge-reranker')],
    [
      'wiki auto update',
      async () => click(document.getElementById('knowledge-wiki-auto') as HTMLElement),
    ],
  ];

  for (const [name, change] of createDraftChanges) {
    it(`guards a create draft made by changing only the ${name}`, async () => {
      listHandlers();
      server.use(
        http.get('/api/knowledge/model-profiles', () =>
          HttpResponse.json([embeddingProfile, rerankProfile]),
        ),
      );
      const router = await mount('/knowledge');
      await click(button('新建知识库'));
      await change();

      await click(button('取消', dialog('新建知识库')));
      expect(dialog('放弃未保存的更改？')).toBeDefined();
      await click(button('取消', dialog('放弃未保存的更改？')));
      expect(dialog('新建知识库')).toBeDefined();

      let navigation: Promise<unknown> | undefined;
      await act(async () => {
        navigation = router.navigate({ to: '/knowledge', search: { q: '新库' }, replace: true });
        void navigation.catch(() => undefined);
      });
      expect(dialog('放弃未保存的更改？')).toBeDefined();
      await click(button('取消', dialog('放弃未保存的更改？')));
      expect(router.state.location.search).toEqual({});
      expect(dialog('新建知识库')).toBeDefined();

      await act(async () => {
        navigation = router.navigate({ to: '/knowledge', search: { q: '新库' } });
      });
      await click(button('放弃并离开', dialog('放弃未保存的更改？')));
      await act(async () => {
        await navigation;
      });
      expect(router.state.location.search).toEqual({ q: '新库' });
    });
  }

  it('links to the imported base package', async () => {
    listHandlers();
    server.use(
      http.post('/api/knowledge/bases/import', () =>
        HttpResponse.json({
          baseId: 'kb_imported',
          serverId: 'srv_imported',
          counts: { folders: 0, tags: 0, documents: 2, versions: 0, chunks: 0, wikiPages: 0 },
        }),
      ),
    );
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
    expect(
      document.querySelector<HTMLAnchorElement>('a[href="/knowledge/kb_imported"]')?.textContent,
    ).toContain('打开知识库');
    await click(button('关闭'));
    expect(document.querySelector('a[href="/knowledge/kb_imported"]')).toBeNull();
  });

  it('associates the 501-character description error with the field', async () => {
    listHandlers();
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    await fill('knowledge-name', '新库');
    await fill('knowledge-slug', 'new-base');
    await fill('knowledge-description', 'x'.repeat(501));
    await click(button('创建', creator));
    const description = document.getElementById('knowledge-description') as HTMLTextAreaElement;
    expect(description.getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(description.getAttribute('aria-describedby') as string)?.textContent,
    ).toContain('最多 500 个字符');
    expect(
      calls.some((item) => item.method === 'POST' && item.path === '/api/knowledge/bases'),
    ).toBe(false);
    expect(document.activeElement).toBe(description);
  });

  it('settles the create form when the profile list refreshes before the create responds', async () => {
    const request = deferred<void>();
    const createdProfile = {
      id: 'profile_new',
      kind: 'embedding',
      name: 'bge-m3',
      endpointUrl: 'https://models.example.com',
      model: 'bge-m3',
      dimensions: 1024,
      enabled: true,
      hasSecret: false,
      embeddingProtocol: 'openai',
      imageInputEnabled: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    let profileCreated = false;
    baseHandlers();
    server.use(
      http.get('/api/knowledge/model-profiles', () =>
        HttpResponse.json(profileCreated ? [createdProfile] : []),
      ),
      http.post('/api/knowledge/model-profiles', async () => {
        // 服务端已落库、响应仍在途：另一条真实 GET 能看到新 profile。
        profileCreated = true;
        await request.promise;
        return HttpResponse.json(createdProfile);
      }),
      http.post('/api/knowledge/bases', () =>
        HttpResponse.json({ ...base, id: 'kb_new', slug: 'new-base', name: '新库' }),
      ),
      http.get('/api/knowledge/bases/kb_new', () =>
        HttpResponse.json({ ...base, id: 'kb_new', slug: 'new-base', name: '新库' }),
      ),
      http.get('/api/knowledge/bases/kb_new/folders', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_new/tags', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_new/documents', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    expect(document.getElementById('profile-name')).not.toBeNull();
    await fill('profile-name', 'bge-m3');
    await fill('profile-endpoint', 'https://models.example.com');
    await fill('profile-model', 'bge-m3');
    await click(button('创建 embedding profile'));

    // deferred 让 pending 真实渲染：内联表单与父层创建按钮共享同一 pending，关闭也不可用。
    const creating = [...creator.querySelectorAll<HTMLButtonElement>('button')].filter(
      (item) => item.textContent?.trim() === '创建中…',
    );
    expect(creating).toHaveLength(2);
    expect(creating.every((item) => item.disabled)).toBe(true);
    expect(button('关闭').disabled).toBe(true);

    // POST 仍挂起时，另一次真实 GET 已返回新 profile，子表单带着 pending=true 卸载。
    await act(async () => {
      await client?.invalidateQueries({ queryKey: ['knowledge', 'model-profiles'] });
    });
    await waitFor(() => document.getElementById('profile-name') === null);
    expect(creator.textContent).not.toContain('创建 embedding profile');
    expect(button('关闭').disabled).toBe(true);

    await act(async () => request.resolve());
    await flush();
    await waitFor(() => !button('关闭').disabled);

    // 外层必须已结算 pending/dirty，并把正确 profile 回填到建库表单。
    expect(button('创建', creator).disabled).toBe(false);
    await fill('knowledge-name', '新库');
    await fill('knowledge-slug', 'new-base');
    await click(button('创建', creator));
    expect(
      calls.find((item) => item.method === 'POST' && item.path === '/api/knowledge/bases')?.body,
    ).toMatchObject({ name: '新库', slug: 'new-base', embeddingProfileId: 'profile_new' });
    expect(dialogShown('新建知识库')).toBe(false);
  });

  it('confirms before discarding rename, manual, URL, Wiki, source and settings drafts', async () => {
    listHandlers();
    await mount('/knowledge');

    await openMenu('操作 产品手册');
    await chooseMenuItem('重命名');
    await fill('knowledge-base-name', '研发手册');
    await click(button('取消', dialog('重命名知识库')));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(document.body.textContent).not.toContain('重命名知识库');

    await cleanup();
    mockMe();
    documentList();
    await mount('/knowledge/kb_1');
    await click(button('导入'));
    await chooseMenuItem('手写文档');
    await fill('knowledge-manual-title', '发布检查');
    await click(button('取消', dialog('手写文档')));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(document.body.textContent).not.toContain('手写文档');

    await click(button('导入'));
    await chooseMenuItem('导入网址');
    await fill('knowledge-url', 'https://example.com/docs');
    await click(button('取消', dialog('导入网址')));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(document.body.textContent).not.toContain('导入网址');
  });

  it('guards unsaved edits in the Wiki editor and source dialog', async () => {
    documentList();
    server.use(http.get('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(wikiPage)));
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    await click(button('编辑正文'));
    await fill('knowledge-wiki-markdown', '## 草稿');
    await click(button('取消', dialog('编辑 Wiki 正文')));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(document.getElementById('knowledge-wiki-markdown')).toBeNull();

    await cleanup();
    mockMe();
    documentList();
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('编辑来源 产品仓库'));
    await fill('source-name', '研发仓库');
    await click(button('取消', dialog('编辑来源')));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(document.body.textContent).not.toContain('编辑来源');
  });

  const folder = {
    id: 'kfd_new',
    baseId: 'kb_1',
    parentId: null,
    name: '规范',
    path: '/规范',
    createdAt: '',
  };

  /** 走真实文件输入与 FileReader，等到上传请求真正发出。 */
  async function startUpload() {
    await click(button('上传文件'));
    const file = new File(['a'], 'good.txt', { type: 'text/plain' });
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="选择要上传的文件"]',
      );
      if (!input) throw new Error('Missing upload input');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() =>
      calls.some(
        (item) =>
          item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
      ),
    );
  }

  it('selects a created folder only after its dialog unmounts', async () => {
    documentList();
    let folders: Array<typeof folder> = [];
    const created = deferred<void>();
    server.use(
      http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json(folders)),
      http.post('/api/knowledge/bases/kb_1/folders', async () => {
        await created.promise;
        return HttpResponse.json(folder);
      }),
    );
    const router = await mount('/knowledge/kb_1');
    await click(button('新建文件夹'));
    await fill('knowledge-folder-name', '规范');
    await click(button('创建', dialog('新建文件夹')));

    let leaving: Promise<unknown> | undefined;
    await act(async () => {
      leaving = router.navigate({ to: '/knowledge/' });
      void leaving.catch(() => undefined);
    });
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('取消', dialog('放弃未保存的更改？')));
    expect(router.state.location.pathname).toBe('/knowledge/kb_1');

    folders = [folder];
    await act(async () => created.resolve());
    await waitFor(() => router.state.location.search.folder === 'kfd_new');
    await flush();
    expect(dialogShown('新建文件夹')).toBe(false);
    expect(button('规范').getAttribute('aria-current')).toBe('true');
  });

  it('selects a created wiki page only after its dialog unmounts', async () => {
    documentList();
    const createdPage = {
      id: 'kwp_new',
      baseId: 'kb_1',
      slug: 'guide',
      title: '新指南',
      status: 'draft',
      currentVersionId: null,
      createdAt: '',
      updatedAt: '',
    };
    let pages: Array<typeof createdPage> = [];
    const created = deferred<void>();
    server.use(
      http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
        HttpResponse.json({ items: pages, nextCursor: null }),
      ),
      http.post('/api/knowledge/bases/kb_1/wiki-pages', async () => {
        await created.promise;
        return HttpResponse.json(createdPage);
      }),
      http.get('/api/knowledge/wiki-pages/kwp_new', () =>
        HttpResponse.json({ ...createdPage, versions: [], nextCursor: null }),
      ),
    );
    const router = await mount('/knowledge/kb_1', { panel: 'wiki' });
    await click(button('新建 Wiki 页面'));
    await fill('wiki-title', '新指南');
    await fill('wiki-slug', 'guide');
    await click(button('创建', dialog('新建 Wiki 页面')));

    let leaving: Promise<unknown> | undefined;
    await act(async () => {
      leaving = router.navigate({ to: '/knowledge/kb_1', search: { panel: 'sources' } });
      void leaving.catch(() => undefined);
    });
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('取消', dialog('放弃未保存的更改？')));
    expect(router.state.location.search).toEqual({ panel: 'wiki' });

    pages = [createdPage];
    await act(async () => created.resolve());
    await waitFor(() => router.state.location.search.page === 'kwp_new');
    await flush();
    expect(dialogShown('新建 Wiki 页面')).toBe(false);
    const pageButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes('新指南'),
    );
    expect(pageButton?.getAttribute('aria-current')).toBe('true');
  });

  it('keeps the draft guard usable after a failed folder create', async () => {
    documentList();
    server.use(
      http.post('/api/knowledge/bases/kb_1/folders', () =>
        HttpResponse.json({ code: 'CONFLICT', message: '同名文件夹已存在' }, { status: 409 }),
      ),
    );
    const router = await mount('/knowledge/kb_1');
    await click(button('新建文件夹'));
    await fill('knowledge-folder-name', '规范');
    await click(button('创建', dialog('新建文件夹')));
    expect(toastError).toHaveBeenCalled();
    expect(dialog('新建文件夹')).toBeDefined();

    let leaving: Promise<unknown> | undefined;
    await act(async () => {
      leaving = router.navigate({ to: '/knowledge/' });
      void leaving.catch(() => undefined);
    });
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('放弃并离开', dialog('放弃未保存的更改？')));
    await act(async () => {
      await leaving;
    });
    expect(router.state.location.pathname).toBe('/knowledge');
  });

  it('pauses folder changes during an upload batch and resumes after it finishes', async () => {
    documentList();
    const upload = deferred<void>();
    server.use(
      http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json([folder])),
      http.put('/api/knowledge/bases/kb_1/documents/upload', async () => {
        await upload.promise;
        return HttpResponse.json({ documentId: 'kdoc_new', jobId: 'kjob_new' });
      }),
    );
    const router = await mount('/knowledge/kb_1');
    await startUpload();
    await click(button('规范'));
    expect(dialog('上传尚未完成')).toBeDefined();
    expect(router.state.location.search).toEqual({});

    await act(async () => upload.resolve());
    await waitFor(() => router.state.location.search.folder === 'kfd_new');
  });

  it('pauses tab changes during an upload batch and resumes after it finishes', async () => {
    documentList();
    const upload = deferred<void>();
    server.use(
      http.put('/api/knowledge/bases/kb_1/documents/upload', async () => {
        await upload.promise;
        return HttpResponse.json({ documentId: 'kdoc_new', jobId: 'kjob_new' });
      }),
    );
    const router = await mount('/knowledge/kb_1');
    await startUpload();
    await click(button('处理记录'));
    expect(dialog('上传尚未完成')).toBeDefined();
    expect(router.state.location.search).toEqual({});

    await act(async () => upload.resolve());
    await waitFor(() => router.state.location.search.panel === 'jobs');
  });

  it('pauses history changes during an upload batch and resumes after it finishes', async () => {
    documentList();
    const upload = deferred<void>();
    server.use(
      http.put('/api/knowledge/bases/kb_1/documents/upload', async () => {
        await upload.promise;
        return HttpResponse.json({ documentId: 'kdoc_new', jobId: 'kjob_new' });
      }),
    );
    const router = await mount('/knowledge/kb_1');
    await startUpload();
    await act(async () => {
      router.history.push('/knowledge/');
    });
    await flush();
    expect(dialog('上传尚未完成')).toBeDefined();
    expect(router.state.location.pathname).toBe('/knowledge/kb_1');

    await act(async () => upload.resolve());
    // 直接走 history.push 的原始路径不会被 Router 归一化，保留末尾斜杠。
    await waitFor(() => router.state.location.pathname === '/knowledge/');
  });

  it('blocks leaving the documents panel until the upload batch finishes', async () => {
    documentList();
    const upload = deferred<void>();
    server.use(
      http.put('/api/knowledge/bases/kb_1/documents/upload', async () => {
        await upload.promise;
        return HttpResponse.json({ documentId: 'kdoc_new', jobId: 'kjob_new' });
      }),
    );
    const router = await mount('/knowledge/kb_1');
    await click(button('上传文件'));
    const file = new File(['a'], 'good.txt', { type: 'text/plain' });
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="选择要上传的文件"]',
      );
      if (!input) throw new Error('Missing upload input');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() =>
      calls.some(
        (item) =>
          item.method === 'PUT' && item.path === '/api/knowledge/bases/kb_1/documents/upload',
      ),
    );

    let navigation: Promise<unknown> | undefined;
    await act(async () => {
      navigation = router.navigate({ to: '/knowledge/' });
      void navigation.catch(() => undefined);
    });
    expect(dialog('上传尚未完成')).toBeDefined();
    expect(router.state.location.pathname).toBe('/knowledge/kb_1');

    await act(async () => upload.resolve());
    await flush();
    await act(async () => {
      await navigation;
    });
    expect(router.state.location.pathname).toBe('/knowledge');
  });

  it('shows field and range errors on source submit instead of disabling save', async () => {
    listHandlers();
    server.use(http.post('/api/knowledge/bases/kb_1/sources', () => HttpResponse.json(source)));
    await mount('/knowledge/kb_1', { panel: 'sources' });
    await click(button('新建来源'));
    await click(sourceChoice('GitHub', dialog('新建来源')));
    const creator = dialog('新建来源');
    const create = button('创建', creator);
    expect(create.disabled).toBe(false);
    await click(create);
    const name = document.getElementById('source-name') as HTMLInputElement;
    const external = document.getElementById('source-range-0-external') as HTMLInputElement;
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(external.getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(name.getAttribute('aria-describedby') as string)?.textContent,
    ).toContain('请填写来源名称');
    expect(
      document.getElementById(external.getAttribute('aria-describedby') as string)?.textContent,
    ).toContain('仓库');
    expect(
      calls.some(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
      ),
    ).toBe(false);

    await fill('source-name', '仓库文档');
    await fill('source-range-0-external', 'acme/docs');
    await fill('knowledge-source-secret', 'ghp_x');
    await click(button('创建', creator));
    expect(
      calls.some(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/sources',
      ),
    ).toBe(true);
  });

  it('polls a sync job pushed out of the latest 50 until it finishes', async () => {
    listHandlers();
    // 自动 Wiki 等任务占满前 50 条，刚提交的同步任务不在列表里。
    const noise = Array.from({ length: 50 }, (_, index) =>
      wikiJob('succeeded', `kjob_noise_${index}`),
    );
    let detailPolls = 0;
    let documentCalls = 0;
    let sourceCalls = 0;
    let runCalls = 0;
    server.use(
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: noise, nextCursor: null })),
      http.get('/api/knowledge/jobs/kjob_sync', () => {
        detailPolls += 1;
        return HttpResponse.json(syncJob(detailPolls === 1 ? 'running' : 'succeeded'));
      }),
      http.get('/api/knowledge/bases/kb_1/documents', () => {
        documentCalls += 1;
        return HttpResponse.json({ items: [doc], nextCursor: null });
      }),
      http.get('/api/knowledge/bases/kb_1/sources', () => {
        sourceCalls += 1;
        return HttpResponse.json({ items: [source], nextCursor: null });
      }),
      http.get('/api/knowledge/sources/ksrc_1/runs', () => {
        runCalls += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
      http.post('/api/knowledge/sources/ksrc_1/sync', () =>
        HttpResponse.json({ jobId: 'kjob_sync', syncRunId: 'ksyn_1' }, { status: 202 }),
      ),
    );
    await mount('/knowledge/kb_1');
    expect(documentCalls).toBeGreaterThan(0);
    await click(button('来源'));
    await click(button('立即同步'));
    const sourceBefore = sourceCalls;
    const runBefore = runCalls;

    // 不手动 invalidate：列表已停止轮询，终态只能由产品自己的定向轮询发现。
    await waitFor(() => detailPolls >= 2, 120);
    await waitFor(() => sourceCalls > sourceBefore, 60);
    expect(runCalls).toBeGreaterThan(runBefore);
    expect(
      calls.filter((item) => item.method === 'GET' && item.path === '/api/knowledge/jobs/kjob_sync')
        .length,
    ).toBeGreaterThanOrEqual(2);
    // 文档面板已切走：查询被标记失效，下次进入会重新拉取。
    const documentQueries =
      client?.getQueryCache().findAll({ queryKey: ['knowledge', 'documents', 'kb_1'] }) ?? [];
    expect(documentQueries.length).toBeGreaterThan(0);
    expect(documentQueries.every((query) => query.state.isInvalidated)).toBe(true);
  });

  it('stops tracking a sync job that the deleted source took with it', async () => {
    listHandlers();
    let detailCalls = 0;
    let runCalls = 0;
    const warning = vi.spyOn(toast, 'warning');
    server.use(
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/jobs/kjob_gone', async () => {
        detailCalls += 1;
        await delay(30);
        return HttpResponse.json({ code: 'NOT_FOUND', message: '任务不存在' }, { status: 404 });
      }),
      http.get('/api/knowledge/sources/ksrc_1/runs', () => {
        runCalls += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
      http.post('/api/knowledge/sources/ksrc_1/sync', () =>
        HttpResponse.json({ jobId: 'kjob_gone', syncRunId: 'ksyn_1' }, { status: 202 }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('来源'));
    await click(button('立即同步'));
    await waitFor(() => detailCalls >= 1);
    await waitFor(() => warning.mock.calls.length > 0);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('同步任务已不存在，可能来源已删除；请刷新来源列表');
    expect(toastError).not.toHaveBeenCalled();

    // 404 不是终态：任务停在失败状态，不伪造完成去失效来源与文档。
    const jobQuery = client?.getQueryCache().find({ queryKey: ['knowledge', 'job', 'kjob_gone'] });
    expect(jobQuery?.state.status).toBe('error');
    const runBefore = runCalls;

    // 跨过两个 2s 轮询周期仍没有新请求：跟踪已停止。
    for (let tick = 0; tick < 55; tick += 1) await flush();
    expect(detailCalls).toBe(1);
    expect(runCalls).toBe(runBefore);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through a 5xx and still settles the sync normally', async () => {
    listHandlers();
    let detailCalls = 0;
    let documentCalls = 0;
    let runCalls = 0;
    const warning = vi.spyOn(toast, 'warning');
    server.use(
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('/api/knowledge/jobs/kjob_sync', () => {
        detailCalls += 1;
        if (detailCalls === 1) {
          return HttpResponse.json(
            { code: 'INTERNAL', message: '任务服务不可用' },
            { status: 500 },
          );
        }
        return HttpResponse.json(syncJob(detailCalls === 2 ? 'running' : 'succeeded'));
      }),
      http.get('/api/knowledge/bases/kb_1/documents', () => {
        documentCalls += 1;
        return HttpResponse.json({ items: [doc], nextCursor: null });
      }),
      http.get('/api/knowledge/sources/ksrc_1/runs', () => {
        runCalls += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
      http.post('/api/knowledge/sources/ksrc_1/sync', () =>
        HttpResponse.json({ jobId: 'kjob_sync', syncRunId: 'ksyn_1' }, { status: 202 }),
      ),
    );
    await mount('/knowledge/kb_1');
    expect(documentCalls).toBeGreaterThan(0);
    await click(button('来源'));
    await click(button('立即同步'));
    const runBefore = runCalls;

    // 500 只让当前这次请求重试，轮询继续到真正的终态。
    await waitFor(() => detailCalls >= 3, 120);
    await waitFor(() => runCalls > runBefore, 60);
    expect(warning).not.toHaveBeenCalled();
    const documentQueries =
      client?.getQueryCache().findAll({ queryKey: ['knowledge', 'documents', 'kb_1'] }) ?? [];
    expect(documentQueries.length).toBeGreaterThan(0);
    expect(documentQueries.every((query) => query.state.isInvalidated)).toBe(true);
  });

  it('clears every document filter from the empty result', async () => {
    listHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', ({ request }) =>
        HttpResponse.json({
          items: new URL(request.url).searchParams.get('status') ? [] : [doc],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1');
    await chooseFilter('按状态筛选', '失败');
    expect(document.body.textContent).toContain('没有匹配的文档');
    await click(button('清除筛选'));
    expect(document.body.textContent).toContain('上线流程');
  });

  it('offers a retry when the tag filter cannot load', async () => {
    listHandlers();
    let tagCalls = 0;
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
      http.get('/api/knowledge/bases/kb_1/tags', () => {
        tagCalls += 1;
        return tagCalls === 1
          ? HttpResponse.json({ code: 'INTERNAL', message: '标签失败' }, { status: 500 })
          : HttpResponse.json([{ id: 'ktag_1', baseId: 'kb_1', name: '流程', createdAt: '' }]);
      }),
    );
    await mount('/knowledge/kb_1');
    expect(document.body.textContent).toContain('标签没有加载出来，重试');
    await click(button('标签没有加载出来，重试'));
    expect(button('按标签筛选')).toBeDefined();
  });
});

describe('knowledge job failure reasons', () => {
  it('explains a lost worker job in Chinese and keeps the raw reason in the title', async () => {
    baseHandlers();
    const lostJob: KnowledgeJob = {
      id: 'kjob_lost',
      type: 'ingest',
      status: 'failed',
      step: null,
      progress: 0,
      attempts: 1,
      error: 'knowledge worker lost track of this job',
      createdAt: '2026-01-01T00:00:00Z',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      documentId: null,
      sourceId: null,
      documentTitle: null,
      sourceName: null,
    };
    server.use(
      http.get('/api/knowledge/jobs', () =>
        HttpResponse.json({ items: [lostJob], nextCursor: null }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'jobs' });
    const reason = document.querySelector('[title="knowledge worker lost track of this job"]');
    expect(reason?.textContent).toBe('后台任务中断，本次未完成；重试会重新执行');
  });
});

// ---- K-U1..U3：批量、版本/草稿、FAQ、Wiki 组织与检索诊断 -----------------

const faqDocument = {
  ...doc,
  id: 'kdoc_faq',
  title: '如何备份',
  sourceType: 'manual' as const,
  contentKind: 'faq' as const,
  currentVersionId: 'kdv_faq_pub',
  tags: ['FAQ'],
  sizeBytes: 128,
  mimeType: 'text/markdown',
};

const faq = {
  question: '如何备份？',
  similarQuestions: ['备份怎么做'],
  negativeQuestions: ['不用备份'],
  answers: ['每日自动备份。', '异机保存副本。'],
  answerStrategy: 'all' as const,
  isRecommended: true,
};

const faqSummary = { ...faqDocument, faq };

const faqPublishedVersion = {
  id: 'kdv_faq_pub',
  documentId: 'kdoc_faq',
  version: 1,
  origin: 'faq' as const,
  parentVersionId: null,
  metadata: {},
  faq,
  isCurrent: true,
  createdAt: '2026-01-01T00:00:00Z',
};

const faqDraftVersion = {
  ...faqPublishedVersion,
  id: 'kdv_faq_draft',
  version: 2,
  origin: 'manual' as const,
  parentVersionId: 'kdv_faq_pub',
  metadata: { publication: 'draft' },
  isCurrent: false,
  createdAt: '2026-01-02T00:00:00Z',
};

const faqDetail = {
  document: faqDocument,
  draftVersion: faqDraftVersion,
  publishedVersion: faqPublishedVersion,
  faq,
};

function wikiSummary(override: Record<string, unknown>) {
  return { ...wikiPageSummary, ...override };
}

function hitWire(override: Record<string, unknown> = {}) {
  return {
    chunkId: 'kchk_faq',
    documentId: 'kdoc_faq',
    versionId: 'kdv_faq_pub',
    target: { kind: 'faq', id: 'kdoc_faq' },
    targetVersionId: 'kdv_faq_pub',
    title: '如何备份？',
    heading: null,
    quote: '每日自动备份。',
    pageFrom: null,
    pageTo: null,
    locator: null,
    parentContent: null,
    sourceUrl: null,
    score: 0.42,
    scoreKind: 'rrf' as const,
    scores: { keyword: 0.7, vector: 0.8, rrf: 0.03, rerank: 0.91 },
    image: null,
    faq: null,
    ...override,
  };
}

describe('knowledge batch actions', () => {
  it('submits selected documents once and shows every per-item result', async () => {
    baseHandlers();
    const second = { ...doc, id: 'kdoc_2', title: '部署流程', currentVersionId: 'kdv_2' };
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc, second], nextCursor: null }),
      ),
      http.post('/api/knowledge/bases/kb_1/documents/batch', () =>
        HttpResponse.json({
          results: [
            { documentId: 'kdoc_1', status: 'succeeded' },
            {
              documentId: 'kdoc_2',
              status: 'failed',
              code: 'INVALID_INPUT',
              message: '文档不属于该知识库',
            },
          ],
        }),
      ),
    );
    await mount('/knowledge/kb_1');
    const selectRow = (label: string): HTMLElement => {
      const item = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      if (!item) throw new Error(`Missing selection: ${label}`);
      return item;
    };
    await click(selectRow('选择 上线流程'));
    await click(selectRow('选择 部署流程'));
    expect(document.body.textContent).toContain('已选 2 个');
    await click(button('标签'));
    const batch = dialog('批量标签');
    await fill('knowledge-batch-tags', '重要');
    await click(button('标签', batch));
    expect(
      calls.find((item) => item.path === '/api/knowledge/bases/kb_1/documents/batch')?.body,
    ).toEqual({
      documentIds: ['kdoc_1', 'kdoc_2'],
      action: 'tag',
      tags: ['重要'],
      tagMode: 'add',
    });
    expect(batch.textContent).toContain('成功 1 项 · 失败 1 项');
    expect(batch.textContent).toContain('文档不属于该知识库');
  });
});

describe('knowledge document versions and manual drafts', () => {
  const versionHandlers = (override: { currentVersionId: string; versions: unknown[] }) =>
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({
          items: [{ ...doc, currentVersionId: override.currentVersionId }],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/versions', () =>
        HttpResponse.json({ items: override.versions, nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/versions/kdv_old/markdown', () => markdownResponse('旧版本正文')),
      http.get('/api/knowledge/versions/kdv_2/markdown', () => markdownResponse('当前正文')),
      detailsHandler(),
    );

  it('switches to an old version and rolls the current pointer back explicitly', async () => {
    baseHandlers();
    versionHandlers({
      currentVersionId: 'kdv_2',
      versions: [
        {
          id: 'kdv_2',
          documentId: 'kdoc_1',
          version: 2,
          isCurrent: true,
          origin: 'source',
          parentVersionId: null,
          metadata: {},
          createdAt: '2026-01-02T00:00:00Z',
        },
        {
          id: 'kdv_old',
          documentId: 'kdoc_1',
          version: 1,
          isCurrent: false,
          origin: 'manual',
          parentVersionId: null,
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    server.use(
      http.post('/api/knowledge/documents/kdoc_1/rollback', () =>
        HttpResponse.json({ ...doc, currentVersionId: 'kdv_old' }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    await flush();
    expect(viewer.textContent).toContain('当前正文');
    const versionTrigger = document.querySelector<HTMLElement>('[aria-label="选择文档版本"]');
    if (!versionTrigger) throw new Error('Missing version picker');
    await click(versionTrigger);
    const oldOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === 'v1 · 人工编辑',
    );
    if (!oldOption) throw new Error('Missing old version option');
    await click(oldOption);
    await flush();
    expect(
      calls.some((item) => item.path.startsWith('/api/knowledge/versions/kdv_old/markdown')),
    ).toBe(true);
    await click(button('设为当前版本', viewer));
    await click(button('切换', dialog('设为当前版本')));
    expect(
      calls.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/documents/kdoc_1/rollback',
      )?.body,
    ).toEqual({ versionId: 'kdv_old', expectedVersionId: 'kdv_2' });
  });

  it('saves a manual draft without publishing and keeps the draft on failure', async () => {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({
          items: [
            {
              ...doc,
              contentKind: 'document',
              sourceType: 'manual',
              status: 'ready',
              currentVersionId: 'kdv_1',
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/documents/kdoc_1/manual', () =>
        HttpResponse.json({ content: '已发布正文', versionId: 'kdv_1', status: 'published' }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('已发布正文')),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      detailsHandler(),
      http.put('/api/knowledge/documents/kdoc_1/manual', () =>
        HttpResponse.json({ code: 'CONFLICT_STALE', message: '正文已被修改' }, { status: 409 }),
      ),
    );
    await mount('/knowledge/kb_1');
    await click(button('上线流程'));
    await click(button('编辑正文', dialog('上线流程')));
    await waitFor(() => document.getElementById('knowledge-manual-draft') !== null);
    await fill('knowledge-manual-draft', '新的草稿正文');
    await click(button('保存草稿', dialog('编辑正文 · 上线流程')));
    expect(
      calls.find(
        (item) => item.method === 'PUT' && item.path === '/api/knowledge/documents/kdoc_1/manual',
      )?.body,
    ).toEqual({ content: '新的草稿正文', expectedVersionId: 'kdv_1' });
    await waitFor(() => document.body.textContent?.includes('数据已被其他操作修改') === true);
    expect(document.getElementById('knowledge-manual-draft')).not.toBeNull();
  });
});

describe('knowledge FAQ management', () => {
  const importCounts = {
    total: 2,
    success: 1,
    failed: 0,
    partialFailed: 1,
    skipped: 0,
    added: 1,
    merged: 1,
  };

  const importedDetail = {
    document: {
      ...faqDocument,
      id: 'kdoc_new',
      title: '新的备份',
      currentVersionId: null,
      tags: [],
    },
    draftVersion: {
      ...faqDraftVersion,
      id: 'kdv_new',
      documentId: 'kdoc_new',
      version: 1,
      parentVersionId: null,
      metadata: {
        publication: 'draft',
        faqImport: { batchId: 'imp_1', mode: 'append', expectedVersionId: null },
      },
    },
    publishedVersion: null,
    faq,
  };

  function faqHandlers() {
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/faqs', () =>
        HttpResponse.json({ items: [faqSummary], nextCursor: null }),
      ),
      http.get('/api/knowledge/faqs/kdoc_faq', () => HttpResponse.json(faqDetail)),
      http.get('/api/knowledge/faqs/kdoc_new', () => HttpResponse.json(importedDetail)),
      http.put('/api/knowledge/faqs/kdoc_faq', () =>
        HttpResponse.json({ documentId: 'kdoc_faq', jobId: 'kjob_faq' }),
      ),
      http.post('/api/knowledge/faqs/kdoc_faq/publish', () => HttpResponse.json(faqDocument)),
      http.post('/api/knowledge/bases/kb_1/faqs/import', async ({ request }) => {
        const body = (await request.json()) as { dryRun: boolean; mode: 'append' | 'replace' };
        if (body.dryRun) {
          return HttpResponse.json({
            dryRun: true,
            mode: body.mode,
            committed: false,
            importBatchId: null,
            counts: importCounts,
            results: [
              {
                row: 1,
                status: 'success',
                operation: 'add',
                issues: [],
              },
              {
                row: 2,
                status: 'partial_failed',
                operation: 'merge',
                issues: [
                  { field: 'similarQuestions', code: 'DUPLICATE', message: '重复问题已去掉' },
                ],
              },
            ],
          });
        }
        return HttpResponse.json(
          {
            dryRun: false,
            mode: body.mode,
            committed: true,
            importBatchId: 'imp_1',
            counts: { ...importCounts, skipped: 1, total: 1, success: 1 },
            results: [
              {
                row: 1,
                status: 'success',
                operation: 'add',
                documentId: 'kdoc_new',
                expectedVersionId: null,
                jobId: 'kjob_import',
                issues: [],
              },
            ],
          },
          { status: 202 },
        );
      }),
      http.post('/api/knowledge/bases/kb_1/faqs/batch', () =>
        HttpResponse.json({ results: [{ documentId: 'kdoc_new', status: 'succeeded' }] }),
      ),
      http.get('/api/knowledge/jobs/kjob_import', () =>
        HttpResponse.json({
          id: 'kjob_import',
          type: 'ingest',
          status: 'succeeded',
          step: null,
          progress: 100,
          attempts: 1,
          error: null,
          createdAt: '2026-01-01T00:00:00Z',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:01:00Z',
        }),
      ),
      http.get(
        '/api/knowledge/bases/kb_1/faqs/export',
        () => new HttpResponse('[]', { headers: { 'content-type': 'application/json' } }),
      ),
      http.post('/api/knowledge/bases/kb_1/faqs/test', () =>
        HttpResponse.json({ hits: [hitWire()], degraded: false, warnings: [] }),
      ),
    );
  }

  it('filters the FAQ list by recommendation without changing status', async () => {
    faqHandlers();
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await chooseFilter('按推荐筛选', '推荐');
    const call = calls.find(
      (item) =>
        item.method === 'GET' &&
        item.path.startsWith('/api/knowledge/bases/kb_1/faqs?') &&
        item.path.includes('isRecommended=true'),
    );
    expect(call).toBeDefined();
    const params = new URL(call?.path ?? '', 'http://localhost').searchParams;
    expect(params.get('isRecommended')).toBe('true');
    expect(params.get('limit')).toBe('50');
  });

  it('saves the answer strategy and recommendation flag without changing published answers', async () => {
    faqHandlers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:faq');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    expect(document.body.textContent).toContain('如何备份？');
    expect(document.body.textContent).toContain('2 个答案');

    await click(button('编辑'));
    const editor = dialog('编辑 FAQ');
    await waitFor(() => document.querySelectorAll('textarea[aria-label^="答案"]').length === 2);
    expect(
      [...document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label^="答案"]')].map(
        (item) => item.value,
      ),
    ).toEqual(['每日自动备份。', '异机保存副本。']);
    await fill('faq-question', '如何做备份？');
    await chooseOption('faq-answer-strategy', '随机一条');
    await click(document.getElementById('faq-recommended') as HTMLElement);
    await click(button('保存草稿', editor));
    expect(
      calls.find((item) => item.method === 'PUT' && item.path === '/api/knowledge/faqs/kdoc_faq')
        ?.body,
    ).toEqual(
      expect.objectContaining({
        faq: expect.objectContaining({
          question: '如何做备份？',
          answers: faq.answers,
          answerStrategy: 'random',
          isRecommended: false,
        }),
        expectedVersionId: 'kdv_faq_draft',
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith('FAQ 草稿已保存，发布后可召回');

    await click(button('发布草稿'));
    const publish = dialog('发布 FAQ');
    await waitFor(() => publish.textContent?.includes('将 v2') === true);
    await click(button('发布', publish));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/faqs/kdoc_faq/publish',
      )?.body,
    ).toEqual({ versionId: 'kdv_faq_draft', expectedVersionId: 'kdv_faq_pub' });
  });

  it('previews without writing, then polls the imported job and publishes the whole batch', async () => {
    faqHandlers();
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await fill('faq-import-content', '{"items":[]}');
    await click(button('预览', importer));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/import',
      )?.body,
    ).toEqual({ format: 'json', content: '{"items":[]}', mode: 'append', dryRun: true });
    expect(importer.textContent).toContain('预览 · 未写入');
    expect(importer.textContent).toContain('共 2');

    await click(button('确认导入', importer));
    expect(
      calls
        .filter(
          (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/import',
        )
        .at(-1)?.body,
    ).toEqual({ format: 'json', content: '{"items":[]}', mode: 'append', dryRun: false });

    await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].some((item) =>
        item.textContent?.includes('发布本批 1 条 FAQ'),
      ),
    );
    const publishButton = button('发布本批 1 条 FAQ', importer);
    await click(publishButton);
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
      )?.body,
    ).toEqual({
      action: 'publish',
      importBatchId: 'imp_1',
      items: [{ documentId: 'kdoc_new', versionId: 'kdv_new', expectedVersionId: null }],
    });
    expect(importer.textContent).toContain('本批已发布');
    expect(toastSuccess).toHaveBeenCalledWith('本批 FAQ 已发布');
  });

  it('shows the old FAQ count in the replace confirmation and keeps the dialog open', async () => {
    faqHandlers();
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await fill('faq-import-content', '{"items":[]}');
    await chooseOption('faq-import-mode', '替换全部');
    await click(button('预览', importer));
    await click(button('确认导入', importer));
    const confirm = dialog('替换全部 FAQ');
    expect(confirm.textContent).toContain('1 条 FAQ');
    expect(dialogShown('导入 FAQ')).toBe(true);
    await click(button('确认导入', confirm));
    await flush();
    expect(
      calls
        .filter(
          (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/import',
        )
        .at(-1)?.body,
    ).toEqual({ format: 'json', content: '{"items":[]}', mode: 'replace', dryRun: false });
    expect(dialogShown('导入 FAQ')).toBe(true);
  });

  it('sends xlsx content as the selected import format', async () => {
    faqHandlers();
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await chooseOption('faq-import-format', 'Excel (.xlsx)');
    await fill('faq-import-content', 'UEsDBAo=');
    await click(button('预览', importer));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/import',
      )?.body,
    ).toEqual({ format: 'xlsx', content: 'UEsDBAo=', mode: 'append', dryRun: true });
  });

  it('keeps the import dialog and its input open while the commit request is in flight', async () => {
    faqHandlers();
    const response = deferred<void>();
    server.use(
      http.post('/api/knowledge/bases/kb_1/faqs/import', async ({ request }) => {
        const body = (await request.json()) as { dryRun: boolean; mode: 'append' | 'replace' };
        if (body.dryRun) {
          return HttpResponse.json({
            dryRun: true,
            mode: body.mode,
            committed: false,
            importBatchId: null,
            counts: importCounts,
            results: [],
          });
        }
        await response.promise;
        return HttpResponse.json(
          {
            dryRun: false,
            mode: body.mode,
            committed: true,
            importBatchId: 'imp_1',
            counts: { ...importCounts, skipped: 1, total: 1, success: 1 },
            results: [],
          },
          { status: 202 },
        );
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await fill('faq-import-content', '{"items":[]}');
    await click(button('预览', importer));
    await click(button('确认导入', importer));
    expect((document.getElementById('faq-import-content') as HTMLTextAreaElement).value).toBe(
      '{"items":[]}',
    );
    await click(button('关闭', importer));
    expect(dialogShown('导入 FAQ')).toBe(true);
    await act(async () => response.resolve());
    await flush();
    expect(dialogShown('导入 FAQ')).toBe(true);
  });

  it('runs the shared FAQ hit test with recommendation and direct-answer options', async () => {
    faqHandlers();
    server.use(
      http.post('/api/knowledge/bases/kb_1/faqs/test', () =>
        HttpResponse.json({
          hits: [
            hitWire({
              faq: {
                answers: ['每日自动备份。'],
                answerStrategy: 'random',
                isRecommended: true,
                matchedQuestion: '如何备份？',
                questionKind: 'standard',
              },
            }),
          ],
          degraded: false,
          warnings: [],
          directAnswer: {
            target: { kind: 'faq', id: 'kdoc_faq' },
            versionId: 'kdv_faq_pub',
            answers: ['每日自动备份。'],
            vectorScore: 0.96,
          },
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="FAQ 命中测试"]');
    if (!input) throw new Error('Missing FAQ test input');
    const testForm = input.closest('form');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '怎么备份',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(document.querySelector('[aria-label="只返回推荐 FAQ"]') as HTMLElement);
    await click(document.querySelector('[aria-label="FAQ 优先"]') as HTMLElement);
    await fill('faq-test-direct-threshold', '0.8');
    await act(async () => {
      testForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/test',
      )?.body,
    ).toEqual(
      expect.objectContaining({
        q: '怎么备份',
        onlyRecommended: true,
        faqPriority: true,
        faqDirectAnswerThreshold: 0.8,
      }),
    );
    const section = [...document.querySelectorAll('section')].find(
      (item) => item.querySelector('h2')?.textContent === '命中测试',
    );
    expect(section?.textContent).toContain('直接答案');
    expect(section?.textContent).toContain('cosine 0.960');
    expect(section?.textContent).toContain('随机答案 · 本次 1 条');
    expect(section?.textContent).not.toContain('异机保存副本。');
  });
});

describe('knowledge wiki organization and contributions', () => {
  it('shows directory links, diffs versions and saves drafts without publishing', async () => {
    baseHandlers();
    const third = {
      id: 'kwv_3',
      pageId: 'kwp_1',
      version: 3,
      markdown: '## 当前\n\n第三步。',
      sourceChunkIds: ['kchk_2'],
      model: 'manual',
      generatedBy: 'manual' as const,
      createdAt: '2026-01-03T00:00:00Z',
    };
    const page = {
      ...wikiPage,
      currentVersionId: 'kwv_2',
      parentId: null,
      position: 0,
      versions: [third, ...wikiPage.versions],
    };
    const sibling = wikiSummary({
      id: 'kwp_2',
      slug: 'backup',
      title: '备份指南',
      status: 'published',
      currentVersionId: null,
    });
    server.use(
      http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
        HttpResponse.json({ items: [wikiPageSummary, sibling], nextCursor: null }),
      ),
      http.get('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(page)),
      http.get('/api/knowledge/wiki-pages/kwp_1/links', () =>
        HttpResponse.json({
          outgoing: [{ targetPageId: 'kwp_2', anchor: '备份' }],
          incoming: [{ sourcePageId: 'kwp_2', anchor: null }],
        }),
      ),
      http.get('/api/knowledge/wiki-pages/kwp_1/diff', () =>
        HttpResponse.json({
          fromVersionId: 'kwv_2',
          toVersionId: 'kwv_3',
          addedLines: ['第三步。'],
          removedLines: ['第二步。'],
          addedSourceChunkIds: ['kchk_2'],
          removedSourceChunkIds: ['kchk_1'],
        }),
      ),
      http.patch('/api/knowledge/wiki-pages/kwp_1', () => HttpResponse.json(wikiPageSummary)),
      http.post('/api/knowledge/wiki-pages/kwp_1/publish', () =>
        HttpResponse.json(wikiPageSummary),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_1' });
    await waitFor(() => document.body.textContent?.includes('链接') === true);
    expect(document.body.textContent).toContain('备份指南');
    expect(document.body.textContent).toContain('链接');
    // 回退后的历史版本不等于草稿；没有 publication 标记时只说明未设为当前。
    expect(document.body.textContent).toContain('未设为当前版本');
    expect(document.body.textContent).not.toContain('有未发布草稿');

    await click(button('对比上一版'));
    const diff = dialog('版本贡献差异');
    await waitFor(() => diff.textContent?.includes('第三步。') === true);
    expect(diff.textContent).toContain('第二步。');
    expect(diff.textContent).toContain('kchk_2');
    await click(button('关闭', diff));

    await click(button('组织'));
    const organize = dialog('组织 Wiki 页面');
    await chooseOption('wiki-parent', '备份指南');
    await fill('wiki-position', '2');
    await click(button('保存', organize));
    expect(
      calls.find(
        (item) => item.method === 'PATCH' && item.path === '/api/knowledge/wiki-pages/kwp_1',
      )?.body,
    ).toEqual({ parentId: 'kwp_2', position: 2, expectedVersion: 'kwv_3' });

    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    await fill('knowledge-wiki-markdown', '## 新草稿');
    await click(button('保存草稿', editor));
    expect(
      calls
        .filter(
          (item) => item.method === 'PATCH' && item.path === '/api/knowledge/wiki-pages/kwp_1',
        )
        .at(-1)?.body,
    ).toEqual({ markdown: '## 新草稿', expectedVersion: 'kwv_3' });
    expect(toastSuccess).toHaveBeenCalledWith('Wiki 草稿已保存，发布后才会上线');

    await click(button('发布此版本', document.body));
    const publish = dialog('发布 Wiki 版本');
    await click(button('发布', publish));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/wiki-pages/kwp_1/publish',
      )?.body,
    ).toEqual({ versionId: 'kwv_3' });
  });
});

describe('knowledge search URL state and diagnostics', () => {
  it('restores filters from the URL and renders warnings, scores and candidate diagnostics', async () => {
    baseHandlers();
    let searchUrl = '';
    server.use(
      http.get('/api/knowledge/bases/kb_1/search', ({ request }) => {
        searchUrl = request.url;
        return HttpResponse.json({
          hits: [hitWire()],
          degraded: true,
          warnings: [{ code: 'embedding_unavailable', message: '向量模型不可用，仅关键词结果' }],
          diagnostics: {
            paths: { keyword: 3, vector: 0, imageVector: 0 },
            fused: 3,
            returned: 1,
            rerank: 'unavailable',
            elapsedMs: 12,
            candidates: [{ chunkId: 'kchk_faq', scores: hitWire().scores }],
          },
        });
      }),
    );
    await mount('/knowledge/kb_1', {
      panel: 'search',
      q: '备份',
      folders: JSON.stringify(['kf_1']),
      tags: JSON.stringify(['流程']),
      kinds: JSON.stringify(['faq']),
      rerank: 'false',
      minVectorScore: '0.5',
      onlyRecommended: 'true',
      faqPriority: 'true',
      faqDirectAnswerThreshold: '0.85',
      diagnostics: 'true',
    });
    await flush();
    const params = new URL(searchUrl, 'http://localhost').searchParams;
    expect(params.getAll('folders')).toEqual(['kf_1']);
    expect(params.getAll('tags')).toEqual(['流程']);
    expect(params.getAll('kinds')).toEqual(['faq']);
    expect(params.get('rerank')).toBe('false');
    expect(params.get('minVectorScore')).toBe('0.5');
    expect(params.get('onlyRecommended')).toBe('true');
    expect(params.get('faqPriority')).toBe('true');
    expect(params.get('faqDirectAnswerThreshold')).toBe('0.85');
    expect(params.get('diagnostics')).toBe('true');

    expect(document.body.textContent).toContain('向量模型不可用，仅关键词结果');
    expect(document.body.textContent).toContain('FAQ');
    expect(document.body.textContent).toContain('关键词');
    expect(document.body.textContent).toContain('RRF 分数');
    expect(document.body.textContent).toContain('诊断 · 12 ms');
    expect(document.body.textContent).toContain('kchk_faq');
  });
});

type KnowledgeJobFixture = KnowledgeJob & {
  documentId: string | null;
  sourceId: string | null;
  documentTitle: string | null;
  sourceName: string | null;
};

function jobFixture(
  overrides: Partial<KnowledgeJobFixture> & Pick<KnowledgeJobFixture, 'id' | 'type' | 'status'>,
): KnowledgeJobFixture {
  return {
    step: null,
    progress: 0,
    attempts: 1,
    error: null,
    createdAt: '2026-01-02T00:00:00Z',
    startedAt: '2026-01-02T00:00:00Z',
    endedAt: null,
    documentId: null,
    sourceId: null,
    documentTitle: null,
    sourceName: null,
    ...overrides,
  };
}

function meWith(ids: readonly string[]) {
  return {
    authenticated: true as const,
    user: { businessId: 'test-admin', username: 'admin', name: '测试管理员' },
    roles: [],
    grants: PERMISSIONS.filter((permission) => ids.includes(permission.id)).flatMap(
      (permission) => {
        const scope = permission.scopes[0];
        return scope ? [{ permissionId: permission.id, scope }] : [];
      },
    ),
  };
}

function findButton(text: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
}

function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (item) => item.textContent?.trim() ?? '',
  );
}

function jobRequest(): URL | undefined {
  const call = calls.find(
    (item) => item.method === 'GET' && item.path.startsWith('/api/knowledge/jobs?'),
  );
  return call ? new URL(call.path, 'http://localhost') : undefined;
}

describe('knowledge detail business line', () => {
  it('orders the five task tabs and exposes status, expert usage and settings in the header', async () => {
    documentList();
    await mount('/knowledge/kb_1');

    const labels = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toEqual(['文档', '来源', '检索测试', '离线评估', 'FAQ', 'Wiki', '处理记录']);
    expect(document.querySelector('[data-slot="page-header"]')?.textContent).toContain('启用');
    expect(findButton('使用此库的专家')).toBeDefined();
    expect(findButton('设置')).toBeDefined();
    // 页头操作与默认按钮同高（32px），不再用更矮的 sm。
    expect(findButton('使用此库的专家')?.className).toContain('h-8');
    expect(findButton('使用此库的专家')?.className).not.toContain('h-7');
    expect(findButton('设置')?.className).toContain('h-8');
    expect(findButton('设置')?.className).not.toContain('h-7');

    await click(button('设置'));
    expect(dialogShown('知识库设置')).toBe(true);
    expect(document.getElementById('knowledge-settings-chunk-tokens')).not.toBeNull();
  });

  it('keeps read-only users on inspection and never requests a search without execute', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json(meWith(['knowledge.read']))));
    documentList();
    await mount('/knowledge/kb_1');

    expect(findButton('上传文件')).toBeUndefined();
    expect(findButton('导入')).toBeUndefined();
    expect(findButton('新建文件夹')).toBeUndefined();
    expect(findButton('管理标签')).toBeUndefined();
    expect(findButton('操作 上线流程')).toBeUndefined();
    expect(findButton('设置')).toBeUndefined();
    expect(findButton('使用此库的专家')).toBeUndefined();
    expect(calls.some((item) => item.path === '/api/agents')).toBe(false);

    await click(button('上线流程'));
    const viewer = dialog('上线流程');
    expect(viewer.textContent).toContain('下载原件');
    expect(viewer.textContent).not.toContain('编辑分块 1');
    await click(button('关闭'));

    await click(button('检索测试'));
    expect(document.body.textContent).toContain('没有检索权限');
    expect(calls.some((item) => item.path.includes('/search'))).toBe(false);
  });

  it('lets content managers write documents but not execute, settings or sources', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.content.manage'])),
      ),
    );
    documentList();
    await mount('/knowledge/kb_1');

    expect(findButton('上传文件')).toBeDefined();
    expect(findButton('导入')).toBeDefined();
    expect(findButton('新建文件夹')).toBeDefined();
    expect(findButton('管理标签')).toBeDefined();
    await openMenu('操作 上线流程');
    expect(menuLabels().some((label) => label.includes('移动 / 标注'))).toBe(true);
    expect(menuLabels().some((label) => label.includes('删除'))).toBe(true);
    expect(menuLabels().some((label) => label.includes('重新解析'))).toBe(false);
    expect(findButton('设置')).toBeUndefined();

    await click(button('来源'));
    expect(findButton('新建来源')).toBeUndefined();
    expect(findButton('立即同步')).toBeUndefined();
  });

  it('lets source managers maintain sources without execute, content or settings', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.sources.manage'])),
      ),
    );
    documentList();
    await mount('/knowledge/kb_1', { panel: 'sources' });

    expect(findButton('新建来源')).toBeDefined();
    expect(findButton('编辑来源 产品仓库')).toBeDefined();
    expect(findButton('删除来源 产品仓库')).toBeDefined();
    expect(findButton('检查配置')).toBeDefined();
    expect(findButton('立即同步')).toBeUndefined();
    expect(findButton('设置')).toBeUndefined();
    expect(findButton('上传文件')).toBeUndefined();
  });

  it('lets executors reprocess, search and manage jobs without writing documents', async () => {
    documentList();
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.execute'])),
      ),
      http.get('/api/knowledge/bases/kb_1/search', () =>
        HttpResponse.json({ degraded: false, hits: [] }),
      ),
      http.get('/api/knowledge/jobs', () =>
        HttpResponse.json({
          items: [jobFixture({ id: 'kjob_retry', type: 'ingest', status: 'failed' })],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1');

    await openMenu('操作 上线流程');
    expect(menuLabels().some((label) => label.includes('重新解析'))).toBe(true);
    expect(menuLabels().some((label) => label.includes('移动 / 标注'))).toBe(false);
    expect(menuLabels().some((label) => label.includes('删除'))).toBe(false);
    await chooseMenuItem('重新解析');
    expect(dialog('重新解析文档').textContent).toContain('人工编辑过的分块会被丢弃');
    await click(button('取消'));
    expect(findButton('上传文件')).toBeUndefined();
    expect(findButton('设置')).toBeUndefined();

    await click(button('检索测试'));
    const search = document.querySelector<HTMLInputElement>('input[aria-label="检索知识库"]');
    if (!search) throw new Error('Missing search input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        '发布',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await click(button('检索'));
    expect(calls.some((item) => item.path.includes('/api/knowledge/bases/kb_1/search'))).toBe(true);

    await click(button('处理记录'));
    expect(findButton('重试')).toBeDefined();
  });

  it('lets publishers edit a blank wiki with an explicit null expectedVersion and publish history', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.publish', 'knowledge.execute'])),
      ),
      http.patch('/api/knowledge/wiki-pages/kwp_blank', () =>
        HttpResponse.json({ ...wikiPageSummary, id: 'kwp_blank' }),
      ),
    );
    documentList();
    server.use(
      http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
        HttpResponse.json({
          items: [
            {
              ...wikiPageSummary,
              id: 'kwp_blank',
              slug: 'blank',
              title: '空白页',
              status: 'draft',
              currentVersionId: null,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/wiki-pages/kwp_blank', () =>
        HttpResponse.json({
          ...wikiPageSummary,
          id: 'kwp_blank',
          slug: 'blank',
          title: '空白页',
          status: 'draft',
          currentVersionId: null,
          versions: [],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'wiki', page: 'kwp_blank' });

    expect(document.body.textContent).toContain('还没有正文');
    expect(findButton('生成草稿')).toBeDefined();
    expect(findButton('重新生成')).toBeUndefined();
    expect(findButton('新建 Wiki 页面')).toBeUndefined();

    await click(button('编辑正文'));
    const editor = dialog('编辑 Wiki 正文');
    await fill('knowledge-wiki-markdown', '# 新正文');
    await click(button('保存草稿', editor));
    const patch = calls.find(
      (item) => item.method === 'PATCH' && item.path === '/api/knowledge/wiki-pages/kwp_blank',
    );
    expect(patch?.body).toMatchObject({ markdown: '# 新正文', expectedVersion: null });
  });

  it('opens settings in place only with knowledge.update', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'knowledge.update'])),
      ),
    );
    documentList();
    await mount('/knowledge/kb_1');

    expect(findButton('上传文件')).toBeUndefined();
    await click(button('设置'));
    expect(dialogShown('知识库设置')).toBe(true);
    expect(calls.some((item) => item.path === '/api/knowledge/bases/kb_1/documents/upload')).toBe(
      false,
    );
  });
});

describe('knowledge expert usage', () => {
  const summary = (id: string, name: string) => ({
    id,
    name,
    description: '',
    enabled: true,
    createdBy: 'test-admin',
    ownerBusinessId: 'test-admin',
  });

  it('reads per-agent access and reports unreadable relationships instead of empty usage', async () => {
    documentList();
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'agents.read', 'agents.config.read'])),
      ),
      http.get('/api/agents', () =>
        HttpResponse.json([summary('agent_a', '文档专家'), summary('agent_b', '外部专家')]),
      ),
      http.get('/api/agents/agent_a/access', () =>
        HttpResponse.json({
          agentId: 'agent_a',
          permissionIds: ['agents.read', 'agents.config.read'],
        }),
      ),
      http.get('/api/agents/agent_b/access', () =>
        HttpResponse.json({ agentId: 'agent_b', permissionIds: ['agents.read'] }),
      ),
      http.get('/api/agents/agent_a', () =>
        HttpResponse.json({ ...summary('agent_a', '文档专家'), serverIds: ['srv_1'] }),
      ),
    );
    await mount('/knowledge/kb_1');

    // 首屏不发专家请求，关系只在打开弹层时查询。
    expect(calls.some((item) => item.path === '/api/agents')).toBe(false);
    await click(button('使用此库的专家'));
    await waitFor(() => document.body.textContent?.includes('文档专家') === true);
    await waitFor(() => document.body.textContent?.includes('部分专家的使用关系无法确认') === true);

    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="/agents/agent_a?tab=config&section=capability"]',
    );
    expect(link?.textContent).toContain('文档专家');
    expect(document.body.textContent).not.toContain('没有被任何专家使用');
    // 已经有人使用时也能直接去选别的专家，而不是只能看当前绑定。
    expect(document.querySelector<HTMLAnchorElement>('a[href="/agents"]')?.textContent).toContain(
      '选择其他专家',
    );
    // 没有 agents.config.read 的专家不取详情，也绝不把摘要缺 serverIds 当成未绑定。
    expect(calls.some((item) => item.path === '/api/agents/agent_b')).toBe(false);
  });

  it('offers the agents list when no expert is bound yet', async () => {
    documentList();
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json(meWith(['knowledge.read', 'agents.read', 'agents.config.read'])),
      ),
      http.get('/api/agents', () => HttpResponse.json([])),
    );
    await mount('/knowledge/kb_1');
    await click(button('使用此库的专家'));
    await waitFor(() => document.body.textContent?.includes('没有被任何专家使用') === true);

    const next = document.querySelector<HTMLAnchorElement>('a[href="/agents"]');
    expect(next?.textContent).toContain('选择专家');
    expect(document.body.textContent).toContain('能力配置');
  });

  it('hides the expert entry and requests no agent data without agents.read', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json(meWith(['knowledge.read']))));
    documentList();
    await mount('/knowledge/kb_1');

    expect(findButton('使用此库的专家')).toBeUndefined();
    expect(calls.some((item) => item.path === '/api/agents')).toBe(false);
  });
});

describe('knowledge document to jobs recovery', () => {
  it('sends a first-time failed document to its filtered jobs and retries the original job', async () => {
    const failedDocument = {
      ...doc,
      id: 'kdoc_failed',
      title: '导入失败',
      status: 'failed',
      currentVersionId: null,
    };
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [failedDocument], nextCursor: null }),
      ),
      http.get('/api/knowledge/jobs', ({ request }) => {
        const url = new URL(request.url);
        return HttpResponse.json({
          items:
            url.searchParams.get('documentId') === 'kdoc_failed'
              ? [
                  jobFixture({
                    id: 'kjob_failed',
                    type: 'ingest',
                    status: 'failed',
                    error: '解析失败',
                    documentId: 'kdoc_failed',
                    documentTitle: '导入失败',
                  }),
                ]
              : [],
          nextCursor: null,
        });
      }),
      http.post('/api/knowledge/jobs/kjob_failed/retry', () =>
        HttpResponse.json({ jobId: 'kjob_retry' }),
      ),
    );
    const router = await mount('/knowledge/kb_1');

    await openMenu('操作 导入失败');
    expect(menuLabels().some((label) => label.includes('重新解析'))).toBe(false);
    await chooseMenuItem('查看处理记录');

    await waitFor(() => router.state.location.search.panel === 'jobs');
    expect(router.state.location.search.document).toBe('kdoc_failed');
    await waitFor(() => jobRequest()?.searchParams.get('documentId') === 'kdoc_failed');
    expect(document.body.textContent).toContain('导入失败');

    await click(button('重试'));
    expect(
      calls.some(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/jobs/kjob_failed/retry',
      ),
    ).toBe(true);

    await click(button('查看全部处理记录'));
    await waitFor(() => router.state.location.search.document === undefined);
    expect(document.body.textContent).not.toContain('只显示该文档的处理记录');
  });

  it('keeps the FAQ tab usable after jumping from a document to its filtered jobs', async () => {
    const failedDocument = {
      ...doc,
      id: 'kdoc_failed',
      title: '导入失败',
      status: 'failed',
      currentVersionId: null,
    };
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [failedDocument], nextCursor: null }),
      ),
      http.get('/api/knowledge/bases/kb_1/faqs', () =>
        HttpResponse.json({ items: [faqSummary], nextCursor: null }),
      ),
    );
    const router = await mount('/knowledge/kb_1');

    await openMenu('操作 导入失败');
    await chooseMenuItem('查看处理记录');
    await waitFor(() => router.state.location.search.document === 'kdoc_failed');

    await click(button('FAQ'));
    await waitFor(() => router.state.location.search.panel === 'faqs');
    // 离开处理记录时清掉文档过滤，FAQ 分区按自己的列表工作。
    expect(router.state.location.search.document).toBeUndefined();
    expect(findButton('新建 FAQ')).toBeDefined();
    expect(document.body.textContent).toContain('如何备份？');
  });
});

describe('knowledge jobs pagination', () => {
  it('offers clearing the filter or re-uploading when a filtered document has no job', async () => {
    // 首次上传就失败、没有版本的文档没有「重新解析」路径，空态不能暗示它存在。
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [doc], nextCursor: null }),
      ),
    );
    const router = await mount('/knowledge/kb_1', { panel: 'jobs', document: 'kdoc_failed' });

    expect(document.body.textContent).toContain('该文档还没有处理记录');
    expect(document.body.textContent).not.toContain('重新解析');
    expect(findButton('清除筛选')).toBeDefined();
    await click(button('重新上传文档'));
    await waitFor(() => router.state.location.search.panel === undefined);
    expect(router.state.location.search.document).toBeUndefined();
  });

  it('lets the jobs table scroll horizontally instead of squeezing targets and reasons', async () => {
    baseHandlers();
    const error = '解析失败：文档结构损坏，无法提取正文内容，请检查文件后重新上传。';
    server.use(
      http.get('/api/knowledge/jobs', () =>
        HttpResponse.json({
          items: [
            jobFixture({
              id: 'kjob_long',
              type: 'ingest',
              status: 'failed',
              error,
              documentId: 'kdoc_1',
              documentTitle: '上线流程',
            }),
          ],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'jobs' });

    const table = document.querySelector<HTMLTableElement>('table[aria-label="知识库任务"]');
    expect(table?.className).toContain('min-w-5xl');
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
    const heads = [...document.querySelectorAll<HTMLTableCellElement>('th')].map(
      (item) => item.className,
    );
    expect(heads.some((item) => item.includes('min-w-56'))).toBe(true);
    expect(heads.some((item) => item.includes('min-w-60'))).toBe(true);
    // 对象与错误文本允许换行，保留 title 作为完整内容兜底。
    const reason = document.querySelector<HTMLElement>(`[title="${error}"]`);
    expect(reason?.textContent).toBe(error);
    expect(reason?.className).not.toContain('truncate');
    expect(reason?.closest('td')?.className).toContain('whitespace-normal');
    const target = document.querySelector<HTMLElement>('[title="kdoc_1"]');
    expect(target?.textContent).toBe('上线流程');
    expect(target?.className).not.toContain('truncate');
    expect(target?.closest('td')?.className).toContain('whitespace-normal');
  });

  it('loads more while keeping rows through a failed page and retries it', async () => {
    let pageTwoCalls = 0;
    documentList();
    server.use(
      http.get('/api/knowledge/jobs', ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('cursor') === 'cursor_2') {
          pageTwoCalls += 1;
          if (pageTwoCalls === 1) {
            return HttpResponse.json(
              { code: 'INTERNAL', message: '任务分页失败' },
              { status: 500 },
            );
          }
          return HttpResponse.json({
            items: [
              jobFixture({
                id: 'kjob_3',
                type: 'sync',
                status: 'succeeded',
                sourceId: 'ksrc_1',
                sourceName: '产品仓库',
              }),
            ],
            nextCursor: null,
          });
        }
        return HttpResponse.json({
          items: [
            jobFixture({
              id: 'kjob_1',
              type: 'ingest',
              status: 'succeeded',
              documentId: 'kdoc_1',
              documentTitle: '上线流程',
            }),
            jobFixture({ id: 'kjob_2', type: 'cleanup', status: 'succeeded' }),
          ],
          nextCursor: 'cursor_2',
        });
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'jobs' });

    expect(document.body.textContent).toContain('已加载 2 条处理记录');
    expect(document.body.textContent).toContain('上线流程');
    expect(document.body.textContent).toContain('整库');

    await click(button('加载更多处理记录'));
    expect(document.body.textContent).toContain('更多处理记录没有加载出来');
    expect(document.body.textContent).toContain('上线流程');

    await click(button('重试'));
    await waitFor(() => document.body.textContent?.includes('产品仓库') === true);
    expect(document.body.textContent).toContain('已加载 3 条处理记录');
  });
});

describe('knowledge job targets', () => {
  it('opens the document or source workspace from a job record', async () => {
    documentList();
    server.use(
      http.get('/api/knowledge/jobs', () =>
        HttpResponse.json({
          items: [
            jobFixture({
              id: 'kjob_doc',
              type: 'ingest',
              status: 'succeeded',
              documentId: 'kdoc_1',
              documentTitle: '上线流程',
            }),
            jobFixture({
              id: 'kjob_src',
              type: 'sync',
              status: 'succeeded',
              sourceId: 'ksrc_1',
              sourceName: '产品仓库',
            }),
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/sources/ksrc_1/runs', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/documents/kdoc_1', () => HttpResponse.json(doc)),
    );
    const router = await mount('/knowledge/kb_1', { panel: 'jobs' });

    await click(button('上线流程'));
    await waitFor(() => router.state.location.search.panel === 'documents');
    expect(router.state.location.search.document).toBe('kdoc_1');

    await click(button('处理记录'));
    await waitFor(() => router.state.location.search.panel === 'jobs');
    // 从文档跳到处理记录保留文档过滤，先清掉才能看到来源任务。
    await click(button('查看全部处理记录'));
    await waitFor(() => router.state.location.search.document === undefined);

    await click(button('产品仓库'));
    await waitFor(() => router.state.location.search.panel === 'sources');
    expect(router.state.location.search.source).toBe('ksrc_1');
    expect(router.state.location.search.document).toBeUndefined();
    await waitFor(() => document.body.textContent?.includes('同步记录') === true);
  });
});

describe('knowledge document filters', () => {
  it('clears query, status, tag and folder together from the empty result', async () => {
    const folderFixture = {
      id: 'kfd_new',
      baseId: 'kb_1',
      parentId: null,
      name: '规范',
      path: '/规范',
      createdAt: '',
    };
    baseHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json([folderFixture])),
      http.get('/api/knowledge/bases/kb_1/documents', ({ request }) => {
        const url = new URL(request.url);
        const filtered = ['status', 'tag', 'folderId', 'q'].some((key) =>
          url.searchParams.has(key),
        );
        return HttpResponse.json({
          items: filtered ? [] : [doc],
          nextCursor: null,
        });
      }),
    );
    await mount('/knowledge/kb_1');

    await chooseFilter('按状态筛选', '失败');
    await chooseFilter('按标签筛选', '流程');
    await click(button('规范'));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索文档"]');
    if (!input) throw new Error('Missing document search input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '上线',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await waitFor(() => document.body.textContent?.includes('没有匹配的文档') === true);

    await click(button('清除筛选'));
    await waitFor(() => document.body.textContent?.includes('上线流程') === true);
    const last = [...calls]
      .reverse()
      .find(
        (item) =>
          item.method === 'GET' && item.path.startsWith('/api/knowledge/bases/kb_1/documents'),
      );
    const url = new URL(last?.path ?? '', 'http://localhost');
    for (const key of ['status', 'tag', 'folderId', 'q']) {
      expect(url.searchParams.has(key)).toBe(false);
    }
  });
});
