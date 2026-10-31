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
import { KnowledgePage } from '../src/pages/knowledge.js';
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail.js';
import { allAccessMe } from './me-fixture.js';
import { createMsw, runCleanup } from './msw.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { server, calls, listen, reset, waitForRequests, assertClean, close } = createMsw();

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

const createdBase = { ...base, id: 'kb_new', slug: 'new-base', name: '新库', description: '' };

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

const secondEmbedding = { ...embeddingProfile, id: 'profile_2', name: 'text-embedding-3' };

const rerankProfile = {
  ...embeddingProfile,
  id: 'profile_rerank',
  kind: 'rerank',
  name: 'bge-reranker',
  model: 'bge-reranker-v2',
  dimensions: null,
  hasSecret: false,
};

beforeAll(() => listen());
afterAll(() => close());

beforeEach(() => {
  reset();
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

async function cleanup() {
  const mountedRoot = root,
    mountedClient = client,
    mountedHost = host;
  root = client = host = undefined;
  await runCleanup([
    () => mountedRoot && act(async () => mountedRoot.unmount()),
    () => mountedClient?.clear(),
    () => mountedHost?.remove(),
    () => waitForRequests(),
    () => vi.restoreAllMocks(),
    () => vi.unstubAllGlobals(),
    () => assertClean(),
  ]);
}

afterEach(() => cleanup());

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await waitForRequests();
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

function advancedPanel(): HTMLElement | null {
  return (
    document
      .getElementById('knowledge-chunk-tokens')
      ?.closest<HTMLElement>('[data-slot="collapsible-content"]') ?? null
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
  await flush();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

type ProfileFixture = typeof embeddingProfile | typeof rerankProfile;

/** 选择投影与后端同规则；创建页只需要 id/name/kind/enabled，不拿管理字段。 */
function selectionOf(profile: ProfileFixture) {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    enabled: profile.enabled,
    supportsImageVectors:
      profile.kind === 'embedding' &&
      profile.enabled &&
      profile.embeddingProtocol === 'cohere_v2' &&
      profile.model === 'embed-v4.0' &&
      profile.imageInputEnabled,
  };
}

function profilesHandler(data: () => ProfileFixture[] | Promise<ProfileFixture[]>) {
  return http.get('/api/knowledge/model-profiles', async ({ request }) => {
    const view = new URL(request.url).searchParams.get('view');
    if (view === 'selection') {
      return HttpResponse.json((await data()).map(selectionOf));
    }
    if (view !== null) {
      return HttpResponse.json({ code: 'INVALID_INPUT', message: '未知的视图' }, { status: 400 });
    }
    return HttpResponse.json(await data());
  });
}

function profileCalls() {
  return calls.filter((item) => item.path.startsWith('/api/knowledge/model-profiles'));
}

function listHandlers(profiles: ProfileFixture[]) {
  server.use(
    http.get('/api/knowledge/bases', () => HttpResponse.json({ items: [base], nextCursor: null })),
    http.get('/api/agents', () => HttpResponse.json([])),
    profilesHandler(() => profiles),
    http.post('/api/knowledge/bases', () => HttpResponse.json(createdBase)),
  );
}

/** 创建成功会直接进详情文档页；这些查询必须真实可答，避免把未配置路由当成通过。 */
function detailHandlers() {
  server.use(
    http.get('/api/knowledge/bases/kb_new', () => HttpResponse.json(createdBase)),
    http.get('/api/knowledge/bases/kb_new/folders', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_new/tags', () => HttpResponse.json([])),
    http.get('/api/knowledge/bases/kb_new/documents', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}

function createPost() {
  return calls.find((item) => item.method === 'POST' && item.path === '/api/knowledge/bases');
}

describe('knowledge create flow', () => {
  it('auto-selects the only embedding profile without turning it into a user edit', async () => {
    const profiles = deferred<ProfileFixture[]>();
    server.use(
      http.get('/api/knowledge/bases', () =>
        HttpResponse.json({ items: [base], nextCursor: null }),
      ),
      http.get('/api/agents', () => HttpResponse.json([])),
      profilesHandler(() => profiles.promise),
    );
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    expect(advancedPanel()?.hasAttribute('hidden')).toBe(true);
    expect(creator.textContent).not.toContain('bge-m3');
    expect(creator.textContent).not.toContain('创建 embedding profile');

    await act(async () => profiles.resolve([embeddingProfile]));
    await waitFor(() => (creator.textContent ?? '').includes('bge-m3'));

    // 自动默认在高级设置里静默完成，不主动展开或制造用户改动。
    expect(advancedPanel()?.hasAttribute('hidden')).toBe(true);
    await click(button('取消', creator));
    expect(dialogShown('新建知识库')).toBe(false);
    expect(dialogShown('放弃未保存的更改？')).toBe(false);
  });

  it('creates from a Chinese name alone with a generated kb- slug and lands on the document page', async () => {
    listHandlers([embeddingProfile]);
    detailHandlers();
    const router = await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    expect(creator.textContent).toContain('bge-m3');
    expect(advancedPanel()?.hasAttribute('hidden')).toBe(true);

    await fill('knowledge-name', '新库');
    await click(button('创建', creator));

    const body = createPost()?.body as {
      name?: string;
      slug?: string;
      embeddingProfileId?: string;
    };
    expect(body).toMatchObject({ name: '新库', embeddingProfileId: 'profile_1' });
    expect(body.slug).toMatch(/^kb-[a-z0-9]{8}$/);
    expect(toastSuccess).toHaveBeenCalledWith('已创建「新库」');
    expect(dialogShown('新建知识库')).toBe(false);
    expect(router.state.location.pathname).toBe('/knowledge/kb_new');
    expect(document.body.textContent).toContain('新库');
  });

  it('derives a readable slug from an ASCII name when slug is left empty', async () => {
    listHandlers([embeddingProfile]);
    detailHandlers();
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');

    await fill('knowledge-name', 'Ops Handbook');
    await click(button('创建', creator));

    expect(createPost()?.body).toMatchObject({ name: 'Ops Handbook', slug: 'ops-handbook' });
  });

  it('keeps an explicitly entered slug', async () => {
    listHandlers([embeddingProfile]);
    detailHandlers();
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');

    await fill('knowledge-name', '新库');
    await fill('knowledge-slug', 'new-base');
    await click(button('创建', creator));

    expect(createPost()?.body).toMatchObject({ name: '新库', slug: 'new-base' });
  });

  it('requires an explicit choice when several embedding profiles are available', async () => {
    listHandlers([embeddingProfile, secondEmbedding]);
    detailHandlers();
    const router = await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    expect(advancedPanel()?.hasAttribute('hidden')).toBe(true);

    await fill('knowledge-name', '新库');
    await click(button('创建', creator));
    expect(createPost()).toBeUndefined();

    // 缺少必要选择时自动展开高级设置并聚焦选择框，用户无需自己找。
    await waitFor(() => advancedPanel()?.hasAttribute('hidden') === false);
    const embedding = document.getElementById('knowledge-embedding');
    expect(embedding?.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(embedding);

    await chooseOption('knowledge-embedding', 'text-embedding-3');
    await click(button('创建', creator));
    expect(createPost()?.body).toMatchObject({ embeddingProfileId: 'profile_2' });
    expect(router.state.location.pathname).toBe('/knowledge/kb_new');
  });

  it('keeps advanced settings collapsed but mounted, and submits edited values', async () => {
    listHandlers([embeddingProfile, rerankProfile]);
    detailHandlers();
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    const panel = advancedPanel();
    expect(panel).not.toBeNull();
    expect(panel?.hasAttribute('hidden')).toBe(true);

    await fill('knowledge-name', '新库');
    await click(button('高级设置', creator));
    expect(panel?.hasAttribute('hidden')).toBe(false);

    await fill('knowledge-slug', 'new-base');
    await chooseOption('knowledge-rerank', 'bge-reranker');
    await fill('knowledge-chunk-tokens', '1000');
    await fill('knowledge-chunk-overlap', '100');
    await click(document.getElementById('knowledge-wiki-auto') as HTMLElement);
    await click(button('创建', creator));

    expect(createPost()?.body).toMatchObject({
      slug: 'new-base',
      embeddingProfileId: 'profile_1',
      rerankProfileId: 'profile_rerank',
      settings: { chunkTokens: 1000, chunkOverlap: 100, wikiAutoUpdate: true },
    });
  });

  it('expands advanced settings, focuses the invalid field and keeps the draft guard', async () => {
    listHandlers([embeddingProfile]);
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    const panel = advancedPanel();
    expect(panel?.hasAttribute('hidden')).toBe(true);

    await fill('knowledge-name', '新库');
    await fill('knowledge-chunk-tokens', '100');
    await click(button('创建', creator));

    expect(createPost()).toBeUndefined();
    await waitFor(() => panel?.hasAttribute('hidden') === false);
    expect(document.activeElement).toBe(document.getElementById('knowledge-chunk-tokens'));
    expect(creator.textContent).toContain('需为 200–4000 的整数');

    await click(button('取消', creator));
    expect(dialogShown('放弃未保存的更改？')).toBe(true);
  });

  it('expands advanced settings and focuses an invalid explicit slug', async () => {
    listHandlers([embeddingProfile]);
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    const panel = advancedPanel();
    expect(panel?.hasAttribute('hidden')).toBe(true);

    await fill('knowledge-name', '新库');
    await fill('knowledge-slug', 'Bad Slug');
    await click(button('创建', creator));

    expect(createPost()).toBeUndefined();
    await waitFor(() => panel?.hasAttribute('hidden') === false);
    expect(document.activeElement).toBe(document.getElementById('knowledge-slug'));
    expect(creator.textContent).toContain('仅允许小写字母、数字、- 和 _');
  });

  it('does not offer inline profile creation without the model permission', async () => {
    server.use(
      http.get('/api/auth/me', () =>
        HttpResponse.json({
          ...allAccessMe,
          grants: allAccessMe.grants.filter(
            (grant) => grant.permissionId !== 'knowledge.models.manage',
          ),
        }),
      ),
    );
    listHandlers([]);
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    // 创建设置只需要读权限：不能为了拿可选模型去请求管理列表。
    expect(profileCalls().map((item) => item.path)).toContain(
      '/api/knowledge/model-profiles?view=selection',
    );
    expect(profileCalls().some((item) => item.path === '/api/knowledge/model-profiles')).toBe(
      false,
    );
    await waitFor(() => advancedPanel()?.hasAttribute('hidden') === false);
    expect(creator.textContent).toContain('还没有可用的 embedding 模型');
    expect(creator.textContent).toContain('管理模型端点');
    const inline = [...creator.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes('创建 embedding profile'),
    );
    expect(inline).toBeUndefined();
    expect(button('创建', creator).disabled).toBe(true);
  });

  it('keeps the inline profile path for members who can manage models', async () => {
    listHandlers([]);
    await mount('/knowledge');
    await click(button('新建知识库'));
    const creator = dialog('新建知识库');
    await waitFor(() => advancedPanel()?.hasAttribute('hidden') === false);
    expect(document.getElementById('profile-name')).not.toBeNull();
    expect(button('创建 embedding profile', creator)).toBeDefined();
  });
});
