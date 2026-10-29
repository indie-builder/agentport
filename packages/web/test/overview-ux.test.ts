import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type HealthMetrics, type Overview } from '../src/lib/api.js';
import {
  attentionQuery,
  healthMetricsQuery,
  overviewQuery,
  overviewTimeseriesQuery,
  useOverviewTimeseries,
} from '../src/lib/queries.js';
import { OverviewPage, RunTrendCard } from '../src/pages/overview.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => {
    const href = to.replace(/\$([A-Za-z]+)/g, (_, key: string) => params?.[key] ?? '');
    return createElement('a', { href, ...props }, children);
  },
  useNavigate: () => vi.fn(),
}));

const metrics: HealthMetrics = {
  process: { uptimeSeconds: 20, memoryRssBytes: 1024, nodeVersion: 'v24' },
  queue: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
  db: { total: 1, idle: 1, waiting: 0 },
  redis: { pingMs: 1 },
};

const points = [
  { date: '2026-10-27', runs: 3, failed: 1, costUsd: 0.1234, tokens: 1200 },
  { date: '2026-10-28', runs: 0, failed: 0, costUsd: 0, tokens: 0 },
  { date: '2026-10-29', runs: 2, failed: 0, costUsd: 0.5, tokens: 300 },
];

function overview(days = 3): Overview {
  return {
    window: { days, since: '2026-10-27T00:00:00Z' },
    counts: {
      agents: 1,
      servers: 1,
      runs: 5,
      running: 0,
      failed: 1,
      tokens: 1500,
      costUsd: 0.6234,
      avgLatencyMs: null,
    },
    recent: [],
    agents: [
      {
        agentId: 'agt_trend',
        name: '趋势专家',
        slug: 'trend',
        createdAt: '2026-10-01T00:00:00Z',
        enabled: true,
        lastRunStartTime: null,
        runCount: 5,
        totalCost: 0.6234,
        errorRate: 0.2,
        latencyP50: null,
        latencyP99: null,
        totalTokens: 1500,
      },
    ],
  };
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, gcTime: Infinity, staleTime: Infinity },
    },
  });
}

function TrendProbe() {
  useOverviewTimeseries();
  return null;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 320,
    height: 160,
    top: 0,
    left: 0,
    right: 320,
    bottom: 160,
    x: 0,
    y: 0,
    toJSON() {},
  } as DOMRect);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement, queryClient = client()): Promise<void> {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, element));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

function trigger(): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('趋势数据'),
  );
  if (!button) throw new Error('Missing trend table trigger');
  return button;
}

function cells(row: Element): (string | null)[] {
  return [...row.querySelectorAll('th, td')].map((cell) => cell.textContent);
}

describe('overview trend query window', () => {
  it('defaults to the latest 7 days for both the options and the hook', async () => {
    const spy = vi.spyOn(api, 'overviewTimeseries').mockResolvedValue([]);
    expect(overviewTimeseriesQuery().queryKey).toEqual(['overview', 'timeseries', 7]);

    await render(createElement(TrendProbe));
    expect(spy).toHaveBeenCalledWith(7);
  });
});

describe('overview trend accessibility', () => {
  it('hides the visual chart from assistive technology and exposes the same data in a keyboard-expandable table', async () => {
    vi.spyOn(api, 'overviewTimeseries').mockResolvedValue(points);
    await render(createElement(RunTrendCard, { days: 7 }));

    const chart = host.querySelector('[data-slot="chart"]');
    expect(chart).toBeTruthy();
    const hidden = chart?.closest('[aria-hidden="true"]');
    expect(hidden).toBeTruthy();
    expect(
      hidden?.querySelectorAll(
        '[tabindex]:not([tabindex="-1"]), a[href], button, input, select, textarea',
      ),
    ).toHaveLength(0);
    expect(host.querySelector('[role="application"]')).toBeNull();

    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().className).toContain('h-8');
    expect(trigger().className).toContain('text-sm');
    expect(host.querySelector('table')).toBeNull();

    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    const table = host.querySelector('table');
    expect(table?.querySelector('caption')?.textContent).toBe('最近 7 天运行趋势明细');
    expect(table?.querySelector('caption')?.className).toContain('sr-only');
    expect([...(table?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent)).toEqual([
      '日期',
      '运行',
      '失败',
      '成本',
      'Tokens',
    ]);

    const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
    expect(rows.map(cells)).toEqual([
      ['2026-10-27', '3', '1', '$0.1234', '1.2k'],
      ['2026-10-28', '0', '0', '$0', '0'],
      ['2026-10-29', '2', '0', '$0.5000', '300'],
    ]);
    expect(rows[0]?.querySelector('th')?.getAttribute('scope')).toBe('row');
    for (const numeric of rows[0]?.querySelectorAll('td') ?? []) {
      expect(numeric.className).toContain('text-right');
    }

    const scroller = table?.closest('.overflow-y-auto');
    expect(scroller?.className).toContain('max-h-');
    expect(scroller?.getAttribute('tabindex')).toBe('0');

    await click(trigger());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('table')).toBeNull();
  });

  it('uses the window supplied by the overview response and links experts to their detail route', async () => {
    vi.spyOn(api, 'overviewTimeseries').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'healthMetrics').mockResolvedValue(metrics);
    vi.spyOn(api, 'attention').mockResolvedValue({ approvals: [], failedRuns: [], total: 0 });

    const queryClient = client();
    queryClient.setQueryData(overviewQuery.queryKey, overview(3));
    queryClient.setQueryData(overviewTimeseriesQuery(3).queryKey, points);
    queryClient.setQueryData(attentionQuery.queryKey, {
      approvals: [],
      failedRuns: [],
      total: 0,
    });
    queryClient.setQueryData(healthMetricsQuery.queryKey, metrics);

    await render(createElement(OverviewPage), queryClient);

    const link = host.querySelector('a[href="/agents/agt_trend"]');
    expect(link?.textContent).toContain('趋势专家');

    await click(trigger());
    expect(host.querySelector('table caption')?.textContent).toBe('最近 3 天运行趋势明细');
  });
});

describe('overview trend states', () => {
  it('keeps an error instead of falling through to loading or empty', async () => {
    vi.spyOn(api, 'overviewTimeseries').mockRejectedValue(new Error('Offline'));
    await render(createElement(RunTrendCard, { days: 7 }));

    expect(host.querySelector('[role="alert"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="加载中"]')).toBeNull();
    expect(host.textContent).not.toContain('发起对话后生成趋势');
    expect(
      [...host.querySelectorAll('button')].some((item) => item.textContent?.includes('趋势数据')),
    ).toBe(false);
  });

  it('keeps loading until the first result arrives', async () => {
    vi.spyOn(api, 'overviewTimeseries').mockReturnValue(new Promise(() => {}));
    await render(createElement(RunTrendCard, { days: 7 }));

    expect(host.querySelector('[aria-label="加载中"]')).toBeTruthy();
    expect(host.textContent).not.toContain('发起对话后生成趋势');
    expect(
      [...host.querySelectorAll('button')].some((item) => item.textContent?.includes('趋势数据')),
    ).toBe(false);
  });

  it('shows the empty hint only when the loaded window has no runs', async () => {
    vi.spyOn(api, 'overviewTimeseries').mockResolvedValue(
      points.map((point) => ({ ...point, runs: 0, failed: 0, costUsd: 0, tokens: 0 })),
    );
    await render(createElement(RunTrendCard, { days: 7 }));

    expect(host.textContent).toContain('发起对话后生成趋势');
    expect(host.querySelector('[aria-label="加载中"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('table')).toBeNull();
  });
});
