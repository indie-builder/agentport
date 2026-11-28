import { isSafeOpenUrl, OPENUI_COMPONENT_NAMES } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENUI_RENDERERS } from '../src/openui/components/index.js';
import { OpenUiBlock } from '../src/openui/renderer.js';

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
});
