import { act, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type EvalRun, type HealthMetrics, type Overview } from '../src/lib/api.js';
import { EvalPage } from '../src/pages/eval.js';
import { LoginPage } from '../src/pages/login.js';
import { OverviewPage } from '../src/pages/overview.js';
import { StatusPage } from '../src/pages/status.js';

const state = vi.hoisted(() => ({
  active: false,
  cursor: 0,
  values: [] as unknown[],
  pending: false,
  mutate: vi.fn(),
  overview: null as unknown,
  metrics: null as unknown,
  detail: null as unknown,
  runs: [] as unknown[],
}));

vi.mock('@/components/ui/label', () => import('../src/components/ui/label.js'));
vi.mock('@/components/ui/separator', () => import('../src/components/ui/separator.js'));

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const nativeState = react.useState(initial);
      if (!state.active) return nativeState;
      const index = state.cursor++;
      if (!(index in state.values)) {
        state.values[index] = typeof initial === 'function' ? initial() : initial;
      }
      return [
        state.values[index],
        (next: unknown) => {
          state.values[index] = typeof next === 'function' ? next(state.values[index]) : next;
        },
      ];
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params: _params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
  }) => createElement('a', { href: to, ...props }, children),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: state.pending, mutate: state.mutate }),
  useQuery: () => ({ data: state.metrics, isPending: true }),
}));
vi.mock('../src/lib/queries.js', () => ({
  queryClient: {},
  agentsQuery: {},
  serversQuery: {},
  healthMetricsQuery: {},
  healthLiveQuery: {},
  healthReadyQuery: {},
  useOverview: () => ({ data: state.overview }),
  useOverviewTimeseries: () => ({ data: [], isPending: false }),
  useRuns: () => ({ data: { items: [] } }),
  useAgents: () => ({ data: [{ id: 'agent', name: 'Expert' }], isSuccess: true }),
  useEvalCases: () => ({ data: [], isSuccess: true }),
  useEvalRuns: () => ({
    data: { pages: [{ items: state.runs, nextCursor: null }] },
    isSuccess: true,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useEvalRun: () => ({ data: state.detail }),
  useStartEvalRun: () => ({}),
  useCancelEvalRun: () => ({}),
  useImportEvalDataset: () => ({}),
  useEvalComparison: () => ({ data: null }),
  useCreateEvalCase: () => ({ isPending: state.pending, mutate: state.mutate }),
  useUpdateEvalCase: () => ({ isPending: state.pending, mutate: state.mutate }),
  useDeleteEvalCase: () => ({}),
  // 运营层组件（工作台里嵌入的待办）依赖这些 hook；返回空数据即可。
  useAttention: () => ({ data: { approvals: [], failedRuns: [], total: 0 }, isSuccess: true }),
  attentionQuery: { queryKey: ['attention'] },
}));
// Portals don't render on the server; keep the editor's actual fields and handlers.
vi.mock('../src/components/dialog-shell.js', () => ({
  DialogShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/components/ui/dialog.js', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/components/confirm-dialog.js', () => ({ ConfirmDialog: () => null }));

// Capture a page's own state and JSX, while React renders all child controls normally.
function mount(component: () => ReactNode) {
  let tree: ReactNode;
  const render = () =>
    renderToStaticMarkup(
      createElement(() => {
        state.active = true;
        state.cursor = 0;
        try {
          tree = component();
        } finally {
          state.active = false;
        }
        return tree;
      }),
    );
  return {
    render,
    find: (predicate: (element: ReactElement<Record<string, unknown>>) => boolean) => {
      const visit = (node: ReactNode): ReactElement<Record<string, unknown>> | undefined => {
        if (Array.isArray(node)) return node.map(visit).find(Boolean);
        if (!isValidElement<Record<string, unknown>>(node)) return undefined;
        if (predicate(node)) return node;
        return visit(node.props.children as ReactNode);
      };
      const found = visit(tree);
      if (!found) throw new Error('Element not found');
      return found;
    },
  };
}

function childComponent(page: () => ReactNode, name: string) {
  const mounted = mount(page);
  mounted.render();
  const child = mounted.find((el) => typeof el.type === 'function' && el.type.name === name);
  state.values = [];
  return () => (child.type as (props: unknown) => ReactNode)(child.props);
}

const metrics: HealthMetrics = {
  process: { uptimeSeconds: 20, memoryRssBytes: 1024, nodeVersion: 'v24' },
  queue: null,
  db: { total: 1, idle: 1, waiting: 0 },
  redis: { pingMs: 1 },
};
const run: EvalRun = {
  id: 'eval-1',
  agentId: 'agent',
  status: 'running',
  total: 1,
  passed: 0,
  error: null,
  createdAt: '2026-10-22T00:00:00Z',
  finishedAt: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  state.active = false;
  state.values = [];
  state.pending = false;
  state.mutate.mockReset();
  state.metrics = metrics;
  state.runs = [];
  state.overview = {
    window: { days: 7, since: '2026-01-01T00:00:00Z' },
    counts: {
      agents: 1,
      servers: 1,
      runs: 0,
      running: 0,
      failed: 0,
      tokens: 0,
      costUsd: 0,
      avgLatencyMs: null,
    },
    recent: [],
    agents: [],
  } satisfies Overview;
});

describe('login validation', () => {
  async function renderLogin() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(LoginPage));
    });
    return {
      container,
      root,
      cleanup: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  function setInput(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function submit(container: HTMLElement) {
    const form = container.querySelector('form');
    if (!form) throw new Error('Missing login form');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  }

  it('allows an empty submission so required errors can be shown', async () => {
    const page = await renderLogin();
    expect(page.container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(
      false,
    );
    expect(page.container.querySelector('#username')?.hasAttribute('required')).toBe(true);
    expect(page.container.querySelector('#password')?.hasAttribute('required')).toBe(true);
    await page.cleanup();
  });

  it.each([
    ['', '', 'username'],
    ['admin', '', 'password'],
  ])('reports missing fields and focuses %s / %s', async (username, password, first) => {
    const page = await renderLogin();
    const usernameInput = page.container.querySelector<HTMLInputElement>('#username');
    const passwordInput = page.container.querySelector<HTMLInputElement>('#password');
    if (!usernameInput || !passwordInput) throw new Error('Missing login inputs');
    await act(async () => {
      setInput(usernameInput, username);
      setInput(passwordInput, password);
    });
    await submit(page.container);
    expect(page.container.querySelector(`#${first}`)?.getAttribute('aria-invalid')).toBe('true');
    expect(page.container.querySelector(`#${first}-error`)?.textContent).toBeTruthy();
    expect(document.activeElement?.id).toBe(first);
    expect(state.mutate).not.toHaveBeenCalled();
    await page.cleanup();
  });

  it('submits valid credentials and blocks pending submission', async () => {
    const page = await renderLogin();
    const usernameInput = page.container.querySelector<HTMLInputElement>('#username');
    const passwordInput = page.container.querySelector<HTMLInputElement>('#password');
    if (!usernameInput || !passwordInput) throw new Error('Missing login inputs');
    await act(async () => {
      setInput(usernameInput, 'admin');
      setInput(passwordInput, 'secret');
    });
    await submit(page.container);
    expect(state.mutate).toHaveBeenCalledWith({ username: 'admin', password: 'secret' });

    state.pending = true;
    await act(async () => {
      page.root.render(createElement(LoginPage));
    });
    expect(page.container.querySelector<HTMLInputElement>('#username')?.disabled).toBe(true);
    expect(page.container.querySelector<HTMLInputElement>('#password')?.disabled).toBe(true);

    await submit(page.container);
    expect(state.mutate).toHaveBeenCalledOnce();
    await page.cleanup();
  });
});

describe('overview summaries', () => {
  it('does not present missing queue metrics as zero work', () => {
    const html = mount(OverviewPage).render();
    expect(html).toContain('队列指标不可用');
    expect(html).not.toContain(' 等待 / ');
  });
  it('stays quiet on the home page when the queue is healthy', () => {
    state.metrics = {
      ...metrics,
      queue: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    };
    const html = mount(OverviewPage).render();
    expect(html).not.toContain('等待 /');
    expect(html).not.toContain('队列指标不可用');
  });
  it.each([true, false])('labels enabled=%s visibly', (enabled) => {
    (state.overview as Overview).agents = [
      {
        agentId: 'a',
        name: 'LongExpertName',
        enabled,
        slug: 'a',
        createdAt: '',
        lastRunStartTime: null,
        runCount: 0,
        totalCost: 0,
        errorRate: 0,
        latencyP50: null,
        latencyP99: null,
        totalTokens: 0,
      },
    ];
    const html = mount(OverviewPage).render();
    expect(html).toContain(enabled ? '已启用' : '已停用');
  });
});

describe('evaluation states', () => {
  it.each(['running', 'failed', 'succeeded'] as const)(
    'explains empty %s results without promising stopped polling',
    (status) => {
      state.runs = [run];
      state.detail = {
        evalRun: { ...run, status, error: status === 'failed' ? 'Worker stopped' : null },
        results: [],
      };
      const page = mount(EvalPage);
      page.render();
      const table = page.find((el) => typeof el.props.renderExpanded === 'function');
      const html = renderToStaticMarkup(
        (table.props.renderExpanded as (run: EvalRun) => ReactElement)(run),
      );
      if (status === 'running') expect(html).toContain('正在逐个执行用例');
      else {
        expect(html).not.toContain('自动刷新');
        expect(html).not.toContain('排队');
        expect(html).toContain(status === 'failed' ? 'Worker stopped' : '评估已完成');
        if (status === 'failed') expect(html).toContain('重新运行评估');
      }
    },
  );
});

describe('smoke check announcements', () => {
  it('keeps the live region mounted before results arrive', () => {
    const smoke = mount(childComponent(StatusPage, 'SmokeChecklist'));
    expect(smoke.render()).toContain('aria-live="polite"');
  });
  it('renders readable success and failure with the actual probe outcomes', async () => {
    vi.spyOn(api, 'healthLive').mockResolvedValue({
      reachable: true,
      httpStatus: 200,
      body: { status: 'ok' },
      error: null,
    });
    vi.spyOn(api, 'healthReady').mockRejectedValue(new Error('Offline'));
    vi.spyOn(api, 'healthMetrics').mockResolvedValue(null);
    const smoke = mount(childComponent(StatusPage, 'SmokeChecklist'));
    smoke.render();
    const button = smoke.find((el) => typeof el.props.actions === 'object').props
      .actions as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    await vi.waitFor(() => expect(state.values[1]).toBe(false));
    const html = smoke.render();
    expect(html).toContain('通过');
    expect(html).toContain('失败');
    expect(html).toContain('Offline');
    expect(html).toContain('aria-live="polite"');
  });
});
