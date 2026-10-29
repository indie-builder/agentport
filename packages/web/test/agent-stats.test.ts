import type { AgentStats } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentStatsQuery } from '../src/lib/queries.js';
import { AgentStatsPanel, fillDailyRuns } from '../src/pages/ops.js';

describe('fillDailyRuns', () => {
  it('补齐跨月的最近自然日，并把有运行的天放到正确位置', () => {
    const daily = [
      { day: '2026-02-26', runs: 2, cost: 1.5 },
      { day: '2026-03-01', runs: 1, cost: 0.25 },
    ];

    expect(fillDailyRuns(daily, 5, new Date('2026-03-02T12:00:00Z'))).toEqual([
      { day: '2026-02-26', runs: 2, cost: 1.5 },
      { day: '2026-02-27', runs: 0, cost: 0 },
      { day: '2026-02-28', runs: 0, cost: 0 },
      { day: '2026-03-01', runs: 1, cost: 0.25 },
      { day: '2026-03-02', runs: 0, cost: 0 },
    ]);
  });

  it('缺失的天补 0，显式 0 值和窗口外记录都不污染结果', () => {
    const daily = [
      { day: '2026-01-30', runs: 9, cost: 4.5 },
      { day: '2026-02-10', runs: 0, cost: 0 },
      { day: '2026-02-20', runs: 1, cost: 0.01 },
    ];

    const filled = fillDailyRuns(daily, 30, new Date('2026-03-01T00:30:00Z'));

    expect(filled).toHaveLength(30);
    expect(filled[0]).toEqual({ day: '2026-01-31', runs: 0, cost: 0 });
    expect(filled.at(-1)).toEqual({ day: '2026-03-01', runs: 0, cost: 0 });
    expect(filled.find((entry) => entry.day === '2026-02-10')).toEqual({
      day: '2026-02-10',
      runs: 0,
      cost: 0,
    });
    expect(filled.find((entry) => entry.day === '2026-02-20')).toEqual({
      day: '2026-02-20',
      runs: 1,
      cost: 0.01,
    });
    expect(filled.some((entry) => entry.day === '2026-01-30')).toBe(false);
    expect(filled.filter((entry) => entry.runs > 0)).toHaveLength(1);
  });

  it('完全没有运行时仍返回完整的零值序列', () => {
    const filled = fillDailyRuns([], 30, new Date('2026-02-01T23:30:00Z'));

    expect(filled).toHaveLength(30);
    expect(filled[0]?.day).toBe('2026-01-03');
    expect(filled.at(-1)?.day).toBe('2026-02-01');
    expect(filled.every((entry) => entry.runs === 0 && entry.cost === 0)).toBe(true);
  });
});

const AGENT_ID = 'agt_stats';

const stats: AgentStats = {
  agentId: AGENT_ID,
  runCount: 2,
  running: 0,
  failed: 1,
  succeeded: 1,
  totalCost: 1.5,
  totalTokens: 1200,
  errorRate: 0.5,
  latencyP50: 120,
  latencyP99: 400,
  lastRunStartTime: '2026-03-01T00:00:00Z',
  daily: [{ day: new Date().toISOString().slice(0, 10), runs: 2, cost: 1.5 }],
};

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

describe('AgentStatsPanel 可访问性', () => {
  it('用 30 行数据表向读屏提供每日次数与成本，视觉柱图对辅助技术隐藏', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    client.setQueryData(agentStatsQuery(AGENT_ID, 30).queryKey, stats);

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(AgentStatsPanel, { agentId: AGENT_ID }),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const table = host.querySelector('table');
    expect(table?.querySelector('caption')?.textContent).toBe('近 30 天每日运行次数与成本');
    expect([...(table?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent)).toEqual([
      '日期',
      '运行次数',
      '成本',
    ]);

    const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
    expect(rows).toHaveLength(30);
    const cells = (row: Element) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent);
    const active = rows.find((row) => cells(row)[0] === stats.daily[0]?.day);
    expect(active && cells(active)).toEqual([stats.daily[0]?.day, '2', '$1.5000']);
    expect(rows.some((row) => cells(row).slice(1).join('|') === '0|$0')).toBe(true);

    const chart = host.querySelector('[data-slot="chart"]');
    const hidden = chart?.closest('[aria-hidden="true"]');
    expect(hidden).toBeTruthy();
    expect(
      hidden?.querySelectorAll(
        '[tabindex]:not([tabindex="-1"]), a[href], button, input, select, textarea',
      ),
    ).toHaveLength(0);
    expect(host.querySelector('[role="application"]')).toBeNull();
  });
});
