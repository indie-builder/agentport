import type { KnowledgeJob } from '@agentport/shared';
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
import { HttpResponse, http } from 'msw';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { z } from 'zod';
import { toastError } from '../src/lib/toast.js';
import { KnowledgeDetailPage } from '../src/pages/knowledge/detail/knowledge-detail-page.js';
import { KnowledgePage } from '../src/pages/knowledge/index.js';
import { allAccessMe } from './me-fixture.js';
import { createMsw, runCleanup } from './msw.js';

export const base = {
  id: 'kb_1',
  slug: 'handbook',
  name: '产品手册',
  description: '内部知识',
  serverId: 'srv_1',
  status: 'active',
  embeddingProfileId: 'profile_1',
  rerankProfileId: null,
  asrProfileId: null,
  settings: {
    chunkTokens: 800,
    chunkOverlap: 120,
    wikiAutoUpdate: false,
    imageProcessing: {
      enabled: false,
      model: null,
      ocrEnabled: false,
      captionEnabled: false,
      descriptionLanguage: 'zh-CN',
      customInstructions: '',
      imageVectorEnabled: false,
      imageVectorMinScore: 0.3,
    },
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

export const doc = {
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
  disabledReason: null,
  currentVersionId: 'kdv_1',
  tags: ['流程'],
  lastSyncedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

export const chunk = {
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

export const source = {
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

export const wikiPage = {
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

export { wikiPageSummary };

export function wikiJob(status: KnowledgeJob['status'], id = 'kjob_gen'): KnowledgeJob {
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

export function syncJob(status: KnowledgeJob['status'], id = 'kjob_sync'): KnowledgeJob {
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

export const msw = createMsw();
export const { server, calls } = msw;

export function mockMe() {
  server.use(http.get('/api/auth/me', () => HttpResponse.json(allAccessMe)));
}

export function mockPins(baseIds: string[] = []) {
  server.use(http.get('/api/knowledge/bases/pins', () => HttpResponse.json({ baseIds })));
}

export const mountState: {
  client: QueryClient | undefined;
  host: HTMLDivElement | undefined;
  root: Root | undefined;
} = { client: undefined, host: undefined, root: undefined };

export async function cleanup(unmount?: () => Promise<void>) {
  const { root: mountedRoot, client: mountedClient, host: mountedHost } = mountState;
  mountState.root = mountState.client = mountState.host = undefined;
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

export async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await msw.waitForRequests();
}

export async function waitFor(probe: () => boolean, tries = 60): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (probe()) return;
    await flush();
  }
  expect(probe()).toBe(true);
}

export async function mount(path: string, search: Record<string, string> = {}) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const list = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/',
    validateSearch: z.object({
      q: z.string().optional(),
      sort: z.enum(['newest', 'name']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  mountState.client = client;
  const host = document.createElement('div');
  mountState.host = host;
  document.body.append(host);
  const root = createRoot(host);
  mountState.root = root;
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
  for (let pass = 0; pass < 20 && client.isFetching() > 0; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await msw.waitForRequests();
  }
  await act(async () => {
    await Promise.resolve();
  });
  return router;
}

export function dialog(title: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
  if (!element) throw new Error(`Missing dialog: ${title}`);
  return element;
}

export function dialogShown(title: string): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
    (item) => item.querySelector('h2')?.textContent === title,
  );
}

export async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

export function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

export function sourceChoice(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!element) throw new Error(`Missing source choice: ${label}`);
  return element;
}

export async function openMenu(label: string) {
  await click(button(label));
}

export async function chooseMenuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!item) throw new Error(`Missing menu item: ${label}`);
  await click(item);
}

export async function chooseFilter(label: string, optionLabel: string) {
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

export async function chooseOption(id: string, optionLabel: string) {
  const trigger = document.getElementById(id);
  if (!trigger) throw new Error(`Missing select: ${id}`);
  await click(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent?.trim() === optionLabel,
  );
  if (!option) throw new Error(`Missing option: ${optionLabel}`);
  await click(option);
}

export async function fill(id: string, value: string) {
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

export function markdownResponse(body: string): Response {
  return HttpResponse.text(body, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}

export function detailsHandler() {
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

export function baseHandlers() {
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
    http.get('/api/agents', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/agents/reference', () => HttpResponse.json({ items: [], truncated: false })),
  );
}

export function patchBody(path: string) {
  return calls.find((item) => item.method === 'PATCH' && item.path === path)?.body;
}

export function documentList(documents: unknown[] = [doc]) {
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

export const faqDocument = {
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

export const faq = {
  question: '如何备份？',
  similarQuestions: ['备份怎么做'],
  negativeQuestions: ['不用备份'],
  answers: ['每日自动备份。', '异机保存副本。'],
  answerStrategy: 'all' as const,
  isRecommended: true,
};

export const faqSummary = { ...faqDocument, faq };

export function hitWire(override: Record<string, unknown> = {}) {
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

export function findButton(
  text: string,
  scope: ParentNode = document,
): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
}

export function registerKnowledgeHarness() {
  beforeAll(() => msw.listen());

  afterAll(() => msw.close());

  beforeEach(() => {
    msw.reset();
    mockMe();
    mockPins();
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

  afterEach(() => cleanup());
}
