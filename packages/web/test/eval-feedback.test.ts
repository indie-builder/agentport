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
  api,
  type EvalCase,
  type EvalResult,
  type EvalRun,
  type EvalRunDetail,
  type EvalRunPage,
} from '../src/lib/api.js';
import { EvalPage } from '../src/pages/eval.js';
import { evalSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let history: ReturnType<typeof createBrowserHistory>;

const LARGE = 'x'.repeat(64 * 1024 + 1);

const runningRun: EvalRun = {
  id: 'evalRun_running',
  agentId: 'agent-a',
  status: 'running',
  total: 2,
  passed: 1,
  error: null,
  createdAt: '2026-10-28T00:00:00Z',
  finishedAt: null,
};

const finishedRun: EvalRun = {
  ...runningRun,
  status: 'succeeded',
  finishedAt: '2026-10-28T00:01:00Z',
};

const testCase: EvalCase = {
  id: 'case-a',
  agentId: 'agent-a',
  name: 'Case A',
  prompt: 'Prompt',
  expectation: '',
  createdAt: '2026-10-28T00:00:00Z',
};

function result(name: string, output: string): EvalResult {
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

function detail(status: EvalRun['status'], results: EvalResult[]): EvalRunDetail {
  return {
    evalRun: {
      ...runningRun,
      status,
      finishedAt: status === 'running' ? null : finishedRun.finishedAt,
    },
    results,
  };
}

async function mount() {
  vi.spyOn(api, 'evalCases').mockResolvedValue([testCase]);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  client.setQueryData(['agents'], [{ id: 'agent-a', name: 'Expert A' }]);
  client.setQueryData(['agent-access', 'agent-a'], {
    agentId: 'agent-a',
    permissionIds: ['eval.read', 'eval.manage', 'eval.execute'],
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const evalRoute = createRoute({
    getParentRoute: () => shell,
    path: '/eval',
    validateSearch: evalSearchSchema,
    component: EvalPage,
  });
  window.history.replaceState(null, '', '/eval?agent=agent-a');
  history = createBrowserHistory();
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([evalRoute])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await actWaitFor(() => expect(container.textContent).toContain('1 / 2'));
}

async function actWaitFor(assert: () => void) {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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

async function openRun(id: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="打开 ${id}"]`);
  if (!trigger) throw new Error(`Missing run: ${id}`);
  await act(async () => trigger.click());
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

describe('evaluation run detail refresh feedback', () => {
  it('keeps already loaded results and expanded output across a failed refresh, then retries into the terminal state', async () => {
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [runningRun], nextCursor: null });
    let resolveInitial!: (value: EvalRunDetail) => void;
    let resolveRetry!: (value: EvalRunDetail) => void;
    vi.spyOn(api, 'evalRun')
      .mockImplementationOnce(
        () =>
          new Promise<EvalRunDetail>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementationOnce(
        () =>
          new Promise<EvalRunDetail>((resolve) => {
            resolveRetry = resolve;
          }),
      );

    await mount();
    await openRun(runningRun.id);
    expect(container.querySelector('[aria-label="加载中"]')).not.toBeNull();

    await act(async () => resolveInitial(detail('running', [result('Result One', LARGE)])));
    await actWaitFor(() => expect(container.textContent).toContain('Result One'));
    const summary = (): string =>
      container.querySelector('[data-slot="eval-run-summary"]')?.textContent ?? '';
    expect(summary()).toContain('运行中');
    expect(summary()).toContain('已记录 1 / 2');
    expect(summary()).toContain('无记录 1');
    expect(summary()).toContain('通过 1');
    expect(container.textContent).toContain('当前用例可能继续执行；停止后不再开始后续用例。');
    await click('内容过大，点击查看');
    expect(button('收起内容')).not.toBeUndefined();
    expect((container.querySelector('pre')?.textContent ?? '').length).toBeGreaterThan(64 * 1024);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['eval-run', runningRun.id] });
    });
    await actWaitFor(() => expect(container.textContent).toContain('刷新失败，内容仍是上次结果'));
    expect(container.textContent).toContain('network down');
    expect(container.textContent).toContain('Result One');
    expect(button('收起内容')).not.toBeUndefined();
    expect(button('重试')).not.toBeUndefined();
    expect(button('导出结果').disabled).toBe(true);

    await click('重试');
    // 重试进行中：旧结果与提示都还在，不提前清空。
    expect(container.textContent).toContain('刷新失败，内容仍是上次结果');
    expect(container.textContent).toContain('Result One');
    expect((container.querySelector('pre')?.textContent ?? '').length).toBeGreaterThan(64 * 1024);

    await act(async () =>
      resolveRetry(
        detail('succeeded', [result('Result One', LARGE), result('Result Two', '新输出')]),
      ),
    );
    await flush();

    await actWaitFor(() => expect(container.textContent).toContain('新输出'));
    expect(container.textContent).not.toContain('刷新失败，内容仍是上次结果');
    expect(button('导出结果').disabled).toBe(false);
    expect(button('收起内容')).not.toBeUndefined();
    expect(summary()).toContain('全部通过');
    expect(summary()).toContain('已记录 2 / 2');
    expect(summary()).toContain('无记录 0');
    expect(summary()).toContain('通过 1');
  });

  it('shows the full error state and retries when no detail data was ever loaded', async () => {
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [runningRun], nextCursor: null });
    let failing = true;
    vi.spyOn(api, 'evalRun').mockImplementation(async () => {
      if (failing) throw new Error('cannot load');
      return detail('succeeded', [result('Result One', '恢复输出')]);
    });

    await mount();
    await openRun(runningRun.id);
    await actWaitFor(() => expect(container.textContent).toContain('cannot load'));
    expect(container.textContent).toContain('内容没有加载出来');
    expect(container.textContent).not.toContain('刷新失败，内容仍是上次结果');

    failing = false;
    await click('重试');
    await actWaitFor(() => expect(container.textContent).toContain('恢复输出'));
    expect(container.textContent).not.toContain('内容没有加载出来');
  });

  it('keeps the empty-result explanation when a finished run has no results', async () => {
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [runningRun], nextCursor: null });
    vi.spyOn(api, 'evalRun').mockResolvedValue(detail('succeeded', []));

    await mount();
    await openRun(runningRun.id);
    await actWaitFor(() => expect(container.textContent).toContain('评估已完成，没有结果记录'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps partial results and says later cases stopped when a batch is cancelled', async () => {
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [runningRun], nextCursor: null });
    vi.spyOn(api, 'evalRun').mockResolvedValue(detail('cancelled', [result('First Case', '完成')]));

    await mount();
    await openRun(runningRun.id);
    await actWaitFor(() => expect(container.textContent).toContain('已停止后续用例'));
    const summary = container.querySelector('[data-slot="eval-run-summary"]')?.textContent ?? '';
    expect(summary).toContain('已取消');
    expect(summary).toContain('已记录 1 / 2');
    expect(summary).toContain('无记录 1');
    expect(container.textContent).toContain('First Case');
    expect(container.textContent).toContain('后续用例不会再开始');
    expect(container.textContent).toContain('有 1 条用例没有结果记录，当前用例可能仍在执行');
  });

  it('keeps the failure reason and results while showing the batch counts', async () => {
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [runningRun], nextCursor: null });
    vi.spyOn(api, 'evalRun').mockResolvedValue({
      evalRun: {
        ...runningRun,
        status: 'failed',
        error: 'worker crashed',
        finishedAt: finishedRun.finishedAt,
      },
      results: [result('Surviving Case', '保留输出')],
    });

    await mount();
    await openRun(runningRun.id);
    await actWaitFor(() => expect(container.textContent).toContain('worker crashed'));
    const summary = container.querySelector('[data-slot="eval-run-summary"]')?.textContent ?? '';
    expect(summary).toContain('有失败');
    expect(summary).toContain('已记录 1 / 2');
    expect(summary).toContain('无记录 1');
    expect(container.textContent).toContain('评估失败');
    expect(container.textContent).toContain('Surviving Case');
    expect(container.textContent).toContain('保留输出');
  });
});

describe('evaluation start blocked by a running batch', () => {
  it('disables start with a visible reason and does not post a new run', async () => {
    const start = vi.spyOn(api, 'startEvalRun');
    vi.spyOn(api, 'evalRuns').mockResolvedValue({ items: [runningRun], nextCursor: null });

    await mount();
    await actWaitFor(() =>
      expect(container.textContent).toContain('已有评估正在运行，请等待结束或先停止'),
    );
    expect(button('运行评估').disabled).toBe(true);
    expect(button('运行评估').getAttribute('aria-describedby')).toBe('eval-start-reason');

    await click('运行评估');
    expect(start).not.toHaveBeenCalled();
  });

  it('stays blocked while cancel is pending or fails, and re-enables only after the list reports a terminal run', async () => {
    let rejectCancel!: (error: Error) => void;
    vi.spyOn(api, 'cancelEvalRun')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectCancel = reject;
          }),
      )
      .mockResolvedValue({ ok: true });
    let page: EvalRunPage = { items: [runningRun], nextCursor: null };
    vi.spyOn(api, 'evalRuns').mockImplementation(async () => page);

    await mount();
    await click('停止后续用例');
    await actWaitFor(() => expect(button('停止中…').disabled).toBe(true));
    expect(button('运行评估').disabled).toBe(true);
    expect(container.textContent).toContain('已有评估正在运行，请等待结束或先停止');

    await act(async () => rejectCancel(new Error('stop failed')));
    await flush();
    expect(button('运行评估').disabled).toBe(true);

    await click('停止后续用例');
    await flush();
    // 停止请求已成功，但列表仍报告 running：启动继续禁用。
    expect(container.textContent).toContain('运行中');
    expect(button('运行评估').disabled).toBe(true);
    expect(container.textContent).toContain('已有评估正在运行，请等待结束或先停止');

    page = { items: [finishedRun], nextCursor: null };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['eval-runs'] });
    });
    await actWaitFor(() => expect(button('运行评估').disabled).toBe(false));
    expect(container.textContent).not.toContain('已有评估正在运行，请等待结束或先停止');
  });
});
