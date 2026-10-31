import type { MemoryFileContent, MemoryFileList, OutputStyle, Rule } from '@agentport/shared';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { MemoryPanel, OutputStylesPanel, RulesPanel } from '../src/pages/memory-panel.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const memoryFile: MemoryFileContent = {
  name: 'MEMORY.md',
  content: '# 记忆',
  updatedAt: '2026-01-01T00:00:00Z',
};
const memoryList: MemoryFileList = {
  files: [{ name: 'MEMORY.md', size: 4, updatedAt: '2026-01-01T00:00:00Z' }],
  initialized: true,
};
const rule: Rule = {
  id: 'rule-1',
  agentId: 'expert',
  slug: 'no-console',
  content: '# 规则',
  globs: '',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const secondRule: Rule = {
  ...rule,
  id: 'rule-2',
  slug: 'no-any',
  content: '# 第二条规则',
  globs: 'src/**',
};
const style: OutputStyle = {
  id: 'style-1',
  agentId: 'expert',
  slug: 'concise',
  description: '简短',
  keepCodingInstructions: false,
  body: '# 风格',
  isSelected: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const selectedStyle: OutputStyle = { ...style, isSelected: true };
const secondStyle: OutputStyle = {
  ...style,
  id: 'style-2',
  slug: 'verbose',
  description: '详细',
  body: '# 第二种风格',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function waitFor<T>(probe: () => T, tries = 60): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 查询或懒加载还没落地，继续等。
    }
    await flush();
  }
  return probe();
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}
function button(text: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
// 输出风格列表项会带“已启用”后缀，按名称前缀定位。
function itemButton(name: string): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.trim().startsWith(name),
  );
  if (!element) throw new Error(`Missing item button: ${name}`);
  return element;
}
function editorView(id: string): EditorView {
  const element = document.getElementById(id);
  if (!element?.classList.contains('cm-content')) {
    throw new Error(`Editor not mounted: ${id}`);
  }
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error(`Editor view not found: ${id}`);
  return view;
}
async function replaceContent(id: string, value: string) {
  await act(async () => {
    const view = editorView(id);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  });
  await flush();
}
async function refetch(key: string[]) {
  await act(async () => {
    await client.refetchQueries({ queryKey: key, exact: true });
  });
  await flush();
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

function mount(element: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(QueryClientProvider, { client }, element)));
}

beforeEach(() => {
  vi.spyOn(api, 'agentMemory').mockResolvedValue(memoryList);
  vi.spyOn(api, 'agentMemoryFile').mockResolvedValue(memoryFile);
  vi.spyOn(api, 'agentRules').mockResolvedValue([rule]);
  vi.spyOn(api, 'agentOutputStyles').mockResolvedValue([style]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('memory file editor', () => {
  it('edits markdown with the source editor and marks the draft dirty', async () => {
    const onDirtyChange = vi.fn();
    mount(createElement(MemoryPanel, { agentId: 'expert', onDirtyChange }));

    const view = await waitFor(() => editorView('memory-content'));
    expect(view.state.doc.toString()).toBe('# 记忆');
    expect(document.querySelector('label[for="memory-content"]')?.textContent).toBe(
      'MEMORY.md 内容',
    );
    expect(document.getElementById('memory-content')?.getAttribute('aria-label')).toBe(
      'MEMORY.md 内容',
    );
    expect(button('记忆保存').disabled).toBe(true);

    await replaceContent('memory-content', '# 新记忆');

    expect(editorView('memory-content').state.doc.toString()).toBe('# 新记忆');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(button('记忆保存').disabled).toBe(false);
  });

  it('takes the memory editor out of editing while saving', async () => {
    const saved = deferred<MemoryFileContent>();
    vi.spyOn(api, 'writeAgentMemoryFile').mockReturnValue(saved.promise);
    mount(createElement(MemoryPanel, { agentId: 'expert' }));

    await waitFor(() => editorView('memory-content'));
    await replaceContent('memory-content', '# 新记忆');
    await click(button('记忆保存'));

    const editor = document.getElementById('memory-content');
    expect(editor?.getAttribute('contenteditable')).toBe('false');
    expect(editor?.getAttribute('aria-disabled')).toBe('true');

    saved.resolve({ ...memoryFile, content: '# 新记忆' });
    await flush();
    expect(document.getElementById('memory-content')?.getAttribute('contenteditable')).toBe('true');
  });
});

describe('rule editor', () => {
  it('edits rule markdown with the source editor and marks the draft dirty', async () => {
    const onDirtyChange = vi.fn();
    mount(createElement(RulesPanel, { agentId: 'expert', onDirtyChange }));

    await waitFor(() => button('no-console'));
    await click(button('no-console'));

    const view = await waitFor(() => editorView('rule-content'));
    expect(view.state.doc.toString()).toBe('# 规则');
    expect(document.querySelector('label[for="rule-content"]')?.textContent).toBe(
      '规则内容（Markdown）',
    );
    expect(button('保存规则').disabled).toBe(true);

    await replaceContent('rule-content', '# 新规则');

    expect(editorView('rule-content').state.doc.toString()).toBe('# 新规则');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(button('保存规则').disabled).toBe(false);
  });

  it('takes the rule editor out of editing while saving', async () => {
    const saved = deferred<Rule>();
    vi.spyOn(api, 'writeAgentRule').mockReturnValue(saved.promise);
    mount(createElement(RulesPanel, { agentId: 'expert' }));

    await waitFor(() => button('no-console'));
    await click(button('no-console'));
    await waitFor(() => editorView('rule-content'));
    await replaceContent('rule-content', '# 新规则');
    await click(button('保存规则'));

    const editor = document.getElementById('rule-content');
    expect(editor?.getAttribute('contenteditable')).toBe('false');
    expect(editor?.getAttribute('aria-disabled')).toBe('true');

    saved.resolve({ ...rule, content: '# 新规则' });
    await flush();
  });
});

describe('output style editor', () => {
  it('edits style markdown with the source editor and marks the draft dirty', async () => {
    const onDirtyChange = vi.fn();
    mount(createElement(OutputStylesPanel, { agentId: 'expert', onDirtyChange }));

    await waitFor(() => button('concise'));
    await click(button('concise'));

    const view = await waitFor(() => editorView('output-style-body'));
    expect(view.state.doc.toString()).toBe('# 风格');
    expect(document.querySelector('label[for="output-style-body"]')?.textContent).toBe('风格内容');
    expect(button('风格保存').disabled).toBe(true);

    await replaceContent('output-style-body', '# 新风格');

    expect(editorView('output-style-body').state.doc.toString()).toBe('# 新风格');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(button('风格保存').disabled).toBe(false);
  });

  it('takes the style editor out of editing while saving', async () => {
    const saved = deferred<OutputStyle>();
    vi.spyOn(api, 'writeAgentOutputStyle').mockReturnValue(saved.promise);
    mount(createElement(OutputStylesPanel, { agentId: 'expert' }));

    await waitFor(() => button('concise'));
    await click(button('concise'));
    await waitFor(() => editorView('output-style-body'));
    await replaceContent('output-style-body', '# 新风格');
    await click(button('风格保存'));

    const editor = document.getElementById('output-style-body');
    expect(editor?.getAttribute('contenteditable')).toBe('false');
    expect(editor?.getAttribute('aria-disabled')).toBe('true');

    saved.resolve({ ...style, body: '# 新风格' });
    await flush();
  });
});

describe('readonly rule and style panels', () => {
  it('opens rules read-only without enabling writes or pending', async () => {
    vi.mocked(api.agentRules).mockResolvedValue([rule, secondRule]);
    const onPendingChange = vi.fn();
    const write = vi.spyOn(api, 'writeAgentRule');
    const remove = vi.spyOn(api, 'deleteAgentRule');
    mount(createElement(RulesPanel, { agentId: 'expert', canWrite: false, onPendingChange }));

    await waitFor(() => button('no-console'));
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false));
    expect(button('新建规则').disabled).toBe(true);

    await click(button('no-console'));
    const view = await waitFor(() => editorView('rule-content'));
    expect(view.state.doc.toString()).toBe('# 规则');
    expect(document.getElementById('rule-content')?.getAttribute('contenteditable')).toBe('false');
    expect(document.getElementById('rule-content')?.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById('rule-globs')?.getAttribute('disabled')).not.toBeNull();
    expect(button('保存规则').disabled).toBe(true);
    expect(button('删除规则 no-console').disabled).toBe(true);

    await click(button('no-any'));
    await waitFor(() =>
      expect(editorView('rule-content').state.doc.toString()).toBe('# 第二条规则'),
    );
    expect(editorView('rule-content')).toBe(view);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it('opens output styles read-only without enabling writes or pending', async () => {
    vi.mocked(api.agentOutputStyles).mockResolvedValue([selectedStyle, secondStyle]);
    const onPendingChange = vi.fn();
    const write = vi.spyOn(api, 'writeAgentOutputStyle');
    const unselect = vi.spyOn(api, 'unselectAgentOutputStyle');
    const remove = vi.spyOn(api, 'deleteAgentOutputStyle');
    mount(
      createElement(OutputStylesPanel, { agentId: 'expert', canWrite: false, onPendingChange }),
    );

    await waitFor(() => itemButton('concise'));
    await waitFor(() => expect(onPendingChange).toHaveBeenLastCalledWith(false));
    expect(button('新建风格').disabled).toBe(true);

    await click(itemButton('concise'));
    const view = await waitFor(() => editorView('output-style-body'));
    expect(view.state.doc.toString()).toBe('# 风格');
    expect(document.getElementById('output-style-body')?.getAttribute('contenteditable')).toBe(
      'false',
    );
    expect(document.getElementById('output-style-body')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(
      document.getElementById('output-style-description')?.getAttribute('disabled'),
    ).not.toBeNull();
    expect(document.getElementById('output-style-slug')?.getAttribute('disabled')).not.toBeNull();
    expect(
      document.getElementById('output-style-keep-coding')?.getAttribute('disabled'),
    ).not.toBeNull();
    expect(button('风格保存').disabled).toBe(true);
    expect(button('取消启用').disabled).toBe(true);
    expect(button('删除风格 concise').disabled).toBe(true);

    await click(itemButton('verbose'));
    await waitFor(() =>
      expect(editorView('output-style-body').state.doc.toString()).toBe('# 第二种风格'),
    );
    expect(editorView('output-style-body')).toBe(view);
    expect(write).not.toHaveBeenCalled();
    expect(unselect).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });
});

describe('readonly uninitialized memory', () => {
  it('reads existing files without offering or sending initialization', async () => {
    vi.mocked(api.agentMemory).mockResolvedValue({
      files: [{ name: 'notes.md', size: 5, updatedAt: '2026-01-01T00:00:00Z' }],
      initialized: false,
    });
    vi.mocked(api.agentMemoryFile).mockResolvedValue({
      name: 'notes.md',
      content: '# 笔记',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const create = vi.spyOn(api, 'writeAgentMemoryFile');
    mount(createElement(MemoryPanel, { agentId: 'expert', canWrite: false }));

    const view = await waitFor(() => editorView('memory-content'));
    expect(view.state.doc.toString()).toBe('# 笔记');
    expect(button('notes.md')).toBeDefined();
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('button')].some((item) =>
        item.textContent?.includes('初始化'),
      ),
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('offers no initialization action when readonly memory has no files', async () => {
    vi.mocked(api.agentMemory).mockResolvedValue({ files: [], initialized: false });
    const create = vi.spyOn(api, 'writeAgentMemoryFile');
    mount(createElement(MemoryPanel, { agentId: 'expert', canWrite: false }));

    await waitFor(() => expect(host.textContent).toContain('初始化记忆'));
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('button')].some((item) =>
        item.textContent?.includes('初始化'),
      ),
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('background refresh errors keep cached editors', () => {
  it('keeps the selected memory file and its draft when the memory list refresh fails', async () => {
    let fail = false;
    vi.mocked(api.agentMemory).mockImplementation(async () => {
      if (fail) throw new Error('列表刷新失败');
      return memoryList;
    });
    mount(createElement(MemoryPanel, { agentId: 'expert' }));

    const view = await waitFor(() => editorView('memory-content'));
    const node = document.getElementById('memory-content');
    await replaceContent('memory-content', '# 草稿');
    expect(button('记忆保存').disabled).toBe(false);

    fail = true;
    await refetch(['agent-memory', 'expert']);
    expect(host.textContent).toContain('列表刷新失败');
    expect(button('MEMORY.md')).toBeDefined();
    expect(document.getElementById('memory-content')).toBe(node);
    expect(editorView('memory-content')).toBe(view);
    expect(view.state.doc.toString()).toBe('# 草稿');
    expect(button('记忆保存').disabled).toBe(false);

    fail = false;
    await click(button('重试'));
    await waitFor(() => expect(host.textContent).not.toContain('列表刷新失败'));
    expect(editorView('memory-content')).toBe(view);
    expect(view.state.doc.toString()).toBe('# 草稿');
  });

  it('keeps the memory file editor and draft when the file refresh fails', async () => {
    let fail = false;
    vi.mocked(api.agentMemoryFile).mockImplementation(async () => {
      if (fail) throw new Error('文件刷新失败');
      return memoryFile;
    });
    mount(createElement(MemoryPanel, { agentId: 'expert' }));

    const view = await waitFor(() => editorView('memory-content'));
    const node = document.getElementById('memory-content');
    await replaceContent('memory-content', '# 文件草稿');

    fail = true;
    await refetch(['agent-memory-file', 'expert', 'MEMORY.md']);
    expect(host.textContent).toContain('文件刷新失败');
    expect(document.getElementById('memory-content')).toBe(node);
    expect(editorView('memory-content')).toBe(view);
    expect(view.state.doc.toString()).toBe('# 文件草稿');
    expect(button('记忆保存').disabled).toBe(false);

    fail = false;
    await click(button('重试'));
    await waitFor(() => expect(host.textContent).not.toContain('文件刷新失败'));
    expect(editorView('memory-content')).toBe(view);
    expect(view.state.doc.toString()).toBe('# 文件草稿');
  });

  it('keeps the rule editor and draft when the rule list refresh fails', async () => {
    let fail = false;
    vi.mocked(api.agentRules).mockImplementation(async () => {
      if (fail) throw new Error('规则刷新失败');
      return [rule];
    });
    mount(createElement(RulesPanel, { agentId: 'expert' }));

    await waitFor(() => button('no-console'));
    await click(button('no-console'));
    const view = await waitFor(() => editorView('rule-content'));
    await replaceContent('rule-content', '# 规则草稿');

    fail = true;
    await refetch(['agent-rules', 'expert']);
    expect(host.textContent).toContain('规则刷新失败');
    expect(button('no-console')).toBeDefined();
    expect(editorView('rule-content')).toBe(view);
    expect(view.state.doc.toString()).toBe('# 规则草稿');
    expect(button('保存规则').disabled).toBe(false);

    fail = false;
    await click(button('重试'));
    await waitFor(() => expect(host.textContent).not.toContain('规则刷新失败'));
    expect(editorView('rule-content')).toBe(view);
    expect(view.state.doc.toString()).toBe('# 规则草稿');
  });

  it('keeps the style editor and draft when the style list refresh fails', async () => {
    let fail = false;
    vi.mocked(api.agentOutputStyles).mockImplementation(async () => {
      if (fail) throw new Error('风格刷新失败');
      return [style];
    });
    mount(createElement(OutputStylesPanel, { agentId: 'expert' }));

    await waitFor(() => button('concise'));
    await click(button('concise'));
    const view = await waitFor(() => editorView('output-style-body'));
    await replaceContent('output-style-body', '# 风格草稿');

    fail = true;
    await refetch(['agent-output-styles', 'expert']);
    expect(host.textContent).toContain('风格刷新失败');
    expect(button('concise')).toBeDefined();
    expect(editorView('output-style-body')).toBe(view);
    expect(view.state.doc.toString()).toBe('# 风格草稿');
    expect(button('风格保存').disabled).toBe(false);

    fail = false;
    await click(button('重试'));
    await waitFor(() => expect(host.textContent).not.toContain('风格刷新失败'));
    expect(editorView('output-style-body')).toBe(view);
    expect(view.state.doc.toString()).toBe('# 风格草稿');
  });
});
