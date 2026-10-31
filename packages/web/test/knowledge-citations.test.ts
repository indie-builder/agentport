import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KnowledgeCitations,
  knowledgeHitsFromTool,
  stripImageReferences,
} from '../src/components/knowledge-citations.js';

const hits = [
  {
    chunkId: 'kchk_1',
    documentId: 'kdoc_1',
    versionId: 'kdv_1',
    target: { kind: 'document' as const, id: 'kdoc_1' },
    targetVersionId: 'kdv_1',
    title: '上线流程',
    heading: '发布前检查',
    quote: '发布前需要产品与研发双方确认。',
    pageFrom: 2,
    pageTo: 2,
    locator: null,
    parentContent: null,
    sourceUrl: 'https://gitlab.example.com/doc/1',
    score: 0.91,
    scoreKind: 'rrf' as const,
    scores: { keyword: 0.8, vector: 0.9, rrf: 0.03, rerank: null },
    image: null,
    faq: null,
  },
];

const wire = JSON.stringify({ hits, degraded: false, warnings: [] });

const readWire = JSON.stringify({
  target: { kind: 'document', id: 'kdoc_1' },
  versionId: 'kdv_1',
  title: '上线流程',
  sourceUrl: null,
  markdown: '正文',
  offset: 0,
  nextOffset: null,
  totalCharacters: 2,
  citations: hits,
});

function detailsResponse(): Response {
  return Response.json({
    id: 'kdv_1',
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
  });
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let client: QueryClient | undefined;

function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root?.render(createElement(QueryClientProvider, { client }, element)));
}

function flush() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('stripImageReferences', () => {
  it('drops knowledge image references but keeps ordinary links and text', () => {
    expect(
      stripImageReferences('图见下方\n\n![a.png](images/a.png)\n\n[文档](https://x.test/a)'),
    ).toBe('图见下方\n\n[文档](https://x.test/a)');
    expect(stripImageReferences('![remote](https://x.test/a.png)')).toBe(
      '![remote](https://x.test/a.png)',
    );
  });
});

describe('knowledge citations', () => {
  it('reads citations from search/read results and rejects unrelated tool output', () => {
    expect(knowledgeHitsFromTool('mcp__kb-handbook__knowledge_search', wire)).toEqual(hits);
    expect(knowledgeHitsFromTool('mcp__kb-handbook__knowledge_read', readWire)).toEqual(hits);
    expect(knowledgeHitsFromTool('mcp__kb-handbook__knowledge_read', wire)).toBeNull();
    expect(
      knowledgeHitsFromTool('mcp__kb-handbook__knowledge_search', 'DOCUMENT_NOT_FOUND: 无'),
    ).toBeNull();
    expect(
      knowledgeHitsFromTool('mcp__kb-handbook__knowledge_search', '{"hits":[{"title":"x"}]}'),
    ).toBeNull();
    expect(knowledgeHitsFromTool('mcp__kb-handbook__knowledge_search', undefined)).toBeNull();
  });

  it('renders nothing for a tool without structured hits', () => {
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: 'BASE_DISABLED: 知识库已禁用',
      }),
    );
    expect(host?.textContent).toBe('');
  });

  it('lists hits and opens the parsed text from the saved tool result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/details')
        ? detailsResponse()
        : new Response('# 上线流程\n\n发布前需要产品与研发双方确认。', {
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
          }),
    );
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: wire,
      }),
    );
    expect(host?.textContent).toContain('来源 · 1');
    expect(host?.textContent).toContain('上线流程');
    expect(host?.textContent).toContain('第 2 页');

    const trigger = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('上线流程'),
    );
    expect(trigger).toBeDefined();
    await act(async () => trigger?.click());
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/knowledge/versions/kdv_1/markdown',
      expect.objectContaining({ credentials: 'include' }),
    );
    const source = document.querySelector<HTMLAnchorElement>('a[href^="https://"]');
    expect(source?.getAttribute('target')).toBe('_blank');
    expect(source?.getAttribute('rel')).toBe('noreferrer noopener');
    expect(document.body.textContent).toContain('发布前需要产品与研发双方确认。');
  });

  it('never turns a non-http source into a clickable link', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/details') ? detailsResponse() : new Response('正文'),
    );
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: JSON.stringify({ hits: [{ ...hits[0], sourceUrl: 'javascript:alert(1)' }] }),
      }),
    );
    const trigger = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('上线流程'),
    );
    await act(async () => trigger?.click());
    await flush();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.body.textContent).not.toContain('查看来源');
  });

  it('explains a deleted or revoked source instead of showing an empty viewer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ code: 'NOT_FOUND', message: '版本不存在' }, { status: 404 }),
    );
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: wire,
      }),
    );
    const trigger = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('上线流程'),
    );
    await act(async () => trigger?.click());
    await flush();
    expect(document.body.textContent).toContain('来源已删除或尚未解析，无法查看原文。');
  });

  it('shows the original image of an image hit in the citation dialog', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/images/')
        ? new Response(new Blob(['png'], { type: 'image/png' }))
        : new Response('正文\n\n![image-1.png](images/image-1.png)'),
    );
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const image = { name: '图 1.png', mimeType: 'image/png', page: 3 };
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: JSON.stringify({ hits: [{ ...hits[0], image }] }),
      }),
    );
    const trigger = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('上线流程'),
    );
    await act(async () => trigger?.click());
    await flush();
    const shown = document.querySelector<HTMLImageElement>('[role="dialog"] img');
    expect(shown?.getAttribute('src')).toBe('blob:image');
    expect(shown?.getAttribute('alt')).toBe('发布前需要产品与研发双方确认。');
    expect(createObjectURL).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('第 3 页');
    // 原图已在上面单独展示，正文里同一条 images/ 引用连同占位一起消失。
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('image-1.png');
  });

  it('distinguishes a revoked image (403) from a missing one (404)', async () => {
    let imageStatus = 403;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/images/')
        ? Response.json({ code: 'FORBIDDEN', message: '无权读取' }, { status: imageStatus })
        : new Response('正文'),
    );
    const image = { name: 'chart.png', mimeType: 'image/png', page: 5 };
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: JSON.stringify({ hits: [{ ...hits[0], image }] }),
      }),
    );
    const trigger = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('上线流程'),
    );
    await act(async () => trigger?.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '无权读取这张图片，或知识库已停用。',
    );
    expect(document.querySelector('[role="dialog"] img')).toBeNull();
    expect(
      document.querySelector<HTMLAnchorElement>(
        '[role="dialog"] a[href="/api/knowledge/versions/kdv_1/content"]',
      ),
    ).not.toBeNull();

    imageStatus = 404;
    if (root) await act(async () => root?.unmount());
    host?.remove();
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: JSON.stringify({ hits: [{ ...hits[0], image }] }),
      }),
    );
    const reopened = [...(host?.querySelectorAll('button') ?? [])].find((item) =>
      item.textContent?.includes('上线流程'),
    );
    await act(async () => reopened?.click());
    await flush();
    expect(document.body.textContent).toContain('图片已删除或不存在，请重新解析该版本。');
  });
});

describe('knowledge citation tools', () => {
  it('parses list and read_image results as citation entries', () => {
    const listWire = JSON.stringify({
      items: [
        {
          target: { kind: 'wiki', id: 'kwp_1' },
          versionId: 'kwv_1',
          title: '备份指南',
          folderId: null,
          tags: [],
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      nextCursor: null,
    });
    expect(knowledgeHitsFromTool('mcp__kb-handbook__knowledge_list', listWire)).toHaveLength(1);

    const image = { name: '图 1.png', mimeType: 'image/png', page: 3 };
    const imageWire = JSON.stringify({
      hit: { ...hits[0], image },
      description: '图片描述',
    });
    const imageHits = knowledgeHitsFromTool('mcp__kb-handbook__knowledge_read_image', imageWire);
    expect(imageHits).toHaveLength(1);
    expect(imageHits?.[0]?.image).toEqual(image);
  });

  it('renders list results as openable objects', () => {
    const listWire = JSON.stringify({
      items: [
        {
          target: { kind: 'wiki', id: 'kwp_1' },
          versionId: 'kwv_1',
          title: '备份指南',
          folderId: null,
          tags: [],
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      nextCursor: null,
    });
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_list',
        result: listWire,
      }),
    );
    expect(host?.textContent).toContain('对象 · 1');
    expect(host?.textContent).toContain('备份指南');
    expect(host?.textContent).toContain('Wiki');
  });

  it('previews a PDF citation through BlobPdf and keeps the download link', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', {
      configurable: true,
      value: true,
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/details')) {
        return Response.json({
          id: 'kdv_1',
          documentId: 'kdoc_1',
          version: 1,
          originalFilename: 'release.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 8,
          sourceRevision: null,
          parseStatus: 'parsed',
          pageMap: [],
          images: [],
          createdAt: '2026-01-01T00:00:00Z',
        });
      }
      return new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } });
    });
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: wire,
      }),
    );
    const trigger = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('上线流程'),
    );
    await act(async () => trigger?.click());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await flush();
      if (document.querySelector('[role="dialog"] iframe')) break;
    }
    const iframe = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe');
    expect(iframe?.getAttribute('src')).toBe('blob:pdf#page=2');
    expect(
      document.querySelector<HTMLAnchorElement>(
        '[role="dialog"] a[href="/api/knowledge/versions/kdv_1/content"]',
      ),
    ).not.toBeNull();
    expect(
      (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([url]) =>
        String(url).includes('/content'),
      ),
    ).toBe(true);
  });

  it('uses the locator page and leaves the fragment off when no page is known', async () => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', {
      configurable: true,
      value: true,
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/details')) {
        return Response.json({
          id: 'kdv_1',
          documentId: 'kdoc_1',
          version: 1,
          originalFilename: 'release.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 8,
          sourceRevision: null,
          parseStatus: 'parsed',
          pageMap: [],
          images: [],
          createdAt: '2026-01-01T00:00:00Z',
        });
      }
      return new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } });
    });
    const openPdf = async (result: string): Promise<HTMLIFrameElement | null> => {
      if (root) await act(async () => root?.unmount());
      host?.remove();
      mount(
        createElement(KnowledgeCitations, {
          name: 'mcp__kb-handbook__knowledge_search',
          result,
        }),
      );
      const trigger = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
        button.textContent?.includes('上线流程'),
      );
      await act(async () => trigger?.click());
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await flush();
        if (document.querySelector('[role="dialog"] iframe')) break;
      }
      return document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe');
    };

    const locatorWire = JSON.stringify({
      hits: [{ ...hits[0], pageFrom: null, locator: { pageFrom: 3 } }],
      degraded: false,
      warnings: [],
    });
    expect((await openPdf(locatorWire))?.getAttribute('src')).toBe('blob:pdf#page=3');

    const noPageWire = JSON.stringify({
      hits: [{ ...hits[0], pageFrom: null, pageTo: null, locator: null }],
      degraded: false,
      warnings: [],
    });
    expect((await openPdf(noPageWire))?.getAttribute('src')).toBe('blob:pdf');
  });

  it('shows the cited FAQ version in full and ignores a newer unrelated draft', async () => {
    const publishedFaq = {
      question: '如何备份？',
      similarQuestions: ['备份怎么做'],
      negativeQuestions: [],
      answers: ['每日自动备份。', '异机保存副本。'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const draftFaq = { ...publishedFaq, answers: ['未发布的草稿答案。'] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        document: {
          id: 'kdoc_faq',
          baseId: 'kb_1',
          folderId: null,
          title: '如何备份',
          contentKind: 'faq',
          status: 'ready',
          disabledReason: null,
          currentVersionId: 'kdv_faq_pub',
          tags: [],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        draftVersion: {
          id: 'kdv_faq_draft',
          documentId: 'kdoc_faq',
          version: 2,
          origin: 'faq',
          parentVersionId: 'kdv_faq_pub',
          metadata: { publication: 'draft' },
          faq: draftFaq,
          isCurrent: false,
          createdAt: '2026-01-02T00:00:00Z',
        },
        publishedVersion: {
          id: 'kdv_faq_pub',
          documentId: 'kdoc_faq',
          version: 1,
          origin: 'faq',
          parentVersionId: null,
          metadata: {},
          faq: publishedFaq,
          isCurrent: true,
          createdAt: '2026-01-01T00:00:00Z',
        },
        faq: draftFaq,
      }),
    );
    const faqHit = {
      ...hits[0],
      target: { kind: 'faq', id: 'kdoc_faq' },
      targetVersionId: 'kdv_faq_pub',
      title: '如何备份？',
      image: null,
    };
    const faqWire = JSON.stringify({ hits: [faqHit], degraded: false, warnings: [] });
    mount(
      createElement(KnowledgeCitations, {
        name: 'mcp__kb-handbook__knowledge_search',
        result: faqWire,
      }),
    );
    const trigger = [...(host?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('如何备份？'),
    );
    await act(async () => trigger?.click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('每日自动备份。');
    expect(dialog?.textContent).toContain('异机保存副本。');
    expect(dialog?.textContent).not.toContain('未发布的草稿答案。');
  });
});
