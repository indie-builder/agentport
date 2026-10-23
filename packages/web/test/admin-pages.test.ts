import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
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
  useRuns: () => ({ data: { items: [] } }),
  useAgents: () => ({ data: [{ id: 'agent', name: 'Expert' }], isSuccess: true }),
  useEvalCases: () => ({ data: [], isSuccess: true }),
  useEvalRuns: () => ({ data: state.runs, isSuccess: true }),
  useEvalRun: () => ({ data: state.detail }),
  useStartEvalRun: () => ({}),
  useCreateEvalCase: () => ({ isPending: state.pending, mutate: state.mutate }),
  useUpdateEvalCase: () => ({ isPending: state.pending, mutate: state.mutate }),
  useDeleteEvalCase: () => ({}),
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
    counts: { agents: 1, servers: 1, runs: 0, running: 0 },
    recent: [],
    agents: [],
  } satisfies Overview;
});

describe('login validation', () => {
  it('allows an empty submission so required errors can be shown', () => {
    const html = mount(LoginPage).render();
    expect(html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]).not.toMatch(/\sdisabled=""/);
    expect(html).toMatch(/<input\b[^>]*id="username"[^>]*required/);
    expect(html).toMatch(/<input\b[^>]*id="password"[^>]*required/);
  });

  it.each([
    ['', '', 'username'],
    ['admin', '', 'password'],
  ])('reports missing fields and focuses %s / %s', (username, password, first) => {
    state.values = [username, password];
    const page = mount(LoginPage);
    page.render();
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    const form = page.find((el) => el.type === 'form');
    (form.props.onSubmit as (event: unknown) => void)({
      preventDefault() {},
      currentTarget: { querySelector },
    });
    const html = page.render();
    expect(html).toMatch(
      /id="password"[^>]*aria-invalid="true"[^>]*aria-describedby="password-error"/,
    );
    expect(html).toContain('id="password-error"');
    if (!username) expect(html).toContain('id="username-error"');
    expect(querySelector).toHaveBeenCalledWith(`#${first}`);
    expect(focus).toHaveBeenCalledOnce();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('submits valid credentials and blocks pending submission', () => {
    state.values = ['admin', 'secret'];
    const page = mount(LoginPage);
    page.render();
    const submit = () =>
      (page.find((el) => el.type === 'form').props.onSubmit as (event: unknown) => void)({
        preventDefault() {},
      });
    submit();
    expect(state.mutate).toHaveBeenCalledOnce();
    state.pending = true;
    const html = page.render();
    submit();
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(html.match(/<input\b[^>]*disabled=""/g)).toHaveLength(2);
  });
});

describe('overview summaries', () => {
  it('does not present missing queue metrics as zero work', () => {
    const html = mount(OverviewPage).render();
    expect(html).toContain('队列指标不可用');
    expect(html).not.toContain(' 等待 / ');
  });
  it('preserves a real zero queue count', () => {
    state.metrics = {
      ...metrics,
      queue: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    };
    const html = mount(OverviewPage).render();
    expect(html).toContain(' 等待 / 0 运行');
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
