import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * OpenUI 文本组件与消息共用同一棵 Streamdown：
 * 字号必须由外层 TextContent/Callout 决定，流式状态必须来自渲染器自己的 isStreaming。
 */

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
    const markdownRoot = host.querySelector<HTMLElement>('[class*="whitespace-normal"]');
    expect(markdownRoot).toBeTruthy();
    expect(markdownRoot?.className).not.toContain('text-base text-fg');
    expect(markdownRoot?.closest('.text-muted-foreground')).toBeTruthy();
    expect(host.textContent).toContain('小字说明');
  });

  it('keeps headings above body size when inheriting small text', async () => {
    await render(['root = Card([t])', 't = TextContent("## 小节标题", "small")'].join('\n'));
    const heading = host.querySelector('h3');
    expect(heading?.className).toContain('text-lg');
    expect(heading?.className).not.toContain('text-sm');
  });

  it('disables code copy while the program is still streaming', async () => {
    const program = ['root = Card([c])', 'c = CodeBlock("ts", "const a = 1;")'].join('\n');
    await render(program, { streaming: true });
    expect(
      host.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')?.disabled,
    ).toBe(true);

    await render(program, { streaming: false });
    expect(
      host.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')?.disabled,
    ).toBe(false);
  });

  it('keeps the rendered card in place from partial to final', async () => {
    const program = ['root = Card([c])', 'c = CodeBlock("ts", "const a = 1;")'].join('\n');
    await render(program, { streaming: true });
    const card = host.firstElementChild;
    expect(host.querySelector('[data-streamdown="code-block"]')).toBeTruthy();

    await render(program, { streaming: false });
    // 根节点不换树；代码块内部由 Streamdown 在 mode 切换时自行重挂（库行为）。
    expect(host.firstElementChild).toBe(card);
    expect(host.querySelector('[data-streamdown="code-block"]')?.textContent).toContain(
      'const a = 1;',
    );
  });

  it('keeps headings at least body size when TextContent is large', async () => {
    await render(['root = Card([t])', 't = TextContent("### 小节标题", "large")'].join('\n'));
    const heading = host.querySelector('h4');
    expect(heading?.closest('.text-lg')).toBeTruthy();
    expect(heading?.style.fontSize).toBe('max(1em, var(--text-base))');
  });
});
