import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type EvalCase } from '../src/lib/api.js';
import { EvalPage } from '../src/pages/eval.js';

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let history: ReturnType<typeof createBrowserHistory>;

const testCase: EvalCase = {
  id: 'case-a',
  agentId: 'agent-a',
  name: 'Original case',
  prompt: 'Original prompt',
  expectation: '',
  createdAt: '2026-10-22T00:00:00Z',
};

async function mount(editing = false) {
  vi.spyOn(api, 'evalCases').mockResolvedValue(editing ? [testCase] : []);
  vi.spyOn(api, 'evalRuns').mockResolvedValue([]);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  for (const agent of ['agent-a', 'agent-b']) {
    client.setQueryData(['eval-cases', agent], editing ? [testCase] : []);
    client.setQueryData(['eval-runs', agent], []);
  }
  client.setQueryData(
    ['agents'],
    [
      { id: 'agent-a', name: 'Expert A' },
      { id: 'agent-b', name: 'Expert B' },
    ],
  );
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: 'shell', component: Outlet });
  const evalRoute = createRoute({
    getParentRoute: () => shell,
    path: '/eval',
    validateSearch: (search: Record<string, unknown>) => ({
      agent: search.agent as string | undefined,
    }),
    component: EvalPage,
  });
  const away = createRoute({
    getParentRoute: () => shell,
    path: '/away',
    component: () => createElement('h1', null, 'Destination'),
  });
  window.history.replaceState(null, '', '/eval?agent=agent-a');
  history = createBrowserHistory();
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([evalRoute, away])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await vi.waitFor(() =>
    expect(container.textContent).toContain(editing ? 'Original case' : '还没有用例'),
  );
  await click(editing ? '编辑 Original case' : '新建用例');
  return router;
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].findLast(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    const prototype =
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function unloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client?.clear();
  history?.destroy();
  container.remove();
  vi.restoreAllMocks();
});

describe('evaluation draft navigation', () => {
  it.each([false, true])(
    'keeps a dirty draft on cancelled navigation, editing=%s',
    async (editing) => {
      const router = await mount(editing);
      expect(unloadPrevented()).toBe(false);
      await fill('eval-name', 'Unsaved draft');
      expect(unloadPrevented()).toBe(true);
      let navigation: Promise<unknown> | undefined;
      await act(async () => {
        navigation = router.navigate({ to: '/away' as never });
      });
      expect(document.body.textContent).toContain('放弃未保存的更改？');
      expect(router.state.location.pathname).toBe('/eval');
      await click('取消');
      expect(router.state.location.pathname).toBe('/eval');
      expect((document.getElementById('eval-name') as HTMLInputElement).value).toBe(
        'Unsaved draft',
      );
      await act(async () => {
        navigation = router.navigate({ to: '/away' as never });
      });
      await click('放弃并离开');
      await act(async () => {
        await navigation;
      });
      expect(container.textContent).toBe('Destination');
      expect(unloadPrevented()).toBe(false);
    },
  );

  it('allows a clean creation dialog to leave without confirmation', async () => {
    const router = await mount();
    await act(async () => {
      await router.navigate({ to: '/away' as never });
    });
    expect(container.textContent).toBe('Destination');
  });

  it('prevents leaving while a clean update is saving', async () => {
    let finish!: (value: EvalCase) => void;
    vi.spyOn(api, 'updateEvalCase').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const router = await mount(true);
    await click('保存');
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(button('保存中…').disabled).toBe(true);
    expect(unloadPrevented()).toBe(true);
    await act(async () => {
      void router.navigate({ to: '/away' as never });
    });
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    expect(button('放弃并离开').disabled).toBe(true);
    await click('放弃并离开');
    expect(router.state.location.pathname).toBe('/eval');
    await click('取消');
    expect(router.state.location.pathname).toBe('/eval');
    await act(async () => finish(testCase));
    await vi.waitFor(() => expect(document.getElementById('eval-name')).toBeNull());
    expect(unloadPrevented()).toBe(false);
  });

  it.each([false, true])(
    'locks fields and rejects repeat submissions while saving, editing=%s',
    async (editing) => {
      let finish!: (value: EvalCase) => void;
      const save = vi.spyOn(api, editing ? 'updateEvalCase' : 'createEvalCase').mockImplementation(
        () =>
          new Promise<EvalCase>((resolve) => {
            finish = resolve;
          }),
      );
      await mount(editing);
      if (!editing) {
        await fill('eval-name', 'New case');
        await fill('eval-prompt', 'New prompt');
      }
      await click('保存');
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      for (const id of ['eval-name', 'eval-prompt', 'eval-expectation']) {
        const field = document.getElementById(id) as HTMLInputElement;
        expect(field.disabled).toBe(true);
        expect(field.closest('[data-slot="field"]')?.getAttribute('data-disabled')).toBe('true');
      }
      expect(button('保存中…').disabled).toBe(true);
      expect(button('取消').disabled).toBe(true);
      await act(async () => {
        document
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => {
        finish(testCase);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(document.getElementById('eval-name')).toBeNull();
    },
  );

  it('keeps a creation draft bound to its opening expert across a URL change', async () => {
    const create = vi.spyOn(api, 'createEvalCase').mockResolvedValue(testCase);
    const router = await mount();
    await fill('eval-name', 'Draft for A');
    await fill('eval-prompt', 'Prompt for A');
    await act(async () => {
      await router.navigate({ to: '/eval', search: { agent: 'agent-b' }, ignoreBlocker: true });
    });
    expect((document.getElementById('eval-name') as HTMLInputElement).value).toBe('Draft for A');
    await click('保存');
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        agentId: 'agent-a',
        name: 'Draft for A',
        prompt: 'Prompt for A',
        expectation: '',
      }),
    );
  });
});
