import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundPage } from '../src/pages/not-found.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params: _params,
    search: _search,
    children,
    ...rest
  }: {
    to?: string;
    params?: unknown;
    search?: unknown;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('a', { href: to, ...rest }, children),
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(node: ReactNode): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

function body(): HTMLElement {
  if (!host) throw new Error('not mounted');
  return host;
}

function anchor(selector: string): HTMLAnchorElement {
  const found = body().querySelector<HTMLAnchorElement>(selector);
  if (!found) throw new Error(`Missing anchor: ${selector}`);
  return found;
}

function expectLinkSemantics(
  element: HTMLAnchorElement,
  href: string,
  role: string | null = null,
): void {
  expect(element.tagName).toBe('A');
  expect(element.getAttribute('href')).toBe(href);
  expect(element.getAttribute('role')).toBe(role);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('page navigation keeps link semantics', () => {
  it('renders the not-found return action as a link', () => {
    mount(createElement(NotFoundPage));

    expectLinkSemantics(anchor('a[href="/"]'), '/');
  });
});
