import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * 图表回归全部走真实 Renderer + Recharts，不用「存在 data-chart」证明数据正确：
 * jsdom 没有布局，这里给响应式容器一个固定 320×256 的矩形，让 Recharts 真正算出
 * 条形宽度、轴刻度与折线路径，再断言数值/尺寸/配置。
 */

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
    if (element.hasAttribute?.('data-openui-chart-frame')) {
      return rect(WIDTH, Number.parseFloat(element.style.height) || HEIGHT);
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

async function settle(rounds = 8): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function render(program: string[]): Promise<void> {
  await act(async () => {
    root.render(createElement(OpenUiBlock, { program: program.join('\n') }));
  });
  await settle();
}

function frameHeight(): string | undefined {
  return (host.querySelector('[data-openui-chart-frame]') as HTMLElement | null)?.style.height;
}

function barWidths(): number[] {
  return [...host.querySelectorAll('.recharts-bar-rectangle path')].map((path) =>
    Number(path.getAttribute('width')),
  );
}

async function openDataView(): Promise<HTMLTableElement> {
  const trigger = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === '数据视图',
  );
  expect(trigger, '数据视图入口').toBeTruthy();
  await act(async () => (trigger as HTMLButtonElement).click());
  await settle(2);
  const table = host.querySelector('table');
  expect(table).toBeTruthy();
  return table as HTMLTableElement;
}

describe('尺寸', () => {
  it('主图默认 256px，schema 显式 height 优先（Composite 传 192）', async () => {
    await render([
      'root = Card([main, small])',
      'main = BarChart(["一月", "二月"], [Series("收入", [1, 2])], "grouped")',
      'small = BarChart(["一月", "二月"], [Series("收入", [1, 2])], "grouped", "月份", "万元", 192)',
    ]);
    const frames = [...host.querySelectorAll<HTMLElement>('[data-openui-chart-frame]')];
    expect(frames.map((frame) => frame.style.height)).toEqual(['256px', '192px']);
    // 容器本身有显式尺寸，Recharts 不需要先量到高度才渲染。
    expect(frames[0]?.querySelector('.recharts-wrapper')).toBeTruthy();
  });

  it('单条堆叠用默认高度 256px', async () => {
    await render(['root = Card([c])', 'c = SingleStackedBarChart(["甲", "乙"], [30, 70])']);
    expect(frameHeight()).toBe('256px');
  });

  it('横向条形按类别数增高，12 个类别不压扁标签', async () => {
    const labels = Array.from({ length: 12 }, (_, index) => `"类别${index}"`).join(', ');
    const values = Array.from({ length: 12 }, (_, index) => index + 1).join(', ');
    await render([
      'root = Card([c])',
      `c = HorizontalBarChart([${labels}], [Series("数量", [${values}])], "grouped")`,
    ]);
    expect(Number.parseFloat(frameHeight() ?? '0')).toBeGreaterThan(256);
    // 类别名落在 y 轴刻度上；jsdom 里 Recharts 把轴文字放在独立标签层，
    // 这里按「全部刻度文本」断言，值轴同时给出 0/3/6/9/12。
    const ticks = [...host.querySelectorAll('.recharts-cartesian-axis-tick-value')].map(
      (tick) => tick.textContent,
    );
    for (let index = 0; index < 12; index += 1) {
      expect(ticks).toContain(`类别${index}`);
    }
  });
});

describe('条形与折线规格', () => {
  it('条形最宽 24px、数据端 4px 圆角、端部在基线外', async () => {
    await render([
      'root = Card([c])',
      'c = BarChart(["一月", "二月", "三月"], [Series("收入", [3, 5, 4])], "grouped")',
    ]);
    const widths = barWidths();
    expect(widths).toHaveLength(3);
    expect(Math.max(...widths)).toBeLessThanOrEqual(24);
    const first = host.querySelector('.recharts-bar-rectangle path');
    // 竖直条只在顶部两个角圆角，底部贴住基线。
    expect(first?.getAttribute('d')).toContain('A 4,4');
  });

  it('堆叠时只有最上层圆角，内段保持方角', async () => {
    await render([
      'root = Card([c])',
      'c = BarChart(["一月"], [Series("甲", [2]), Series("乙", [3])], "stacked")',
    ]);
    const paths = [...host.querySelectorAll('.recharts-bar-rectangle path')];
    expect(paths).toHaveLength(2);
    expect(paths[0]?.getAttribute('d')).not.toContain('A 4,4');
    expect(paths[1]?.getAttribute('d')).toContain('A 4,4');
  });

  it('折线 2px、关闭动画、缺失值断线而不是补零', async () => {
    await render([
      'root = Card([c])',
      'c = LineChart(["一月", "二月", "三月", "四月"], [Series("收入", [3, 5])], "linear")',
    ]);
    const path = host.querySelector('.recharts-line-curve');
    expect(path?.getAttribute('stroke-width')).toBe('2');
    // 只有两个月有点：一段折线、一个 M、一条连接；缺失的三/四月没有补成 0 值
    // （补零会多出两个顶点并落回基线）。
    const d = path?.getAttribute('d') ?? '';
    expect((d.match(/M/g) ?? []).length).toBe(1);
    expect((d.match(/L/g) ?? []).length).toBe(1);
    // 关闭了静态点；缺失的月份不产生替换点（dot=false 时 Recharts 不给任何点）。
    expect(host.querySelectorAll('.recharts-line-dots .recharts-line-dot')).toHaveLength(0);
    expect(barWidths()).toHaveLength(0);
    const table = await openDataView();
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows[2]).toContain('—');
    expect(rows[3]).toContain('—');
  });

  it('没有数据空格子不画柱，数据视图用「—」表示缺口', async () => {
    await render([
      'root = Card([c])',
      'c = BarChart(["一月", "二月", "三月"], [Series("收入", [3, 5])], "grouped")',
    ]);
    expect(barWidths()).toHaveLength(2);
    const table = await openDataView();
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows[2]?.textContent).toContain('—');
  });
});

describe('多系列可区分', () => {
  it('第 2 个系列起加虚线，10 个系列都保留在 legend 里', async () => {
    const series = Array.from(
      { length: 10 },
      (_, index) => `Series("系列${index}", [${index + 1}, ${index + 2}])`,
    ).join(', ');
    await render(['root = Card([c])', `c = LineChart(["一月", "二月"], [${series}], "linear")`]);
    const curves = [...host.querySelectorAll('.recharts-line-curve')];
    expect(curves).toHaveLength(10);
    expect(curves.map((curve) => curve.getAttribute('stroke-dasharray'))).toEqual([
      null,
      '3 3',
      '4 3',
      '5 3',
      '6 3',
      '7 3',
      '8 3',
      '9 3',
      '10 3',
      '11 3',
    ]);
    const legend = host.querySelector('.recharts-legend-wrapper');
    for (let index = 0; index < 10; index += 1) {
      expect(legend?.textContent).toContain(`系列${index}`);
    }
    // legend 图标与线型一致，不只靠灰度；按真实系列数生成，不靠固定 12 个模循环。
    expect(legend?.querySelectorAll('svg')).toHaveLength(10);
    // 图标 viewBox 与虚线周期同长，12px 画布里能看到整段 dash + gap，而不是被截成实线。
    const icons = [...(legend?.querySelectorAll('svg') ?? [])];
    expect(icons.map((icon) => icon.getAttribute('viewBox'))).toEqual([
      '0 0 12 12',
      '0 0 6 12',
      '0 0 7 12',
      '0 0 8 12',
      '0 0 9 12',
      '0 0 10 12',
      '0 0 11 12',
      '0 0 12 12',
      '0 0 13 12',
      '0 0 14 12',
    ]);
    expect(icons[9]?.querySelector('line')?.getAttribute('stroke-dasharray')).toBe('11 3');
  });

  it('中间缺失值断成两段，不跨缺口连线', async () => {
    await render([
      'root = Card([c])',
      'c = LineChart(["一月", "二月", "三月", "四月", "五月"], [Series("收入", [1, 2, null, 4, 5])], "linear")',
    ]);
    const d = host.querySelector('.recharts-line-curve')?.getAttribute('d') ?? '';
    // 前后各一段 M，缺口两侧没有 L 连接。
    expect((d.match(/M/g) ?? []).length).toBe(2);
    expect(d).not.toContain('null');
    const table = await openDataView();
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows[2]).toContain('—');
  });

  it('第 11 个系列与第 1 个不重复：灰阶循环，虚线/纹理随序号变化', async () => {
    const series = Array.from(
      { length: 11 },
      (_, index) => `Series("系列${index}", [${index + 1}, ${index + 2}])`,
    ).join(', ');
    await render(['root = Card([c])', `c = BarChart(["一月", "二月"], [${series}], "grouped")`]);
    const legend = host.querySelector('.recharts-legend-wrapper');
    expect(legend?.textContent).toContain('系列10');
    const fills = [...host.querySelectorAll('.recharts-bar-rectangle path')].map((path) =>
      path.getAttribute('fill'),
    );
    // 每个系列一个 pattern，11 条互不相同。
    expect(new Set(fills).size).toBe(11);
    // 只数柱体所在的图表面，legend 图标自带同规格的 pattern。
    const defines = [...host.querySelectorAll('svg.recharts-surface pattern')];
    expect(defines).toHaveLength(11);
    const first = defines[0];
    const last = defines[10];
    expect(first?.getAttribute('patternTransform')).not.toBe(
      last?.getAttribute('patternTransform'),
    );
    expect(first?.getAttribute('width')).not.toBe(last?.getAttribute('width'));
    // legend 图标用同一套 pattern 参数，不再画与实际纹理无关的斜纹（legend 顺序由 Recharts 定）。
    const legendPatterns = [...(legend?.querySelectorAll('pattern') ?? [])];
    expect(legendPatterns).toHaveLength(10);
    const sort = (list: (string | null)[]) => [...list].sort();
    expect(sort(legendPatterns.map((icon) => icon.getAttribute('patternTransform')))).toEqual(
      sort(defines.slice(1).map((item) => item.getAttribute('patternTransform'))),
    );
    expect(sort(legendPatterns.map((icon) => icon.getAttribute('width')))).toEqual(
      sort(defines.slice(1).map((item) => item.getAttribute('width'))),
    );
    // 第 1 个系列保持纯实色。
    expect(fills[0]?.startsWith('url(#')).toBe(false);
    expect(fills[10]?.startsWith('url(#')).toBe(true);
  });

  it('重复系列名不会互相覆盖', async () => {
    await render([
      'root = Card([c])',
      'c = BarChart(["一月", "二月"], [Series("收入", [1, 2]), Series("收入", [3, 4])], "grouped")',
    ]);
    expect(barWidths()).toHaveLength(4);
    const legend = host.querySelector('.recharts-legend-wrapper');
    expect(legend?.textContent).toContain('收入');
    expect(legend?.textContent).toContain('收入 (2)');
  });

  it('饼图缺失值不补零，数据视图保留空项', async () => {
    await render(['root = Card([c])', 'c = PieChart(["甲", "乙", "丙"], [40, 60], "donut")']);
    expect(host.querySelectorAll('.recharts-pie-sector')).toHaveLength(2);
    expect(host.querySelector('.recharts-legend-wrapper')?.textContent).toContain('甲');
    const table = await openDataView();
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain('丙');
    expect(rows[2]).toContain('—');
  });
});

describe('数据视图与键盘', () => {
  it('数据视图默认不展开，入口是真实按钮且可键盘操作', async () => {
    await render([
      'root = Card([c])',
      'c = BarChart(["一月", "二月"], [Series("收入", [1, 2]), Series("成本", [3, 4])], "grouped")',
    ]);
    expect(host.querySelector('table')).toBeNull();
    const trigger = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '数据视图',
    ) as HTMLButtonElement;
    expect(trigger?.tagName).toBe('BUTTON');
    await act(async () => trigger.focus());
    expect(document.activeElement).toBe(trigger);
    const table = await openDataView();
    expect(table.querySelectorAll('thead th')).toHaveLength(3);
    expect([...table.querySelectorAll('tbody tr')].map((row) => row.textContent)).toEqual([
      '一月13',
      '二月24',
    ]);
  });

  it('九种图表都开启可访问层', async () => {
    const programs: Record<string, string[]> = {
      BarChart: ['c = BarChart(["甲", "乙"], [Series("值", [1, 2])], "grouped")'],
      LineChart: ['c = LineChart(["甲", "乙"], [Series("值", [1, 2])], "linear")'],
      AreaChart: ['c = AreaChart(["甲", "乙"], [Series("值", [1, 2])], "linear")'],
      HorizontalBarChart: [
        'c = HorizontalBarChart(["甲", "乙"], [Series("值", [1, 2])], "grouped")',
      ],
      RadarChart: ['c = RadarChart(["甲", "乙"], [Series("值", [1, 2])])'],
      PieChart: ['c = PieChart(["甲", "乙"], [40, 60], "donut")'],
      RadialChart: ['c = RadialChart(["甲", "乙"], [30, 70])'],
      SingleStackedBarChart: ['c = SingleStackedBarChart(["甲", "乙"], [30, 70])'],
      ScatterChart: [
        'c = ScatterChart([ScatterSeries("组", [Point(1, 2), Point(3, 4)])], "X", "Y")',
      ],
    };
    for (const [name, program] of Object.entries(programs)) {
      await render(['root = Card([c])', ...program]);
      const surface = host.querySelector('svg.recharts-surface');
      expect(surface?.getAttribute('role'), name).toBe('application');
      expect(surface?.getAttribute('tabindex'), name).toBe('0');
    }
  });
});

describe('tooltip', () => {
  it('portal 到 body，键盘可触发且不被消息流裁切', async () => {
    await render([
      'root = Card([c])',
      'c = BarChart(["一月", "二月"], [Series("收入", [3, 4])], "grouped")',
    ]);
    // 图表内部不再渲染 tooltip 层，避免 content-visibility 裁剪。
    expect(host.querySelector('.recharts-tooltip-wrapper')).toBeNull();
    const surface = host.querySelector('svg.recharts-surface') as SVGElement;
    await act(async () => {
      surface.focus();
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await settle(4);
    const wrapper = document.body.querySelector('.recharts-tooltip-wrapper');
    expect(wrapper).toBeTruthy();
    expect(host.contains(wrapper)).toBe(false);
    // Recharts 的 portal 会去掉自带定位样式，由内容自己按图表矩形换算成 fixed。
    const content = wrapper?.firstElementChild as HTMLElement | null;
    expect(content).toBeTruthy();
    const style = (content as HTMLElement).style;
    expect(style.position).toBe('fixed');
    expect(style.pointerEvents).toBe('none');
    // 覆盖共享 tooltip 的 min-w-32，窄视口时以 maxWidth 为准。
    expect((content as HTMLElement).className).toContain('min-w-0');
    expect(style.left === '' && style.right === '').toBe(false);
    // 限制在翻转方向的可用宽度内，长值不被视口裁掉。
    expect(Number.parseFloat(style.maxWidth)).toBeGreaterThan(0);
    expect(Number.parseFloat(style.maxWidth)).toBeLessThanOrEqual(288);
    expect(style.overflowWrap).toBe('anywhere');
    expect(wrapper?.textContent).toContain('二月');
    expect(wrapper?.textContent).toContain('4');
  });
});
