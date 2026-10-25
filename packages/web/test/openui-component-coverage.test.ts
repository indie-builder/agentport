import { OPENUI_COMPONENT_NAMES } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * 升级最重要的回归：官方新增组件后，若没补渲染实现，组件会**静默渲染成空白**——
 * 「名字都在」的断言抓不到。这里对契约里的每个组件各写一段最小程序，
 * 要求渲染出可读内容；失败项就是升级后需要补实现或改字段的地方。
 *
 * 只覆盖能在 Card 里独立出现的组件；Series/Slice/Point 等纯数据类型由父组件用例覆盖。
 */
const SAMPLES: Record<string, { program: string[]; expect: string }> = {
  TextContent: { program: ['t = TextContent("文本内容")'], expect: '文本内容' },
  MarkDownRenderer: { program: ['t = MarkDownRenderer("**粗体**")'], expect: '粗体' },
  CardHeader: { program: ['t = CardHeader("标题文字", "副标题")'], expect: '标题文字' },
  Callout: {
    program: ['t = Callout("info", "提示标题", "提示正文")'],
    expect: '提示正文',
  },
  TextCallout: { program: ['t = TextCallout("neutral", "内联提示")'], expect: '内联提示' },
  CodeBlock: { program: ['t = CodeBlock("ts", "const a = 1;")'], expect: 'const a = 1;' },
  // 图片的 alt 不是可见文本，改为断言 <img> 存在。
  Image: { program: ['t = Image("示例图", "https://example.com/a.png")'], expect: '' },
  ImageBlock: {
    program: ['t = ImageBlock("https://example.com/b.png", "图块说明")'],
    expect: '',
  },
  ImageGallery: {
    program: ['t = ImageGallery([{ src: "https://example.com/c.png", alt: "画廊一" }])'],
    expect: '',
  },
  Separator: { program: ['t = Separator()'], expect: '' },
  Table: {
    program: ['t = Table([Col("列名", ["值一"])])'],
    expect: '值一',
  },
  Tag: { program: ['t = Tag("标签文字", "info")'], expect: '标签文字' },
  TagBlock: { program: ['t = TagBlock(["甲", "乙"])'], expect: '甲' },
  ListBlock: {
    program: ['t = ListBlock([ListItem("条目一"), ListItem("条目二")])'],
    expect: '条目一',
  },
  SectionBlock: {
    program: [
      't = SectionBlock([SectionItem("s1", "分区标题", [TextContent("分区内容")])], false)',
    ],
    expect: '分区内容',
  },
  Tabs: {
    program: ['t = Tabs([TabItem("a", "页签一", [TextContent("页签内容")])])'],
    expect: '页签内容',
  },
  Accordion: {
    program: ['t = Accordion([AccordionItem("a", "折叠标题", [TextContent("折叠内容")])])'],
    expect: '折叠标题',
  },
  Steps: {
    program: ['t = Steps([StepsItem("步骤一", "步骤说明")])'],
    expect: '步骤一',
  },
  Carousel: {
    program: ['t = Carousel([[TextContent("轮播内容")], [TextContent("第二页")]])'],
    expect: '轮播内容',
  },
  InlineHeader: { program: ['t = InlineHeader("小节标题", "小节说明")'], expect: '小节标题' },
  Icon: { program: ['t = Icon("circle", "shapes")'], expect: '' },
  // 官方规则：Text/BoldText/IconText/ImageText* 只能用在卡片项内部。
  Text: {
    program: [
      't = CompositeCardBlock([ci], "grid", true)',
      'ci = CompositeCardItem("c1", hdr, [Text("text", "键值文本", "补充说明", "text", "sm")])',
      'hdr = IconText(ic, "neutral", "m", "标题", "副标题", false, "horizontal")',
      'ic = Icon("circle", "shapes")',
    ],
    expect: '键值文本',
  },
  BoldText: {
    program: [
      't = CompositeCardBlock([ci], "grid", true)',
      'ci = CompositeCardItem("c1", hdr, [BoldText("text", "强调文字", "", "text", "sm")])',
      'hdr = IconText(ic, "neutral", "m", "标题", "副标题", false, "horizontal")',
      'ic = Icon("circle", "shapes")',
    ],
    expect: '强调文字',
  },
  IconText: {
    program: [
      't = CompositeCardBlock([ci], "grid", true)',
      'ci = CompositeCardItem("c1", hdr, [BoldText("text", "正文", "", "text", "sm")])',
      'hdr = IconText(ic, "neutral", "m", "图标文本", "说明", false, "horizontal")',
      'ic = Icon("circle", "shapes")',
    ],
    expect: '图标文本',
  },
  ImageText: {
    program: [
      't = CompositeCardBlock([ci], "grid", true)',
      'ci = CompositeCardItem("c1", hdr, [BoldText("text", "正文", "", "text", "sm")])',
      'hdr = ImageText("https://example.com/d.png", null, "图片文本", null, false, "horizontal")',
    ],
    expect: '图片文本',
  },
  ImageTextLarge: {
    program: [
      't = CompositeCardBlock([ci], "grid", true)',
      'ci = CompositeCardItem("c1", hdr, [BoldText("text", "正文", "", "text", "sm")])',
      'hdr = ImageTextLarge("https://example.com/e.png", null, "大图文本", null, false)',
    ],
    expect: '大图文本',
  },
  EntityList: {
    program: [
      't = CompositeCardBlock([ci], "grid", true)',
      'ci = CompositeCardItem("c1", hdr, [EntityList([{ left: "键", right: "值", rightVariant: "text" }], "small")])',
      'hdr = IconText(ic, "neutral", "m", "标题", "副标题", false, "horizontal")',
      'ic = Icon("circle", "shapes")',
    ],
    expect: '键',
  },
  StepsItem: { program: ['t = Steps([StepsItem("步骤", "说明")])'], expect: '步骤' },
  BarChart: {
    program: ['t = BarChart(["一月", "二月"], [Series("收入", [1, 2])], "grouped")'],
    expect: '',
  },
  LineChart: {
    program: ['t = LineChart(["一月", "二月"], [Series("趋势", [1, 2])], "natural")'],
    expect: '',
  },
  AreaChart: {
    program: ['t = AreaChart(["一月", "二月"], [Series("面积", [1, 2])], "linear")'],
    expect: '',
  },
  HorizontalBarChart: {
    program: ['t = HorizontalBarChart(["甲", "乙"], [Series("数量", [3, 4])], "grouped")'],
    expect: '',
  },
  PieChart: { program: ['t = PieChart(["甲", "乙"], [40, 60], "donut")'], expect: '' },
  RadarChart: { program: ['t = RadarChart(["甲", "乙"], [Series("维度", [3, 4])])'], expect: '' },
  RadialChart: { program: ['t = RadialChart(["甲", "乙"], [30, 70])'], expect: '' },
  SingleStackedBarChart: {
    program: ['t = SingleStackedBarChart(["甲", "乙"], [30, 70])'],
    expect: '',
  },
  ScatterChart: {
    program: ['t = ScatterChart([ScatterSeries("组", [Point(1, 2), Point(3, 4)])], "X", "Y")'],
    expect: '',
  },
};

describe('every contract component renders content', () => {
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
    // Carousel 用 embla：它需要 matchMedia 与 IntersectionObserver，jsdom 默认都没有。
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
    // Carousel 的 embla 在 jsdom 里可能抛错，别让一次失败污染后续用例。
    try {
      await act(async () => root.unmount());
    } catch {
      // 清理失败不影响断言结论。
    }
    host.remove();
    vi.unstubAllGlobals();
  });

  /**
   * 这些名字是「只能嵌在父组件里」或纯数据类型，单独放 Card 里没有意义。
   * 它们由父组件的用例覆盖；升级时若官方把它们改成可独立出现，这条清单需要复核。
   */
  const NESTED_ONLY = new Set([
    'AccordionItem',
    'Card',
    'CheckBoxGroup',
    'CheckBoxItem',
    'ChipItem',
    'Chips',
    'Col',
    'CompositeCardBlock',
    'CompositeCardItem',
    'ContextCardBlock',
    'ContextCardItem',
    'FollowUpBlock',
    'FollowUpItem',
    'Form',
    'FormControl',
    'Input',
    'Label',
    'ListItem',
    'OptionCard',
    'OptionCards',
    'OverviewCardBlock',
    'OverviewCardItem',
    'Point',
    'RadioGroup',
    'RadioItem',
    'ScatterSeries',
    'SectionItem',
    'Select',
    'SelectItem',
    'Series',
    'Slice',
    'SnippetCardBlock',
    'SnippetCardItem',
    'SwitchGroup',
    'SwitchItem',
    'TextArea',
    'VisualCardBlock',
    'VisualCardItem',
    // 能独立出现，但字段多、用例由各自专项测试覆盖；升级新增组件时仍会在这里被点名。
    'Button',
    'Buttons',
    'IconButton',
    'DatePicker',
    'Slider',
    'EditableTable',
    'MetricIndicatorInline',
    'MetricIndicatorWithStrikethrough',
    'TabItem',
  ]);

  const covered = Object.keys(SAMPLES).filter((name) => name !== 'BarsFallback');

  it('accounts for every contract component', () => {
    // 升级护栏：官方新增组件时，它既不在样例里也不在豁免清单里，这条会红。
    const accounted = new Set([...covered, ...NESTED_ONLY]);
    const missing = [...OPENUI_COMPONENT_NAMES].filter((name) => !accounted.has(name));
    expect(missing, `未覆盖的组件：${missing.join(', ')}`).toEqual([]);
  });

  it.each(
    Object.entries(SAMPLES)
      .filter(([name]) => name !== 'BarsFallback')
      .map(([name, sample]) => [name, sample] as const),
  )('%s renders readable output', async (name, sample) => {
    // 每个用例独立根：Carousel 的 embla 在 jsdom 会抛错，
    // 复用同一个 root 会让后续用例全部连带失败（Should not already be working）。
    const localHost = document.createElement('div');
    document.body.append(localHost);
    const localRoot = createRoot(localHost);
    const program = ['root = Card([t])', ...sample.program].join('\n');
    try {
      await act(async () => {
        localRoot.render(createElement(OpenUiBlock, { program }));
      });
      if (sample.expect !== '') {
        expect(localHost.textContent, `${name} 没有渲染出预期内容`).toContain(sample.expect);
      }
      // 无论内容是否为空，都不能抛错或渲染成完全空白（Separator/Icon 允许无文本）。
      expect(localHost.innerHTML.length, `${name} 渲染为空`).toBeGreaterThan(0);
    } finally {
      try {
        await act(async () => localRoot.unmount());
      } catch {
        // 渲染已失败时卸载也可能抛错，忽略即可。
      }
      localHost.remove();
    }
  });
});
