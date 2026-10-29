import type { Plugin } from '@agentport/shared';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api.js';
import { PluginDetailPage } from '../src/pages/plugin-detail.js';

type Mode = 'read' | 'source';
type Tab = 'intro' | 'content';
type Search = { tab?: Tab; file?: string; mode?: Mode };

type Query = {
  data: Plugin | undefined;
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

const plugin: Plugin = {
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
  act(() => root?.render(createElement(PluginDetailPage)));
}

/** 模拟路由器在 navigate 后重新渲染同一页面。 */
function rerender(): void {
  act(() => root?.render(createElement(PluginDetailPage)));
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

/** Markdown 解析在静态模式下异步完成，等一拍再断言。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function tab(name: Tab): HTMLElement {
  const label = name === 'intro' ? '简介' : '内容';
  const found = [...body().querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (item) => item.textContent?.trim() === label,
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

/** 目录树与正文同属内容面板，但在不同滚动容器里。 */
function tree(): HTMLElement {
  const found = panel('content').querySelector<HTMLElement>('nav[aria-label="插件文件"]');
  if (!found) throw new Error('Missing file tree');
  return found;
}

/** 真实目录树里的文件行，按完整路径定位，不依赖展开状态。 */
function fileRow(path: string, scope: Element = body()): HTMLButtonElement {
  const row = buttons(scope).find((item) => item.getAttribute('title') === path);
  if (!row) throw new Error(`Missing file row: ${path}`);
  return row;
}

/** 树默认只展开部分目录；逐层点开所有未展开目录，验证全部真实文件可达。 */
async function expandAll(scope: ParentNode): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    const collapsed = [
      ...scope.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]'),
    ];
    if (collapsed.length === 0) return;
    for (const item of collapsed) {
      await act(async () => item.click());
    }
  }
  throw new Error('tree folders never finished expanding');
}

function current(): string {
  const found = body().querySelector('[aria-current="true"]');
  return found?.getAttribute('title') ?? '';
}

beforeEach(() => {
  wide = true;
  state.pluginId = 'plugin-1';
  state.search = {};
  state.navCalls = [];
  state.retry = vi.fn();
  setQuery({ data: plugin });
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
  vi.unstubAllGlobals();
});

describe('plugin detail', () => {
  it('opens on the intro tab with only the README', () => {
    mount();
    expect(body().querySelector('h1')?.textContent).toBe('演示插件');
    expect(body().querySelectorAll('h1')).toHaveLength(1);
    expect(tab('intro').getAttribute('aria-selected')).toBe('true');
    expect(tab('content').getAttribute('aria-selected')).toBe('false');
    expect(panel('intro').hidden).toBe(false);
    expect(panel('content').hidden).toBe(true);
    expect(panel('intro').textContent).toContain('README-TOKEN');
    expect(panel('intro').textContent).not.toContain('title: 演示');
    expect(panel('intro').querySelector('aside')).toBeNull();
    expect(panel('intro').textContent).not.toContain('demo@market');
    expect(body().querySelector('a[href="/api/plugins/plugin-1/export"]')).not.toBeNull();
    expect(body().querySelector('a[href="/plugins"]')).not.toBeNull();
    // 简介落到标题下方并与标题左对齐，不在标题行里。
    const header = body().querySelector('[data-slot="page-header"]');
    expect(header?.textContent).not.toContain('演示插件的能力');
    expect(header?.nextElementSibling?.textContent).toBe('演示插件的能力');
    expect(header?.nextElementSibling?.className).toContain('ps-11');
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
    expect(intro.hasAttribute('inert')).toBe(true);
    const content = panel('content');
    expect(content.hidden).toBe(false);
    expect(content.hasAttribute('inert')).toBe(false);

    const hiddenInteractive = intro.querySelectorAll<HTMLElement>(
      'button, a[href], input, [tabindex="0"]',
    );
    expect(hiddenInteractive.length).toBeGreaterThan(0);
    for (const item of hiddenInteractive) {
      item.focus();
      expect(document.activeElement).not.toBe(item);
    }
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
    // 显式选新文件回到阅读模式，不继承上一次的源码开关。
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

    await click(button('源码', scroller()));
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
    // 不通过 effect 回写 URL，避免渲染循环。
    expect(state.navCalls).toHaveLength(0);
  });

  it('reveals a deep file link inside the tree', async () => {
    state.search = { tab: 'content', file: 'skills/alpha/references/guide.md' };
    mount();
    await flush();
    expect(current()).toBe('skills/alpha/references/guide.md');
    expect(scroller().textContent).toContain('RESOURCE-TOKEN-GUIDE');
    expect(fileRow('skills/alpha/references', tree()).getAttribute('aria-expanded')).toBe('true');
  });

  it('shows every real file in the content tree', async () => {
    state.search = { tab: 'content', file: 'README.md' };
    mount();
    await expandAll(tree());
    for (const file of plugin.files) {
      expect(buttons(tree()).some((item) => item.getAttribute('title') === file.path)).toBe(true);
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
    expect(scroller().textContent).toContain('可执行');
  });

  it('keeps empty files readable', () => {
    state.search = { tab: 'content', file: 'assets/empty.txt' };
    mount();
    expect(scroller().textContent).toContain('该文件是空的。');
  });

  it('offers a keyboard action to view the content when the plugin has no README', async () => {
    setQuery({
      data: {
        ...plugin,
        capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
        files: plugin.files.filter((file) => file.path === 'LICENSE'),
      },
    });
    mount();
    expect(panel('intro').textContent).toContain('未提供插件说明。');
    expect(panel('intro').querySelector('aside')).toBeNull();
    expect(panel('intro').textContent).not.toContain('来源');
    expect(body().querySelectorAll('h1')).toHaveLength(1);
    // 简介没有内容时，用真实按钮给下一步，不要求用户自己找页签。
    const next = button('查看插件内容', panel('intro'));
    expect(next.tagName).toBe('BUTTON');
    await click(next);
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'LICENSE' });
    expect(scroller().textContent).toContain('LICENSE-TOKEN');
  });

  it('offers the next action when the plugin has no files', () => {
    setQuery({
      data: {
        ...plugin,
        files: [],
        capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
      },
    });
    mount();
    expect(body().textContent).toContain('这个插件没有支持文件');
    expect(body().querySelector('a[href="/plugins"]')).not.toBeNull();
    expect(body().querySelector('[role="tablist"]')).toBeNull();
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
    // 默认 activateOnFocus=false：方向键只移动焦点，不切换面板。
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
    // 窄屏默认只给阅读正文，目录收在「文件」按钮后。
    expect(buttons(content).some((item) => item.getAttribute('title') === 'scripts/run.sh')).toBe(
      false,
    );
    await click(button('文件', content));
    await expandAll(content);
    await click(fileRow('scripts/run.sh', content));
    rerender();
    expect(state.search).toEqual({ tab: 'content', file: 'scripts/run.sh' });
    expect(scroller().textContent).toContain('SCRIPT-TOKEN');
    // 收起后隐藏的文件行不能拿走焦点。
    expect(buttons(content).some((item) => item.getAttribute('title') === 'scripts/run.sh')).toBe(
      false,
    );
    expect(document.activeElement).toBe(button('文件', content));
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
    // 换文件后应看到新文件的复制动作，而不是上一个文件留下的「已复制」。
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
    expect(tree().querySelector('[aria-current="true"]')?.getAttribute('title')).toBe(
      'skills/alpha/SKILL.md',
    );

    toggle.focus();
    await click(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel('content').querySelector('nav[aria-label="插件文件"]')).toBeNull();
    expect(scroller().textContent).toContain('SKILL-TOKEN-ALPHA');

    await click(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(current()).toBe('skills/alpha/SKILL.md');
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

    await click(button('源码', scrollerEl));
    rerender();
    // 同一文件只换渲染方式，DOM 不被替换。
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
