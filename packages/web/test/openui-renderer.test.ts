import { isSafeOpenUrl, OPENUI_COMPONENT_NAMES, type OpenUiToolResult } from '@agentport/shared';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { OPENUI_RENDERERS } from '../src/openui/components/index.js';
import { OpenUiBlock, type OpenUiToolCallInput } from '../src/openui/renderer.js';

describe('OPENUI_RENDERERS', () => {
  it('implements every component in the generated contract', () => {
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
    const card = host.firstElementChild?.firstElementChild;
    expect(card?.hasAttribute('tabindex')).toBe(false);
    expect(card?.hasAttribute('role')).toBe(false);
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

  it('renders only http(s) card sources as links', async () => {
    await render(
      [
        'root = Card([t], [{title: "危险链接", sourceName: "来源甲", url: "javascript:alert(1)"}, {title: "数据链接", sourceName: "来源乙", url: "data:text/html,<script>alert(1)</script>"}, {title: "正常链接", sourceName: "来源丙", url: "https://example.com/a"}])',
        't = TextContent("正文")',
      ].join('\n'),
    );
    expect(host.textContent).toContain('危险链接');
    expect(host.textContent).toContain('数据链接');
    const anchors = [...host.querySelectorAll('a')];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute('href')).toBe('https://example.com/a');
    expect(anchors[0]?.textContent).toBe('正常链接');
    const dangerous = [...host.querySelectorAll('span')].find(
      (span) => span.textContent === '危险链接',
    );
    expect(dangerous?.closest('a')).toBeNull();
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
    expect(host.textContent).toContain('--color-s0: var(--color-chart-runs)');
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

  it('ignores warning-severity diagnostics when a fallback root renders', async () => {
    await render(['card = Card([t])', 't = TextContent("回退渲染内容")'].join('\n'));
    expect(host.textContent).toContain('回退渲染内容');
    expect(host.textContent).not.toContain('这段界面有内容没有显示出来');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('disables observability publishing during streaming and settlement', async () => {
    const bus = (
      globalThis as Record<symbol, { listenAll?: (fn: (event: unknown) => void) => () => void }>
    )[Symbol.for('openui.observability')];
    const events: unknown[] = [];
    const unsubscribe = bus?.listenAll?.((event) => events.push(event));
    try {
      await render(['root = Card([t])', 't = TextContent("流式中")'].join('\n'), {
        streaming: true,
      });
      await render(['root = Card([t])', 't = TextContent("已完成")'].join('\n'), {
        streaming: false,
      });
      expect(events).toEqual([]);
    } finally {
      unsubscribe?.();
    }
  });

  it('maps tool error results to mcp-error and ApiError NOT_FOUND to tool-not-found', async () => {
    const settle = async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    };

    const mcpToolCall = vi
      .fn<(input: OpenUiToolCallInput) => Promise<OpenUiToolResult>>()
      .mockResolvedValue({ status: 'error', error: '数据源超时' });
    await render(
      [
        'root = Card([t])',
        'metrics = Query("fetch_metrics", {}, { summary: "默认" })',
        't = TextContent(metrics.summary)',
      ].join('\n'),
      {
        streaming: false,
        conversationId: 'conversation_err',
        messageId: 'message_err_mcp',
        blockKey: 's0',
        onToolCall: mcpToolCall,
      },
    );
    await settle();
    expect(host.textContent).toContain('Query "fetch_metrics" returned an error: 数据源超时');

    const notFoundToolCall = vi
      .fn<(input: OpenUiToolCallInput) => Promise<OpenUiToolResult>>()
      .mockRejectedValue(new ApiError(404, '工具不存在', { code: 'NOT_FOUND' }));
    await render(
      [
        'root = Card([t])',
        'missing = Query("missing_tool", {}, { summary: "默认" })',
        't = TextContent(missing.summary)',
      ].join('\n'),
      {
        streaming: false,
        conversationId: 'conversation_err',
        messageId: 'message_err_404',
        blockKey: 's0',
        onToolCall: notFoundToolCall,
      },
    );
    await settle();
    expect(host.textContent).toContain('Query tool "missing_tool" not found');
  });

  it('waits for pending state flush before dispatching continue_conversation even when save fails', async () => {
    const formProgram = [
      'root = Card([form])',
      'form = Form("booking", buttons, [fc])',
      'buttons = Buttons([submit])',
      'submit = Button("提交", @ToAssistant("提交"), "primary")',
      'fc = FormControl("姓名", name)',
      'name = Input("fullName", "", "text", {})',
    ].join('\n');
    const typeName = async (value: string) => {
      const input = host.querySelector<HTMLInputElement>('input[name="fullName"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      await act(async () => {
        setter?.call(input, value);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const clickSubmit = async () => {
      const button = [...host.querySelectorAll('button')].find(
        (element) => element.textContent === '提交',
      );
      await act(async () => button?.click());
    };

    let resolveFirstSave: () => void = () => {};
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve;
    });
    const onSaveState = vi
      .fn<() => Promise<unknown>>()
      .mockReturnValueOnce(firstSave)
      .mockRejectedValueOnce(new Error('保存失败'));
    const onAction = vi.fn();

    await render(formProgram, {
      streaming: false,
      conversationId: 'conversation_flush',
      messageId: 'message_flush',
      blockKey: 's0',
      onSaveState,
      onAction,
    });

    await typeName('李四');
    await clickSubmit();
    expect(onSaveState).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirstSave();
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledTimes(1);

    await typeName('王五');
    await clickSubmit();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSaveState).toHaveBeenCalledTimes(2);
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('waits for queued dirty state after an in-flight save before dispatching continue_conversation', async () => {
    const formProgram = [
      'root = Card([form])',
      'form = Form("booking", buttons, [fc])',
      'buttons = Buttons([submit])',
      'submit = Button("提交", @ToAssistant("提交"), "primary")',
      'fc = FormControl("姓名", name)',
      'name = Input("fullName", "", "text", {})',
    ].join('\n');
    const typeName = async (value: string) => {
      const input = host.querySelector<HTMLInputElement>('input[name="fullName"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      await act(async () => {
        setter?.call(input, value);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const clickSubmit = async () => {
      const button = [...host.querySelectorAll('button')].find(
        (element) => element.textContent === '提交',
      );
      await act(async () => button?.click());
    };

    let resolveFirstSave: () => void = () => {};
    let resolveSecondSave: () => void = () => {};
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve;
    });
    const secondSave = new Promise<void>((resolve) => {
      resolveSecondSave = resolve;
    });
    const onSaveState = vi
      .fn<() => Promise<unknown>>()
      .mockReturnValueOnce(firstSave)
      .mockReturnValueOnce(secondSave);
    const onAction = vi.fn();

    await render(formProgram, {
      streaming: false,
      conversationId: 'conversation_inflight',
      messageId: 'message_inflight',
      blockKey: 's0',
      onSaveState,
      onAction,
    });

    await typeName('第一版');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    visibility.mockRestore();
    expect(onSaveState).toHaveBeenCalledTimes(1);

    await typeName('第二版');
    await clickSubmit();
    expect(onAction).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirstSave();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSaveState).toHaveBeenCalledTimes(2);
    expect(onAction).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecondSave();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('merges streaming patch statements with previousProgram for live preview', async () => {
    const previousProgram = [
      'root = Card([header, intro])',
      'header = CardHeader("周报", "原副标题")',
      'intro = TextContent("旧正文")',
    ].join('\n');
    await render('intro = TextContent("新正文")', {
      streaming: true,
      previousProgram,
    });
    expect(host.textContent).toContain('周报');
    expect(host.textContent).toContain('原副标题');
    expect(host.textContent).toContain('新正文');
    expect(host.textContent).not.toContain('旧正文');
  });

  it('merges a streaming patch that redeclares root with existing refs against previousProgram', async () => {
    const previousProgram = [
      'root = Card([title, intro])',
      'title = TextContent("保留标题")',
      'intro = TextContent("待删除正文")',
    ].join('\n');
    await render('root = Card([title])', {
      streaming: true,
      previousProgram,
    });
    expect(host.textContent).toContain('保留标题');
    expect(host.textContent).not.toContain('待删除正文');
  });
});

describe('Tabs and Accordion resilience', () => {
  it('selects the first tab immediately, handles streaming updates, and falls back when the active tab disappears', async () => {
    await render(
      [
        'root = Card([tabs])',
        'tabs = Tabs([t1, t2])',
        't1 = TabItem("a", "页签一", [TextContent("内容一")])',
        't2 = TabItem("b", "页签二", [TextContent("内容二")])',
      ].join('\n'),
      { streaming: true },
    );

    const activeTab = () => host.querySelector('[role="tab"][aria-selected="true"]');
    expect(activeTab()?.textContent).toBe('页签一');
    expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('内容一');

    const secondTab = [...host.querySelectorAll('[role="tab"]')].find(
      (element) => element.textContent === '页签二',
    ) as HTMLElement | undefined;
    await act(async () => secondTab?.click());
    expect(activeTab()?.textContent).toBe('页签二');
    expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('内容二');

    await render(
      [
        'root = Card([tabs])',
        'tabs = Tabs([t1, t3])',
        't1 = TabItem("a", "页签一", [TextContent("内容一已更新")])',
        't3 = TabItem("c", "页签三", [TextContent("内容三")])',
      ].join('\n'),
      { streaming: true },
    );

    expect(activeTab()?.textContent).toBe('页签一');
    expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain(
      '内容一已更新',
    );

    await render(
      [
        'root = Card([tabs])',
        'tabs = Tabs([t1, t3])',
        't1 = TabItem("a", "页签一", [TextContent("内容一已更新")])',
        't3 = TabItem("c", "页签三", [TextContent("内容三已定稿")])',
      ].join('\n'),
      { streaming: false },
    );

    expect(activeTab()?.textContent).toBe('页签一');
  });

  it('deduplicates colliding Accordion values and adds streamed items inside StrictMode', async () => {
    const renderStrict = async (program: string, streaming: boolean) => {
      await act(async () => {
        root.render(
          createElement(StrictMode, null, createElement(OpenUiBlock, { program, streaming })),
        );
      });
    };

    await renderStrict(
      [
        'root = Card([tabs])',
        'tabs = Tabs([t1])',
        't1 = TabItem("main", "总览", [acc])',
        'acc = Accordion([a1, a2])',
        'a1 = AccordionItem("dup", "第一节", [TextContent("内容一")])',
        'a2 = AccordionItem("dup", "第二节", [TextContent("内容二")])',
      ].join('\n'),
      true,
    );

    const triggers = () => [
      ...host.querySelectorAll<HTMLButtonElement>('[data-slot="accordion-trigger"]'),
    ];
    expect(triggers().map((button) => button.textContent)).toEqual(['第一节', '第二节']);
    expect(triggers()[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(triggers()[1]?.getAttribute('aria-expanded')).toBe('false');

    await renderStrict(
      [
        'root = Card([tabs])',
        'tabs = Tabs([t1])',
        't1 = TabItem("main", "总览", [acc])',
        'acc = Accordion([a1, a2, a3])',
        'a1 = AccordionItem("dup", "第一节", [TextContent("内容一")])',
        'a2 = AccordionItem("dup", "第二节", [TextContent("内容二")])',
        'a3 = AccordionItem("dup", "第三节", [TextContent("内容三")])',
      ].join('\n'),
      true,
    );

    expect(triggers().map((button) => button.textContent)).toEqual(['第一节', '第二节', '第三节']);
    expect(triggers()[2]?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('内容三');
  });
});
