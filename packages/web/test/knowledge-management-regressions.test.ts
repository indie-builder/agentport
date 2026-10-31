import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
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
import { BatchActionDialog, ManualDraftDialog } from '../src/components/knowledge-documents.js';
import { knowledgeKeys } from '../src/lib/queries.js';
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail.js';
import { knowledgeDetailSearchSchema } from '../src/routes/-search.js';
import { createMsw, runCleanup } from './msw.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
const msw = createMsw();
const { server, calls } = msw;
const now = '2026-01-02T00:00:00Z';
const base = {
  id: 'kb_1',
  slug: 'handbook',
  name: '产品手册',
  description: '',
  status: 'active',
  settings: {},
  createdAt: now,
  updatedAt: now,
};
const doc = {
  id: 'kdoc_99',
  baseId: 'kb_1',
  folderId: null,
  title: '分页外手写正文',
  contentKind: 'document',
  sourceType: 'manual',
  sourceUrl: null,
  sourcePath: null,
  mimeType: 'text/markdown',
  sizeBytes: 12,
  status: 'ready',
  currentVersionId: 'kdv_1',
  tags: [],
  lastSyncedAt: null,
  createdAt: now,
  updatedAt: now,
};
const version = {
  id: 'kdv_1',
  documentId: doc.id,
  version: 1,
  origin: 'manual',
  isCurrent: true,
  metadata: {},
  createdAt: now,
};
let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let browserHistory: ReturnType<typeof createBrowserHistory> | undefined;
const releases: Array<() => void> = [];
function deferred() {
  const signal = Promise.withResolvers<void>();
  releases.push(() => signal.resolve());
  return signal;
}
beforeAll(() => msw.listen());
afterAll(() => msw.close());
beforeEach(() => {
  msw.reset();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  server.use(
    http.get('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)),
    http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/tags', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_1/documents', () =>
      HttpResponse.json({ items: [], nextCursor: 'page_2' }),
    ),
    http.get('/api/knowledge/documents/kdoc_99', () => HttpResponse.json(doc)),
    http.get('/api/knowledge/documents/kdoc_99/versions', () =>
      HttpResponse.json({ items: [version], nextCursor: null }),
    ),
    http.get('/api/knowledge/documents/kdoc_99/chunks', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/versions/kdv_1/markdown', () => HttpResponse.text('分页外的完整正文')),
    http.get('/api/knowledge/versions/kdv_1/details', () => HttpResponse.json({ images: [] })),
  );
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await runCleanup([
    () => root && act(async () => root.unmount()),
    () => client?.clear(),
    () => {
      browserHistory?.destroy();
      browserHistory = undefined;
    },
    () => host?.remove(),
    () => msw.waitForRequests(),
    () => vi.restoreAllMocks(),
    () => vi.unstubAllGlobals(),
    () => msw.assertClean(),
  ]);
});
async function until(assertion: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {});
      assertion();
    },
    { timeout: 5000 },
  );
}
async function mount(
  component: () => React.ReactNode = KnowledgeDetailPage,
  path = '/knowledge/kb_1',
  browser = false,
) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const detail = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/$baseId',
    validateSearch: knowledgeDetailSearchSchema,
    component,
  });
  const list = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/',
    component: () => createElement('p', null, '知识库列表'),
  });
  if (browser) {
    window.history.replaceState({}, '', '/knowledge');
    browserHistory = createBrowserHistory();
    browserHistory.push(path);
    browserHistory.flush();
  }
  const history = browserHistory ?? createMemoryHistory({ initialEntries: ['/knowledge', path] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([list, detail])]),
    history,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  return router;
}
function button(label: string, scope: ParentNode = document.body) {
  const found = [...scope.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label,
  );
  expect(found, label).toBeDefined();
  return found as HTMLButtonElement;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function input(id: string, value: string) {
  const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  expect(element).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function dialogs() {
  return [...document.querySelectorAll('[role="dialog"]')];
}

describe('知识管理真实路由回归', () => {
  it('分页外 document 深链独立取详情，URL 去掉 document 后关闭查看器', async () => {
    const router = await mount(
      KnowledgeDetailPage,
      '/knowledge/kb_1?document=kdoc_99&folder=other',
    );
    await until(() => expect(document.body.textContent).toContain('分页外的完整正文'));
    expect(calls.some((call) => call.path === '/api/knowledge/documents/kdoc_99')).toBe(true);
    expect(calls.some((call) => call.path.includes('cursor=page_2'))).toBe(false);
    await act(async () => {
      await router.navigate({ to: '/knowledge/$baseId', params: { baseId: 'kb_1' }, search: {} });
    });
    await until(() => expect(dialogs()).toHaveLength(0));
  });

  it('正文初始化同时固定版本锁，后台刷新不把新锁配给旧正文', async () => {
    server.use(
      http.get('/api/knowledge/documents/kdoc_99/manual', () =>
        HttpResponse.json({ content: '原正文', versionId: 'kdv_1', status: 'published' }),
      ),
      http.put('/api/knowledge/documents/kdoc_99/manual', () =>
        HttpResponse.json({ code: 'CONFLICT', message: '正文版本已变化' }, { status: 409 }),
      ),
    );
    await mount(() =>
      createElement(ManualDraftDialog, {
        baseId: 'kb_1',
        documentId: doc.id,
        title: doc.title,
        onClose: vi.fn(),
      }),
    );
    await until(() => expect(document.querySelector('.cm-content')).not.toBeNull());
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement);
    expect(view).not.toBeNull();
    await act(async () =>
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '我的修改' } }),
    );
    await act(async () => {
      client.setQueryData(knowledgeKeys.manual(doc.id), {
        content: '他人正文',
        versionId: 'kdv_2',
        status: 'draft',
      });
    });
    await until(() => expect(document.body.textContent).toContain('未发布草稿'));
    await click(button('保存草稿'));
    await until(() => expect(document.body.textContent).toContain('正文版本已变化'));
    await msw.waitForRequests();
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
      content: '我的修改',
      expectedVersionId: 'kdv_1',
    });
    expect(view?.state.doc.toString()).toBe('我的修改');
  });

  it('202 仅表示解析受理，终态失败保留草稿并刷新 manual/versions', async () => {
    const response = deferred();
    const requested = deferred();
    const close = vi.fn();
    server.use(
      http.get('/api/knowledge/documents/kdoc_99/manual', () =>
        HttpResponse.json({ content: '原正文', versionId: 'kdv_1', status: 'published' }),
      ),
      http.put('/api/knowledge/documents/kdoc_99/manual', () =>
        HttpResponse.json({ documentId: doc.id, jobId: 'kjob_save' }, { status: 202 }),
      ),
      http.get('/api/knowledge/jobs/kjob_save', async () => {
        requested.resolve();
        await response.promise;
        return HttpResponse.json({
          id: 'kjob_save',
          type: 'ingest',
          status: 'failed',
          error: '解析服务拒绝正文',
          createdAt: now,
        });
      }),
    );
    await mount(() =>
      createElement(ManualDraftDialog, {
        baseId: 'kb_1',
        documentId: doc.id,
        title: doc.title,
        onClose: close,
      }),
    );
    await until(() => expect(document.querySelector('.cm-content')).not.toBeNull());
    client.setQueryData(knowledgeKeys.documentVersions(doc.id), {
      pages: [{ items: [version], nextCursor: null }],
      pageParams: [null],
    });
    await click(button('保存草稿'));
    await until(() =>
      expect(calls.some((call) => call.path === '/api/knowledge/jobs/kjob_save')).toBe(true),
    );
    await requested.promise;
    expect(close).not.toHaveBeenCalled();
    expect(button('解析中…').disabled).toBe(true);
    await act(async () => response.resolve());
    await until(() => expect(document.body.textContent).toContain('解析服务拒绝正文'));
    await until(() =>
      expect(
        calls.filter((call) => call.path.endsWith('/manual') && call.method === 'GET').length,
      ).toBeGreaterThan(1),
    );
    expect(client.getQueryState(knowledgeKeys.documentVersions(doc.id))?.isInvalidated).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it('批处理 pending 阻止 Escape、外部点击与历史后退，ID/标题固定为打开快照', async () => {
    const response = deferred();
    const started = deferred();
    const close = vi.fn();
    const ids = ['kdoc_99'];
    const titles = { kdoc_99: '打开时标题' };
    server.use(
      http.post('/api/knowledge/bases/kb_1/documents/batch', async () => {
        started.resolve();
        await response.promise;
        return HttpResponse.json({ results: [{ documentId: doc.id, status: 'succeeded' }] });
      }),
    );
    const router = await mount(
      () =>
        createElement(BatchActionDialog, {
          baseId: 'kb_1',
          action: 'delete',
          documentIds: ids,
          titles,
          folders: [],
          onClose: close,
        }),
      '/knowledge/kb_1',
      true,
    );
    await until(() => expect(dialogs()).toHaveLength(1));
    ids.push('kdoc_later');
    titles.kdoc_99 = '刷新后标题';
    await click(button('删除'));
    await started.promise;
    await until(() => expect(button('处理中…').disabled).toBe(true));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      expect(overlay).not.toBeNull();
      overlay?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      overlay?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(close).not.toHaveBeenCalled();
    await act(async () => router.history.back());
    await until(() => expect(document.body.textContent).toContain('正在保存，请等待请求完成。'));
    expect(router.state.location.pathname).toBe('/knowledge/kb_1');
    await act(async () => response.resolve());
    await until(() => expect(document.body.textContent).toContain('打开时标题'));
    await msw.waitForRequests();
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      documentIds: ['kdoc_99'],
    });
    await click(button('完成'));
    expect(close).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe('/knowledge/kb_1');
  });

  it('同步逐项结果保留游标，并在运行终态后刷新已展开明细', async () => {
    const syncRun = (status: string) => ({
      id: 'ksr_1',
      sourceId: 'ksrc_1',
      status,
      stats: { created: 0, updated: 0, failed: 1 },
      startedAt: now,
      createdAt: now,
    });
    const item = (id: string, externalId: string) => ({
      id,
      syncRunId: 'ksr_1',
      sourceId: 'ksrc_1',
      externalId,
      status: 'failed',
      code: 'REMOTE_ERROR',
      message: '远端拒绝',
      documentId: null,
    });
    let terminal = false;
    server.use(
      http.get('/api/knowledge/bases/kb_1/sources', () =>
        HttpResponse.json({
          items: [
            {
              id: 'ksrc_1',
              baseId: 'kb_1',
              name: '产品仓库',
              type: 'github',
              config: {},
              ranges: [],
              status: 'active',
              syncCron: null,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get('/api/knowledge/sources/ksrc_1/runs', () =>
        HttpResponse.json({ items: [syncRun(terminal ? 'failed' : 'running')], nextCursor: null }),
      ),
      http.get('/api/knowledge/sources/ksrc_1/runs/ksr_1/items', ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.has('cursor')
            ? { items: [item('ksi_2', '第二页文件')], nextCursor: null }
            : {
                items: [item('ksi_1', terminal ? '终态文件' : '第一页文件')],
                nextCursor: 'items_2',
              },
        ),
      ),
    );
    await mount(KnowledgeDetailPage, '/knowledge/kb_1?panel=sources&source=ksrc_1');
    await until(() => expect(document.body.textContent).toContain('第一页文件'));
    await click(button('加载更多逐项结果'));
    await until(() => expect(document.body.textContent).toContain('第二页文件'));
    expect(document.body.textContent).toContain('第一页文件');
    terminal = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: knowledgeKeys.sourceRuns('ksrc_1') });
    });
    await until(() => expect(document.body.textContent).toContain('终态文件'));
    expect(document.body.textContent).toContain('第二页文件');
  });

  it('离线评估通过现有接口提交 query/target/chunk 并展示 Recall/MRR 和下载', async () => {
    server.use(
      http.post('/api/knowledge/bases/kb_1/retrieval-evaluations', () =>
        HttpResponse.json({
          recallAtK: 0.5,
          mrr: 0.25,
          chunkRecallAtK: 1,
          results: [
            {
              q: '如何发布',
              hit: true,
              recallAtK: 0.5,
              reciprocalRank: 0.25,
              chunkRecallAtK: 1,
              elapsedMs: 12,
              degraded: false,
              warnings: [],
            },
          ],
        }),
      ),
    );
    await mount(KnowledgeDetailPage, '/knowledge/kb_1?panel=evaluations');
    await until(() => expect(document.getElementById('knowledge-evaluation-query')).not.toBeNull());
    await input('knowledge-evaluation-query', '如何发布');
    await input('knowledge-evaluation-targets', 'document:kdoc_99');
    await input('knowledge-evaluation-chunks', 'kchk_1');
    await click(button('运行评估'));
    await until(() => expect(document.body.textContent).toContain('0.250'));
    expect(document.body.textContent).toContain('50.0%');
    expect(button('下载结果').disabled).toBe(false);
    const downloaded: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      downloaded.push(blob);
      return 'blob:evaluation';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    await click(button('下载结果'));
    expect(downloadClick).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:evaluation');
    const reader = new FileReader();
    const body = new Promise<string>((resolve) => {
      reader.onload = () => resolve(String(reader.result));
    });
    reader.readAsText(downloaded[0] as Blob);
    expect(JSON.parse(await body)).toMatchObject({ recallAtK: 0.5, mrr: 0.25, chunkRecallAtK: 1 });
    await msw.waitForRequests();
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      cases: [
        {
          q: '如何发布',
          expectedTargets: [{ kind: 'document', id: 'kdoc_99' }],
          expectedChunkIds: ['kchk_1'],
        },
      ],
    });
  });
});
