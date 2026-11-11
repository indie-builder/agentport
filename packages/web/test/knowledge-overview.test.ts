import { PERMISSIONS } from '@agentport/shared';
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
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail/index.js';
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
  embeddingProfileId: 'profile_gone',
  rerankProfileId: 'profile_rerank',
  asrProfileId: null,
  settings: {
    chunkTokens: 800,
    chunkOverlap: 120,
    wikiAutoUpdate: false,
    imageProcessing: {
      enabled: false,
      model: null,
      ocrEnabled: true,
      captionEnabled: true,
      descriptionLanguage: 'zh-CN',
      customInstructions: '',
      imageVectorEnabled: false,
      imageVectorMinScore: 0.3,
    },
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const summary = {
  documents: 3,
  faqs: 2,
  wikiPages: 1,
  sources: 4,
  folders: 5,
  tags: 6,
  lastJob: {
    id: 'kjob_1',
    type: 'ingest',
    status: 'failed',
    createdAt: '2026-01-03T08:00:00Z',
    updatedAt: '2026-01-03T08:05:00Z',
  },
};

const msw = createMsw();
const { server, calls } = msw;

beforeAll(() => msw.listen());

afterAll(() => msw.close());

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

beforeEach(() => {
  msw.reset();
  server.use(http.get('/api/auth/me', () => HttpResponse.json(allAccessMe)));
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

afterEach(async () => {
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
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await msw.waitForRequests();
}

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
  const detail = createRoute({
    getParentRoute: () => shell,
    path: '/knowledge/$baseId',
    validateSearch: z.object({
      panel: z.string().optional(),
      page: z.string().optional(),
      folder: z.string().optional(),
      document: z.string().optional(),
      source: z.string().optional(),
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

function findButton(text: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
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

/** 定义列表项的值：配置项与计数项都以 dt 文本定位。 */
function valueFor(label: string): string | undefined {
  const term = [...document.querySelectorAll('dt')].find(
    (item) => item.textContent?.trim() === label,
  );
  return term?.parentElement?.querySelector('dd')?.textContent?.trim();
}

function overviewHandlers(job: typeof summary.lastJob = summary.lastJob) {
  server.use(
    http.get('/api/knowledge/bases/kb_1', () => HttpResponse.json(base)),
    http.get('/api/knowledge/bases/kb_1/summary', () =>
      HttpResponse.json({ ...summary, lastJob: job }),
    ),
    http.get('/api/knowledge/bases/kb_1/activity', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('/api/knowledge/model-profiles', () =>
      HttpResponse.json([
        {
          id: 'profile_rerank',
          name: '重排 B',
          kind: 'rerank',
          enabled: true,
          supportsImageVectors: false,
        },
      ]),
    ),
    http.get('/api/agents', () => HttpResponse.json([])),
  );
}

describe('knowledge base overview', () => {
  it('renders real counts, resolved model names and the latest job', async () => {
    overviewHandlers();
    await mount('/knowledge/kb_1', { panel: 'overview' });

    // 完整描述在概览最上方，不在页头。
    expect(document.body.textContent).toContain('内部知识');
    expect(valueFor('文档')).toBe('3');
    expect(valueFor('FAQ')).toBe('2');
    expect(valueFor('Wiki')).toBe('1');
    expect(valueFor('来源')).toBe('4');
    expect(valueFor('文件夹')).toBe('5');
    expect(valueFor('标签')).toBe('6');
    // 绑定已删除的 profile 不猜名字，如实标注不可见；未绑定显示未启用。
    expect(valueFor('向量模型')).toBe('已不可见');
    expect(valueFor('重排')).toBe('重排 B');
    expect(valueFor('音频转录')).toBe('未启用');
    expect(valueFor('分块')).toBe('800 tokens · 重叠 120');
    expect(valueFor('Wiki 自动更新')).toBe('未开启');
    expect(valueFor('图片处理')).toBe('未启用');
    expect(document.body.textContent).toContain('文档摄取');
    expect(document.body.textContent).toContain('失败');
    expect(findButton('处理记录')).toBeDefined();
  });

  it('opens the jobs tab from the overview entry', async () => {
    overviewHandlers();
    server.use(
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    const router = await mount('/knowledge/kb_1', { panel: 'overview' });
    await click(button('处理记录'));
    expect(router.state.location.search).toMatchObject({ panel: 'jobs' });
  });

  it('points an empty base at the documents tab', async () => {
    overviewHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/summary', () =>
        HttpResponse.json({ ...summary, documents: 0, faqs: 0, wikiPages: 0, lastJob: null }),
      ),
      http.get('/api/knowledge/bases/kb_1/documents', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/bases/kb_1/folders', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_1/tags', () => HttpResponse.json([])),
    );
    const router = await mount('/knowledge/kb_1', { panel: 'overview' });

    expect(valueFor('文档')).toBe('0');
    expect(document.body.textContent).toContain('这个库还没有内容');
    await click(button('上传文档'));
    expect(router.state.location.search).toMatchObject({ panel: 'documents' });
  });

  it('omits the empty next step once any content exists', async () => {
    overviewHandlers();
    await mount('/knowledge/kb_1', { panel: 'overview' });

    expect(document.body.textContent).not.toContain('这个库还没有内容');
    expect(findButton('上传文档')).toBeUndefined();
  });

  it('hides the empty next step from a reader without content management', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json(meWith(['knowledge.read']))));
    overviewHandlers();
    server.use(
      http.get('/api/knowledge/bases/kb_1/summary', () =>
        HttpResponse.json({ ...summary, documents: 0, faqs: 0, wikiPages: 0, lastJob: null }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'overview' });

    // 计数照常可读，只是没有动作可做：整块下一步都不出现，不留空话。
    expect(valueFor('文档')).toBe('0');
    expect(document.body.textContent).not.toContain('这个库还没有内容');
    expect(findButton('上传文档')).toBeUndefined();
  });

  it('saves name and description from the header edit dialog', async () => {
    overviewHandlers();
    server.use(
      http.patch('/api/knowledge/bases/kb_1', () =>
        HttpResponse.json({ ...base, name: '研发手册', description: '研发内部知识' }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'overview' });

    await click(button('编辑信息'));
    const editor = dialog('编辑信息');
    await fill('knowledge-base-info-name', '研发手册');
    await fill('knowledge-base-info-description', '研发内部知识');
    await click(button('保存', editor));

    expect(
      calls.find((item) => item.method === 'PATCH' && item.path === '/api/knowledge/bases/kb_1')
        ?.body,
    ).toEqual({ name: '研发手册', description: '研发内部知识' });
    expect(toastSuccess).toHaveBeenCalledWith('已保存知识库信息');
  });

  it('duplicates from the overview with the prefilled defaults and opens the copy', async () => {
    overviewHandlers();
    const copy = { ...base, id: 'kb_2', name: '产品手册 副本', slug: 'handbook-copy' };
    server.use(
      http.post('/api/knowledge/bases/kb_1/duplicate', () =>
        HttpResponse.json(copy, { status: 201 }),
      ),
      http.get('/api/knowledge/bases/kb_2', () => HttpResponse.json(copy)),
      http.get('/api/knowledge/bases/kb_2/summary', () =>
        HttpResponse.json({ ...summary, documents: 0, lastJob: null }),
      ),
      http.get('/api/knowledge/bases/kb_2/documents', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/bases/kb_2/folders', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_2/tags', () => HttpResponse.json([])),
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    const router = await mount('/knowledge/kb_1', { panel: 'overview' });

    await click(button('复制知识库'));
    const copier = dialog('复制知识库');
    const slugInput = document.getElementById('knowledge-duplicate-slug') as HTMLInputElement;
    expect((document.getElementById('knowledge-duplicate-name') as HTMLInputElement).value).toBe(
      '产品手册 副本',
    );
    // slug 默认留空，只在 placeholder 里给建议值，真正的落点交给服务端。
    expect(slugInput.value).toBe('');
    expect(slugInput.placeholder).toBe('handbook-copy');
    await click(button('复制', copier));

    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/duplicate',
      )?.body,
    ).toEqual({ name: '产品手册 副本', description: '内部知识' });
    await waitFor(() => router.state.location.pathname === '/knowledge/kb_2');
    expect(toastSuccess).toHaveBeenCalledWith('已复制为「产品手册 副本」');
  });

  it('sends the slug only when the user typed one', async () => {
    overviewHandlers();
    const copy = { ...base, id: 'kb_2', name: '产品手册 副本', slug: 'handbook-v2' };
    server.use(
      http.post('/api/knowledge/bases/kb_1/duplicate', () =>
        HttpResponse.json(copy, { status: 201 }),
      ),
      http.get('/api/knowledge/bases/kb_2', () => HttpResponse.json(copy)),
      http.get('/api/knowledge/bases/kb_2/summary', () =>
        HttpResponse.json({ ...summary, documents: 0, lastJob: null }),
      ),
      http.get('/api/knowledge/bases/kb_2/documents', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get('/api/knowledge/bases/kb_2/folders', () => HttpResponse.json([])),
      http.get('/api/knowledge/bases/kb_2/tags', () => HttpResponse.json([])),
      http.get('/api/knowledge/jobs', () => HttpResponse.json({ items: [], nextCursor: null })),
    );
    await mount('/knowledge/kb_1', { panel: 'overview' });

    await click(button('复制知识库'));
    const copier = dialog('复制知识库');
    await fill('knowledge-duplicate-slug', 'handbook-v2');
    await click(button('复制', copier));

    expect(
      calls.find(
        (item) => item.method === 'POST' && item.path === '/api/knowledge/bases/kb_1/duplicate',
      )?.body,
    ).toEqual({ name: '产品手册 副本', slug: 'handbook-v2', description: '内部知识' });
  });

  it('keeps overview read-only without create or update', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json(meWith(['knowledge.read']))));
    overviewHandlers();
    await mount('/knowledge/kb_1', { panel: 'overview' });

    expect(valueFor('文档')).toBe('3');
    expect(findButton('复制知识库')).toBeUndefined();
    expect(findButton('编辑信息')).toBeUndefined();
    expect(findButton('设置')).toBeUndefined();
  });

  it('lists recent activity with Chinese action names and the raw actor', async () => {
    overviewHandlers();
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    server.use(
      http.get('/api/knowledge/bases/kb_1/activity', () =>
        HttpResponse.json({
          items: [
            {
              id: 'aud_5',
              action: 'knowledge.document.updated',
              actor: 'bus_ops',
              status: 'ok',
              targetKind: 'document',
              createdAt: minutesAgo(1),
            },
            {
              id: 'aud_4',
              action: 'knowledge.base.updated',
              actor: 'bus_admin',
              status: 'ok',
              targetKind: 'base',
              createdAt: minutesAgo(1),
            },
            {
              id: 'aud_3',
              action: 'knowledge.tag.renamed',
              actor: 'bus_ops',
              status: 'ok',
              targetKind: 'tag',
              createdAt: minutesAgo(4),
            },
            {
              id: 'aud_2',
              action: 'knowledge.not_mapped_action',
              actor: 'bus_ops',
              status: 'ok',
              targetKind: 'base',
              createdAt: minutesAgo(90),
            },
            {
              id: 'aud_1',
              action: 'knowledge.base.created',
              actor: 'bus_admin',
              status: 'ok',
              targetKind: 'base',
              createdAt: minutesAgo(60 * 24 * 30),
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    await mount('/knowledge/kb_1', { panel: 'overview' });

    expect(document.body.textContent).toContain('最近活动');
    expect(document.body.textContent).toContain('更新知识库');
    expect(document.body.textContent).toContain('更新文档');
    expect(document.body.textContent).toContain('重命名标签');
    expect(document.body.textContent).toContain('· 4 分钟前');
    expect(document.body.textContent).toContain('创建知识库');
    // 没映射过的 action 原样显示，不猜中文名。
    expect(document.body.textContent).toContain('knowledge.not_mapped_action');
    expect(document.body.textContent).toContain('bus_ops');
    expect(document.body.textContent).toContain('bus_admin');
  });

  it('omits the activity section when the base has no events', async () => {
    overviewHandlers();
    await mount('/knowledge/kb_1', { panel: 'overview' });

    expect(document.body.textContent).toContain('文档摄取');
    expect(document.body.textContent).not.toContain('最近活动');
  });

  it('reports an activity load failure with a retry that recovers', async () => {
    overviewHandlers();
    let attempts = 0;
    server.use(
      http.get('/api/knowledge/bases/kb_1/activity', () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json({ title: 'boom' }, { status: 500 })
          : HttpResponse.json({
              items: [
                {
                  id: 'aud_1',
                  action: 'knowledge.base.created',
                  actor: 'bus_admin',
                  status: 'ok',
                  targetKind: 'base',
                  createdAt: new Date(Date.now() - 60_000).toISOString(),
                },
              ],
              nextCursor: null,
            });
      }),
    );
    await mount('/knowledge/kb_1', { panel: 'overview' });

    expect(document.body.textContent).toContain('最近活动');
    expect(document.body.textContent).toContain('内容没有加载出来');

    await click(button('重试'));
    await waitFor(() => document.body.textContent?.includes('创建知识库') ?? false);
    expect(document.body.textContent).not.toContain('内容没有加载出来');
  });
});
