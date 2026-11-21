import { EditorView } from '@codemirror/view';
import { delay, HttpResponse, http } from 'msw';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { toastError } from '../src/lib/toast.js';
import {
  base,
  baseHandlers,
  button,
  calls,
  chooseFilter,
  chooseMenuItem,
  chunk,
  click,
  deferred,
  detailsHandler,
  dialog,
  dialogShown,
  doc,
  fill,
  flush,
  markdownResponse,
  mount,
  mountState,
  openMenu,
  patchBody,
  registerKnowledgeHarness,
  server,
  waitFor,
} from './knowledge-harness.js';

vi.mock('../src/lib/toast.js', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const editorImport = vi.hoisted(() => {
  let release: () => void = () => {};
  let gate: Promise<void> | undefined;
  return {
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release();
      gate = undefined;
    },
    wait() {
      return gate ?? Promise.resolve();
    },
  };
});

vi.mock('../src/components/source-editor-inner.js', async (importOriginal) => {
  await editorImport.wait();
  return importOriginal();
});

registerKnowledgeHarness();

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
        HttpResponse.json(
          {
            code: 'CONFLICT',
            message: '分块已被其他修改更新',
            status: 409,
            requestId: '',
            retryable: false,
          },
          { status: 409 },
        ),
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
        HttpResponse.json(
          {
            code: 'CONFLICT',
            message: '分块已被其他修改更新',
            status: 409,
            requestId: '',
            retryable: false,
          },
          { status: 409 },
        ),
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
        HttpResponse.json(
          {
            code: 'CONFLICT',
            message: '分块已被其他修改更新',
            status: 409,
            requestId: '',
            retryable: false,
          },
          { status: 409 },
        ),
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
    editorImport.hold();
    try {
      await act(async () => item.click());
      const loading = document.getElementById('knowledge-manual-content');
      expect(loading?.tagName).toBe('TEXTAREA');
      expect(loading?.getAttribute('aria-label')).toBe('正文（Markdown）');
    } finally {
      editorImport.release();
    }

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

    server.use(
      http.get('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ code: 'INTERNAL', message: '知识库刷新失败' }, { status: 500 }),
      ),
    );
    await act(async () => {
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'base', 'kb_1'] });
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
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'documents', 'kb_1'] });
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
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'documents', 'kb_1'] });
    });
    await flush();
    expect(dialog('上线流程').textContent).toContain('解析后的正文');

    state = 'missing';
    await act(async () => {
      await mountState.client?.invalidateQueries({ queryKey: ['knowledge', 'documents', 'kb_1'] });
    });
    await flush();
    const viewer = dialog('上线流程');
    expect(viewer.textContent).toContain('解析后的正文');
    expect(viewer.textContent).toContain('发布前需要产品与研发双方确认。');
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
    )?.body as { filename: string; relativePath?: string } | undefined;
    expect(body?.filename).toBe('docs/spec.txt');
    expect(body?.relativePath).toBe('docs/spec.txt');
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
        HttpResponse.json({
          content: '已发布正文',
          versionId: 'kdv_1',
          status: 'published',
          pendingJobId: null,
        }),
      ),
      http.get('/api/knowledge/versions/kdv_1/markdown', () => markdownResponse('已发布正文')),
      http.get('/api/knowledge/documents/kdoc_1/chunks', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      detailsHandler(),
      http.put('/api/knowledge/documents/kdoc_1/manual', () =>
        HttpResponse.json(
          {
            code: 'CONFLICT_STALE',
            message: '正文已被修改',
            status: 409,
            requestId: '',
            retryable: false,
          },
          { status: 409 },
        ),
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
