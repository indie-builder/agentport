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
});
