import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeCitations } from '../src/components/knowledge-citations.js';
import { WikiTab } from '../src/components/knowledge-wiki.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let client: QueryClient | undefined;
let calls: Call[] = [];

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const routeTree = createRootRoute({ component: () => element });
  const router = createRouter({
    routeTree,
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

function flush() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function waitFor(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await flush();
    if (check()) return;
  }
  throw new Error(message);
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function trigger(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes(text),
  );
  if (!found) throw new Error(`Missing trigger: ${text}`);
  return found;
}

async function fill(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Missing field: ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function mockFetch(handler: (url: string, method: string, body: unknown) => Response | undefined) {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    return handler(url, method, body) ?? json({ code: 'NOT_FOUND', message: '未模拟' }, 404);
  });
}

const hit = {
  chunkId: 'kchk_1',
  documentId: 'kdv_1',
  versionId: 'kdv_1',
  target: { kind: 'faq', id: 'kdoc_faq' },
  targetVersionId: 'kdv_faq_v1',
  title: '如何备份？',
  heading: null,
  quote: '引用片段',
  pageFrom: null,
  pageTo: null,
  locator: null,
  parentContent: null,
  sourceUrl: null,
  score: 0.9,
  scoreKind: 'rrf' as const,
  scores: { keyword: 0.8, vector: 0.9, rrf: 0.03, rerank: null },
  image: null,
  faq: null,
};

function citationWire(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hits: [{ ...hit, ...overrides }],
    degraded: false,
    warnings: [],
  });
}

function faq(question: string, answer: string) {
  return {
    question,
    similarQuestions: [],
    negativeQuestions: [],
    answers: [answer],
    answerStrategy: 'all',
    isRecommended: true,
  };
}

const wikiSummary = {
  id: 'kwp_1',
  baseId: 'kb_1',
  slug: 'release',
  title: '发布指南',
  status: 'published',
  currentVersionId: 'kwv_old',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

function wikiVersion(id: string, version: number, markdown: string) {
  return {
    id,
    pageId: 'kwp_1',
    version,
    markdown,
    sourceChunkIds: [],
    model: 'manual',
    generatedBy: 'manual',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function wikiHandlers(detail: () => unknown, links: () => Response) {
  return (url: string, method: string): Response | undefined => {
    if (url.includes('/knowledge/jobs')) return json({ items: [], nextCursor: null });
    if (url.includes('/knowledge/bases/kb_1/wiki-pages')) {
      return json({ items: [wikiSummary], nextCursor: null });
    }
    if (url.includes('/knowledge/wiki-pages/kwp_1/versions')) {
      return json({
        items: [wikiVersion('kwv_old', 1, '## 当前\n\n线上正文。')],
        nextCursor: null,
      });
    }
    if (url.includes('/knowledge/wiki-pages/kwp_1/links')) return links();
    if (url.endsWith('/knowledge/wiki-pages/kwp_1')) {
      return json(detail());
    }
    if (url.includes('/knowledge/wiki-pages/') && method === 'PATCH') {
      return json(detail());
    }
    return undefined;
  };
}

function mountWiki() {
  return mount(
    createElement(WikiTab, { baseId: 'kb_1', pageId: 'kwp_1', onSelect: () => undefined }),
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  client = undefined;
  host?.remove();
  host = undefined;
  calls = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('historical citation versions', () => {
  it('keeps showing FAQ v1 after v2 becomes the published version', async () => {
    mockFetch((url) => {
      if (url.includes('/knowledge/documents/kdoc_faq/versions')) {
        return url.includes('cursor=c1')
          ? json({
              items: [
                {
                  id: 'kdv_faq_v1',
                  documentId: 'kdoc_faq',
                  version: 1,
                  origin: 'faq',
                  parentVersionId: null,
                  metadata: {},
                  faq: faq('如何备份？', '历史版本答案。'),
                  isCurrent: false,
                  createdAt: '2026-01-01T00:00:00Z',
                },
              ],
              nextCursor: null,
            })
          : json({
              items: [
                {
                  id: 'kdv_faq_v2',
                  documentId: 'kdoc_faq',
                  version: 2,
                  origin: 'faq',
                  parentVersionId: 'kdv_faq_v1',
                  metadata: {},
                  faq: faq('如何备份？', '当前版本答案。'),
                  isCurrent: true,
                  createdAt: '2026-01-02T00:00:00Z',
                },
              ],
              nextCursor: 'c1',
            });
      }
      if (url.includes('/knowledge/faqs/kdoc_faq')) {
        return json({
          document: { id: 'kdoc_faq', currentVersionId: 'kdv_faq_v2' },
          draftVersion: null,
          publishedVersion: {
            id: 'kdv_faq_v2',
            documentId: 'kdoc_faq',
            version: 2,
            origin: 'faq',
            parentVersionId: 'kdv_faq_v1',
            metadata: {},
            faq: faq('如何备份？', '当前版本答案。'),
            isCurrent: true,
            createdAt: '2026-01-02T00:00:00Z',
          },
          faq: faq('如何备份？', '当前版本答案。'),
        });
      }
      return undefined;
    });
    await mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb__knowledge_search',
        result: citationWire(),
      }),
    );
    await click(trigger('如何备份？'));
    await waitFor(
      () =>
        document.querySelector('[role="dialog"]')?.textContent?.includes('历史版本答案。') === true,
      'FAQ v1 was not loaded from history',
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).not.toContain('当前版本答案。');
  });

  it('reads a cited Wiki version outside the first page instead of falling back', async () => {
    mockFetch((url) =>
      url.includes('/knowledge/wiki-pages/kwp_1/versions')
        ? url.includes('cursor=c1')
          ? json({ items: [wikiVersion('kwv_old', 1, '## 历史\n\n历史正文。')], nextCursor: null })
          : json({ items: [wikiVersion('kwv_new', 2, '## 当前\n\n当前正文。')], nextCursor: 'c1' })
        : undefined,
    );
    await mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb__knowledge_search',
        result: citationWire({
          target: { kind: 'wiki', id: 'kwp_1' },
          targetVersionId: 'kwv_old',
        }),
      }),
    );
    await click(trigger('如何备份？'));
    await waitFor(
      () => document.querySelector('[role="dialog"]')?.textContent?.includes('历史正文。') === true,
      'Wiki target version was not loaded',
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('当前正文。');
  });

  it('states a missing Wiki citation version instead of using the current one', async () => {
    mockFetch((url) =>
      url.includes('/knowledge/wiki-pages/kwp_1/versions')
        ? json({ items: [wikiVersion('kwv_new', 2, '## 当前\n\n当前正文。')], nextCursor: null })
        : undefined,
    );
    await mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb__knowledge_search',
        result: citationWire({
          target: { kind: 'wiki', id: 'kwp_1' },
          targetVersionId: 'kwv_missing',
        }),
      }),
    );
    await click(trigger('如何备份？'));
    await waitFor(
      () =>
        document.querySelector('[role="dialog"]')?.textContent?.includes('该版本已不可读。') ===
        true,
      'Missing Wiki version was not reported',
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('当前正文。');
  });
});

describe('Wiki management regressions', () => {
  it('lets a page with no version create its first draft from the editor', async () => {
    const emptyPage = {
      ...wikiSummary,
      status: 'draft',
      currentVersionId: null,
      versions: [],
      nextCursor: null,
    };
    mockFetch(
      wikiHandlers(
        () => emptyPage,
        () => json({ outgoing: [], incoming: [] }),
      ),
    );
    await mountWiki();
    await waitFor(
      () => document.body.textContent?.includes('还没有正文') === true,
      'Wiki not ready',
    );
    await click(button('编辑正文'));
    await waitFor(
      () => document.getElementById('knowledge-wiki-markdown') !== null,
      'First draft editor did not open',
    );
    expect(button('保存草稿').disabled).toBe(true);
    await fill('knowledge-wiki-markdown', '   ');
    expect(button('保存草稿').disabled).toBe(true);
    const firstDraft = '## 首稿\n\n人工写的首稿。';
    await fill('knowledge-wiki-markdown', firstDraft);
    expect(button('保存草稿').disabled).toBe(false);
    await click(button('保存草稿'));
    await waitFor(
      () =>
        calls.some(
          (call) => call.method === 'PATCH' && call.url.endsWith('/knowledge/wiki-pages/kwp_1'),
        ),
      'First draft was not saved',
    );
    expect(
      calls.find(
        (call) => call.method === 'PATCH' && call.url.endsWith('/knowledge/wiki-pages/kwp_1'),
      )?.body,
    ).toEqual({ markdown: firstDraft, expectedVersion: null });
  });

  it('reads the published version outside page one and never mislabels its draft as unpublished', async () => {
    const page = {
      ...wikiSummary,
      currentVersionId: 'kwv_old',
      versions: [wikiVersion('kwv_new', 3, '## 草稿\n\n新草稿。')],
      nextCursor: 'c1',
    };
    mockFetch(
      wikiHandlers(
        () => page,
        () => json({ outgoing: [], incoming: [] }),
      ),
    );
    await mountWiki();
    await waitFor(
      () => document.body.textContent?.includes('线上正文。') === true,
      'Current published version was not loaded',
    );
    expect(document.body.textContent).toContain('当前发布');
    expect(document.body.textContent).not.toContain('草稿预览');
    expect(document.body.textContent).not.toContain('新草稿。');
  });

  it('offers retry when wiki links fail to load', async () => {
    let linksFail = true;
    mockFetch(
      wikiHandlers(
        () => ({
          ...wikiSummary,
          versions: [wikiVersion('kwv_old', 1, '## 当前')],
          nextCursor: null,
        }),
        () =>
          linksFail
            ? json({ code: 'INTERNAL', message: '链接读取失败' }, 500)
            : json({ outgoing: [{ targetPageId: 'kwp_2', anchor: null }], incoming: [] }),
      ),
    );
    await mountWiki();
    await waitFor(
      () => document.body.textContent?.includes('链接没有加载出来') === true,
      'Links error was hidden',
    );
    linksFail = false;
    await click(button('重试'));
    await waitFor(
      () => document.body.textContent?.includes('链接没有加载出来') === false,
      'Links retry did not recover',
    );
    expect(button('链接')).toBeDefined();
  });

  it('organizes against the latest version instead of the published pointer', async () => {
    const page = {
      ...wikiSummary,
      currentVersionId: 'kwv_v1',
      versions: [
        wikiVersion('kwv_v2', 2, '## 草稿\n\n未发布草稿。'),
        wikiVersion('kwv_v1', 1, '## 当前\n\n线上正文。'),
      ],
      nextCursor: null,
    };
    mockFetch(
      wikiHandlers(
        () => page,
        () => json({ outgoing: [], incoming: [] }),
      ),
    );
    await mountWiki();
    await waitFor(
      () => document.body.textContent?.includes('线上正文。') === true,
      'Wiki page not ready',
    );
    await click(button('组织'));
    await waitFor(() => button('保存') !== null, 'Organize dialog did not open');
    await click(button('保存'));
    await waitFor(
      () =>
        calls.some(
          (call) => call.method === 'PATCH' && call.url.endsWith('/knowledge/wiki-pages/kwp_1'),
        ),
      'Organize payload was not sent',
    );
    expect(
      calls.find(
        (call) => call.method === 'PATCH' && call.url.endsWith('/knowledge/wiki-pages/kwp_1'),
      )?.body,
    ).toEqual({ parentId: null, position: 0, expectedVersion: 'kwv_v2' });
  });

  it('organizes a page whose only version is an unpublished first draft', async () => {
    const page = {
      ...wikiSummary,
      status: 'draft',
      currentVersionId: null,
      versions: [wikiVersion('kwv_first', 1, '## 首稿\n\n未发布首稿。')],
      nextCursor: null,
    };
    mockFetch(
      wikiHandlers(
        () => page,
        () => json({ outgoing: [], incoming: [] }),
      ),
    );
    await mountWiki();
    await waitFor(
      () => document.body.textContent?.includes('未发布首稿。') === true,
      'First draft not shown',
    );
    await click(button('组织'));
    await waitFor(() => button('保存') !== null, 'Organize dialog did not open');
    await click(button('保存'));
    await waitFor(
      () =>
        calls.some(
          (call) => call.method === 'PATCH' && call.url.endsWith('/knowledge/wiki-pages/kwp_1'),
        ),
      'Organize payload was not sent',
    );
    expect(
      calls.find(
        (call) => call.method === 'PATCH' && call.url.endsWith('/knowledge/wiki-pages/kwp_1'),
      )?.body,
    ).toEqual({ parentId: null, position: 0, expectedVersion: 'kwv_first' });
  });

  it('does not label the current published version as unpublished in preview', async () => {
    const page = {
      ...wikiSummary,
      currentVersionId: 'kwv_v1',
      versions: [
        wikiVersion('kwv_v2', 2, '## 草稿\n\n未发布草稿。'),
        wikiVersion('kwv_v1', 1, '## 当前\n\n线上正文。'),
      ],
      nextCursor: null,
    };
    mockFetch(
      wikiHandlers(
        () => page,
        () => json({ outgoing: [], incoming: [] }),
      ),
    );
    await mountWiki();
    await waitFor(
      () => document.body.textContent?.includes('当前发布') === true,
      'Current version not listed',
    );
    const currentRow = [...document.querySelectorAll('li')].find(
      (item) => item.textContent?.includes('v1') && item.textContent?.includes('当前发布'),
    );
    if (!currentRow) throw new Error('Current version row missing');
    await click(button('预览', currentRow));
    await waitFor(
      () => document.querySelector('[role="dialog"]')?.textContent?.includes('线上正文。') === true,
      'Preview did not open',
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('尚未发布');
  });

  it('refreshes wiki links after saving a draft', async () => {
    const page = {
      ...wikiSummary,
      versions: [wikiVersion('kwv_old', 1, '## 当前\n\n线上正文。')],
      nextCursor: null,
    };
    mockFetch(
      wikiHandlers(
        () => page,
        () => json({ outgoing: [], incoming: [] }),
      ),
    );
    await mountWiki();
    await waitFor(
      () => calls.some((call) => call.url.endsWith('/knowledge/wiki-pages/kwp_1/links')),
      'Initial links request missing',
    );
    await click(button('编辑正文'));
    await waitFor(
      () => document.getElementById('knowledge-wiki-markdown') !== null,
      'Editor did not open',
    );
    await fill('knowledge-wiki-markdown', '## 更新\n\n新正文。');
    await click(button('保存草稿'));
    await waitFor(
      () =>
        calls.filter((call) => call.url.endsWith('/knowledge/wiki-pages/kwp_1/links')).length >= 2,
      'Links were not refreshed after save',
    );
  });
});
