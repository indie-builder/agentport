import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessIllustration } from '../src/components/business-illustration.js';
import { EmptyState } from '../src/components/states.js';

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(node: ReactNode): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('EmptyState illustration', () => {
  it('uses the decorative illustration in place of the default icon', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: '还没有知识库',
        illustration: createElement(BusinessIllustration, { name: 'knowledge' }),
      }),
    );

    expect(html).toContain('src="/brand/business/knowledge.webp"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('alt=""');
    expect(html).not.toContain('<svg');
    expect(html).toContain('还没有知识库');
  });

  it('keeps the default icon and a working action without an illustration', async () => {
    const onClick = vi.fn();
    mount(
      createElement(EmptyState, {
        variant: 'filter',
        title: '还没有插件',
        action: createElement('button', { type: 'button', onClick }, '导入插件'),
      }),
    );

    expect(host?.querySelector('svg')).not.toBeNull();
    expect(host?.querySelector('img')).toBeNull();

    const button = host?.querySelector('button');
    await act(async () => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the custom icon slot when no illustration is passed', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: '空',
        icon: createElement('span', { 'data-test-icon': 'custom' }, 'x'),
      }),
    );

    expect(html).toContain('data-test-icon="custom"');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<img');
  });
});
