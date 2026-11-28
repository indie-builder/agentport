import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(host.textContent).toContain('Annual Visitors');
    expect(host.textContent).toContain('Museums');
  });
});

describe('CardBlock carousel', () => {
  it('uses the shadcn carousel with focusable, labelled controls and keyboard nav', async () => {
    const measureCallbacks: Array<() => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          measureCallbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
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
    const previous = byText<HTMLButtonElement>('[data-slot="carousel-previous"]', '上一张');
    const next = byText<HTMLButtonElement>('[data-slot="carousel-next"]', '下一张');
    expect(previous.querySelector('.sr-only')?.textContent).toBe('上一张');
    expect(next.querySelector('.sr-only')?.textContent).toBe('下一张');
    const items = [...host.querySelectorAll<HTMLElement>('[data-slot="carousel-item"]')];
    expect(items.length).toBe(2);

    // jsdom 没有真实轨道几何，这里按 ui-sdk 的读取方式补最小几何得到两页；真实滚动由主会话上屏核对。
    const viewport = host.querySelector<HTMLElement>('[data-slot="carousel-viewport"]');
    for (const [index, item] of items.entries()) {
      Object.defineProperty(item, 'offsetLeft', { configurable: true, value: index * 200 });
      item.style.width = '200px';
    }
    if (viewport) {
      Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
      Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: 600 });
    }
    await act(async () => {
      for (const measure of measureCallbacks) measure();
    });
    await settle();

    expect(previous.getAttribute('aria-disabled')).toBe('true');
    expect(previous.hasAttribute('data-disabled')).toBe(true);
    expect(next.hasAttribute('aria-disabled')).toBe(false);
    expect(next.hasAttribute('data-disabled')).toBe(false);
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(false);

    const keyEvent = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      viewport?.dispatchEvent(keyEvent);
    });
    await settle();
    expect(keyEvent.defaultPrevented).toBe(true);
    expect(previous.hasAttribute('aria-disabled')).toBe(false);
    expect(previous.hasAttribute('data-disabled')).toBe(false);
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(next.hasAttribute('data-disabled')).toBe(true);
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(false);
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
  it('defaults card charts to 192 only when no explicit height is given', async () => {
    await render(
      [
        'root = Card([block])',
        'block = CompositeCardBlock([a, b, c, d], "grid", true)',
        'a = CompositeCardItem("a", aHeader, [bar])',
        'aHeader = IconText(aIcon, "neutral", "m", "柱状图", "", false, "horizontal")',
        'aIcon = Icon("circle", "shapes")',
        'bar = BarChart(["一月"], [Series("收入", [1])], "grouped")',
        'b = CompositeCardItem("b", bHeader, [area])',
        'bHeader = IconText(bIcon, "neutral", "m", "面积图", "", false, "horizontal")',
        'bIcon = Icon("circle", "shapes")',
        'area = AreaChart(["一月"], [Series("收入", [1])], "linear", "", "", 120)',
        'c = CompositeCardItem("c", cHeader, [line])',
        'cHeader = IconText(cIcon, "neutral", "m", "折线图", "", false, "horizontal")',
        'cIcon = Icon("circle", "shapes")',
        'line = LineChart(["一月"], [Series("收入", [1])], "linear")',
        'd = CompositeCardItem("d", dHeader, [radial])',
        'dHeader = IconText(dIcon, "neutral", "m", "径向图", "", false, "horizontal")',
        'dIcon = Icon("circle", "shapes")',
        'radial = RadialChart(["甲", "乙"], [30, 70])',
      ].join('\n'),
    );
    const heights = [...host.querySelectorAll<HTMLElement>('[data-openui-chart-frame]')].map(
      (frame) => frame.style.height,
    );
    expect(heights).toEqual(['192px', '120px', '192px', '256px']);
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

    expect(host.querySelector('[role="button"] button')).toBeNull();
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

describe('MetricIndicatorWithStrikethrough', () => {
  it('renders value, strikethrough previousValue, trend and subtext', async () => {
    await render(
      [
        'root = Card([block])',
        'block = CompositeCardBlock([a, b], "grid", true)',
        'a = CompositeCardItem("a", aHeader, [aText], aFooter)',
        'aHeader = IconText(aIcon, "neutral", "m", "套餐甲", "", false, "horizontal")',
        'aIcon = Icon("circle", "shapes")',
        'aText = Text("text", "基础配置", "", "text", "sm")',
        'aFooter = { price: aPrice }',
        'aPrice = MetricIndicatorWithStrikethrough("¥199", "限时优惠", "¥299", { direction: "down", value: 33 })',
        'b = CompositeCardItem("b", bHeader, [bText])',
        'bHeader = IconText(bIcon, "neutral", "m", "套餐乙", "", false, "horizontal")',
        'bIcon = Icon("circle", "shapes")',
        'bText = Text("text", "标准配置", "", "text", "sm")',
      ].join('\n'),
    );

    expect(host.textContent).toContain('¥199');
    expect(host.textContent).toContain('¥299');
    expect(host.textContent).toContain('↓ 33%');
    expect(host.textContent).toContain('限时优惠');
    const previous = byText<HTMLSpanElement>('span', '¥299');
    expect(previous.className).toContain('line-through');
  });
});

describe('CompositeCard nesting and normalization', () => {
  it('avoids nested buttons when body contains clickable ListBlock and normalizes EntityList', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([block])',
        'block = CompositeCardBlock([a, b], "grid", true, @ToAssistant("点卡片"))',
        'a = CompositeCardItem("a", aHeader, [aList, aEntities], aFooter)',
        'aHeader = Text("text", "文本标题", "副说明", "text", "sm")',
        'aList = ListBlock([l1], "number")',
        'l1 = ListItem("列表项操作", "可点击", null, "打开", @ToAssistant("点列表项"))',
        'aEntities = EntityList([{left: "项", right: "10", rightVariant: "number"}], "default", {left: "头左", right: "头右", rightVariant: "text"}, {left: "尾左", right: "尾右", rightVariant: "text"})',
        'aFooter = { price: aPrice, button: aBtn }',
        'aPrice = BoldText("number", "¥99", "", "text", "sm")',
        'aBtn = Button("立即购买", @ToAssistant("购买"))',
        'b = CompositeCardItem("b", bHeader, [bText])',
        'bHeader = Image("封面描述", "https://example.com/cover.png")',
        'bText = Text("text", "正文二", "", "text", "sm")',
      ].join('\n'),
      { onAction },
    );

    expect(host.querySelector('[role="button"] button')).toBeNull();
    expect(host.textContent).not.toContain('头左');
    expect(host.textContent).not.toContain('尾左');
    expect(host.textContent).toContain('项');

    await act(async () => byText<HTMLElement>('[role="button"]', '文本标题').click());
    expect(onAction).toHaveBeenCalledTimes(1);
    const firstContext = String(onAction.mock.calls[0]?.[0]?.params?.context);
    expect(firstContext).toContain('"itemTitle":"文本标题"');
    expect(firstContext).toContain('"itemHeaderSubtitle":"副说明"');
    expect(firstContext).toContain('"itemFooterPrice":"¥99"');
    expect(firstContext).toContain('"itemFooterButtonLabel":"立即购买"');

    const listBtn = host.querySelector<HTMLButtonElement>('button[aria-label="列表项操作"]');
    expect(listBtn).not.toBeNull();
    await act(async () => listBtn?.click());
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction.mock.calls[1]?.[0]).toMatchObject({ message: '点列表项' });
  });

  it('avoids nested buttons when clickable CompositeCard body contains a chart', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Card([block])',
        'block = CompositeCardBlock([a, b], "grid", true, @ToAssistant("点图表卡"))',
        'a = CompositeCardItem("a", aHeader, [bar])',
        'aHeader = IconText(Icon("circle", "shapes"), "neutral", "m", "趋势卡", "", false, "horizontal")',
        'bar = BarChart(["一月"], [Series("收入", [1])], "grouped")',
        'b = CompositeCardItem("b", bHeader, [line])',
        'bHeader = IconText(Icon("circle", "shapes"), "neutral", "m", "折线卡", "", false, "horizontal")',
        'line = LineChart(["一月"], [Series("收入", [2])], "linear")',
      ].join('\n'),
      { onAction },
    );

    expect(host.querySelector('[role="button"] button')).toBeNull();
    expect(byText<HTMLButtonElement>('button', '数据视图')).toBeTruthy();
    await act(async () => byText<HTMLElement>('[role="button"]', '趋势卡').click());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({ message: '点图表卡' });
  });
});

describe('SectionBlock, Tabs keepMounted, Steps, Separator and Icon', () => {
  it('auto-opens streamed SectionBlock items in multiple mode and collapses to first on end', async () => {
    await render(
      [
        'root = Card([sec])',
        'sec = SectionBlock([s1], true)',
        's1 = SectionItem("one", "第一段", [TextContent("内容一")])',
      ].join('\n'),
      { streaming: true },
    );
    const triggers = () => [
      ...host.querySelectorAll<HTMLButtonElement>('[data-slot="accordion-trigger"]'),
    ];
    expect(triggers().map((t) => t.getAttribute('aria-expanded'))).toEqual(['true']);

    await render(
      [
        'root = Card([sec])',
        'sec = SectionBlock([s1, s2], true)',
        's1 = SectionItem("one", "第一段", [TextContent("内容一")])',
        's2 = SectionItem("two", "第二段", [TextContent("内容二")])',
      ].join('\n'),
      { streaming: true },
    );
    expect(triggers().map((t) => t.getAttribute('aria-expanded'))).toEqual(['true', 'true']);

    await render(
      [
        'root = Card([sec])',
        'sec = SectionBlock([s1, s2], true)',
        's1 = SectionItem("one", "第一段", [TextContent("内容一")])',
        's2 = SectionItem("two", "第二段", [TextContent("内容二")])',
      ].join('\n'),
      { streaming: false },
    );
    expect(triggers().map((t) => t.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  });

  it('keeps SectionBlock collapsed after user manually closes all sections across updates', async () => {
    await render(
      [
        'root = Card([sec])',
        'sec = SectionBlock([s1, s2], true)',
        's1 = SectionItem("one", "第一段", [TextContent("内容一")])',
        's2 = SectionItem("two", "第二段", [TextContent("内容二")])',
      ].join('\n'),
      { streaming: true },
    );
    const triggers = () => [
      ...host.querySelectorAll<HTMLButtonElement>('[data-slot="accordion-trigger"]'),
    ];
    for (const trigger of triggers()) {
      if (trigger.getAttribute('aria-expanded') === 'true') {
        await act(async () => trigger.click());
      }
    }
    expect(triggers().map((t) => t.getAttribute('aria-expanded'))).toEqual(['false', 'false']);

    await render(
      [
        'root = Card([sec])',
        'sec = SectionBlock([s1, s2, s3], true)',
        's1 = SectionItem("one", "第一段", [TextContent("内容一")])',
        's2 = SectionItem("two", "第二段", [TextContent("内容二")])',
        's3 = SectionItem("three", "第三段", [TextContent("内容三")])',
      ].join('\n'),
      { streaming: false },
    );
    expect(triggers().map((t) => t.getAttribute('aria-expanded'))).toEqual([
      'false',
      'false',
      'false',
    ]);
  });

  it('binds non-foldable SectionBlock headings via aria-labelledby', async () => {
    await render(
      [
        'root = Card([sec])',
        'sec = SectionBlock([s1], false)',
        's1 = SectionItem("one", "固定章节", [TextContent("正文")])',
      ].join('\n'),
    );
    const section = host.querySelector('section');
    const heading = section?.querySelector('h3');
    expect(heading?.id).toBeTruthy();
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id);
  });

  it('keeps TabsContent mounted across tab switches to preserve drafts', async () => {
    await render(
      [
        'root = Card([tabs])',
        'tabs = Tabs([t1, t2])',
        't1 = TabItem("first", "表单页", [form])',
        't2 = TabItem("second", "说明页", [TextContent("第二页内容")])',
        'form = Form("draftForm", btns, [fc])',
        'btns = Buttons([submit])',
        'submit = Button("提交", @ToAssistant("提交"))',
        'fc = FormControl("备注", inp)',
        'inp = Input("note", "", "text", {})',
      ].join('\n'),
    );

    const input = host.querySelector<HTMLInputElement>('input[name="note"]');
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, '未提交草稿');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => byText<HTMLElement>('[role="tab"]', '说明页').click());
    expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain(
      '第二页内容',
    );
    await act(async () => byText<HTMLElement>('[role="tab"]', '表单页').click());
    expect(host.querySelector<HTMLInputElement>('input[name="note"]')?.value).toBe('未提交草稿');
  });

  it('forwards decorative on Separator, renders Markdown in Steps, and falls back icons to category or circle-dot', async () => {
    await render(
      [
        'root = Card([sep, steps, ic1, ic2])',
        'sep = Separator("horizontal", true)',
        'steps = Steps([st1])',
        'st1 = StepsItem("第一步", "执行 **部署** 命令")',
        'ic1 = Icon("nonexistent-icon", "security")',
        'ic2 = Icon("nonexistent-icon", "unknown-category")',
      ].join('\n'),
    );

    expect(host.querySelector('[data-slot="separator"]')?.getAttribute('role')).toBe('none');
    expect(host.querySelector('[data-streamdown="strong"]')?.textContent).toBe('部署');
    expect(host.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });
});
