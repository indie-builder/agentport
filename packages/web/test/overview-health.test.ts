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

function withQueue(queue: Partial<NonNullable<HealthMetrics['queue']>>): HealthMetrics {
  return {
    ...metrics,
    queue: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, ...queue },
  };
}

const overview = (counts: Partial<Overview['counts']> = {}): Overview => ({
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
    ...counts,
  },
  recent: [],
  agents: [],
});

function renderHealth({
  value = metrics,
  error = false,
  pending = false,
  loaded = true,
}: {
  value?: HealthMetrics;
  error?: boolean;
  pending?: boolean;
  loaded?: boolean;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  client.setQueryData(overviewQuery.queryKey, overview());
  if (!pending) {
    const query = client.getQueryCache().build(client, healthMetricsQuery);
    // 端点不可达在 queryFn 里抛错：首次失败没有旧读数，刷新失败才保留上次成功值。
    if (loaded) query.setData(value);
    if (error) query.setState({ status: 'error', error: new Error('Offline') });
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
    const html = renderHealth({ pending: true });
    expect(html).toContain('健康指标加载中');
    expect(html).not.toContain('健康指标不可用');
    expect(html).toContain('查看健康');
    expect(html).toMatch(/<a\b[^>]*href="\/status"/);
  });

  it('keeps diagnostics reachable when the first read fails', () => {
    const html = renderHealth({ loaded: false, error: true });
    expect(html).toContain('健康指标不可用');
    expect(html).toContain('重试');
    expect(html).toMatch(/<a\b[^>]*href="\/status"/);
  });

  it('stays quiet on the home page when the queue is healthy', () => {
    const html = renderHealth();
    expect(html).not.toContain('队列');
    expect(html).not.toContain('指标不可用');
  });

  it('does not turn missing queue metrics into zero counts', () => {
    const html = renderHealth({ value: { ...metrics, queue: null } });
    expect(html).toContain('队列指标不可用');
    expect(html).not.toContain(' 个等待');
  });

  it('surfaces a backlog above the shared waiting limit', () => {
    const html = renderHealth({ value: withQueue({ waiting: 11, active: 1 }) });
    expect(html).toContain('队列积压：11 个等待，1 个运行中');
    expect(html).toContain('查看健康');
  });

  it.each([11, 20])('treats %i waiting tasks as a backlog', (waiting) => {
    const html = renderHealth({ value: withQueue({ waiting, active: waiting }) });
    expect(html).toContain(`队列积压：${waiting} 个等待`);
  });

  it('reports waiting without an active run as a fact, not a missing consumer', () => {
    const html = renderHealth({ value: withQueue({ waiting: 3, active: 0 }) });
    expect(html).toContain('有 3 个任务等待，当前没有运行中的任务');
    expect(html).not.toContain('消费者');
  });

  it('ignores historical failed jobs on the home page', () => {
    const html = renderHealth({ value: withQueue({ failed: 2 }) });
    expect(html).not.toContain('历史失败记录');
    expect(html).not.toContain('队列指标不可用');
    expect(html).not.toContain('查看健康');
  });

  it('keeps the last readings and offers a retry when a refresh fails', () => {
    const html = renderHealth({
      value: withQueue({ waiting: 11, active: 1 }),
      error: true,
    });
    expect(html).toContain('队列积压：11 个等待，1 个运行中');
    expect(html).toContain('健康指标刷新失败，显示上次结果');
    expect(html).toContain('重试');
    expect(html).toContain('查看健康');
    expect(html).not.toContain('健康指标不可用');
  });

  it('places queue exceptions before the long tables', () => {
    const html = renderHealth({ value: withQueue({ waiting: 11, active: 11 }) });
    expect(html.indexOf('队列积压：11 个等待')).toBeLessThan(html.indexOf('运行趋势'));
    expect(html.indexOf('队列积压：11 个等待')).toBeLessThan(html.indexOf('专家运行'));
  });
});
