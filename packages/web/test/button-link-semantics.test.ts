import type { Plugin } from '@agentport/shared';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderToolbar } from '../src/components/reader-toolbar.js';
import { NotFoundPage } from '../src/pages/not-found.js';
import { PluginDetailPage } from '../src/pages/plugin-detail.js';

const state = vi.hoisted(() => ({
  search: {} as Record<string, string | undefined>,
  query: {} as {
    data: Plugin | undefined;
    isPending: boolean;
    isError: boolean;
    isRefetchError: boolean;
    error: unknown;
    refetch: () => void;
  },
}));

vi.mock('../src/lib/queries.js', () => ({
  meQuery: {
    queryKey: ['me'],
    queryFn: async () => (await import('./me-fixture.js')).allAccessMe,
  },
  usePlugin: () => state.query,
}));

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
  useParams: () => ({ pluginId: 'plugin-1' }),
  useSearch: () => state.search,
  useNavigate: () => () => {},
}));

const plugin: Plugin = {
  id: 'plugin-1',
  slug: 'demo',
  runtimeName: 'demo',
  name: '演示插件',
  description: '演示插件的能力',
  version: '1.0.0',
  sourceId: null,
  capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
  files: [{ path: 'README.md', content: '# 演示\n\n正文', executable: false }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

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

/** 原生链接保留隐式 link 角色；Button 包装的锚点会被 Base UI 覆盖成 role=button。 */
function expectLinkSemantics(element: HTMLAnchorElement, href: string): void {
  expect(element.tagName).toBe('A');
  expect(element.getAttribute('href')).toBe(href);
  expect(element.getAttribute('role')).toBeNull();
}

beforeEach(() => {
  state.search = {};
  state.query = {
    data: plugin,
    isPending: false,
    isError: false,
    isRefetchError: false,
    error: null,
    refetch: vi.fn(),
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 64rem)',
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

describe('download links keep link semantics', () => {
  it('renders the reader toolbar download as a native download link', () => {
    mount(
      createElement(ReaderToolbar, {
        identity: createElement('span', null, '正文.md'),
        download: { href: '/api/file', label: '下载 正文.md' },
      }),
    );

    const download = anchor('a[aria-label="下载 正文.md"]');
    expectLinkSemantics(download, '/api/file');
    expect(download.hasAttribute('download')).toBe(true);
    expect(download.getAttribute('title')).toBe('下载 正文.md');
  });
});

describe('plugin detail links keep link semantics', () => {
  it('renders back and export as links instead of buttons', () => {
    mount(createElement(PluginDetailPage));

    expectLinkSemantics(anchor('a[aria-label="返回插件列表"]'), '/plugins');
    expectLinkSemantics(
      anchor('a[href="/api/plugins/plugin-1/export"]'),
      '/api/plugins/plugin-1/export',
    );
  });
});

describe('page navigation keeps link semantics', () => {
  it('renders the not-found return action as a link', () => {
    mount(createElement(NotFoundPage));

    expectLinkSemantics(anchor('a[href="/"]'), '/');
  });
});
