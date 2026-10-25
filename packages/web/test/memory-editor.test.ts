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
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
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
