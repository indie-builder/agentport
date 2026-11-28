import type { AuthMe, MarketSkill, SkillWithAgentCount } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserHistory, createRoute, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { SkillsPage } from '../src/pages/skills.js';
import { skillsSearchSchema } from '../src/routes/-search.js';
import { allAccessMe } from './me-fixture.js';
import { routerFor } from './navigation-blocker.js';

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const demoSkill: SkillWithAgentCount = {
  id: 'skill',
  slug: 'demo',
  name: 'Demo',
  description: '演示技能',
  body: '# 步骤',
  sourceId: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  agentCount: 0,
  status: 'published',
  submittedAt: null,
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: null,
};

function marketItem(id: string, name = 'PDF'): MarketSkill {
  return {
    id,
    source: id.split('/').slice(0, 2).join('/'),
    slug: name.toLowerCase(),
    name,
    installs: 10,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

let client: QueryClient;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let history: ReturnType<typeof createBrowserHistory> | undefined;
let router: ReturnType<typeof routerFor> | undefined;

function flush(ms = 10) {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor<T>(probe: () => T, tries = 60): Promise<T> {
  for (let index = 0; index < tries; index += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {}
    await flush();
  }
  return probe();
}

async function mount(url = '/skills', me: AuthMe = allAccessMe) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  client.setQueryData(['me'], me);
  window.history.replaceState(null, '', url);
  history = createBrowserHistory();
  router = routerFor(history, (shell) => [
    createRoute({
      getParentRoute: () => shell,
      path: '/skills',
      validateSearch: skillsSearchSchema,
      component: SkillsPage,
    }),
  ]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router?.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function byLabel(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Missing button labelled: ${label}`);
  return found;
}

function installButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter((item) =>
    item.getAttribute('aria-label')?.includes('安装'),
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function typeSearch(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索技能"]');
  if (!input) throw new Error('Missing search input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
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
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'skills').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'marketSkills').mockResolvedValue([]);
  vi.spyOn(api, 'installMarketSkill');
});

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  history?.destroy();
  host?.remove();
  root = undefined;
  host = undefined;
  history = undefined;
  router = undefined;
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('internal skill library empty state', () => {
  it('points to the market instead of restating that the list is empty', async () => {
    const meWithoutCreate: AuthMe = {
      ...allAccessMe,
      grants: allAccessMe.grants.filter((grant) => grant.permissionId !== 'skills.create'),
    };
    await mount('/skills', meWithoutCreate);
    await waitFor(() => document.body.textContent?.includes('为专家装配可复用技能'));

    expect(document.body.textContent).not.toContain('暂无');
    await click(button('浏览技能市场'));

    await waitFor(
      () => (router?.state.location.search as { scope?: string } | undefined)?.scope === 'market',
    );
    expect((router?.state.location.search as { scope?: string } | undefined)?.scope).toBe('market');
  });

  it('keeps the clear-filters note when only the filter result is empty', async () => {
    vi.mocked(api.skills).mockResolvedValue({ items: [demoSkill], nextCursor: null });
    await mount('/skills?q=nomatch&usage=bound');
    await waitFor(() => document.body.textContent?.includes('没有匹配的技能'));

    expect(document.body.textContent).not.toContain('为专家装配可复用技能');
    expect(document.body.textContent).toContain('没有匹配的技能');
  });
});

describe('shared resource search', () => {
  it('writes typing to the URL with replace so search does not stack history', async () => {
    await mount('/skills');
    const replaceSpy = vi.spyOn(history!, 'replace');
    const pushSpy = vi.spyOn(history!, 'push');

    await typeSearch('pdf');

    await waitFor(() => (router?.state.location.search as { q?: string } | undefined)?.q === 'pdf');
    expect((router?.state.location.search as { q?: string } | undefined)?.q).toBe('pdf');
    expect(replaceSpy).toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe('market readiness', () => {
  it('does not render cards or install actions while installed skills are pending', async () => {
    const pendingSkills = deferred<{ items: SkillWithAgentCount[]; nextCursor: string | null }>();
    vi.mocked(api.skills).mockReturnValue(pendingSkills.promise);
    vi.mocked(api.marketSkills).mockResolvedValue([marketItem('owner/repo/pdf')]);

    await mount('/skills?scope=market');

    expect(document.querySelector('[aria-label="加载中"]')).not.toBeNull();
    expect(installButtons()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('市场榜单暂时为空');
  });

  it('retries the installed-skills query on error and stays without install actions', async () => {
    vi.mocked(api.skills)
      .mockRejectedValueOnce(new Error('Skills unavailable'))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    vi.mocked(api.marketSkills).mockResolvedValue([marketItem('owner/repo/pdf')]);

    await mount('/skills?scope=market');
    await waitFor(() => document.body.textContent?.includes('Skills unavailable'));

    expect(installButtons()).toHaveLength(0);
    await click(button('重试'));

    await waitFor(() => installButtons().length === 1);
    expect(api.skills).toHaveBeenCalledTimes(2);
  });

  it('replaces the stale list with loading while the search term is debouncing', async () => {
    vi.mocked(api.marketSkills).mockResolvedValue([marketItem('owner/repo/pdf')]);

    await mount('/skills?scope=market');
    await waitFor(() => installButtons().length === 1);

    await typeSearch('react');

    expect(document.querySelector('[aria-label="加载中"]')).not.toBeNull();
    expect(installButtons()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('技能市场未找到');
  });

  it('marks only the installing card as pending and blocks the rest', async () => {
    const installing = deferred<{ skill: SkillWithAgentCount; warnings: string[] }>();
    vi.mocked(api.marketSkills).mockResolvedValue([
      marketItem('owner/repo/pdf', 'PDF'),
      marketItem('owner/repo/csv', 'CSV'),
    ]);
    vi.mocked(api.installMarketSkill).mockReturnValue(installing.promise);

    await mount('/skills?scope=market');
    const pdfButton = await waitFor(() => byLabel('安装 PDF'));

    await click(pdfButton);

    const activeButton = byLabel('安装 PDF');
    const otherButton = byLabel('安装 CSV');
    expect(activeButton.disabled).toBe(true);
    expect(activeButton.getAttribute('aria-busy')).toBe('true');
    expect(activeButton.textContent?.trim()).toBe('安装中…');
    expect(otherButton.disabled).toBe(true);
    expect(otherButton.getAttribute('aria-busy')).toBe('false');

    await act(async () => {
      installing.resolve({
        skill: { ...demoSkill, sourceId: 'owner/repo/pdf', name: 'PDF' },
        warnings: [],
      });
    });
    await flush();
  });

  it('treats an installed skill as done from the real installed set', async () => {
    vi.mocked(api.skills).mockResolvedValue({
      items: [{ ...demoSkill, sourceId: 'owner/repo/pdf', name: 'PDF' }],
      nextCursor: null,
    });
    vi.mocked(api.marketSkills).mockResolvedValue([marketItem('owner/repo/pdf', 'PDF')]);

    await mount('/skills?scope=market');
    const doneButton = await waitFor(() => byLabel('PDF 已安装'));

    expect(doneButton.disabled).toBe(true);
    expect(doneButton.textContent?.trim()).toBe('已安装');
  });

  it('installs the exact market item behind the clicked action', async () => {
    vi.mocked(api.marketSkills).mockResolvedValue([
      marketItem('owner/repo/pdf', 'PDF'),
      marketItem('owner/repo/csv', 'CSV'),
    ]);
    vi.mocked(api.installMarketSkill).mockResolvedValue({
      skill: { ...demoSkill, sourceId: 'owner/repo/pdf', name: 'PDF' },
      warnings: [],
    });

    await mount('/skills?scope=market');
    await click(await waitFor(() => byLabel('安装 PDF')));

    expect(api.installMarketSkill).toHaveBeenCalledWith({ id: 'owner/repo/pdf' });
  });

  it('offers a refresh action when the empty ranking is not a failed search', async () => {
    vi.mocked(api.marketSkills).mockResolvedValue([]);

    await mount('/skills?scope=market');
    await waitFor(() => document.body.textContent?.includes('市场榜单暂时为空'));

    await click(button('刷新榜单'));

    expect(api.marketSkills).toHaveBeenCalledTimes(2);
  });
});
