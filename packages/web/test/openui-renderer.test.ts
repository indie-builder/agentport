import { isSafeOpenUrl, OPENUI_COMPONENT_NAMES } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { missingOpenUiRenderers, OPENUI_RENDERERS } from '../src/openui/components/index.js';
import { OpenUiBlock } from '../src/openui/renderer.js';

describe('OPENUI_RENDERERS', () => {
  it('implements every component in the generated contract', () => {
    expect(missingOpenUiRenderers()).toEqual([]);
    expect(Object.keys(OPENUI_RENDERERS).sort()).toEqual([...OPENUI_COMPONENT_NAMES].sort());
  });
});

describe('isSafeOpenUrl', () => {
  it.each([
    ['https://example.com/a', true],
    ['http://example.com', true],
    ['javascript:alert(1)', false],
    ['data:text/html,<script>alert(1)</script>', false],
    ['vbscript:msgbox(1)', false],
    ['//example.com', false],
    ['not a url', false],
  ])('%s → %s', (url, allowed) => {
    expect(isSafeOpenUrl(url)).toBe(allowed);
  });
});

// ─── 渲染 ─────────────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Recharts 与分栏库都需要 ResizeObserver；jsdom 没有。
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(program: string, props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(createElement(OpenUiBlock, { program, ...props }));
  });
}

describe('OpenUiBlock', () => {
  it('renders a card program with prose, table and buttons', async () => {
    await render(
      [
        'root = Card([header, intro, tbl, buttons])',
        'header = CardHeader("周报", "10 月第 4 周")',
        'intro = TextContent("本周完成 12 项。")',
        'tbl = Table([Col("项目", ["接入", "评审"]), Col("耗时", [3, 5], "number")])',
        'buttons = Buttons([b1])',
        'b1 = Button("继续分析", @ToAssistant("继续分析"), "primary")',
      ].join('\n'),
    );
    expect(host.textContent).toContain('周报');
    expect(host.textContent).toContain('本周完成 12 项');
    expect(host.textContent).toContain('接入');
    expect(host.textContent).toContain('继续分析');
  });

  it('right-aligns numeric columns and uses tabular figures', async () => {
    await render(
      [
        'root = Card([tbl])',
        'tbl = Table([Col("渠道", ["自然搜索"]), Col("收入", [82.4], "number")])',
      ].join('\n'),
    );
    const cells = [...host.querySelectorAll('td')];
    const revenue = cells.find((cell) => cell.textContent === '82.4');
    expect(revenue?.className).toContain('text-right');
    expect(revenue?.className).toContain('font-mono');
    expect(revenue?.className).toContain('tabular-nums');
    const channel = cells.find((cell) => cell.textContent === '自然搜索');
    expect(channel?.className).not.toContain('text-right');
  });

  it('shows inline errors when a primary button validates the form', async () => {
    await render(
      [
        'root = Card([form])',
        'form = Form("trip", buttons, [fc])',
        'buttons = Buttons([submit])',
        'submit = Button("提交", @ToAssistant("提交"), "primary")',
        'fc = FormControl("邮箱", mail, "用于接收行程")',
        'mail = Input("email", "you@example.com", "email", { required: true, email: true })',
      ].join('\n'),
    );
    const submit = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '提交',
    );
    expect(submit).toBeTruthy();
    await act(async () => submit?.click());
    expect(host.textContent).toContain('This field is required');
    // 校验失败不发动作：没有新的回调可断言，但错误必须就地出现。
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('reports a settled program without a root so the caller can fall back', async () => {
    const onInvalid = vi.fn();
    await render('这不是程序', { onInvalid });
    expect(onInvalid).toHaveBeenCalledWith('这不是程序');
  });

  it('never opens non-http actions', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const onAction = vi.fn();
    await render(
      ['root = Card([b])', 'b = Button("危险", @OpenUrl("javascript:alert(1)"), "primary")'].join(
        '\n',
      ),
      { onAction },
    );
    const button = [...host.querySelectorAll('button')].find(
      (element) => element.textContent === '危险',
    );
    await act(async () => button?.click());
    expect(open).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('opens http(s) links in a new tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await render(
      ['root = Card([b])', 'b = Button("打开", @OpenUrl("https://example.com"), "primary")'].join(
        '\n',
      ),
    );
    const button = [...host.querySelectorAll('button')].find(
      (element) => element.textContent === '打开',
    );
    await act(async () => button?.click());
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });

  it('renders charts without data and with a single value', async () => {
    await render(
      [
        'root = Card([empty, one])',
        'empty = BarChart([], [])',
        'one = LineChart(["一月"], [Series("收入", [1])])',
      ].join('\n'),
    );
    // Recharts 在 jsdom 里量不到尺寸，只画容器；断言系列配置进了颜色变量。
    expect(host.querySelector('[data-chart]')).toBeTruthy();
    expect(host.textContent).toContain('--color-收入: var(--color-primary)');
    // 无数据图表不占位。
    expect(host.querySelectorAll('[data-chart]')).toHaveLength(1);
  });

  it('survives a missing lucide icon name', async () => {
    await render(
      [
        'root = Card([row])',
        'row = IconText(Icon("not-a-real-icon", "people"), "neutral", "m", "标题", "说明", false, "horizontal")',
      ].join('\n'),
    );
    expect(host.textContent).toContain('标题');
  });

  it('mounts the non-text form controls without crashing', async () => {
    await render(
      [
        'root = Card([form])',
        'form = Form("prefs", buttons, [fcSelect, fcSlider, fcChips, fcOptions, fcSwitch, fcCheck, fcRadio, fcDate])',
        'buttons = Buttons([ok])',
        'ok = Button("保存", @ToAssistant("保存"), "primary")',
        'fcSelect = FormControl("人数", sel)',
        'sel = Select("people", [s1, s2], "选择人数", { required: true })',
        's1 = SelectItem("1", "1 人")',
        's2 = SelectItem("2", "2 人")',
        'fcSlider = FormControl("预算", slider)',
        'slider = Slider("budget", "discrete", 0, 100, 10, [20])',
        'fcChips = FormControl("住宿", chips)',
        'chips = Chips("stay", "multiple", [c1], {}, ["hotel"])',
        'c1 = ChipItem("hotel", "酒店")',
        'fcOptions = FormControl("类型", options)',
        'options = OptionCards("kind", "single", [o1], { required: true })',
        'o1 = OptionCard("city", "城市", "都市漫步")',
        'fcSwitch = FormControl("通知", switches)',
        'switches = SwitchGroup("notify", [sw1])',
        'sw1 = SwitchItem("邮件", "每日摘要", "email", true)',
        'fcCheck = FormControl("兴趣", checks)',
        'checks = CheckBoxGroup("hobbies", [cb1])',
        'cb1 = CheckBoxItem("徒步", "山区路线", "hiking", true)',
        'fcRadio = FormControl("节奏", radios)',
        'radios = RadioGroup("pace", [r1, r2], "slow")',
        'r1 = RadioItem("慢", "轻松", "slow")',
        'r2 = RadioItem("快", "紧凑", "fast")',
        'fcDate = FormControl("日期", date)',
        'date = DatePicker("when", "single")',
      ].join('\n'),
    );
    expect(host.textContent).toContain('人数');
    expect(host.textContent).toContain('预算');
    expect(host.textContent).toContain('酒店');
    expect(host.textContent).toContain('城市');
    expect(host.textContent).toContain('每日摘要');
    expect(host.textContent).toContain('徒步');
    expect(host.textContent).toContain('轻松');
    expect(host.textContent).toContain('Select date...');
    // 只允许一个 primary 提交按钮。
    expect(
      [...host.querySelectorAll('button')].filter((b) => b.textContent === '保存'),
    ).toHaveLength(1);
  });

  it('renders tabs, accordion, steps and lists', async () => {
    await render(
      [
        'root = Card([tabs, acc, steps, list, follow, tags])',
        'tabs = Tabs([t1, t2])',
        't1 = TabItem("a", "春季", [TextContent("樱花")])',
        't2 = TabItem("b", "夏季", [TextContent("塞纳河")])',
        'acc = Accordion([a1])',
        'a1 = AccordionItem("faq", "常见问题", [TextContent("答案")])',
        'steps = Steps([st1])',
        'st1 = StepsItem("第一步", "准备材料")',
        'list = ListBlock([li1], "number")',
        'li1 = ListItem("条目", "说明")',
        'follow = FollowUpBlock([f1])',
        'f1 = FollowUpItem("展开讲讲")',
        'tags = TagBlock(["标签一", "标签二"])',
      ].join('\n'),
    );
    expect(host.textContent).toContain('春季');
    expect(host.textContent).toContain('常见问题');
    expect(host.textContent).toContain('准备材料');
    expect(host.textContent).toContain('条目');
    expect(host.textContent).toContain('展开讲讲');
    expect(host.textContent).toContain('标签二');
  });
});
