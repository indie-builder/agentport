import type { PluginWithAgentCount } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { PluginDetailPage } from '../src/pages/plugins/plugin-detail.js';
import { allAccessMe } from './me-fixture.js';

type Mode = 'read' | 'source';
type Tab = 'intro' | 'content';
type Search = { tab?: Tab; file?: string; mode?: Mode };

type Query = {
  data: PluginWithAgentCount | undefined;
  isPending: boolean;
  isError: boolean;
  isRefetchError: boolean;
  error: unknown;
  refetch: () => void;
};

const state = vi.hoisted(() => ({
  pluginId: 'plugin-1',
  search: {} as Search,
  navCalls: [] as Array<{
    to: string;
    params?: { pluginId: string };
    search?: Search | ((previous: Search) => Search);
    resetScroll?: boolean;
  }>,
  retry: vi.fn(),
  query: {} as Query,
}));

vi.mock('../src/lib/queries.js', () => ({
  meQuery: {
    queryKey: ['me'],
    queryFn: async () => (await import('./me-fixture.js')).allAccessMe,
  },
  usePlugin: () => state.query,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: (props: { to?: string; children?: ReactNode }) =>
    createElement('a', { href: props.to }, props.children),
  useParams: () => ({ pluginId: state.pluginId }),
  useSearch: () => state.search,
  useNavigate: () => (options: (typeof state.navCalls)[number]) => {
    state.navCalls.push(options);
    if (typeof options.search === 'function') state.search = options.search(state.search);
    else if (options.search) state.search = options.search;
  },
}));

const manifest = JSON.stringify(
  {
    name: 'demo',
    version: '1.0.0',
    description: '演示插件',
    hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'true' }] }] },
    mcpServers: { 'inline-server': { command: 'node', args: ['server.js'] } },
  },
  null,
  2,
);

const plugin: PluginWithAgentCount = {
  agentCount: 3,
  id: 'plugin-1',
  slug: 'demo',
  runtimeName: 'demo',
  name: '演示插件',
  description: '演示插件的能力',
  version: '1.0.0',
  sourceId: 'demo@market',
  capabilities: {
    skills: ['alpha'],
    agents: ['review/api-reviewer'],
    hasHooks: true,
    mcpServers: ['inline-server'],
  },
  files: [
    {
      path: 'README.md',
      content:
        '---\ntitle: 演示\n---\n# 演示插件\n\nREADME-TOKEN\n\n链接：[Alpha 技能](skills/alpha/SKILL.md)\n',
      executable: false,
    },
    { path: '.claude-plugin/plugin.json', content: manifest, executable: false },
    {
      path: 'skills/alpha/SKILL.md',
      content:
        '---\nname: Alpha 技能\ndescription: 处理 alpha 任务\nunknownField: keep\n---\n# Alpha\nSKILL-TOKEN-ALPHA',
      executable: false,
    },
    {
      path: 'skills/alpha/references/guide.md',
      content: 'RESOURCE-TOKEN-GUIDE',
      executable: false,
    },
    {
      path: 'agents/review/api-reviewer.md',
      content: '---\nname: API 审查\n---\nAGENT-TOKEN-NESTED',
      executable: false,
    },
    { path: 'commands/deploy.md', content: 'COMMAND-TOKEN-BETA', executable: false },
    { path: 'output-styles/compact.md', content: 'STYLE-TOKEN', executable: false },
    { path: '.mcp.json', content: 'MCP-FILE-TOKEN', executable: false },
    { path: 'hooks/hooks.json', content: 'HOOKS-FILE-TOKEN', executable: false },
    { path: 'scripts/run.sh', content: 'SCRIPT-TOKEN', executable: true },
    { path: 'assets/empty.txt', content: '', executable: false },
    { path: 'LICENSE', content: 'LICENSE-TOKEN', executable: false },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const WIDE = '(min-width: 64rem)';
let wide = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let client: QueryClient;

function page(): ReactNode {
  return createElement(QueryClientProvider, { client }, createElement(PluginDetailPage));
}

function setQuery(patch: Partial<Query>): void {
  state.query = {
    data: undefined,
    isPending: false,
    isError: false,
    isRefetchError: false,
    error: null,
    refetch: state.retry,
    ...patch,
  };
}

function mount(): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(page()));
}

function rerender(): void {
  act(() => root?.render(page()));
}

function body(): HTMLElement {
  if (!host) throw new Error('not mounted');
  return host;
}

function buttons(scope: Element = body()): HTMLButtonElement[] {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')];
}

function button(label: string, scope: Element = body()): HTMLButtonElement {
  const found = buttons(scope).find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function buttonContaining(label: string, scope: Element = body()): HTMLButtonElement {
  const found = buttons(scope).find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`Missing button containing: ${label}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function tab(name: Tab): HTMLElement {
  const label = name === 'intro' ? /^概览$/ : /^文件 \d+$/;
  const found = [...body().querySelectorAll<HTMLElement>('[role="tab"]')].find((item) =>
    label.test(item.textContent?.trim() ?? ''),
  );
  if (!found) throw new Error(`Missing tab: ${name}`);
  return found;
}

function panel(value: Tab): HTMLElement {
  const found = [...body().querySelectorAll<HTMLElement>('[role="tabpanel"]')].find(
    (item) => item.id === tab(value).getAttribute('aria-controls'),
  );
  if (!found) throw new Error(`Missing panel: ${value}`);
  return found;
}

function scroller(scope: Element = panel('content')): HTMLElement {
  const found = scope.querySelector<HTMLElement>('[data-slot="plugin-content-scroll"]');
  if (!found) throw new Error('Missing content scroller');
  return found;
}

function tree(): HTMLElement {
  const found = panel('content').querySelector<HTMLElement>('[role="tree"][aria-label="插件文件"]');
  if (!found) throw new Error('Missing file tree');
  return found;
}

function fileRow(path: string, scope: Element = body()): HTMLElement {
  const row = scope.querySelector<HTMLElement>(`[data-slot="tree-label"][title="${path}"]`);
  if (!row) throw new Error(`Missing file row: ${path}`);
  return row;
}

async function expandAll(scope: ParentNode): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    const collapsed = [
      ...scope.querySelectorAll<HTMLElement>('[role="treeitem"][aria-expanded="false"]'),
    ];
    if (collapsed.length === 0) return;
    for (const item of collapsed) {
      await act(async () => item.click());
    }
  }
  throw new Error('tree folders never finished expanding');
}

function current(): string {
  const found = tree().querySelector('[aria-current="page"]');
  return found?.querySelector('[data-slot="tree-label"]')?.getAttribute('title') ?? '';
}

beforeEach(() => {
  wide = true;
  state.pluginId = 'plugin-1';
  state.search = {};
  state.navCalls = [];
  state.retry = vi.fn();
  setQuery({ data: plugin });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(['me'], allAccessMe);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === WIDE ? wide : false,
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
  client.clear();
  vi.unstubAllGlobals();
});

describe('plugin detail', () => {
  it('opens on the overview with the README, capabilities and plugin facts', async () => {
    mount();
    expect(body().querySelector('h1')?.textContent).toBe('演示插件');
    expect(body().querySelectorAll('h1')).toHaveLength(1);
    expect(tab('intro').getAttribute('aria-selected')).toBe('true');
    expect(tab('content').getAttribute('aria-selected')).toBe('false');
    expect(panel('intro').hidden).toBe(false);
    expect(panel('content').hidden).toBe(true);
    expect(panel('intro').textContent).toContain('README-TOKEN');
    expect(panel('intro').textContent).not.toContain('title: 演示');
    expect(panel('intro').querySelector('aside')?.textContent).toContain('demo@market');
    expect(panel('intro').querySelector('aside')?.textContent).toContain('关联专家3');
    expect(panel('intro').textContent).toContain('处理 alpha 任务');
    const more = buttons().find((item) => item.getAttribute('aria-label') === '更多操作');
    if (!more) throw new Error('Missing 更多操作');
    await click(more);
    expect(document.querySelector('a[href="/api/plugins/plugin-1/export"]')).not.toBeNull();
    expect(body().querySelector('a[href="/plugins"]')).not.toBeNull();
    expect(body().querySelector('[data-slot="page-topbar"]')?.textContent).toContain(
      `${plugin.slug} · ${plugin.description}`,
    );
    const description = panel('intro').querySelector('p');
    expect(description?.textContent).toBe(plugin.description);
    expect(description?.className).toContain('whitespace-pre-wrap');
    expect(panel('intro').className).toContain('overflow-y-auto');
  });

  it('keeps the paragraph structure of a multi-line long description in the scrollable intro', () => {
    const paragraphs = [
      '第一段：这个插件集中了接口审查与风险评估的常用步骤，帮助团队在合并前发现契约漂移。',
      '第二段：它会读取仓库里的规则文件，逐条对照当前改动，输出可执行的修正建议；这一段故意写得更长，用来覆盖单行放不下的正文，并确认段落按原文保留换行而不是被压成一行。',
      '第三段：supersupersupersupersupersupersupersupersupersupersupersupersupersuperlongtoken',
    ];
    const description = paragraphs.join('\n\n');
    setQuery({ data: { ...plugin, description } });

    mount();

    const rendered = panel('intro').querySelector('p');
    expect(rendered?.textContent?.split('\n\n')).toEqual(paragraphs);
    expect(rendered?.className).toContain('whitespace-pre-wrap');
    expect(rendered?.className).toContain('break-words');
    expect(panel('intro').className).toContain('overflow-y-auto');
  });

  it('never opens a Sheet or dialog for content, even with a file in the URL', () => {
    state.search = { tab: 'content', file: 'README.md' };
    mount();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(tab('content').getAttribute('aria-selected')).toBe('true');
    expect(scroller().textContent).toContain('README-TOKEN');
  });

  it('exposes real tabs with proper roles and control relationships', () => {
    mount();
    const list = body().querySelector('[data-slot="tabs-list"]');
    expect(list?.getAttribute('aria-label')).toBe('插件视图');
    expect(tab('intro').getAttribute('role')).toBe('tab');
    expect(tab('intro').getAttribute('aria-controls')).toBe(panel('intro').id);
    expect(panel('intro').getAttribute('aria-labelledby')).toBe(tab('intro').id);
    expect(panel('intro').getAttribute('role')).toBe('tabpanel');
    expect(tab('content').getAttribute('aria-controls')).toBe(panel('content').id);
  });

  it('keeps the inactive panel non-focusable and non-visible', async () => {
    mount();
    await flush();
    await click(tab('content'));
    rerender();
    const intro = panel('intro');
    expect(intro.hidden).toBe(true);
    const content = panel('content');
    expect(content.hidden).toBe(false);
    const read = button('阅读', content);
    read.focus();
    expect(document.activeElement).toBe(read);

    const hiddenInteractive = intro.querySelectorAll<HTMLElement>(
      'button, a[href], input, [tabindex="0"]',
    );
    expect(hiddenInteractive.length).toBeGreaterThan(0);
    for (const item of hiddenInteractive) {
      item.focus();
      expect(document.activeElement).not.toBe(item);
    }

    await click(tab('intro'));
    rerender();
    expect(intro.hidden).toBe(false);
    expect(content.hidden).toBe(true);
    const skill = buttonContaining('处理 alpha 任务', intro);
    skill.focus();
    expect(document.activeElement).toBe(skill);
  });

  it('renders only one document before the content tab is first opened', () => {
    mount();
    expect(body().textContent?.match(/README-TOKEN/g)).toHaveLength(1);
    expect(body().querySelector('[data-slot="plugin-content-scroll"]')).toBeNull();
    expect(panel('content').childElementCount).toBe(0);
  });

  it('follows a README relative link into the content tab as a direct read', async () => {
    mount();
    await flush();
    const link = buttons(panel('intro')).find((item) => item.textContent === 'Alpha 技能');
    if (!link) throw new Error('Missing in-page README link');
    await click(link);
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'skills/alpha/SKILL.md' });
    expect(tab('content').getAttribute('aria-selected')).toBe('true');
    expect(current()).toBe('skills/alpha/SKILL.md');
    expect(scroller().textContent).toContain('SKILL-TOKEN-ALPHA');
    expect(body().querySelectorAll('h1')).toHaveLength(1);
  });

  it('returns to intro keeping file and mode, and restores them on content', async () => {
    state.search = { tab: 'content', file: 'skills/alpha/SKILL.md', mode: 'source' };
    mount();
    expect(scroller().textContent).toContain('unknownField: keep');

    await click(tab('intro'));
    rerender();
    expect(state.search).toEqual({ tab: 'intro', file: 'skills/alpha/SKILL.md', mode: 'source' });
    expect(tab('intro').getAttribute('aria-selected')).toBe('true');

    await click(tab('content'));
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'skills/alpha/SKILL.md', mode: 'source' });
    expect(scroller().textContent).toContain('unknownField: keep');
    expect(current()).toBe('skills/alpha/SKILL.md');
  });

  it('picks the README when entering content', async () => {
    mount();
    await click(tab('content'));
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'README.md' });
  });

  it('falls back to a skill, then to the first file, when there is no README', async () => {
    setQuery({
      data: { ...plugin, files: plugin.files.filter((file) => file.path !== 'README.md') },
    });
    mount();
    await click(tab('content'));
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'skills/alpha/SKILL.md' });

    await act(async () => root?.unmount());
    host?.remove();
    setQuery({
      data: {
        ...plugin,
        files: plugin.files.filter(
          (file) => file.path !== 'README.md' && !file.path.startsWith('skills/'),
        ),
      },
    });
    state.search = {};
    mount();
    await click(tab('content'));
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: '.claude-plugin/plugin.json' });
  });

  it('switches to source mode and resets it when changing files', async () => {
    state.search = { tab: 'content', file: 'skills/alpha/SKILL.md' };
    mount();
    expect(scroller().textContent).not.toContain('unknownField: keep');

    await click(button('源码', panel('content')));
    rerender();
    expect(state.search).toEqual({
      tab: 'content',
      file: 'skills/alpha/SKILL.md',
      mode: 'source',
    });
    expect(scroller().textContent).toContain('unknownField: keep');

    await expandAll(tree());
    await click(fileRow('agents/review/api-reviewer.md', tree()));
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'agents/review/api-reviewer.md' });
    expect(scroller().textContent).toContain('AGENT-TOKEN-NESTED');
  });

  it('keeps the content tab readable when the URL names an invalid file', () => {
    state.search = { tab: 'content', file: 'missing/file.md' };
    mount();
    expect(panel('content').textContent).toContain('找不到这个文件');
    expect(current()).toBe('README.md');
    expect(state.navCalls).toHaveLength(0);
  });

  it('reveals a deep file link inside the tree', async () => {
    state.search = { tab: 'content', file: 'skills/alpha/references/guide.md' };
    mount();
    await flush();
    expect(current()).toBe('skills/alpha/references/guide.md');
    expect(scroller().textContent).toContain('RESOURCE-TOKEN-GUIDE');
    expect(
      fileRow('skills/alpha/references', tree())
        .closest('[role="treeitem"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('shows every real file in the content tree', async () => {
    state.search = { tab: 'content', file: 'README.md' };
    mount();
    await expandAll(tree());
    for (const file of plugin.files) {
      expect(tree().querySelector(`[data-slot="tree-label"][title="${file.path}"]`)).not.toBeNull();
    }
  });

  it('renders raw markup literally and marks executables', () => {
    setQuery({
      data: {
        ...plugin,
        files: [
          ...plugin.files,
          {
            path: 'notes.html',
            content: '<script>alert(1)</script>HOSTILE-TOKEN',
            executable: false,
          },
        ],
      },
    });
    state.search = { tab: 'content', file: 'notes.html' };
    mount();
    expect(document.querySelector('script')).toBeNull();
    expect(scroller().textContent).toContain('<script>alert(1)</script>');
    expect(scroller().textContent).toContain('HOSTILE-TOKEN');

    state.search = { tab: 'content', file: 'scripts/run.sh' };
    rerender();
    expect(scroller().textContent).toContain('SCRIPT-TOKEN');
    expect(panel('content').textContent).toContain('可执行');
  });

  it('keeps empty files readable', () => {
    state.search = { tab: 'content', file: 'assets/empty.txt' };
    mount();
    expect(scroller().textContent).toContain('该文件是空的。');
  });

  it('keeps the files tab available when the plugin has no README', async () => {
    setQuery({
      data: {
        ...plugin,
        capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
        files: plugin.files.filter((file) => file.path === 'LICENSE'),
      },
    });
    mount();
    expect(panel('intro').textContent).not.toContain('说明');
    expect(panel('intro').textContent).toContain('未检测到技能、命令、代理、钩子或 MCP 服务。');
    expect(body().querySelectorAll('h1')).toHaveLength(1);
    const next = tab('content');
    expect(next.tagName).toBe('BUTTON');
    await click(next);
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'LICENSE' });
    expect(scroller().textContent).toContain('LICENSE-TOKEN');
  });

  it('falls back to the overview when an old file link has no files', () => {
    setQuery({
      data: {
        ...plugin,
        files: [],
        capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
      },
    });
    state.search = { tab: 'content', file: 'README.md' };
    mount();
    const content = panel('intro');
    expect(content?.querySelector('p')?.textContent).toBe(plugin.description);
    expect(content?.className).toContain('overflow-y-auto');
    expect(body().querySelector('[data-slot="page-topbar"]')?.textContent).toContain(
      `${plugin.slug} · ${plugin.description}`,
    );
    expect(body().querySelector('a[href="/plugins"]')).not.toBeNull();
    expect(tab('intro').getAttribute('aria-selected')).toBe('true');
    expect(body().querySelectorAll('[role="tab"]')).toHaveLength(1);
  });

  it('moves tab focus with arrows and activates on Space', async () => {
    mount();
    await act(async () => tab('intro').focus());
    expect(document.activeElement).toBe(tab('intro'));
    await act(async () => {
      tab('intro').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(tab('content'));
    expect(tab('intro').getAttribute('aria-selected')).toBe('true');
    // 原生 button 的 Enter 由浏览器触发 click；jsdom 不模拟它，这里走组件的 Space 路径。
    await act(async () => {
      tab('content').dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
      );
    });
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'README.md' });
  });

  it('collapses the file tree on narrow screens and keeps focus on the toggle', async () => {
    wide = false;
    state.search = { tab: 'content', file: 'README.md' };
    mount();
    const content = panel('content');
    expect(content.querySelector('[data-slot="tree-label"][title="scripts/run.sh"]')).toBeNull();
    const toggle = content.querySelector<HTMLButtonElement>('button[aria-label="展开文件列表"]');
    if (!toggle) throw new Error('Missing files toggle');
    await click(toggle);
    await expandAll(content);
    await click(fileRow('scripts/run.sh', content));
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'scripts/run.sh' });
    expect(scroller().textContent).toContain('SCRIPT-TOKEN');
    expect(content.querySelector('[data-slot="tree-label"][title="scripts/run.sh"]')).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(content.querySelector('h1')).toBeNull();
  });

  it('copies the selected file through the reading toolbar and follows file switches', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    state.search = { tab: 'content', file: 'skills/alpha/SKILL.md' };
    mount();
    const copy = body().querySelector<HTMLButtonElement>(
      'button[aria-label="复制 skills/alpha/SKILL.md"]',
    );
    if (!copy) throw new Error('Missing copy action');
    await click(copy);
    expect(writeText).toHaveBeenLastCalledWith(
      plugin.files.find((file) => file.path === 'skills/alpha/SKILL.md')?.content,
    );

    await expandAll(tree());
    await click(fileRow('agents/review/api-reviewer.md', tree()));
    rerender();
    const switched = body().querySelector<HTMLButtonElement>(
      'button[aria-label="复制 agents/review/api-reviewer.md"]',
    );
    if (!switched) throw new Error('Missing copy action after switching files');
    await click(switched);
    expect(writeText).toHaveBeenLastCalledWith('---\nname: API 审查\n---\nAGENT-TOKEN-NESTED');
  });

  it('collapses and expands the wide file sidebar without losing the selected file or focus', async () => {
    state.search = { tab: 'content', file: 'skills/alpha/SKILL.md' };
    mount();
    const toggle = body().querySelector<HTMLButtonElement>('button[aria-label="收起文件列表"]');
    if (!toggle) throw new Error('Missing files toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const controls = toggle.getAttribute('aria-controls');
    if (!controls) throw new Error('Missing aria-controls target');
    expect(document.getElementById(controls)).not.toBeNull();
    expect(
      tree().querySelector('[aria-current="page"] [data-slot="tree-label"]')?.getAttribute('title'),
    ).toBe('skills/alpha/SKILL.md');

    toggle.focus();
    await click(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel('content').querySelector('[role="tree"][aria-label="插件文件"]')).toBeNull();
    expect(scroller().textContent).toContain('SKILL-TOKEN-ALPHA');

    await click(toggle);
    await flush();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(current()).toBe('skills/alpha/SKILL.md');
    expect(document.activeElement).toBe(tree().querySelector('[aria-current="page"]'));
  });

  it('keeps a single copy action in source mode and copies the current file', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    state.search = { tab: 'content', file: 'skills/alpha/SKILL.md', mode: 'source' };
    mount();
    expect(scroller().textContent).toContain('unknownField: keep');
    const copies = buttons().filter((item) => item.getAttribute('aria-label')?.startsWith('复制'));
    expect(copies).toHaveLength(1);
    const copy = copies[0];
    if (!copy) throw new Error('Missing copy action');
    expect(copy.getAttribute('aria-label')).toBe('复制 skills/alpha/SKILL.md');
    await click(copy);
    expect(writeText).toHaveBeenLastCalledWith(
      plugin.files.find((file) => file.path === 'skills/alpha/SKILL.md')?.content,
    );
  });

  it('keeps the reading position across mode changes and tab switches', async () => {
    state.search = { tab: 'content', file: 'skills/alpha/SKILL.md' };
    mount();
    const scrollerEl = scroller();
    scrollerEl.scrollTop = 240;
    expect(scrollerEl.scrollTop).toBe(240);

    await click(button('源码', panel('content')));
    rerender();
    expect(scroller()).toBe(scrollerEl);
    expect(scroller().scrollTop).toBe(240);

    await click(tab('intro'));
    rerender();
    expect(panel('content').hidden).toBe(true);
    expect(scroller()).toBe(scrollerEl);
    expect(scroller().scrollTop).toBe(240);

    await click(tab('content'));
    rerender();
    expect(panel('content').hidden).toBe(false);
    expect(scroller().scrollTop).toBe(240);
  });

  it('starts a different file at the top', async () => {
    state.search = { tab: 'content', file: 'skills/alpha/SKILL.md' };
    mount();
    scroller().scrollTop = 180;
    await expandAll(tree());
    await click(fileRow('agents/review/api-reviewer.md', tree()));
    rerender();
    expect(scroller().scrollTop).toBe(0);
  });

  it('shows a loading state with the page heading', () => {
    setQuery({ isPending: true });
    mount();
    expect(body().querySelector('h1')?.textContent).toBe('插件详情');
    expect(body().querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('offers retry when the request fails', async () => {
    setQuery({ isError: true, error: new Error('boom') });
    mount();
    expect(body().querySelector('h1')?.textContent).toBe('插件详情');
    await click(buttonContaining('重试'));
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it('explains a 404 and links back to the list', () => {
    setQuery({ isError: true, error: new ApiError(404, '插件不存在，可能已被删除', {}) });
    mount();
    expect(body().querySelector('h1')?.textContent).toBe('插件不存在');
    expect(body().textContent).toContain('它可能已被删除');
    expect(body().querySelector('a[href="/plugins"]')).not.toBeNull();
  });

  it('keeps loaded content visible when a background refetch fails', async () => {
    setQuery({ data: plugin, isRefetchError: true, error: new Error('offline') });
    mount();
    expect(body().textContent).toContain('刷新失败，已保留加载的内容');
    expect(panel('intro').textContent).toContain('README-TOKEN');
    await click(buttonContaining('重试'));
    expect(state.retry).toHaveBeenCalledOnce();
  });
});
