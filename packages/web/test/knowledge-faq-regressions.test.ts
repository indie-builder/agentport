import type { KnowledgeJob } from '@agentport/shared';
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toastSuccess } from '../src/lib/toast.js';
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail.js';
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
  tags: [],
  lastSyncedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const faq = {
  question: '如何备份？',
  similarQuestions: ['备份怎么做'],
  negativeQuestions: ['不用备份'],
  answers: ['每日自动备份。', '异机保存副本。'],
  answerStrategy: 'all' as const,
  isRecommended: true,
};

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

const secondFaqDocument = {
  ...faqDocument,
  id: 'kdoc_2',
  title: '如何恢复',
  currentVersionId: null,
  tags: [],
};
const secondFaq = { ...faq, question: '如何恢复数据？' };
const secondFaqSummary = { ...secondFaqDocument, faq: secondFaq };

function hitWire(quote: string) {
  return {
    chunkId: 'kchk_faq',
    documentId: 'kdoc_faq',
    versionId: 'kdv_faq_pub',
    target: { kind: 'faq', id: 'kdoc_faq' },
    targetVersionId: 'kdv_faq_pub',
    title: '如何备份？',
    heading: null,
    quote,
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
  };
}

function job(status: KnowledgeJob['status'], id: string): KnowledgeJob {
  const now = '2026-01-01T00:00:00Z';
  return {
    id,
    type: 'ingest',
    status,
    step: null,
    progress: status === 'succeeded' ? 100 : 0,
    attempts: 1,
    error: status === 'failed' ? '索引失败' : null,
    result: null,
    createdAt: now,
    startedAt: now,
    endedAt: status === 'running' ? null : now,
  };
}

const msw = createMsw();
const { server, calls } = msw;

beforeAll(() => msw.listen());
afterAll(() => msw.close());

beforeEach(() => {
  msw.reset();
  vi.mocked(toastSuccess).mockClear();
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

async function waitFor(probe: () => boolean, tries = 120): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (probe()) return;
    await flush();
  }
  expect(probe()).toBe(true);
}

async function mount(path: string, search: Record<string, string> = {}) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
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
    routeTree: rootRoute.addChildren([shell.addChildren([detail])]),
    history: createMemoryHistory({
      initialEntries: [
        Object.keys(search).length ? `${path}?${new URLSearchParams(search)}` : path,
      ],
    }),
  });
  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
  return { router, client };
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

function maybeButton(text: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = maybeButton(text, scope);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

async function selectAllFaqs(): Promise<number> {
  const boxes = [...document.querySelectorAll<HTMLElement>('[aria-label^="选择 "]')];
  await act(async () => {
    for (const box of boxes) box.click();
  });
  await flush();
  return boxes.length;
}

async function fill(id: string, value: string) {
  const element = document.getElementById(id);
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
  server.use(
    http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [base], nextCursor: null })),
    http.get('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)),
    http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/tags', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/sources', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/bases/kb_1/wiki-pages', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/bases/kb_1/documents', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get('/api/knowledge/model-profiles', () => HttpResponse.json([])),
    http.get('/api/knowledge/documents/:documentId/versions', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/agents', () => HttpResponse.json([])),
  );
}

function faqListHandler(items: unknown[]) {
  return http.get('/api/knowledge/bases/kb_1/faqs', () =>
    HttpResponse.json({ items, nextCursor: null }),
  );
}

describe('FAQ editor state against refetches', () => {
  it('keeps the draft and its expected version when detail changes or a refetch fails', async () => {
    baseHandlers();
    let detailCalls = 0;
    let failDetail = false;
    const newerDraft = {
      ...faqDraftVersion,
      id: 'kdv_faq_newer',
      faq: { ...faq, question: '服务端已改' },
    };
    server.use(
      faqListHandler([faqSummary]),
      http.get('/api/knowledge/faqs/kdoc_faq', () => {
        detailCalls += 1;
        if (failDetail) return HttpResponse.json({ message: 'boom' }, { status: 500 });
        const draft = detailCalls === 1 ? faqDraftVersion : newerDraft;
        return HttpResponse.json({ ...faqDetail, draftVersion: draft, faq: draft.faq });
      }),
      http.put('/api/knowledge/faqs/kdoc_faq', () =>
        HttpResponse.json({ documentId: 'kdoc_faq', jobId: 'kjob_faq' }),
      ),
    );
    const mounted = await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('编辑'));
    const editor = dialog('编辑 FAQ');
    await waitFor(() => document.querySelectorAll('textarea[aria-label^="答案"]').length === 2);
    await fill('faq-question', '本地草稿问题');

    await act(async () => {
      await mounted.client.invalidateQueries({ queryKey: ['knowledge', 'faq', 'kdoc_faq'] });
    });
    await flush();
    expect((document.getElementById('faq-question') as HTMLInputElement).value).toBe(
      '本地草稿问题',
    );

    failDetail = true;
    await act(async () => {
      await mounted.client.invalidateQueries({ queryKey: ['knowledge', 'faq', 'kdoc_faq'] });
    });
    await flush();
    expect((document.getElementById('faq-question') as HTMLInputElement).value).toBe(
      '本地草稿问题',
    );
    expect(editor.textContent).toContain('服务端暂时无法完成请求');

    failDetail = false;
    await click(button('重试', editor));
    await waitFor(() => editor.textContent?.includes('服务端暂时无法完成请求') === false);
    await click(button('保存草稿', editor));
    expect(
      calls.find((item) => item.method === 'PUT' && item.path === '/api/knowledge/faqs/kdoc_faq')
        ?.body,
    ).toEqual(expect.objectContaining({ expectedVersionId: 'kdv_faq_draft' }));
  });

  it('associates title and per-answer errors and focuses the first invalid field', async () => {
    baseHandlers();
    server.use(
      faqListHandler([faqSummary]),
      http.get('/api/knowledge/faqs/kdoc_faq', () => HttpResponse.json(faqDetail)),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('编辑'));
    const editor = dialog('编辑 FAQ');
    await waitFor(() => document.querySelectorAll('textarea[aria-label^="答案"]').length === 2);
    await fill('faq-title', 'x'.repeat(301));
    await fill('faq-question', faq.question);
    const firstAnswer = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="答案 1"]',
    );
    if (!firstAnswer) throw new Error('Missing first answer');
    await act(async () => {
      const prototype = HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
        firstAnswer,
        'y'.repeat(20_001),
      );
      firstAnswer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('保存草稿', editor));

    const title = document.getElementById('faq-title') as HTMLInputElement;
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(title.getAttribute('aria-describedby')).toBe('faq-title-error');
    expect(document.getElementById('faq-title-error')?.textContent).toContain('最多 300');
    expect(firstAnswer.getAttribute('aria-invalid')).toBe('true');
    expect(firstAnswer.getAttribute('aria-describedby')).toBe('faq-answer-0-error');
    expect(document.getElementById('faq-answer-0-error')?.textContent).toContain('最多 20000');
    expect(document.activeElement).toBe(title);

    await fill('faq-title', '正常标题');
    await click(button('保存草稿', editor));
    expect(document.activeElement).toBe(firstAnswer);
  });
});

describe('FAQ repeated retrieval', () => {
  it('requests again when the same search term is submitted twice', async () => {
    baseHandlers();
    let searches = 0;
    server.use(
      http.get('/api/knowledge/bases/kb_1/search', () => {
        searches += 1;
        return HttpResponse.json({
          hits: [hitWire(`第 ${searches} 次答案`)],
          degraded: false,
          warnings: [],
        });
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'search', q: '备份' });
    const input = document.getElementById('knowledge-search') as HTMLInputElement;
    const form = input.closest('form');
    for (let round = 0; round < 2; round += 1) {
      await act(async () => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flush();
    }
    expect(searches).toBeGreaterThanOrEqual(3);
    expect(document.body.textContent).toContain(`第 ${searches} 次答案`);
  });

  it('requests again when the same FAQ hit test is submitted twice', async () => {
    baseHandlers();
    let tests = 0;
    server.use(
      faqListHandler([faqSummary]),
      http.get('/api/knowledge/faqs/kdoc_faq', () => HttpResponse.json(faqDetail)),
      http.post('/api/knowledge/bases/kb_1/faqs/test', () => {
        tests += 1;
        return HttpResponse.json({
          hits: [hitWire(`第 ${tests} 次命中`)],
          degraded: false,
          warnings: [],
        });
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="FAQ 命中测试"]');
    if (!input) throw new Error('Missing FAQ test input');
    const form = input.closest('form');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '怎么备份',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (let round = 0; round < 2; round += 1) {
      await act(async () => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flush();
    }
    expect(tests).toBe(2);
    expect(document.body.textContent).toContain('第 2 次命中');
  });
});

describe('FAQ import batch recovery', () => {
  const importedVersions = {
    kdoc_a: {
      document: {
        ...faqDocument,
        id: 'kdoc_a',
        title: '新增备份',
        currentVersionId: null,
        tags: [],
      },
      draftVersion: {
        ...faqDraftVersion,
        id: 'kdv_a',
        documentId: 'kdoc_a',
        parentVersionId: null,
        metadata: {
          publication: 'draft',
          faqImport: {
            batchId: 'imp_9',
            mode: 'append',
            enabled: true,
            expectedVersionId: null,
          },
          faqImportJobId: 'kjob_a',
        },
      },
      publishedVersion: null,
      faq,
    },
    kdoc_b: {
      document: {
        ...faqDocument,
        id: 'kdoc_b',
        title: '合并备份',
        currentVersionId: 'kdv_b_pub',
        tags: [],
      },
      draftVersion: {
        ...faqDraftVersion,
        id: 'kdv_b',
        documentId: 'kdoc_b',
        metadata: {
          publication: 'draft',
          faqImport: {
            batchId: 'imp_9',
            mode: 'append',
            enabled: true,
            expectedVersionId: 'kdv_b_pub',
          },
          faqImportJobId: 'kjob_b',
        },
      },
      publishedVersion: { ...faqPublishedVersion, id: 'kdv_b_pub', documentId: 'kdoc_b' },
      faq,
    },
  };
  const importedSummaries = [
    { ...importedVersions.kdoc_a.document, faq },
    { ...importedVersions.kdoc_b.document, faq },
  ];

  function recoveryHandlers(statusById: Record<string, KnowledgeJob['status']>) {
    baseHandlers();
    // 重试后草稿 metadata 的 faqImportJobId 会持久成新任务；UI 必须读回它，而不是自己记。
    const jobByDocument: Record<string, string> = { kdoc_a: 'kjob_a', kdoc_b: 'kjob_b' };
    const detailFor = (documentId: 'kdoc_a' | 'kdoc_b') => {
      const source = importedVersions[documentId];
      return {
        ...source,
        draftVersion: {
          ...source.draftVersion,
          metadata: {
            ...source.draftVersion.metadata,
            faqImportJobId: jobByDocument[documentId],
          },
        },
      };
    };
    server.use(
      faqListHandler(importedSummaries),
      http.get('/api/knowledge/faqs/kdoc_a', () => HttpResponse.json(detailFor('kdoc_a'))),
      http.get('/api/knowledge/faqs/kdoc_b', () => HttpResponse.json(detailFor('kdoc_b'))),
      http.get('/api/knowledge/jobs/:jobId', ({ params }) => {
        const id = String(params.jobId);
        const status = statusById[id] ?? 'succeeded';
        return HttpResponse.json(job(status, id));
      }),
      http.post('/api/knowledge/jobs/:jobId/retry', ({ params }) => {
        const failedJobId = String(params.jobId);
        const documentId = Object.keys(jobByDocument).find(
          (key) => jobByDocument[key] === failedJobId,
        );
        const nextJobId = `kjob_retry_${documentId ?? 'unknown'}`;
        if (documentId) jobByDocument[documentId] = nextJobId;
        statusById[nextJobId] = 'succeeded';
        return HttpResponse.json({ jobId: nextJobId }, { status: 202 });
      }),
      http.post('/api/knowledge/bases/kb_1/faqs/batch', async ({ request }) => {
        const body = (await request.json()) as { items: Array<{ documentId: string }> };
        return HttpResponse.json({
          results: body.items.map((item) => ({ documentId: item.documentId, status: 'succeeded' })),
        });
      }),
    );
  }

  it('restores the pending batch after the dialog is closed and publishes every member', async () => {
    recoveryHandlers({ kjob_a: 'succeeded', kjob_b: 'succeeded' });
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    await waitFor(() => dialog('导入 FAQ').textContent?.includes('继续未完成批次') === true);
    expect(dialog('导入 FAQ').textContent).toContain('2 条');
    await click(button('取消', dialog('导入 FAQ')));
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await waitFor(() => importer.textContent?.includes('继续未完成批次') === true);
    await waitFor(() => maybeButton('发布批次 2 条 FAQ', importer)?.disabled === false);
    await click(button('发布批次 2 条 FAQ', importer));
    expect(
      calls
        .filter(
          (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
        )
        .at(-1)?.body,
    ).toEqual({
      action: 'publish',
      importBatchId: 'imp_9',
      items: [
        { documentId: 'kdoc_a', versionId: 'kdv_a', expectedVersionId: null },
        { documentId: 'kdoc_b', versionId: 'kdv_b', expectedVersionId: 'kdv_b_pub' },
      ],
    });
    expect(toastSuccess).toHaveBeenCalledWith('已发布批次 2 条 FAQ');
  });

  it('tracks the retried index job and only then enables batch publish', async () => {
    recoveryHandlers({ kjob_a: 'succeeded', kjob_b: 'failed' });
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await waitFor(() => importer.textContent?.includes('重试失败索引') === true);
    expect(maybeButton('发布批次 2 条 FAQ', importer)?.disabled).toBe(true);
    await click(button('重试失败索引', importer));
    await waitFor(() => maybeButton('发布批次 2 条 FAQ', importer)?.disabled === false);
    await click(button('发布批次 2 条 FAQ', importer));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
      )?.body,
    ).toEqual({
      action: 'publish',
      importBatchId: 'imp_9',
      items: [
        { documentId: 'kdoc_a', versionId: 'kdv_a', expectedVersionId: null },
        { documentId: 'kdoc_b', versionId: 'kdv_b', expectedVersionId: 'kdv_b_pub' },
      ],
    });
  });

  it('refuses to announce a batch from a partial FAQ list and recovers after retrying the page', async () => {
    baseHandlers();
    let secondPageFails = true;
    server.use(
      http.get('/api/knowledge/bases/kb_1/faqs', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor === null) {
          return HttpResponse.json({ items: [importedSummaries[0]], nextCursor: 'page_2' });
        }
        if (secondPageFails) return HttpResponse.json({ message: 'boom' }, { status: 500 });
        return HttpResponse.json({ items: [importedSummaries[1]], nextCursor: null });
      }),
      http.get('/api/knowledge/faqs/kdoc_a', () => HttpResponse.json(importedVersions.kdoc_a)),
      http.get('/api/knowledge/faqs/kdoc_b', () => HttpResponse.json(importedVersions.kdoc_b)),
      http.get('/api/knowledge/jobs/:jobId', ({ params }) =>
        HttpResponse.json(job('succeeded', String(params.jobId))),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await waitFor(() => importer.textContent?.includes('继续未完成批次') === true);
    expect(importer.textContent).not.toContain('索引已完成，可整批发布');
    expect(maybeButton('发布批次 2 条 FAQ', importer)).toBeUndefined();

    secondPageFails = false;
    await click(button('重试读取列表', importer));
    await waitFor(() => importer.textContent?.includes('索引已完成，可整批发布') === true);
    expect(importer.textContent).toContain('2 条');
    expect(button('发布批次 2 条 FAQ', importer).disabled).toBe(false);
  });

  it('treats a cached detail with a failed refetch as incomplete and recovers after retrying it', async () => {
    recoveryHandlers({ kjob_a: 'succeeded', kjob_b: 'succeeded' });
    let detailFails = false;
    server.use(
      http.get('/api/knowledge/faqs/kdoc_b', () => {
        if (detailFails) return HttpResponse.json({ message: 'boom' }, { status: 500 });
        return HttpResponse.json(importedVersions.kdoc_b);
      }),
    );
    const mounted = await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await waitFor(() => maybeButton('发布批次 2 条 FAQ', importer)?.disabled === false);

    detailFails = true;
    await act(async () => {
      await mounted.client.invalidateQueries({ queryKey: ['knowledge', 'faq', 'kdoc_b'] });
    });
    await flush();
    expect(importer.textContent).not.toContain('索引已完成，可整批发布');
    expect(importer.textContent).toContain('批次成员读取不完整');
    expect(maybeButton('发布批次 2 条 FAQ', importer)).toBeUndefined();

    detailFails = false;
    await click(button('重试读取 1 条详情', importer));
    await waitFor(() => importer.textContent?.includes('索引已完成，可整批发布') === true);
    expect(button('发布批次 2 条 FAQ', importer).disabled).toBe(false);
  });

  it('publishes the version pinned at import time instead of the drifting current version', async () => {
    baseHandlers();
    const pinned = {
      ...importedVersions.kdoc_b,
      document: { ...importedVersions.kdoc_b.document, currentVersionId: 'kdv_b_now' },
      draftVersion: {
        ...importedVersions.kdoc_b.draftVersion,
        metadata: {
          publication: 'draft',
          faqImport: {
            batchId: 'imp_pinned',
            mode: 'append',
            enabled: true,
            expectedVersionId: 'kdv_b_pinned',
          },
          faqImportJobId: 'kjob_b',
        },
      },
    };
    server.use(
      faqListHandler([{ ...pinned.document, faq }]),
      http.get('/api/knowledge/faqs/kdoc_b', () => HttpResponse.json(pinned)),
      http.get('/api/knowledge/jobs/:jobId', ({ params }) =>
        HttpResponse.json(job('succeeded', String(params.jobId))),
      ),
      http.post('/api/knowledge/bases/kb_1/faqs/batch', () =>
        HttpResponse.json(
          { code: 'CONFLICT_STALE', message: '线上版本已变化', requestId: 'req_stale' },
          { status: 409 },
        ),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await waitFor(() => maybeButton('发布批次 1 条 FAQ', importer)?.disabled === false);
    await click(button('发布批次 1 条 FAQ', importer));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
      )?.body,
    ).toEqual({
      action: 'publish',
      importBatchId: 'imp_pinned',
      items: [{ documentId: 'kdoc_b', versionId: 'kdv_b', expectedVersionId: 'kdv_b_pinned' }],
    });
    await waitFor(() => importer.textContent?.includes('数据已被其他操作修改') === true);
    expect(importer.textContent).toContain('继续未完成批次');
    expect(toastSuccess).not.toHaveBeenCalledWith('已发布批次 1 条 FAQ');
  });

  it('keeps waiting after retry until the persisted job id arrives, then survives reopening', async () => {
    const statusById: Record<string, KnowledgeJob['status']> = {
      kjob_a: 'succeeded',
      kjob_b: 'failed',
    };
    recoveryHandlers(statusById);
    let retried = false;
    let blockDetail = false;
    let releaseDetail: (() => void) | undefined;
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    server.use(
      http.get('/api/knowledge/faqs/kdoc_b', async () => {
        if (blockDetail) await detailGate;
        return HttpResponse.json({
          ...importedVersions.kdoc_b,
          draftVersion: {
            ...importedVersions.kdoc_b.draftVersion,
            metadata: {
              ...importedVersions.kdoc_b.draftVersion.metadata,
              faqImportJobId: retried ? 'kjob_retry_kdoc_b' : 'kjob_b',
            },
          },
        });
      }),
      http.post('/api/knowledge/jobs/:jobId/retry', () => {
        retried = true;
        blockDetail = true;
        statusById.kjob_retry_kdoc_b = 'succeeded';
        return HttpResponse.json({ jobId: 'kjob_retry_kdoc_b' }, { status: 202 });
      }),
    );
    const batchCalls = () =>
      calls.filter(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
      );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await waitFor(() => maybeButton('重试失败索引', importer) !== undefined);
    expect(maybeButton('发布批次 2 条 FAQ', importer)?.disabled).toBe(true);
    expect(batchCalls()).toHaveLength(0);

    await click(button('重试失败索引', importer));
    expect(importer.textContent).not.toContain('重试失败索引');
    expect(importer.textContent).not.toContain('有索引任务失败');
    expect(maybeButton('发布批次 2 条 FAQ', importer)).toBeUndefined();
    expect(batchCalls()).toHaveLength(0);

    blockDetail = false;
    releaseDetail?.();
    await waitFor(() => maybeButton('发布批次 2 条 FAQ', importer)?.disabled === false);
    expect(importer.textContent).toContain('索引已完成，可整批发布');
    await click(button('取消', importer));
    await click(button('导入'));
    const reopened = dialog('导入 FAQ');
    await waitFor(() => maybeButton('发布批次 2 条 FAQ', reopened)?.disabled === false);
    expect(
      calls.filter(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/jobs/kjob_b/retry',
      ),
    ).toHaveLength(1);
    await click(button('发布批次 2 条 FAQ', reopened));
    expect(batchCalls().at(-1)?.body).toEqual({
      action: 'publish',
      importBatchId: 'imp_9',
      items: [
        { documentId: 'kdoc_a', versionId: 'kdv_a', expectedVersionId: null },
        { documentId: 'kdoc_b', versionId: 'kdv_b', expectedVersionId: 'kdv_b_pub' },
      ],
    });
  });
});

describe('FAQ committed import publish readiness', () => {
  const mergedDocument = {
    ...faqDocument,
    id: 'kdoc_m',
    title: '合并备份',
    currentVersionId: 'kdv_m_pub',
    tags: [],
  };
  const publishedVersion = { ...faqPublishedVersion, id: 'kdv_m_pub', documentId: 'kdoc_m' };
  const oldDraft = {
    ...faqDraftVersion,
    id: 'kdv_m_old',
    documentId: 'kdoc_m',
    metadata: { publication: 'draft' },
  };
  const newDraft = {
    ...oldDraft,
    id: 'kdv_m_new',
    version: 3,
    metadata: {
      publication: 'draft',
      faqImport: {
        batchId: 'imp_m',
        mode: 'append',
        enabled: true,
        expectedVersionId: 'kdv_m_pub',
      },
      faqImportJobId: 'kjob_m',
    },
  };
  const oldDetail = {
    document: mergedDocument,
    draftVersion: oldDraft,
    publishedVersion,
    faq,
  };
  const importResponse = {
    dryRun: false,
    mode: 'append' as const,
    committed: true,
    importBatchId: 'imp_m',
    counts: {
      total: 1,
      success: 1,
      failed: 0,
      partialFailed: 0,
      skipped: 0,
      added: 0,
      merged: 1,
    },
    results: [
      {
        row: 1,
        status: 'success' as const,
        operation: 'merge' as const,
        documentId: 'kdoc_m',
        expectedVersionId: 'kdv_m_pub',
        jobId: 'kjob_m',
        issues: [],
      },
    ],
  };

  it('does not publish the cached draft when the committed detail refresh fails, then publishes the retried draft', async () => {
    baseHandlers();
    let detailReads = 0;
    let detailFails = false;
    let freshDraft = false;
    const batchCalls = () =>
      calls.filter(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
      );
    server.use(
      faqListHandler([{ ...mergedDocument, faq }]),
      http.get('/api/knowledge/faqs/kdoc_m', () => {
        detailReads += 1;
        if (detailFails) return HttpResponse.json({ message: 'boom' }, { status: 500 });
        return HttpResponse.json({
          ...oldDetail,
          draftVersion: freshDraft ? newDraft : oldDraft,
        });
      }),
      http.get('/api/knowledge/jobs/:jobId', ({ params }) =>
        HttpResponse.json(job('succeeded', String(params.jobId))),
      ),
      http.post('/api/knowledge/bases/kb_1/faqs/import', async ({ request }) => {
        const body = (await request.json()) as { dryRun: boolean };
        return HttpResponse.json({
          ...importResponse,
          dryRun: body.dryRun,
          committed: !body.dryRun,
        });
      }),
      http.post('/api/knowledge/bases/kb_1/faqs/batch', async ({ request }) => {
        const body = (await request.json()) as { items: Array<{ documentId: string }> };
        return HttpResponse.json({
          results: body.items.map((item) => ({ documentId: item.documentId, status: 'succeeded' })),
        });
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('导入'));
    const importer = dialog('导入 FAQ');
    await waitFor(() => detailReads === 1);
    await fill(
      'faq-import-content',
      JSON.stringify([{ question: '如何恢复数据？', answers: ['从备份恢复。'] }]),
    );
    await click(button('预览', importer));
    await waitFor(() => maybeButton('确认导入', importer)?.disabled === false);

    detailFails = true;
    await click(button('确认导入', importer));
    await waitFor(() => importer.textContent?.includes('草稿批次已创建') === true);
    await waitFor(() => importer.textContent?.includes('草稿版本读取失败') === true);
    expect(button('发布本批 1 条 FAQ', importer).disabled).toBe(true);
    await click(button('发布本批 1 条 FAQ', importer));
    expect(batchCalls()).toHaveLength(0);

    detailFails = false;
    freshDraft = true;
    await click(button('重试读取 1 条草稿版本', importer));
    await waitFor(() => maybeButton('发布本批 1 条 FAQ', importer)?.disabled === false);
    await click(button('发布本批 1 条 FAQ', importer));
    expect(batchCalls().at(-1)?.body).toEqual({
      action: 'publish',
      importBatchId: 'imp_m',
      items: [{ documentId: 'kdoc_m', versionId: 'kdv_m_new', expectedVersionId: 'kdv_m_pub' }],
    });
  });
});

describe('FAQ list status semantics', () => {
  it('shows pending as an unpublished draft and only explicit processing as parsing', async () => {
    baseHandlers();
    const pendingFaq = {
      ...faqSummary,
      id: 'kdoc_pending',
      title: '未发布问题',
      status: 'pending',
      currentVersionId: null,
      faq: { ...faq, question: '未发布问题？' },
    };
    const processingFaq = {
      ...faqSummary,
      id: 'kdoc_processing',
      title: '解析问题',
      status: 'processing',
      currentVersionId: null,
      faq: { ...faq, question: '解析问题？' },
    };
    const disabledDraft = {
      ...faqSummary,
      id: 'kdoc_disabled',
      title: '停用问题',
      status: 'disabled',
      currentVersionId: null,
      disabledReason: 'manual',
      faq: { ...faq, question: '停用问题？' },
    };
    server.use(faqListHandler([pendingFaq, processingFaq, disabledDraft]));
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await waitFor(() => document.querySelectorAll('[aria-label^="选择 "]').length === 3);
    const row = (question: string): HTMLElement => {
      const element = [...document.querySelectorAll<HTMLElement>('li')].find((item) =>
        item.textContent?.includes(question),
      );
      if (!element) throw new Error(`Missing FAQ row: ${question}`);
      return element;
    };
    const pendingRow = row('未发布问题？');
    expect(pendingRow.textContent).toContain('未发布草稿');
    expect(pendingRow.textContent).not.toContain('解析中');
    expect(pendingRow.textContent).not.toContain('排队');
    const processingRow = row('解析问题？');
    expect(processingRow.textContent).toContain('解析中');
    expect(processingRow.textContent).not.toContain('未发布草稿');
    const disabledRow = row('停用问题？');
    expect(disabledRow.textContent).toContain('已停用');
    expect(disabledRow.textContent).not.toContain('未发布草稿');

    const filter = document.querySelector<HTMLElement>('[aria-label="按 FAQ 状态筛选"]');
    if (!filter) throw new Error('Missing FAQ status filter');
    await click(filter);
    await waitFor(() => document.querySelectorAll('[role="option"]').length > 0);
    const options = [...document.querySelectorAll('[role="option"]')].map((item) =>
      item.textContent?.trim(),
    );
    expect(options).toContain('未发布草稿');
    expect(options).not.toContain('解析中');
  });
});

describe('FAQ history and bulk actions', () => {
  const oldVersion = {
    ...faqPublishedVersion,
    id: 'kdv_faq_old',
    version: 1,
    faq: { ...faq, question: '旧备份问题' },
    isCurrent: false,
  };
  const currentVersion = {
    ...faqPublishedVersion,
    id: 'kdv_faq_pub',
    version: 2,
    faq: { ...faq, question: '当前问题' },
  };

  it('shows each version FAQ body and rolls back to the selected version', async () => {
    baseHandlers();
    server.use(
      faqListHandler([faqSummary]),
      http.get('/api/knowledge/faqs/kdoc_faq', () => HttpResponse.json(faqDetail)),
      http.get('/api/knowledge/documents/kdoc_faq/versions', () =>
        HttpResponse.json({ items: [currentVersion, oldVersion], nextCursor: null }),
      ),
      http.post('/api/knowledge/documents/kdoc_faq/rollback', () =>
        HttpResponse.json({ ...faqDocument, currentVersionId: 'kdv_faq_old' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await click(button('历史'));
    const history = dialog('FAQ 版本历史');
    await waitFor(() => history.textContent?.includes('旧备份问题') === true);
    expect(history.textContent).toContain('当前问题');
    const oldRow = [...history.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes('旧备份问题'),
    );
    if (!oldRow) throw new Error('Missing old version row');
    await click(oldRow);
    await click(button('回退到所选版本', history));
    expect(
      calls.find(
        (item) =>
          item.method === 'POST' && item.path === '/api/knowledge/documents/kdoc_faq/rollback',
      )?.body,
    ).toEqual({ versionId: 'kdv_faq_old', expectedVersionId: 'kdv_faq_pub' });
    expect(toastSuccess).toHaveBeenCalledWith('FAQ 已回退');
  });

  it('sends selected FAQs once to the batch endpoint for disable and delete', async () => {
    baseHandlers();
    server.use(
      faqListHandler([faqSummary, secondFaqSummary]),
      http.get('/api/knowledge/faqs/kdoc_faq', () => HttpResponse.json(faqDetail)),
      http.post('/api/knowledge/bases/kb_1/faqs/batch', async ({ request }) => {
        const body = (await request.json()) as { items: Array<{ documentId: string }> };
        return HttpResponse.json({
          results: body.items.map((item) => ({ documentId: item.documentId, status: 'succeeded' })),
        });
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    const select = (label: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      if (!element) throw new Error(`Missing selection: ${label}`);
      return element;
    };
    await click(select('选择 如何备份？'));
    await click(select('选择 如何恢复数据？'));
    expect(document.body.textContent).toContain('已选 2 个');
    await click(button('停用'));
    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
      )?.body,
    ).toEqual({
      action: 'disable',
      items: [{ documentId: 'kdoc_faq' }, { documentId: 'kdoc_2' }],
    });
    expect(toastSuccess).toHaveBeenCalledWith('FAQ 已批量停用');

    await click(select('选择 如何备份？'));
    await click(button('删除'));
    await click(button('删除', dialog('批量删除 FAQ')));
    expect(
      calls
        .filter(
          (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
        )
        .at(-1)?.body,
    ).toEqual({ action: 'delete', items: [{ documentId: 'kdoc_faq' }] });
  });

  it('splits more than 100 selected FAQs into sequential batch calls', async () => {
    baseHandlers();
    const many = Array.from({ length: 101 }, (_, index) => ({
      ...faqSummary,
      id: `kdoc_many_${index}`,
      title: `FAQ ${index}`,
      currentVersionId: null,
      faq: { ...faq, question: `批量问题 ${index}？` },
    }));
    const batchCalls = () =>
      calls.filter(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/faqs/batch',
      );
    let active = 0;
    let maxActive = 0;
    server.use(
      http.get('/api/knowledge/bases/kb_1/faqs', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        const start = cursor === null ? 0 : Number(cursor);
        const next = start + 50 < many.length ? String(start + 50) : null;
        return HttpResponse.json({ items: many.slice(start, start + 50), nextCursor: next });
      }),
      http.post('/api/knowledge/bases/kb_1/faqs/batch', async ({ request }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const body = (await request.json()) as {
          action: string;
          items: Array<{ documentId: string }>;
        };
        return HttpResponse.json({
          results: body.items.map((item) => ({
            documentId: item.documentId,
            status: 'succeeded',
          })),
        });
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'faqs' });
    await waitFor(() => document.querySelectorAll('[aria-label^="选择 "]').length === 101);
    expect(await selectAllFaqs()).toBe(101);
    expect(document.body.textContent).toContain('已选 101 个');

    await click(button('停用'));
    await waitFor(() => batchCalls().length === 2);
    await waitFor(() =>
      vi.mocked(toastSuccess).mock.calls.some(([text]) => text === 'FAQ 已批量停用'),
    );
    expect(batchCalls()[0]?.body).toEqual({
      action: 'disable',
      items: many.slice(0, 100).map((item) => ({ documentId: item.id })),
    });
    expect(batchCalls()[1]?.body).toEqual({
      action: 'disable',
      items: many.slice(100).map((item) => ({ documentId: item.id })),
    });

    await selectAllFaqs();
    await click(button('删除'));
    await click(button('删除', dialog('批量删除 FAQ')));
    await waitFor(() => batchCalls().length === 4);
    await waitFor(() =>
      vi.mocked(toastSuccess).mock.calls.some(([text]) => text === 'FAQ 已批量删除'),
    );
    expect(batchCalls()[2]?.body).toEqual({
      action: 'delete',
      items: many.slice(0, 100).map((item) => ({ documentId: item.id })),
    });
    expect(batchCalls()[3]?.body).toEqual({
      action: 'delete',
      items: many.slice(100).map((item) => ({ documentId: item.id })),
    });

    await waitFor(() => document.body.textContent?.includes('已选 101 个') === false);
    await selectAllFaqs();
    await click(button('启用'));
    await waitFor(() => batchCalls().length === 6);
    await waitFor(() =>
      vi.mocked(toastSuccess).mock.calls.some(([text]) => text === 'FAQ 已批量启用'),
    );
    expect(batchCalls()[4]?.body).toEqual({
      action: 'enable',
      items: many.slice(0, 100).map((item) => ({ documentId: item.id })),
    });
    expect(batchCalls()[5]?.body).toEqual({
      action: 'enable',
      items: many.slice(100).map((item) => ({ documentId: item.id })),
    });
    expect(maxActive).toBe(1);
  });
});
