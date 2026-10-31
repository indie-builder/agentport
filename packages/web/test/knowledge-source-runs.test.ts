import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { KnowledgeDetailPage } from '../src/pages/knowledge-detail.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const now = '2026-01-02T00:00:00Z';

const base = {
  id: 'kb_1',
  slug: 'handbook',
  name: '产品手册',
  description: '',
  serverId: 'srv_1',
  status: 'active',
  embeddingProfileId: 'profile_1',
  rerankProfileId: null,
  settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  createdAt: now,
  updatedAt: now,
};

function source(id: string, name: string) {
  return {
    id,
    baseId: 'kb_1',
    type: 'gitlab',
    name,
    config: { baseUrl: 'https://gitlab.example.com', projectId: id, ref: 'main' },
    hasSecret: true,
    status: 'active',
    syncCron: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ranges: [
      {
        id: `${id}_range`,
        kind: 'gitlab_project',
        externalId: id,
        ref: 'main',
        paths: ['docs'],
        enabled: true,
      },
    ],
  };
}

function run(id: string, sourceId: string, created: number) {
  return {
    id,
    sourceId,
    status: 'succeeded',
    startedAt: now,
    endedAt: now,
    cursorBefore: null,
    cursorAfter: null,
    stats: { listed: created, created, updated: 0, disabled: 0, failed: 0 },
    error: null,
    createdAt: now,
  };
}

const sourceA = source('ksrc_a', '来源 A');
const sourceB = source('ksrc_b', '来源 B');

const state = {
  calls: [] as Array<{ method: string; path: string }>,
  handlers: {} as Record<string, () => unknown>,
};

function handler(method: string, path: string, body: unknown) {
  state.handlers[`${method} ${path}`] = () => body;
}

function runCalls() {
  return state.calls.filter((call) => call.path.endsWith('/runs')).map((call) => call.path);
}

beforeEach(() => {
  state.calls.length = 0;
  state.handlers = {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    state.calls.push({ method, path });
    const found = state.handlers[`${method} ${path.split('?')[0] ?? path}`];
    return found ? Response.json(found()) : Response.json({ items: [], nextCursor: null });
  });
});

let client: QueryClient | undefined;
let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function mount() {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
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
    routeTree: rootRoute.addChildren([shell.addChildren([detail])]),
    history: createMemoryHistory({ initialEntries: ['/knowledge/kb_1?panel=sources'] }),
  });
  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
}

function button(text: string): HTMLButtonElement {
  const element = findButton(text);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

/** 查询 promise resolve 后才出现目标 DOM：按条件等待真实异步，不用固定 tick 猜时长。 */
async function waitForDom(probe: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      expect(probe()).toBe(true);
    },
    { timeout: 5_000, interval: 20 },
  );
}

function sourcePanel(name: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('li')].find((element) =>
    element.querySelector('button')?.textContent?.includes(name),
  );
  if (!item) throw new Error(`Missing source: ${name}`);
  return item;
}

type FakeAnimation = { finished: Promise<void>; done: boolean; finish: () => void };

/**
 * jsdom 不解析样式也不跑过渡：只给来源面板补 150ms 过渡和可测尺寸，把关闭窗口交给测试。
 * 每个面板共用同一个 finished Promise，完成后返回空动画，与浏览器一致；否则 Base UI
 * 在收尾阶段再次 getAnimations 时会拿到新 Promise，永远等不到卸载。
 */
function controlPanelClose() {
  const getAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const computed = window.getComputedStyle.bind(window);
  const animations = new WeakMap<Element, FakeAnimation>();
  const pending: Array<() => void> = [];

  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const result = computed(element, pseudo);
    if (element.getAttribute('data-slot') === 'collapsible-content') {
      Object.defineProperty(result, 'transitionDuration', { value: '0.15s' });
    }
    return result;
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-slot') === 'collapsible-content' ? 100 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-slot') === 'collapsible-content' ? 100 : 0;
    },
  });
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value(this: Element) {
      if (this.getAttribute('data-slot') !== 'collapsible-content') return [];
      let animation = animations.get(this);
      if (!animation) {
        let resolve!: () => void;
        const finished = new Promise<void>((next) => {
          resolve = next;
        });
        const created: FakeAnimation = {
          finished,
          done: false,
          finish: () => {
            created.done = true;
            resolve();
          },
        };
        animation = created;
        animations.set(this, created);
        pending.push(created.finish);
      }
      return animation.done
        ? []
        : [
            {
              effect: { getTiming: () => ({ duration: 150, iterations: 1 }) },
              finished: animation.finished,
              pending: false,
              playState: 'running',
            },
          ];
    },
  });

  return {
    async finish() {
      // 先让 Base UI 的 animation frame 拿到关闭动画，再结束它。
      await flush();
      await act(async () => {
        for (const finish of pending.splice(0)) finish();
      });
      await flush();
    },
    restore() {
      if (getAnimations) Object.defineProperty(Element.prototype, 'getAnimations', getAnimations);
      else Reflect.deleteProperty(Element.prototype, 'getAnimations');
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
      if (scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth);
      vi.mocked(window.getComputedStyle).mockRestore();
    },
  };
}

function baseHandlers() {
  handler('GET', '/api/knowledge/bases/kb_1', base);
  handler('GET', '/api/knowledge/bases/kb_1/sources', {
    items: [sourceA, sourceB],
    nextCursor: null,
  });
  handler('GET', '/api/knowledge/bases/kb_1/folders', []);
  handler('GET', '/api/knowledge/bases/kb_1/tags', []);
  handler('GET', '/api/knowledge/jobs', { items: [], nextCursor: null });
  handler('GET', '/api/knowledge/model-profiles', []);
  handler('GET', '/api/agents', []);
  handler('GET', '/api/knowledge/sources/ksrc_a/runs', {
    items: [run('krun_a', 'ksrc_a', 7)],
    nextCursor: null,
  });
  handler('GET', '/api/knowledge/sources/ksrc_b/runs', {
    items: [run('krun_b', 'ksrc_b', 9)],
    nextCursor: null,
  });
}

describe('knowledge source runs', () => {
  it('queries only the source whose panel is mounted and keeps each source own records while A exits', async () => {
    baseHandlers();
    const close = controlPanelClose();

    try {
      await mount();
      expect(runCalls()).toEqual([]);

      await waitForDom(() => findButton('来源 A') !== undefined);
      await click(button('来源 A'));
      await waitForDom(
        () => sourcePanel('来源 A').textContent?.includes('新增 7') === true,
      );
      expect(runCalls()).toEqual(['/api/knowledge/sources/ksrc_a/runs']);
      expect(sourcePanel('来源 A').textContent).toContain('新增 7');

      await click(button('来源 B'));
      await waitForDom(
        () => sourcePanel('来源 B').textContent?.includes('新增 9') === true,
      );
      expect(runCalls()).toEqual([
        '/api/knowledge/sources/ksrc_a/runs',
        '/api/knowledge/sources/ksrc_b/runs',
      ]);
      // A 仍在收起窗口里：各自面板只显示自己的记录。
      expect(sourcePanel('来源 A').textContent).toContain('新增 7');
      expect(sourcePanel('来源 B').textContent).toContain('新增 9');
      expect(sourcePanel('来源 B').textContent).not.toContain('新增 7');

      await close.finish();
      await waitForDom(
        () =>
          document.body.textContent?.includes('新增 7') === false &&
          document.body.textContent?.includes('新增 9') === true,
      );
      expect(document.body.textContent).not.toContain('新增 7');
      expect(document.body.textContent).toContain('新增 9');
    } finally {
      close.restore();
    }
  });

  it('keeps the closing source own records until its panel exits', async () => {
    baseHandlers();
    const close = controlPanelClose();

    try {
      await mount();
      await waitForDom(() => findButton('来源 A') !== undefined);
      await click(button('来源 A'));
      await click(button('来源 A'));
      await waitForDom(
        () => sourcePanel('来源 A').textContent?.includes('新增 7') === true,
      );
      expect(sourcePanel('来源 A').textContent).toContain('新增 7');
      expect(document.body.textContent).toContain('新增 7');

      await close.finish();
      await waitForDom(() => document.body.textContent?.includes('新增 7') === false);
      expect(document.body.textContent).not.toContain('新增 7');
      expect(document.querySelectorAll('[data-slot="collapsible-content"]')).toHaveLength(0);
    } finally {
      close.restore();
    }
  });
});
