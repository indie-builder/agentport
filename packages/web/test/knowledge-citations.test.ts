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
    title: '上线流程',
    heading: '发布前检查',
    quote: '发布前需要产品与研发双方确认。',
    pageFrom: 2,
    pageTo: 2,
    sourceUrl: 'https://gitlab.example.com/doc/1',
    score: 0.91,
    image: null,
  },
];

const wire = JSON.stringify({ hits });

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(element));
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
  it('only treats a knowledge_search JSON result as citations', () => {
    expect(knowledgeHitsFromTool('mcp__kb-handbook__knowledge_search', wire)).toEqual(hits);
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('# 上线流程\n\n发布前需要产品与研发双方确认。', {
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('正文'));
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
