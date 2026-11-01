import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalRun } from '../src/lib/api.js';
import { formatDateTime } from '../src/lib/format.js';
import { buildEvalPassRatePoints, EvalPassRateChart } from '../src/pages/eval.js';

function makeRun(
  id: string,
  createdAt: string,
  total: number,
  passed: number,
  status: EvalRun['status'] = 'succeeded',
): EvalRun {
  return {
    id,
    agentId: 'agent-a',
    status,
    total,
    passed,
    error: null,
    createdAt,
    finishedAt: status === 'running' ? null : createdAt,
  };
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

async function render(runs: EvalRun[]): Promise<void> {
  await act(async () => {
    root.render(createElement(EvalPassRateChart, { runs }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('buildEvalPassRatePoints', () => {
  it('orders points oldest to newest regardless of input order', () => {
    const oldest = makeRun('evalRun_old', '2026-10-22T00:01:00.000Z', 2, 1);
    const newest = makeRun('evalRun_new', '2026-10-22T00:02:00.000Z', 5, 4);

    const points = buildEvalPassRatePoints([newest, oldest]);

    expect(points.map((point) => point.ratePct)).toEqual([50, 80]);
    expect(points.map((point) => point.label)).toEqual([
      formatDateTime(oldest.createdAt),
      formatDateTime(newest.createdAt),
    ]);
  });

  it('rounds the pass rate', () => {
    const points = buildEvalPassRatePoints([
      makeRun('evalRun_a', '2026-10-22T00:01:00.000Z', 3, 2),
    ]);

    expect(points[0]?.ratePct).toBe(67);
  });

  it('drops running runs and runs without cases', () => {
    const points = buildEvalPassRatePoints([
      makeRun('evalRun_a', '2026-10-22T00:01:00.000Z', 2, 1),
      makeRun('evalRun_running', '2026-10-22T00:02:00.000Z', 2, 2, 'running'),
      makeRun('evalRun_empty', '2026-10-22T00:03:00.000Z', 0, 0),
      makeRun('evalRun_b', '2026-10-22T00:04:00.000Z', 5, 4),
    ]);

    expect(points).toHaveLength(2);
    expect(points.map((point) => point.ratePct)).toEqual([50, 80]);
  });

  it('returns an empty array when nothing qualifies', () => {
    expect(
      buildEvalPassRatePoints([
        makeRun('evalRun_running', '2026-10-22T00:01:00.000Z', 2, 1, 'running'),
        makeRun('evalRun_empty', '2026-10-22T00:02:00.000Z', 0, 0),
      ]),
    ).toEqual([]);
  });
});

describe('eval pass rate chart', () => {
  it('plots a hidden trend chart once two terminal runs have cases', async () => {
    await render([
      makeRun('evalRun_new', '2026-10-22T00:02:00.000Z', 10, 8),
      makeRun('evalRun_old', '2026-10-22T00:01:00.000Z', 10, 5),
    ]);

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
  });

  it('renders nothing for a single terminal run', async () => {
    await render([makeRun('evalRun_only', '2026-10-22T00:01:00.000Z', 10, 5)]);

    expect(host.querySelector('[data-slot="chart"]')).toBeNull();
  });

  it('ignores runs without cases', async () => {
    await render([
      makeRun('evalRun_a', '2026-10-22T00:01:00.000Z', 0, 0),
      makeRun('evalRun_b', '2026-10-22T00:02:00.000Z', 0, 0),
    ]);

    expect(host.querySelector('[data-slot="chart"]')).toBeNull();
  });

  it('ignores runs that are still running', async () => {
    await render([
      makeRun('evalRun_a', '2026-10-22T00:01:00.000Z', 10, 5, 'running'),
      makeRun('evalRun_b', '2026-10-22T00:02:00.000Z', 10, 6, 'running'),
    ]);

    expect(host.querySelector('[data-slot="chart"]')).toBeNull();
  });
});
