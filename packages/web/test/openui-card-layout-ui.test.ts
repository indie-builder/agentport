import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCardChartHeight } from '../src/openui/components/data.js';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * 卡片/表格的呈现基线：官方 shadcn 示例负责结构，本项目的令牌负责视觉。
 * jsdom 量不到真实几何，布局用例只断言容器查询与跨列声明，
 * 实际单双列切换由主会话在真实消息宽度下测量。
 */

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
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = '';
      thresholds = [];
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function settle(rounds = 12): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(program: string, props: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(OpenUiBlock, { program, ...props }));
  });
  await settle();
}

function byText<T extends Element>(selector: string, text: string): T {
  const found = [...host.querySelectorAll<T>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`${selector} not found: ${text}`);
  return found;
}

function overviewBlock(items: string[], responsive = true): string[] {
  const entries = items.map((name, index) => {
    const top = `t${index}`;
    return {
      item: `i${index} = OverviewCardItem("${name}", ${top})`,
      top: `${top} = Text("text", "${name}", "", "text", "sm")`,
    };
  });
  return [
    `root = Card([block])`,
    `block = OverviewCardBlock([${items.map((_, index) => `i${index}`).join(', ')}], "grid", ${responsive})`,
    ...entries.map((entry) => entry.item),
    ...entries.map((entry) => entry.top),
  ];
}

describe('OverviewCard metric slot', () => {
  it('renders the bottom MetricIndicatorInline node with value, subtext and trend', async () => {
    await render(
      [
        'root = Card([block])',
        'block = OverviewCardBlock([a, b], "grid", true)',
        'a = OverviewCardItem("visitors", aTop, aMetric)',
        'aTop = IconText(aIcon, "neutral", "m", "Annual Visitors", "2024 arrivals", false, "vertical")',
        'aIcon = Icon("users", "people")',
        'aMetric = MetricIndicatorInline("48.7M", "tourists", { direction: "up", value: 2.5 })',
        'b = OverviewCardItem("museums", bTop, bMetric)',
        'bTop = IconText(bIcon, "neutral", "m", "Museums", "Cultural sites", false, "vertical")',
        'bIcon = Icon("landmark", "buildings")',
        'bMetric = MetricIndicatorInline("2,370+", "across the city")',
      ].join('\n'),
    );

    expect(host.textContent).toContain('48.7M');
    expect(host.textContent).toContain('tourists');
    expect(host.textContent).toContain('2.5%');
    expect(host.textContent).toContain('2,370+');
    expect(host.textContent).toContain('across the city');
    // 顶槽不能被底槽替换或丢弃。
    expect(host.textContent).toContain('Annual Visitors');
    expect(host.textContent).toContain('Museums');
  });
});

describe('Text / BoldText weight', () => {
  it('keeps plain Text at 400 and BoldText at 600', async () => {
    await render(
      [
        'root = Card([block])',
        'block = CompositeCardBlock([a, b], "grid", true)',
        'a = CompositeCardItem("a", aHeader, [plain])',
        'aHeader = IconText(aIcon, "neutral", "m", "卡片一", "说明", false, "horizontal")',
        'aIcon = Icon("circle", "shapes")',
        'plain = Text("text", "普通文字", "", "text", "sm")',
        'b = CompositeCardItem("b", bHeader, [strong])',
        'bHeader = IconText(bIcon, "neutral", "m", "卡片二", "说明", false, "horizontal")',
        'bIcon = Icon("circle", "shapes")',
        'strong = BoldText("text", "强调文字", "", "text", "sm")',
      ].join('\n'),
    );

    expect(byText('span', '普通文字').className).toContain('font-normal');
    expect(byText('span', '普通文字').className).not.toContain('font-medium');
    expect(byText('span', '强调文字').className).toContain('font-semibold');
  });
});

describe('CardBlock grid layout', () => {
  it('switches columns on the message container, not the viewport', async () => {
    await render(overviewBlock(['甲', '乙']).join('\n'));
    const wrapper = host.querySelector('[class~="@container"]');
    expect(wrapper).not.toBeNull();
    const grid = wrapper?.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('@min-[481px]:grid-cols-2');
    expect(grid.className).toContain('gap-3');
    expect(grid.className).not.toContain('sm:grid-cols-2');
  });

  it('lets the last card span the full row for 3 and 5 items, but not for 4', async () => {
    await render(overviewBlock(['甲', '乙', '丙']).join('\n'));
    const three = host.querySelector('[class~="@container"]')?.firstElementChild as HTMLElement;
    expect(three.className).toContain('@min-[481px]:[&>*:last-child]:col-span-2');

    await act(async () => root.unmount());
    root = createRoot(host);

    await render(overviewBlock(['甲', '乙', '丙', '丁', '戊']).join('\n'));
    const five = host.querySelector('[class~="@container"]')?.firstElementChild as HTMLElement;
    expect(five.className).toContain('@min-[481px]:[&>*:last-child]:col-span-2');

    await act(async () => root.unmount());
    root = createRoot(host);

    await render(overviewBlock(['甲', '乙', '丙', '丁']).join('\n'));
    const four = host.querySelector('[class~="@container"]')?.firstElementChild as HTMLElement;
    expect(four.className).not.toContain('col-span-2');
  });

  it('keeps the original fixed grid when responsive is false', async () => {
    await render(overviewBlock(['甲', '乙'], false).join('\n'));
    const grid = host.querySelector('[class~="@container"]')?.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).not.toContain('@min-[481px]');
  });
});

describe('CardBlock carousel', () => {
  /** 轨道本身：间距来自 gap，不用 item 内距，否则 basis 会把 12px 内距算进卡宽。 */
  function track(): HTMLElement | null {
    return host.querySelector<HTMLElement>('[data-slot="carousel-content"] > div');
  }

  it('keeps container-relative card widths only when responsive is true', async () => {
    await render(
      [
        'root = Card([block])',
        'block = ContextCardBlock([a, b], "carousel", true)',
        'a = ContextCardItem("a", "第一张", "说明一")',
        'b = ContextCardItem("b", "第二张", "说明二")',
      ].join('\n'),
    );
    const items = [...host.querySelectorAll<HTMLElement>('[data-slot="carousel-item"]')];
    expect(items.length).toBe(2);
    // 盒模型：轨道 gap 与卡宽共用 --openui-card-gap，默认 3 个 spacing 单位；
    // 两列各让出半个 gap，两张 50%+50%-gap 加一个 gap 正好铺满轨道。
    expect(items[0]?.className).toContain('basis-4/5');
    expect(items[0]?.className).toContain(
      '@min-[481px]:basis-[calc((100%_-_var(--openui-card-gap))/2)]',
    );
    expect(track()?.style.getPropertyValue('--openui-card-gap')).toBe('calc(var(--spacing) * 3)');
    expect(track()?.style.gap).toBe('calc(var(--spacing) * 3)');
    expect(track()?.className).toContain('ml-0');
    expect(track()?.className).not.toContain('-ml-4');
    expect(track()?.className).not.toContain('-ml-3');
    for (const item of items) {
      expect(item.className).not.toContain('pl-3');
      expect(item.className).toContain('pl-0');
    }
  });

  it('drops breakpoints and keeps the official fixed card width when responsive is false', async () => {
    await render(
      [
        'root = Card([block])',
        'block = ContextCardBlock([a, b], "carousel", false)',
        'a = ContextCardItem("a", "第一张", "说明一")',
        'b = ContextCardItem("b", "第二张", "说明二")',
      ].join('\n'),
    );
    const small = [...host.querySelectorAll<HTMLElement>('[data-slot="carousel-item"]')];
    expect(small.length).toBe(2);
    // 官方 small 卡片固定 17.5rem，不随容器换列；无内距时 basis-70 就是真实卡宽。
    expect(small[0]?.className).toContain('basis-70');
    expect(small[0]?.className).not.toContain('basis-4/5');
    expect(small[0]?.className).not.toContain('@min-[481px]');
    expect(small[0]?.className).not.toContain('pl-3');

    await act(async () => root.unmount());
    root = createRoot(host);

    await render(
      [
        'root = Card([block])',
        'block = CompositeCardBlock([a, b], "carousel", false)',
        'a = CompositeCardItem("a", aHeader, [aText])',
        'aHeader = IconText(aIcon, "neutral", "m", "标题一", "副标题一", false, "horizontal")',
        'aIcon = Icon("circle", "shapes")',
        'aText = Text("text", "正文一", "", "text", "sm")',
        'b = CompositeCardItem("b", bHeader, [bText])',
        'bHeader = IconText(bIcon, "neutral", "m", "标题二", "副标题二", false, "horizontal")',
        'bIcon = Icon("circle", "shapes")',
        'bText = Text("text", "正文二", "", "text", "sm")',
      ].join('\n'),
    );
    const medium = [...host.querySelectorAll<HTMLElement>('[data-slot="carousel-item"]')];
    expect(medium.length).toBe(2);
    // 官方 medium 卡片固定 20rem。
    expect(medium[0]?.className).toContain('basis-80');
    expect(medium[0]?.className).not.toContain('@min-[481px]');
    expect(medium[0]?.className).not.toContain('pl-3');
  });

  it('keeps the official Overview carousel widths regardless of responsive', async () => {
    const program = (responsive: boolean) =>
      [
        'root = Card([block])',
        `block = OverviewCardBlock([a, b], "carousel", ${responsive})`,
        'a = OverviewCardItem("visitors", aTop)',
        'aTop = Text("text", "访客", "", "text", "sm")',
        'b = OverviewCardItem("museums", bTop)',
        'bTop = Text("text", "博物馆", "", "text", "sm")',
      ].join('\n');

    for (const responsive of [true, false]) {
      await act(async () => root.unmount());
      root = createRoot(host);
      await render(program(responsive));
      const items = [...host.querySelectorAll<HTMLElement>('[data-slot="carousel-item"]')];
      expect(items.length).toBe(2);
      // 官方 smallCardBlock.css 特例：Overview carousel 固定 15rem（basis-60），
      // 容器 ≤30rem 时 12.5rem（basis-50），与 responsive 无关。
      expect(items[0]?.className).toContain('basis-60');
      expect(items[0]?.className).toContain('@max-[30rem]:basis-50');
      expect(items[0]?.className).not.toContain('basis-4/5');
      expect(items[0]?.className).not.toContain('basis-70');
      expect(items[0]?.className).not.toContain('pl-3');
    }
  });

  it('feeds a custom gap into the shared card-gap variable', async () => {
    await render(
      [
        'root = Card([block])',
        'block = ContextCardBlock([a, b], "carousel", true, null, 20)',
        'a = ContextCardItem("a", "第一张", "说明一")',
        'b = ContextCardItem("b", "第二张", "说明二")',
      ].join('\n'),
    );
    const items = [...host.querySelectorAll<HTMLElement>('[data-slot="carousel-item"]')];
    expect(items.length).toBe(2);
    expect(track()?.style.gap).toBe('20px');
    expect(track()?.style.getPropertyValue('--openui-card-gap')).toBe('20px');
    // 卡宽公式引用同一变量，自定义 gap 下两张卡加一个 gap 仍正好铺满轨道。
    expect(items[0]?.className).toContain(
      '@min-[481px]:basis-[calc((100%_-_var(--openui-card-gap))/2)]',
    );
    expect(items[0]?.className).not.toContain('pl-3');
  });

  it('uses the shadcn carousel with focusable, labelled controls and keyboard nav', async () => {
    await render(
      [
        'root = Card([block])',
        'block = ContextCardBlock([a, b], "carousel", true)',
        'a = ContextCardItem("a", "第一张", "说明一")',
        'b = ContextCardItem("b", "第二张", "说明二")',
      ].join('\n'),
    );

    const region = host.querySelector('[aria-roledescription="carousel"]');
    expect(region).not.toBeNull();
    const previous = byText<HTMLButtonElement>('[data-slot="carousel-previous"]', 'Previous slide');
    const next = byText<HTMLButtonElement>('[data-slot="carousel-next"]', 'Next slide');
    expect(previous.querySelector('.sr-only')?.textContent).toBe('Previous slide');
    expect(next.querySelector('.sr-only')?.textContent).toBe('Next slide');
    expect(host.querySelectorAll('[data-slot="carousel-item"]').length).toBe(2);

    // jsdom 没有轨道几何，两个按钮都会是禁用态；真实可滚动性由主会话上屏核对。
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    // 键盘方向键由 carousel 原语接管；jsdom 量不到轨道尺寸，这里只验证事件被消费。
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      region?.dispatchEvent(keyEvent);
    });
    await settle();
    expect(keyEvent.defaultPrevented).toBe(true);
    expect(previous.tabIndex).toBeGreaterThanOrEqual(0);
    expect(next.tabIndex).toBeGreaterThanOrEqual(0);
  });
});

describe('Table columns', () => {
  it('keeps numbers unbroken and right-aligned while long text can wrap', async () => {
    const description =
      '这是一段很长的描述文字，用来确认文本列在消息宽度内换行，而不会把整张表撑出页面。';
    await render(
      [
        'root = Card([tbl])',
        `tbl = Table([nameCol, countCol])`,
        `nameCol = Col("名称", ["${description}"], "string")`,
        'countCol = Col("数量", [1234], "number")',
      ].join('\n'),
    );

    const cells = [...host.querySelectorAll('td')];
    expect(cells.length).toBe(2);
    const textCell = cells[0] as HTMLElement;
    const numberCell = cells[1] as HTMLElement;
    expect(textCell.textContent).toContain(description);
    expect(textCell.className).toContain('whitespace-normal');
    expect(textCell.className).not.toContain('break-all');
    expect(numberCell.textContent).toBe('1234');
    expect(numberCell.className).toContain('whitespace-nowrap');
    expect(numberCell.className).toContain('text-right');
    expect(numberCell.className).toContain('font-mono');

    const heads = [...host.querySelectorAll('th')];
    expect(heads[1]?.className).toContain('text-right');
  });
});

describe('CompositeCard chart height', () => {
  const element = (typeName: string, props: Record<string, unknown> = {}) => ({
    type: 'element',
    typeName,
    props,
  });

  it('defaults card charts to 192 only when no explicit height is given', () => {
    // 官方做法：复制节点再补默认 props，不改 schema，也不动其它组件。
    expect(withCardChartHeight(element('BarChart', { labels: ['一月'] }))).toMatchObject({
      typeName: 'BarChart',
      props: { labels: ['一月'], height: 192 },
    });
    expect(withCardChartHeight(element('AreaChart', { height: 120 })).props).toMatchObject({
      height: 120,
    });
    expect(withCardChartHeight(element('LineChart', {})).props).toMatchObject({ height: 192 });

    const text = element('Text', { value: '说明' });
    expect(withCardChartHeight(text)).toBe(text);
    const radial = element('RadialChart', {});
    expect(withCardChartHeight(radial)).toBe(radial);
    expect(withCardChartHeight('plain')).toBe('plain');
  });
});

describe('CompositeCard footer actions', () => {
  it('keeps block action context and never lets a footer button bubble into the block action', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([block])',
        'block = CompositeCardBlock([a, b], "grid", true, @ToAssistant("打开这张卡"))',
        'a = CompositeCardItem("a", aHeader, [aText], aFooter)',
        'aHeader = IconText(aIcon, "neutral", "m", "标题一", "副标题一", false, "horizontal")',
        'aIcon = Icon("circle", "shapes")',
        'aText = Text("text", "正文一", "", "text", "sm")',
        'aFooter = { button: aButton }',
        'aButton = Button("查看详情", @ToAssistant("查看详情"))',
        'b = CompositeCardItem("b", bHeader, [bText])',
        'bHeader = IconText(bIcon, "neutral", "m", "标题二", "副标题二", false, "horizontal")',
        'bIcon = Icon("circle", "shapes")',
        'bText = Text("text", "正文二", "", "text", "sm")',
      ].join('\n'),
      { onAction },
    );

    const card = byText<HTMLElement>('[role="button"]', '标题一');
    await act(async () => card.click());

    expect(onAction).toHaveBeenCalledTimes(1);
    const blockAction = onAction.mock.calls[0]?.[0];
    expect(blockAction).toMatchObject({
      type: 'continue_conversation',
      message: '打开这张卡',
    });
    // 官方 cardActionUtils 语义：选中项的上下文追加在 ToAssistant 步骤的 context 里。
    expect(String(blockAction.params.context)).toContain('"itemId":"a"');
    expect(String(blockAction.params.context)).toContain('"itemTitle":"标题一"');

    await act(async () => byText<HTMLButtonElement>('button', '查看详情').click());
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction.mock.calls[1]?.[0]).toMatchObject({
      type: 'continue_conversation',
      message: '查看详情',
    });
  });
});
