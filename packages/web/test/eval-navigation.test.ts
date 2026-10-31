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
import {
  ApiError,
  api,
  type EvalCase,
  type EvalComparison,
  type EvalResult,
  type EvalRun,
  type EvalRunDetail,
  type EvalRunPage,
} from '../src/lib/api.js';
import { shortId } from '../src/lib/format.js';
import { EvalPage } from '../src/pages/eval.js';
import { evalSearchSchema } from '../src/routes/-search.js';

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

function makeRun(id: string, overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id,
    agentId: 'agent-a',
    status: 'succeeded',
    total: 3,
    passed: 2,
    error: null,
    createdAt: '2026-10-22T00:00:00Z',
    finishedAt: '2026-10-22T00:01:00Z',
    ...overrides,
  };
}

function makeResult(name: string, output = 'output'): EvalResult {
  return {
    caseId: `case-${name}`,
    name,
    prompt: 'Prompt',
    expectation: '',
    passed: true,
    output,
    runId: null,
  };
}

function makeDetail(run: EvalRun, results: EvalResult[]): EvalRunDetail {
  return { evalRun: run, results };
}

type RunsQuery = { agentId?: string; cursor?: string; limit?: number };

type MountOptions = {
  url?: string;
  runs?: EvalRunPage | ((query: RunsQuery) => Promise<EvalRunPage>);
  openDialog?: boolean;
};

async function mount(editing = false, options: MountOptions = {}) {
  vi.spyOn(api, 'evalCases').mockResolvedValue(editing ? [testCase] : []);
  const evalRuns = vi.spyOn(api, 'evalRuns');
  if (typeof options.runs === 'function') {
    evalRuns.mockImplementation(
      (query) => options.runs?.(query ?? {}) ?? Promise.resolve({ items: [], nextCursor: null }),
    );
  } else {
    evalRuns.mockResolvedValue(options.runs ?? { items: [], nextCursor: null });
  }
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  for (const agent of ['agent-a', 'agent-b']) {
    client.setQueryData(['eval-cases', agent], editing ? [testCase] : []);
  }
  client.setQueryData(
    ['agents'],
    [
      { id: 'agent-a', name: 'Expert A' },
      { id: 'agent-b', name: 'Expert B' },
    ],
  );
  for (const agentId of ['agent-a', 'agent-b']) {
    client.setQueryData(['agent-access', agentId], {
      agentId,
      permissionIds: ['eval.read', 'eval.manage', 'eval.execute'],
    });
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const evalRoute = createRoute({
    getParentRoute: () => shell,
    path: '/eval',
    validateSearch: evalSearchSchema,
    component: EvalPage,
  });
  const away = createRoute({
    getParentRoute: () => shell,
    path: '/away',
    component: () => createElement('h1', null, 'Destination'),
  });
  window.history.replaceState(null, '', options.url ?? '/eval?agent=agent-a');
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
  if (options.openDialog !== false) {
    await click(editing ? '编辑 Original case' : '新建用例');
  }
  return router;
}

function runTrigger(id: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button[data-row]')].find((element) =>
    element.getAttribute('aria-label')?.includes(shortId(id)),
  );
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

async function actWaitFor(assert: () => void) {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

async function chooseOption(triggerLabel: string, optionText: string) {
  const trigger = document.querySelector<HTMLElement>(`[aria-label="${triggerLabel}"]`);
  if (!trigger) throw new Error(`Missing select: ${triggerLabel}`);
  await act(async () => trigger.click());
  await actWaitFor(() =>
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((option) =>
        option.textContent?.includes(optionText),
      ),
    ).toBe(true),
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes(optionText),
  );
  if (!option) throw new Error(`Missing option: ${optionText}`);
  await act(async () => option.click());
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
        navigation = router.navigate({ to: '/away' });
      });
      expect(document.body.textContent).toContain('放弃未保存的更改？');
      expect(router.state.location.pathname).toBe('/eval');
      await click('取消');
      expect(router.state.location.pathname).toBe('/eval');
      expect((document.getElementById('eval-name') as HTMLInputElement).value).toBe(
        'Unsaved draft',
      );
      await act(async () => {
        navigation = router.navigate({ to: '/away' });
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
      await router.navigate({ to: '/away' });
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
      void router.navigate({ to: '/away' });
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
          new Promise((resolve) => {
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

describe('evaluation run URL state', () => {
  const newestRun = makeRun('evalRun_newest01', { createdAt: '2026-10-22T00:00:03Z' });
  const olderRun = makeRun('evalRun_older001', { createdAt: '2026-10-22T00:00:02Z' });
  const oldestRun = makeRun('evalRun_oldest01', { createdAt: '2026-10-22T00:00:01Z' });

  function comparison(base: EvalRun, head: EvalRun): EvalComparison {
    return { baseRun: base, headRun: head, rows: [] };
  }

  it('opens a deep-linked run outside the loaded history page without paging through history', async () => {
    const deepRun = makeRun('evalRun_deep0001', { passed: 1 });
    const evalRun = vi
      .spyOn(api, 'evalRun')
      .mockResolvedValue(makeDetail(deepRun, [makeResult('Deep result'), makeResult('Second')]));

    await mount(false, {
      url: '/eval?agent=agent-a&run=evalRun_deep0001',
      runs: { items: [newestRun], nextCursor: newestRun.id },
      openDialog: false,
    });

    await actWaitFor(() => expect(container.textContent).toContain('Deep result'));
    expect(evalRun).toHaveBeenCalledWith('evalRun_deep0001');
    const evalRuns = vi.mocked(api.evalRuns);
    expect(evalRuns).toHaveBeenCalledTimes(1);
    expect(evalRuns).toHaveBeenCalledWith(
      { agentId: 'agent-a', limit: 50 },
      expect.any(AbortSignal),
    );
    const summary = container.querySelector('[data-slot="eval-run-summary"]')?.textContent ?? '';
    expect(summary).toContain('已记录 2 / 3');
    expect(summary).toContain('无记录 1');
    expect(summary).toContain('通过 1');
  });

  it('selects a history run through the URL and restores it after back navigation', async () => {
    const run = makeRun('evalRun_newest01', { passed: 1, total: 2 });
    vi.spyOn(api, 'evalRun').mockResolvedValue(makeDetail(run, [makeResult('History result')]));
    const router = await mount(false, {
      runs: { items: [run], nextCursor: null },
      openDialog: false,
    });

    await actWaitFor(() => expect(runTrigger(run.id)).not.toBeUndefined());
    await act(async () => runTrigger(run.id)?.click());
    await actWaitFor(() => expect(router.state.location.search.run).toBe(run.id));
    await actWaitFor(() => expect(container.textContent).toContain('History result'));

    await act(async () => {
      await router.navigate({ to: '/away' });
    });
    expect(container.textContent).toBe('Destination');

    await act(async () => {
      router.history.back();
    });
    await actWaitFor(() => expect(router.state.location.pathname).toBe('/eval'));
    await actWaitFor(() => expect(router.state.location.search.run).toBe(run.id));
    await actWaitFor(() => expect(container.textContent).toContain('History result'));

    await click('返回历史');
    await actWaitFor(() => expect(router.state.location.search.run).toBeUndefined());
    expect(container.textContent).not.toContain('History result');
  });

  it('returns to history in place after opening a run, without leaving the page', async () => {
    const run = makeRun('evalRun_newest01', { passed: 1, total: 2 });
    vi.spyOn(api, 'evalRun').mockResolvedValue(makeDetail(run, [makeResult('History result')]));
    const router = await mount(false, {
      runs: { items: [run], nextCursor: null },
      openDialog: false,
    });

    await actWaitFor(() => expect(runTrigger(run.id)).not.toBeUndefined());
    await act(async () => runTrigger(run.id)?.click());
    await actWaitFor(() => expect(router.state.location.search.run).toBe(run.id));
    await actWaitFor(() => expect(container.textContent).toContain('History result'));

    await click('返回历史');
    await actWaitFor(() => expect(router.state.location.search.run).toBeUndefined());
    expect(router.state.location.pathname).toBe('/eval');
    expect(container.textContent).toContain('通过 / 总数');
    // 行内展开已移除：清掉 URL 后旧结果不应从表格里重新冒出来。
    expect(container.textContent).not.toContain('History result');
  });

  it('clears the selected run when the expert filter changes', async () => {
    const run = makeRun('evalRun_newest01');
    vi.spyOn(api, 'evalRun').mockResolvedValue(makeDetail(run, [makeResult('Selected result')]));
    const router = await mount(false, {
      url: '/eval?agent=agent-a&run=evalRun_newest01',
      runs: (query) =>
        Promise.resolve(
          query.agentId === 'agent-b'
            ? { items: [], nextCursor: null }
            : { items: [run], nextCursor: null },
        ),
      openDialog: false,
    });
    await actWaitFor(() => expect(container.textContent).toContain('Selected result'));

    await chooseOption('按专家筛选', 'Expert B');
    await actWaitFor(() => expect(router.state.location.search.agent).toBe('agent-b'));
    const search = router.state.location.search as Record<string, unknown>;
    expect(search.run).toBeUndefined();
    expect(search.base).toBeUndefined();
    expect(search.head).toBeUndefined();
    expect(container.textContent).not.toContain('Selected result');
  });

  it('writes comparison open, change and close to the URL', async () => {
    const compare = vi
      .spyOn(api, 'compareEvalRuns')
      .mockImplementation(async (baseId) =>
        comparison(baseId === oldestRun.id ? oldestRun : olderRun, newestRun),
      );
    const router = await mount(false, {
      runs: { items: [newestRun, olderRun, oldestRun], nextCursor: null },
      openDialog: false,
    });

    await actWaitFor(() => expect(container.textContent).toContain('oldest01'));
    await click('比较运行');
    await actWaitFor(() => expect(router.state.location.search.base).toBe(olderRun.id));
    expect(router.state.location.search.head).toBe(newestRun.id);
    expect(document.body.textContent).toContain('比较评估运行');
    expect(compare).toHaveBeenCalledWith(olderRun.id, newestRun.id);

    await chooseOption('基准运行', shortId(oldestRun.id));
    await actWaitFor(() => expect(router.state.location.search.base).toBe(oldestRun.id));
    expect(router.state.location.search.head).toBe(newestRun.id);
    await actWaitFor(() => expect(compare).toHaveBeenCalledWith(oldestRun.id, newestRun.id));

    await click('关闭');
    await actWaitFor(() => expect(router.state.location.search.base).toBeUndefined());
    expect(router.state.location.search.head).toBeUndefined();
    expect(document.body.textContent).not.toContain('比较评估运行');
  });

  it('opens a deep-linked comparison outside the loaded history page', async () => {
    const base = makeRun('evalRun_outbase1');
    const head = makeRun('evalRun_outhead1');
    const compare = vi.spyOn(api, 'compareEvalRuns').mockResolvedValue(comparison(base, head));

    await mount(false, {
      url: '/eval?agent=agent-a&base=evalRun_outbase1&head=evalRun_outhead1',
      runs: { items: [], nextCursor: null },
      openDialog: false,
    });

    await actWaitFor(() => expect(compare).toHaveBeenCalledWith(base.id, head.id));
    expect(document.body.textContent).toContain('比较评估运行');
  });

  it('shows an invalid run id error with a way back to history', async () => {
    vi.spyOn(api, 'evalRun').mockRejectedValue(new ApiError(404, '评估运行不存在'));
    const router = await mount(false, {
      url: '/eval?agent=agent-a&run=evalRun_missing1',
      runs: { items: [newestRun], nextCursor: null },
      openDialog: false,
    });

    await actWaitFor(() => expect(container.textContent).toContain('这次评估运行不存在'));
    expect(container.textContent).toContain('评估运行不存在');
    await click('返回历史');
    await actWaitFor(() => expect(router.state.location.search.run).toBeUndefined());
    expect(container.textContent).not.toContain('这次评估运行不存在');
    expect(container.textContent).toContain('通过 / 总数');
  });

  it('shows an invalid comparison id error and returns to history', async () => {
    vi.spyOn(api, 'compareEvalRuns').mockRejectedValue(new ApiError(404, '评估运行不存在'));
    const router = await mount(false, {
      url: '/eval?agent=agent-a&base=evalRun_missing1&head=evalRun_missing2',
      runs: { items: [], nextCursor: null },
      openDialog: false,
    });

    await actWaitFor(() => expect(document.body.textContent).toContain('评估运行不存在'));
    await click('返回历史');
    await actWaitFor(() => expect(router.state.location.search.base).toBeUndefined());
    expect(router.state.location.search.head).toBeUndefined();
    expect(document.body.textContent).not.toContain('比较评估运行');
  });
});
