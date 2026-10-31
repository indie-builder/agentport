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
    expect(html).not.toContain('rounded-full bg-sunken');
    expect(html).toContain('还没有知识库');
  });

  it('keeps the default icon and a working action without an illustration', async () => {
    const onClick = vi.fn();
    mount(
      createElement(EmptyState, {
        title: '还没有插件',
        action: createElement('button', { type: 'button', onClick }, '导入插件'),
      }),
    );

    const circle = host?.querySelector('.rounded-full.bg-sunken');
    expect(circle?.querySelector('svg')).not.toBeNull();

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
    expect(html).toContain('rounded-full bg-sunken');
  });
});

describe('BusinessIllustration', () => {
  it('maps a name to the shared business asset path at the standard size', () => {
    const html = renderToStaticMarkup(createElement(BusinessIllustration, { name: 'not-found' }));

    expect(html).toContain('src="/brand/business/not-found.webp"');
    expect(html).toContain('class="size-24 shrink-0 object-contain"');
    expect(html).toContain('width="96"');
    expect(html).toContain('height="96"');
  });

  it('renders each fixed size with matching width and height', () => {
    const compact = renderToStaticMarkup(
      createElement(BusinessIllustration, { name: 'tools', size: 'compact' }),
    );
    expect(compact).toContain('class="size-16 shrink-0 object-contain"');
    expect(compact).toContain('width="64"');
    expect(compact).toContain('height="64"');

    const large = renderToStaticMarkup(
      createElement(BusinessIllustration, { name: 'search', size: 'error' }),
    );
    expect(large).toContain('class="size-36 shrink-0 object-contain"');
    expect(large).toContain('width="144"');
    expect(large).toContain('height="144"');
  });
});
