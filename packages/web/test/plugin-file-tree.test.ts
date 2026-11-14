import type { PluginFileInput } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginFileTree } from '../src/components/plugin/plugin-file-tree.js';

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const LONG_NAME = 'a-very-long-reference-document-name-that-must-stay-readable.md';
const DEEP = `skills/alpha/references/${LONG_NAME}`;

const files: PluginFileInput[] = [
  { path: 'README.md', content: '# 根', executable: false },
  { path: 'a.b.d', content: 'dotted', executable: false },
  { path: '.claude-plugin/plugin.json', content: '{}', executable: false },
  { path: 'zeta.md', content: 'z', executable: false },
  { path: 'skills/alpha/SKILL.md', content: 'alpha', executable: false },
  { path: 'skills/alpha/references/guide.md', content: 'guide', executable: false },
  { path: DEEP, content: 'long', executable: false },
  { path: 'agents/reviewer.md', content: 'reviewer', executable: false },
  { path: 'output-styles/compact.md', content: 'compact', executable: false },
];

function mount(props: Parameters<typeof PluginFileTree>[0]): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PluginFileTree, props)));
}

function rerender(props: Parameters<typeof PluginFileTree>[0]): void {
  act(() => root?.render(createElement(PluginFileTree, props)));
}

function body(): HTMLElement {
  if (!host) throw new Error('not mounted');
  return host;
}

function tree(): HTMLElement {
  const found = body().querySelector<HTMLElement>('[role="tree"]');
  if (!found) throw new Error('Missing tree');
  return found;
}

function row(title: string): HTMLElement {
  const found = body().querySelector<HTMLElement>(`[data-slot="tree-label"][title="${title}"]`);
  if (!found) throw new Error(`Missing row: ${title}`);
  return found;
}

function item(title: string): HTMLElement {
  const found = row(title).closest<HTMLElement>('[role="treeitem"]');
  if (!found) throw new Error(`Missing item: ${title}`);
  return found;
}

function titles(scope: ParentNode): (string | null)[] {
  return [...scope.querySelectorAll<HTMLElement>(':scope > [role="treeitem"]')].map(
    (entry) =>
      entry
        .querySelector<HTMLElement>(':scope > [data-slot="tree-label"]')
        ?.getAttribute('title') ?? null,
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('PluginFileTree', () => {
  it('nests files under their real path instead of flattening them', () => {
    mount({ files, onSelect: vi.fn() });

    expect(tree().getAttribute('aria-label')).toBe('插件文件');
    const skillsGroup = item('skills').querySelector(':scope > [role="group"]');
    expect(skillsGroup?.textContent).toContain('alpha');
    expect(
      skillsGroup?.querySelector('[data-slot="tree-label"][title="skills/alpha"]'),
    ).not.toBeNull();

    const alphaGroup = item('skills/alpha').querySelector(':scope > [role="group"]');
    expect(
      alphaGroup?.querySelector('[data-slot="tree-label"][title="skills/alpha/SKILL.md"]'),
    ).not.toBeNull();
    expect(
      alphaGroup?.querySelector('[data-slot="tree-label"][title="skills/alpha/references"]'),
    ).not.toBeNull();

    // 行上只显示 basename，完整路径留给 title 与选择结果。
    expect(tree().textContent).not.toContain('skills/alpha/SKILL.md');
  });

  it('expands and collapses a folder without selecting it', async () => {
    const onSelect = vi.fn();
    mount({ files, onSelect });

    const folder = item('.claude-plugin');
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(body().textContent).not.toContain('plugin.json');

    await click(row('.claude-plugin'));
    expect(item('.claude-plugin').getAttribute('aria-expanded')).toBe('true');
    expect(body().textContent).toContain('plugin.json');
    expect(onSelect).not.toHaveBeenCalled();

    await click(row('.claude-plugin'));
    expect(item('.claude-plugin').getAttribute('aria-expanded')).toBe('false');
    expect(body().textContent).not.toContain('plugin.json');
  });

  it('selects the full path of a file and marks only the current one', async () => {
    const onSelect = vi.fn();
    const deep = 'skills/alpha/references/guide.md';
    mount({ files, onSelect, selectedPath: 'README.md' });

    expect(item('README.md').getAttribute('aria-current')).toBe('page');

    await click(row('zeta.md'));
    expect(onSelect).toHaveBeenCalledWith('zeta.md');

    rerender({ files, onSelect, selectedPath: deep });
    expect(item(deep).getAttribute('aria-current')).toBe('page');
    expect(item('README.md').getAttribute('aria-current')).toBeNull();
  });

  it('lists folders before files, each group sorted by name', async () => {
    const flat: PluginFileInput[] = [
      { path: 'falsey/b.md', content: 'b', executable: false },
      { path: 'zeta.md', content: 'z', executable: false },
      { path: 'README.md', content: '# 根', executable: false },
      { path: 'a.b.d', content: 'dotted', executable: false },
      { path: 'scripts/run.sh', content: 'x', executable: true },
      { path: 'scripts/a.sh', content: 'a', executable: true },
      { path: '.claude-plugin/plugin.json', content: '{}', executable: false },
    ];
    mount({ files: flat, onSelect: vi.fn() });
    await click(row('scripts'));

    expect(titles(tree())).toEqual([
      '.claude-plugin',
      'falsey',
      'scripts',
      'a.b.d',
      'README.md',
      'zeta.md',
    ]);

    const scriptsGroup = item('scripts').querySelector(':scope > [role="group"]');
    expect(scriptsGroup && titles(scriptsGroup)).toEqual(['scripts/a.sh', 'scripts/run.sh']);
  });

  it('puts the SKILL.md entry file before support folders', async () => {
    mount({ files, onSelect: vi.fn() });
    await click(row('skills/alpha'));

    const alphaGroup = item('skills/alpha').querySelector(':scope > [role="group"]');
    expect(alphaGroup && titles(alphaGroup)).toEqual([
      'skills/alpha/SKILL.md',
      'skills/alpha/references',
    ]);
  });

  it('keeps one chevron slot on every row so labels align', () => {
    mount({ files, onSelect: vi.fn(), selectedPath: DEEP });

    for (const title of ['skills', 'skills/alpha', 'skills/alpha/references', DEEP]) {
      const slot = row(title).firstElementChild;
      expect(slot?.getAttribute('aria-hidden'), title).toBe('true');
      expect(slot?.className, title).toContain('size-4');
    }
  });

  it('marks only the selected file and leaves expanded folders unfilled', () => {
    mount({ files, onSelect: vi.fn(), selectedPath: 'README.md' });

    expect(row('README.md').className).toContain('bg-selected');
    expect(row('zeta.md').className).not.toContain('bg-selected');

    // skills 默认展开，不应为了表示展开而铺任何底色（hover: 变体不算常态底色）。
    expect(item('skills').getAttribute('aria-expanded')).toBe('true');
    for (const title of ['skills', 'skills/alpha']) {
      const backgrounds = row(title)
        .className.split(/\s+/)
        .filter((name) => name.startsWith('bg-'));
      expect(backgrounds).toEqual([]);
    }
  });

  it('reaches every file through all levels of the tree', async () => {
    mount({ files, onSelect: vi.fn() });

    for (const title of [
      'skills/alpha',
      'skills/alpha/references',
      '.claude-plugin',
      'output-styles',
    ]) {
      await click(row(title));
    }

    const visible = [...body().querySelectorAll('[role="treeitem"]')].filter(
      (entry) => entry.getAttribute('aria-expanded') === null,
    );
    expect(visible).toHaveLength(files.length);
    for (const file of files) expect(row(file.path)).not.toBeNull();
  });

  it('keeps every row inside the tree width, including deep nesting', () => {
    mount({ files, onSelect: vi.fn(), selectedPath: DEEP });

    // 每层只加一个 ms-4 缩进与 1px 引导线，长名由 truncate 收敛，不撑开文档。
    const referencesGroup =
      item('skills/alpha/references').querySelector(':scope > [role="group"]');
    expect(referencesGroup?.className).toContain('ms-4');
    expect(referencesGroup?.className).toContain('border-s border-line');
    expect(row(DEEP).className).toContain('min-w-0');
    expect(row(DEEP).querySelector('span.truncate')?.textContent).toBe(LONG_NAME);
  });

  it('reveals every ancestor when the selected path changes', () => {
    mount({ files, onSelect: vi.fn() });

    expect(item('output-styles').getAttribute('aria-expanded')).toBe('false');
    rerender({ files, onSelect: vi.fn(), selectedPath: 'output-styles/compact.md' });
    expect(item('output-styles').getAttribute('aria-expanded')).toBe('true');
    expect(item('output-styles/compact.md').getAttribute('aria-current')).toBe('page');

    // skills 默认展开，但更深的 alpha / references 仍按选中路径自动展开。
    rerender({ files, onSelect: vi.fn(), selectedPath: DEEP });
    expect(item('skills/alpha').getAttribute('aria-expanded')).toBe('true');
    expect(item('skills/alpha/references').getAttribute('aria-expanded')).toBe('true');
    expect(item(DEEP).getAttribute('aria-current')).toBe('page');
  });

  it('shows the base name while keeping the full path for selection and hover', async () => {
    const onSelect = vi.fn();
    mount({ files, onSelect, selectedPath: DEEP });

    const long = row(DEEP);
    expect(long.textContent).toBe(LONG_NAME);
    expect(long.getAttribute('title')).toBe(DEEP);

    await click(long);
    expect(onSelect).toHaveBeenCalledWith(DEEP);
  });

  it('renders an empty state when the plugin has no files', () => {
    mount({ files: [], onSelect: vi.fn() });

    expect(body().querySelector('[role="tree"]')).toBeNull();
    expect(body().textContent).toContain('没有可查看的文件');
  });
});
