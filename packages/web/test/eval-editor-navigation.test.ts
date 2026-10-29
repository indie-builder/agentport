import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserHistory, createRoute, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type EvalCase } from '../src/lib/api.js';
import { EvalPage } from '../src/pages/eval.js';
import { evalSearchSchema } from '../src/routes/-search.js';
import { captureBlockedNavigations, routerFor, settled } from './navigation-blocker.js';

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

const testCase: EvalCase = {
  id: 'case-a',
  agentId: 'agent-a',
  name: 'Case A',
  prompt: 'Prompt',
  expectation: '',
  createdAt: '2026-10-28T00:00:00Z',
};

let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let history: ReturnType<typeof createBrowserHistory>;
let router: ReturnType<typeof routerFor>;
let blocked: Array<Promise<boolean>>;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function waitFor(assert: () => void) {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) throw new Error(`Missing input: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  const form = document.querySelector('form');
  if (!form) throw new Error('Missing form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function mount() {
  vi.spyOn(api, 'evalCases').mockResolvedValue([testCase]);
  vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [], nextCursor: null });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  client.setQueryData(['agents'], [{ id: 'agent-a', name: 'Expert A' }]);
  window.history.replaceState(null, '', '/eval/other');
  history = createBrowserHistory();
  blocked = captureBlockedNavigations(history);
  history.push('/eval?agent=agent-a');
  await new Promise((resolve) => setTimeout(resolve, 0));
  router = routerFor(history, (shell) => [
    createRoute({
      getParentRoute: () => shell,
      path: '/eval',
      validateSearch: evalSearchSchema,
      component: EvalPage,
    }),
    createRoute({
      getParentRoute: () => shell,
      path: '/eval/other',
      component: () => createElement('p', null, '其他页面'),
    }),
  ]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await waitFor(() => expect(document.body.textContent).toContain('Case A'));
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  history?.destroy();
  host?.remove();
  vi.restoreAllMocks();
});

describe('eval case editor blocked navigation', () => {
  it('settles a POP blocked during save before the successful save closes the dialog', async () => {
    let finishSave!: () => void;
    const update = vi.spyOn(api, 'updateEvalCase').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ ...testCase, name: 'Case B' });
        }),
    );
    await mount();

    await click(button('编辑 Case A'));
    expect(document.body.textContent).toContain('编辑用例');
    fill('eval-name', 'Case B');
    await submit();
    expect(update).toHaveBeenCalledOnce();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await flush();
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    const pending = blocked.at(-1);
    expect(pending).toBeDefined();

    await act(async () => finishSave());
    await flush();

    expect(await settled(pending as Promise<boolean>)).toBe(true);
    expect(document.body.textContent).not.toContain('编辑用例');
    expect(document.body.textContent).not.toContain('放弃未保存的更改？');
    expect(history.location.pathname).toBe('/eval');

    await act(async () => {
      await router.navigate({ to: '/eval/other' });
    });
    expect(document.body.textContent).toContain('其他页面');
  });
});
