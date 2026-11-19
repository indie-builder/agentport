import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { delay, HttpResponse, http } from 'msw';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useKnowledgeSearch } from '../src/lib/queries.js';
import { toast, toastError } from '../src/lib/toast.js';
import {
  base,
  baseHandlers,
  button,
  calls,
  chooseFilter,
  chooseMenuItem,
  chooseOption,
  cleanup,
  click,
  deferred,
  dialog,
  dialogShown,
  doc,
  fill,
  flush,
  hitWire,
  markdownResponse,
  mockMe,
  mockPins,
  mount,
  mountState,
  openMenu,
  registerKnowledgeHarness,
  server,
  source,
  sourceChoice,
  syncJob,
  waitFor,
  wikiJob,
  wikiPage,
} from './knowledge-harness.js';

vi.mock('../src/lib/toast.js', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

registerKnowledgeHarness();

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
    mountState.client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    mountState.host = document.createElement('div');
    document.body.append(mountState.host);
    mountState.root = createRoot(mountState.host);
    const renderProbe = async (limit: number) => {
      await act(async () => {
        mountState.root?.render(
          createElement(
            QueryClientProvider,
            { client: mountState.client },
            createElement(Probe, { limit }),
          ),
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
    supportsImageVectors: false,
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
    mockPins();
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
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'bases'] });
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
    await click(button('清除筛选'));
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
    await openMenu('更多操作');
    await chooseMenuItem('导入知识包');
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
      supportsImageVectors: false,
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
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'model-profiles'] });
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
    await chooseMenuItem('编辑信息');
    await fill('knowledge-base-info-name', '研发手册');
    await click(button('取消', dialog('编辑信息')));
    expect(dialog('放弃未保存的更改？')).toBeDefined();
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(dialogShown('编辑信息')).toBe(false);

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
      mountState.client
        ?.getQueryCache()
        .findAll({ queryKey: ['knowledge', 'documents', 'kb_1'] }) ?? [];
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
    const jobQuery = mountState.client
      ?.getQueryCache()
      .find({ queryKey: ['knowledge', 'job', 'kjob_gone'] });
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
      mountState.client
        ?.getQueryCache()
        .findAll({ queryKey: ['knowledge', 'documents', 'kb_1'] }) ?? [];
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
    expect(params.getAll('folders[0]')).toEqual(['kf_1']);
    expect(params.getAll('tags[0]')).toEqual(['流程']);
    expect(params.getAll('kinds[0]')).toEqual(['faq']);
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

  it('restores the default vector threshold when the field is cleared', async () => {
    baseHandlers();
    let searchUrl = '';
    server.use(
      http.get('/api/knowledge/bases/kb_1/search', ({ request }) => {
        searchUrl = request.url;
        return HttpResponse.json({ hits: [], degraded: false });
      }),
    );
    await mount('/knowledge/kb_1', {
      panel: 'search',
      q: '备份',
      minVectorScore: '0.5',
    });
    await flush();
    expect(new URL(searchUrl, 'http://localhost').searchParams.get('minVectorScore')).toBe('0.5');

    await fill('knowledge-min-vector', '');
    await flush();

    expect(new URL(searchUrl, 'http://localhost').searchParams.has('minVectorScore')).toBe(false);
    expect(document.querySelector<HTMLInputElement>('#knowledge-min-vector')?.value).toBe('0.3');
  });
});
