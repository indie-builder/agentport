import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
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

describe('OpenUI Markdown components', () => {
  it('lets TextContent size and color reach the Markdown tree', async () => {
    await render(['root = Card([t])', 't = TextContent("小字说明", "small")'].join('\n'));
    expect(host.querySelector('p')?.textContent).toBe('小字说明');
    expect(host.innerHTML).not.toContain('text-base text-fg');
  });

  it('renders headings semantically inside small TextContent', async () => {
    await render(['root = Card([t])', 't = TextContent("## 小节标题", "small")'].join('\n'));
    const heading = host.querySelector('h3');
    expect(heading?.textContent).toBe('小节标题');
  });

  it('converts prose [1] citations from Card.sources without touching code spans, escaped brackets or unsafe URLs', async () => {
    await render(
      [
        'root = Card([t], [{title: "官方文档", sourceName: "Docs", url: "https://example.com/docs?q=a\\"b(1)"}, {title: "危险源", sourceName: "Bad", url: "javascript:alert(1)"}])',
        't = TextContent("结论见 [1] 与 [2]，忽略 \\\\[1] 与 [[1] 与 ][1]，行内代码 `[1]` 不改：\\n```ts\\nconst x = arr[1];\\n```")',
      ].join('\n'),
    );
    const links = [...host.querySelectorAll('a')];
    const inlineCitations = links.filter((a) => a.textContent === '[1]');
    expect(inlineCitations).toHaveLength(1);
    expect(inlineCitations[0]?.getAttribute('href')).toBe(
      'https://example.com/docs?q=a%22b%281%29',
    );
    expect(inlineCitations[0]?.getAttribute('target')).toBe('_blank');
    expect(links.some((a) => a.textContent === '[2]')).toBe(false);
    expect(host.querySelector('code')?.textContent).toContain('[1]');
    expect(host.textContent).toContain('arr[1]');
  });

  it('toggles reactive Callout $visible and auto-dismisses after 3s', async () => {
    vi.useFakeTimers();
    try {
      await render(
        [
          'root = Card([btn, banner])',
          '$shown = false',
          'btn = Button("显示提示", @Set($shown, true))',
          'banner = Callout("info", "自动提示", "三秒后消失", $shown)',
        ].join('\n'),
      );
      expect(host.textContent).not.toContain('自动提示');

      const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === '显示提示');
      await act(async () => btn?.click());
      expect(host.textContent).toContain('自动提示');

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(host.textContent).not.toContain('自动提示');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies sm, md, lg size classes to Tag and TagBlock', async () => {
    await render(
      [
        'root = Card([tSm, tLg, block])',
        'tSm = Tag("小标签", null, "sm", "neutral")',
        'tLg = Tag("大标签", null, "lg", "info")',
        'block = TagBlock(["块标签"], "lg")',
      ].join('\n'),
    );
    const badges = [...host.querySelectorAll<HTMLElement>('[data-slot="badge"]')];
    expect(badges[0]?.className).toContain('text-xs');
    expect(badges[1]?.className).toContain('text-base');
    expect(badges[2]?.className).toContain('text-base');
  });
});
