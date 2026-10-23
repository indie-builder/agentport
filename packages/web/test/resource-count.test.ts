import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ResourcePage } from '../src/components/resource-page.js';

vi.mock('../src/components/search-input.js', () => ({ SearchInput: () => null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) =>
    createElement('a', { href: to, ...props }, children),
}));

describe('resource result count', () => {
  it.each([
    ['pending', '加载中…'],
    ['error', '数量不可用'],
    ['success', '共 0 个专家'],
  ] as const)('distinguishes %s from an empty result', (status, expected) => {
    const html = renderToStaticMarkup(
      createElement(ResourcePage, {
        section: 'agents',
        query: '',
        onQueryChange() {},
        sort: 'newest',
        onSortChange() {},
        count: 0,
        status,
        // biome-ignore lint/correctness/noChildrenProp: Required by the component's props type in createElement.
        children: null,
      }),
    );
    expect(html).toContain(expected);
    if (status !== 'success') expect(html).not.toContain('共 0 个专家');
  });
});
