import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeBlock, LARGE_CONTENT_CHARS } from '../src/components/code-block.js';
import { type DataColumn, DataTable } from '../src/components/data-table.js';

/**
 * jsdom 没有过渡：报告 150ms height 过渡并让动画永不结束，模拟浏览器收起阶段
 * 仍挂载 panel 的窗口，验证内容不会在关闭开始时被切断。
 */
function keepOpenDuringClose(): () => void {
  const computed = vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        transitionDuration: '0.15s',
        transitionProperty: 'height, opacity',
        animationDuration: '0s',
        animationName: 'none',
      }) as CSSStyleDeclaration,
  );
  const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(100);
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => [
      {
        effect: { getTiming: () => ({ duration: 150, iterations: 1 }) },
        finished: new Promise(() => {}),
        pending: false,
        playState: 'running',
      },
    ],
  });
  return () => {
    computed.mockRestore();
    scrollHeight.mockRestore();
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(element: ReturnType<typeof createElement>): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('collapsible content motion', () => {
  it('keeps large CodeBlock content rendered until the closing transition ends', async () => {
    const restore = keepOpenDuringClose();
    const code = `needle ${'x'.repeat(LARGE_CONTENT_CHARS + 1)}`;
    const host = mount(createElement(CodeBlock, { code }));
    const trigger = () => {
      const button = host.querySelector('button');
      if (!button) throw new Error('Missing large content trigger');
      return button;
    };

    expect(host.textContent).not.toContain('needle');

    await click(trigger());
    expect(host.textContent).toContain('needle');

    await click(trigger());
    expect(host.textContent).toContain('needle');
    restore();
  });

  it('keeps DataTable detail content inside the controlled cell while it closes', async () => {
    const restore = keepOpenDuringClose();
    const rows = [{ id: 'run-1', name: 'Run' }];
    const columns: DataColumn<(typeof rows)[number]>[] = [
      { id: 'name', header: '名称', locked: true },
    ];
    const host = mount(
      createElement(DataTable<(typeof rows)[number]>, {
        rows,
        columns,
        rowKey: (row) => row.id,
        label: '运行列表',
        renderExpanded: () => createElement('span', null, 'DETAIL-MARKER'),
      }),
    );
    const toggle = () => {
      const button = host.querySelector<HTMLButtonElement>('button[data-row]');
      if (!button) throw new Error('Missing row toggle');
      return button;
    };

    expect(host.textContent).not.toContain('DETAIL-MARKER');

    await click(toggle());
    expect(host.textContent).toContain('DETAIL-MARKER');
    const panelId = toggle().getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(host.querySelector(`td#${panelId}`)).not.toBeNull();

    await click(toggle());
    expect(host.textContent).toContain('DETAIL-MARKER');
    restore();
  });
});
