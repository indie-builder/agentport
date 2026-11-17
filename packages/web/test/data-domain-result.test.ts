import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataDomainResultView } from '../src/components/chat/chat-thread/data-domain-result.js';
import { NO_KIDS, ToolGroup } from '../src/components/chat/chat-thread/trace.js';
import {
  chartPlan,
  dataDomainResultFromTool,
  inferColumnTypes,
} from '../src/lib/data-domain-result.js';

const NAME = 'mcp__dd-demo__run_sql';

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    columns: ['city', 'amount'],
    rows: [
      ['北京', 10],
      ['上海', 20],
    ],
    rowCount: 2,
    truncated: false,
    ...overrides,
  });
}

describe('dataDomainResultFromTool', () => {
  it('parses the columns/rows envelope of a run_sql result', () => {
    expect(dataDomainResultFromTool(NAME, payload())).toEqual({
      columns: ['city', 'amount'],
      rows: [
        ['北京', 10],
        ['上海', 20],
      ],
      rowCount: 2,
      truncated: false,
    });
  });

  it('keeps truncated results and empty results', () => {
    expect(dataDomainResultFromTool(NAME, payload({ truncated: true }))?.truncated).toBe(true);
    expect(dataDomainResultFromTool(NAME, payload({ rows: [], rowCount: 0 }))?.rowCount).toBe(0);
  });

  it('rejects other tools even when the payload looks valid', () => {
    expect(dataDomainResultFromTool('mcp__kb__knowledge_search', payload())).toBeNull();
    expect(dataDomainResultFromTool('ReadTool', payload())).toBeNull();
  });

  it('rejects malformed or replaced text', () => {
    expect(dataDomainResultFromTool(NAME, '{"columns": [')).toBeNull();
    expect(
      dataDomainResultFromTool(
        NAME,
        'Error: result (61234 characters) exceeds maximum allowed tokens. Output has been saved to /tmp/result.json',
      ),
    ).toBeNull();
    expect(
      dataDomainResultFromTool(
        NAME,
        `Error: result (${60_000} characters) exceeds maximum allowed tokens. Output has been saved to /tmp/result.json`,
      ),
    ).toBeNull();
    expect(dataDomainResultFromTool(NAME, `${payload()}\n…[truncated]`)).toBeNull();
    expect(dataDomainResultFromTool(NAME, 'QUERY_FAILED: 数据查询服务请求失败')).toBeNull();
    expect(
      dataDomainResultFromTool(
        NAME,
        JSON.stringify({ status: 'pending_approval', approvalId: 'x' }),
      ),
    ).toBeNull();
    expect(dataDomainResultFromTool(NAME, undefined)).toBeNull();
  });

  it('rejects structurally inconsistent results', () => {
    expect(dataDomainResultFromTool(NAME, payload({ columns: [1, 2] }))).toBeNull();
    expect(dataDomainResultFromTool(NAME, payload({ rows: [['北京']] }))).toBeNull();
    expect(dataDomainResultFromTool(NAME, payload({ rows: [['北京', 10, 1]] }))).toBeNull();
    expect(dataDomainResultFromTool(NAME, payload({ rowCount: -1 }))).toBeNull();
    expect(dataDomainResultFromTool(NAME, payload({ truncated: 'yes' }))).toBeNull();
    expect(dataDomainResultFromTool(NAME, payload({ rowCount: 0 }))).toBeNull();
    expect(dataDomainResultFromTool(NAME, payload({ rowCount: 3 }))).toBeNull();
  });
});

describe('inferColumnTypes', () => {
  it('only treats real numbers as measure columns', () => {
    expect(
      inferColumnTypes(
        ['id', 'amount', 'code', 'ratio'],
        [
          [1, 10, '20', null],
          [2, null, '30', null],
        ],
      ),
    ).toEqual(['text', 'number', 'text', 'text']);
  });

  it('keeps null values out of number inference for a mixed column', () => {
    expect(inferColumnTypes(['amount'], [[1], [null], [3]])).toEqual(['number']);
    expect(inferColumnTypes(['amount'], [[null], [null]])).toEqual(['text']);
  });
});

describe('chartPlan', () => {
  it('separates text dimensions from number measures', () => {
    const plan = chartPlan(
      ['city', 'amount'],
      [
        ['北京', 10],
        ['上海', 20],
      ],
    );
    expect(plan.dimensions).toEqual([{ index: 0, name: 'city' }]);
    expect(plan.measures).toEqual([{ index: 1, name: 'amount' }]);
    expect(plan.canChart).toBe(true);
  });

  it('keeps duplicate column names distinct by index', () => {
    const plan = chartPlan(['name', 'name', 'amount'], [['北京', '海淀', 10]]);
    expect(plan.dimensions.map((column) => column.index)).toEqual([0, 1]);
    expect(plan.measures.map((column) => column.index)).toEqual([2]);
  });

  it('cannot chart without rows, dimensions or measures', () => {
    expect(chartPlan(['city', 'amount'], []).canChart).toBe(false);
    expect(chartPlan(['city'], [['北京']]).canChart).toBe(false);
    expect(chartPlan(['amount'], [[10]]).canChart).toBe(false);
  });
});

const WIDTH = 320;
const HEIGHT = 256;

function rect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {},
  } as DOMRect;
}

let host: HTMLDivElement;
let root: Root;

async function settle(rounds = 6): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element));
  await settle();
}

async function click(match: (button: HTMLButtonElement) => boolean): Promise<void> {
  const button = [...host.querySelectorAll('button')].find(match);
  expect(button, 'button').toBeTruthy();
  await act(async () => (button as HTMLButtonElement).click());
  await settle();
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const element = this as HTMLElement;
    if (
      element.classList?.contains('recharts-responsive-container') ||
      element.classList?.contains('recharts-wrapper')
    ) {
      return rect(WIDTH, HEIGHT);
    }
    return rect(0, 0);
  });
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

const normalResult = {
  columns: ['city', 'amount'],
  rows: [
    ['北京', 10],
    ['上海', 20],
  ],
  rowCount: 2,
  truncated: false,
};

describe('DataDomainResultView table', () => {
  it('renders columns, rows and numeric cells', async () => {
    await render(createElement(DataDomainResultView, { result: normalResult }));
    expect(host.querySelector('table[aria-label="查询结果"]')).toBeTruthy();
    expect(host.textContent).toContain('city');
    expect(host.textContent).toContain('北京');
    expect(host.textContent).toContain('20');
    expect(host.querySelector('[role="table"]')).toBeTruthy();
  });

  it('shows the empty state when the query returns no rows', async () => {
    await render(
      createElement(DataDomainResultView, {
        result: { columns: ['city'], rows: [], rowCount: 0, truncated: false },
      }),
    );
    expect(host.textContent).toContain('查询无结果');
  });

  it('caps the table and explains truncation', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => [`row-${index}`, index]);
    await render(
      createElement(DataDomainResultView, {
        result: { columns: ['name', 'value'], rows, rowCount: 250, truncated: true },
      }),
    );
    expect(host.textContent).toContain('显示前 200 行，共 250 行');
    expect(host.textContent).toContain('结果已达查询上限，已截断');
    expect(host.textContent).not.toContain('row-249');
  });
});

describe('DataDomainResultView chart', () => {
  it('draws one bar per returned row after switching views', async () => {
    await render(createElement(DataDomainResultView, { result: normalResult }));
    expect(host.querySelector('.recharts-wrapper')).toBeNull();
    await click((button) => button.textContent?.trim() === '图表');
    expect(host.querySelector('.recharts-wrapper')).toBeTruthy();
    expect(host.querySelectorAll('.recharts-bar-rectangle path')).toHaveLength(2);
    expect(host.textContent).toContain('不聚合：每行一个数据点');
  });

  it('keeps one bar per row when dimension values repeat', async () => {
    await render(
      createElement(DataDomainResultView, {
        result: {
          columns: ['city', 'amount'],
          rows: [
            ['北京', 10],
            ['北京', 20],
          ],
          rowCount: 2,
          truncated: false,
        },
      }),
    );
    await click((button) => button.textContent?.trim() === '图表');
    expect(host.querySelectorAll('.recharts-bar-rectangle path')).toHaveLength(2);
  });

  it('explains the missing measure instead of drawing an empty chart', async () => {
    await render(
      createElement(DataDomainResultView, {
        result: {
          columns: ['city', 'note'],
          rows: [
            ['北京', 'a'],
            ['上海', 'b'],
          ],
          rowCount: 2,
          truncated: false,
        },
      }),
    );
    await click((button) => button.textContent?.trim() === '图表');
    expect(host.querySelector('.recharts-wrapper')).toBeNull();
    expect(host.textContent).toContain('没有可用于图表的维度与度量');
  });
});

describe('DataDomainResultView raw result', () => {
  it('keeps the raw JSON collapsed until requested', async () => {
    await render(createElement(DataDomainResultView, { result: normalResult }));
    expect(host.textContent).not.toContain('"rowCount"');
    await click((button) => button.textContent?.includes('查看原始结果') ?? false);
    expect(host.textContent).toContain('"rowCount"');
  });
});

describe('ToolGroup integration', () => {
  function tool(result: string, name = NAME) {
    return { kind: 'tool' as const, toolUseId: 'tool-1', name, result };
  }

  function group(result: string, name = NAME) {
    return createElement(ToolGroup, {
      tool: tool(result, name),
      kids: NO_KIDS,
      approvalHosts: new Map(),
      pending: null,
      onApprove: undefined,
      liveRunId: null,
    });
  }

  it('opens the structured result and advertises the row count', async () => {
    await render(group(payload()));
    expect(host.textContent).toContain('· 2 行');
    await click((button) => button.textContent?.includes(NAME) ?? false);
    expect(host.querySelector('table[aria-label="查询结果"]')).toBeTruthy();
    expect(host.textContent).toContain('北京');
  });

  it('falls back to the raw block for results the CLI replaced', async () => {
    const replaced =
      'Error: result (61234 characters) exceeds maximum allowed tokens. Output has been saved to /tmp/result.json';
    await render(group(replaced));
    await click((button) => button.textContent?.includes(NAME) ?? false);
    expect(host.textContent).toContain('exceeds maximum allowed tokens');
    expect(host.querySelector('table[aria-label="查询结果"]')).toBeNull();
  });

  it('keeps the raw JSON path for other mcp tools with a similar payload', async () => {
    await render(group(payload(), 'mcp__dd-demo__get_mdl'));
    await click((button) => button.textContent?.includes('mcp__dd-demo__get_mdl') ?? false);
    expect(host.textContent).toContain('"rowCount"');
    expect(host.querySelector('table[aria-label="查询结果"]')).toBeNull();
  });
});
