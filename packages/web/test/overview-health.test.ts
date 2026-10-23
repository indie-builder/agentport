import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HealthMetrics, Overview } from '../src/lib/api.js';
import { healthMetricsQuery, overviewQuery } from '../src/lib/queries.js';
import { OverviewPage } from '../src/pages/overview.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) =>
    createElement('a', { href: to, ...props }, children),
  useNavigate: () => vi.fn(),
}));

const metrics: HealthMetrics = {
  process: { uptimeSeconds: 20, memoryRssBytes: 1024, nodeVersion: 'v24' },
  queue: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
  db: { total: 1, idle: 1, waiting: 0 },
  redis: { pingMs: 1 },
};

function renderHealth(state: 'pending' | 'unavailable' | 'error' | 'ready' | 'missing-queue') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  client.setQueryData(overviewQuery.queryKey, {
    counts: { agents: 1, servers: 1, runs: 0, running: 0 },
    recent: [],
    agents: [],
  } satisfies Overview);
  if (state === 'unavailable') client.setQueryData(healthMetricsQuery.queryKey, null);
  if (state === 'ready') client.setQueryData(healthMetricsQuery.queryKey, metrics);
  if (state === 'missing-queue') {
    client.setQueryData(healthMetricsQuery.queryKey, { ...metrics, queue: null });
  }
  if (state === 'error') {
    client
      .getQueryCache()
      .build(client, healthMetricsQuery)
      .setState({
        status: 'error',
        error: new Error('Offline'),
      });
  }
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(OverviewPage)),
    );
  } finally {
    client.clear();
  }
}

describe('overview health summary', () => {
  it('shows initial loading without reporting an outage', () => {
    const html = renderHealth('pending');
    expect(html).toContain('健康指标加载中');
    expect(html).not.toContain('健康指标不可用');
    expect(html).toMatch(/<a\b[^>]*href="\/status"/);
  });

  it.each(['unavailable', 'error'] as const)('keeps diagnostics reachable when %s', (state) => {
    const html = renderHealth(state);
    expect(html).toContain('健康指标不可用');
    expect(html).toMatch(/<a\b[^>]*href="\/status"/);
  });

  it('preserves zero queue counts', () => {
    const html = renderHealth('ready');
    expect(html).toContain(' 等待 / 0 运行');
    expect(html).not.toContain('指标不可用');
  });

  it('does not turn missing queue metrics into zero counts', () => {
    const html = renderHealth('missing-queue');
    expect(html).toContain('队列指标不可用');
    expect(html).not.toContain(' 等待 / ');
  });
});
