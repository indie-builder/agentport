import type {
  MemoryChange,
  MemoryFileContent,
  MemoryFileList,
  OutputStyle,
  Rule,
} from '@agentport/shared';
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
const memoryChange: MemoryChange = {
  id: 'chg_1',
  target: { kind: 'agent_memory', agentId: 'expert', name: 'MEMORY.md' },
  before: { content: '', globs: null, index: null },
  after: { content: '# 记忆', globs: null, index: null },
  sourceReviewRunId: null,
  reversesChangeId: null,
  state: 'applied',
  createdAt: '2026-10-01T00:00:00.000Z',
};
const topicCreation: MemoryChange = {
  id: 'chg_topic',
  target: { kind: 'agent_memory', agentId: 'expert', name: 'topic.md' },
  before: { content: null, globs: null, index: { content: '# 记忆\n' } },
  after: {
    content: '# 新主题正文',
    globs: null,
    index: { content: '# 记忆\n- [topic.md](topic.md)\n' },
  },
  sourceReviewRunId: 'run-topic',
  reversesChangeId: null,
  state: 'applied',
  createdAt: '2026-10-02T00:00:00.000Z',
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
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const element = buttonOrNull(text, scope);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
function buttonOrNull(text: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text,
  );
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
  vi.spyOn(api, 'agentMemoryVersions').mockResolvedValue({ items: [] });
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

  it('提供原生记忆下载，无写权限时不显示任何写动作', async () => {
    mount(createElement(MemoryPanel, { agentId: 'expert', canWrite: false }));

    await waitFor(() => editorView('memory-content'));
    const download = host.querySelector<HTMLAnchorElement>('a[download]');
    expect(download?.getAttribute('href')).toBe('/api/agents/expert/memory/download');
    expect(buttonOrNull('记忆保存')).toBeUndefined();
    expect(buttonOrNull('新建记忆文件')).toBeUndefined();
    expect(buttonOrNull('删除 MEMORY.md')).toBeUndefined();
    expect(buttonOrNull('回滚')).toBeUndefined();
  });

  it('无写权限且记忆未初始化时不显示初始化动作', async () => {
    vi.mocked(api.agentMemory).mockResolvedValue({ files: [], initialized: false });
    mount(createElement(MemoryPanel, { agentId: 'expert', canWrite: false }));

    await waitFor(() => host.textContent?.includes('初始化记忆'));
    expect(buttonOrNull('初始化 MEMORY.md')).toBeUndefined();
  });

  it('按所选文件加载版本，可查看内容并回滚', async () => {
    vi.mocked(api.agentMemoryVersions).mockResolvedValue({ items: [memoryChange] });
    const rollback = vi
      .spyOn(api, 'rollbackMemoryChange')
      .mockResolvedValue({ ...memoryChange, id: 'chg_2', reversesChangeId: 'chg_1' });
    mount(createElement(MemoryPanel, { agentId: 'expert' }));

    await waitFor(() => buttonOrNull('查看'));
    expect(api.agentMemoryVersions).toHaveBeenCalledWith(
      'expert',
      'MEMORY.md',
      expect.any(AbortSignal),
    );

    await click(button('查看'));
    const view = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'));
    expect(view?.textContent).toContain('# 记忆');
    await click(button('关闭', view as HTMLElement));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

    await click(button('回滚'));
    const confirm = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'));
    await click(button('回滚', confirm as HTMLElement));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith('chg_1'));
  });

  it('切换主题后按该文件名请求版本', async () => {
    vi.mocked(api.agentMemory).mockResolvedValue({
      files: [
        { name: 'MEMORY.md', size: 4, updatedAt: '2026-01-01T00:00:00Z' },
        { name: 'topic.md', size: 8, updatedAt: '2026-01-01T00:00:00Z' },
      ],
      initialized: true,
    });
    mount(createElement(MemoryPanel, { agentId: 'expert' }));

    await waitFor(() => buttonOrNull('topic.md'));
    await click(button('topic.md'));
    await waitFor(() =>
      expect(api.agentMemoryVersions).toHaveBeenCalledWith(
        'expert',
        'topic.md',
        expect.any(AbortSignal),
      ),
    );
  });

  it('保存成功后清掉已提交草稿，外部刷新显示服务端正文', async () => {
    vi.spyOn(api, 'writeAgentMemoryFile').mockResolvedValue({
      ...memoryFile,
      content: '# 新记忆',
    });
    vi.mocked(api.agentMemoryFile)
      .mockResolvedValueOnce(memoryFile)
      .mockResolvedValue({ ...memoryFile, content: '# 外部更新' });
    mount(createElement(MemoryPanel, { agentId: 'expert' }));

    await waitFor(() => editorView('memory-content'));
    await replaceContent('memory-content', '# 新记忆');
    await click(button('记忆保存'));

    await waitFor(() =>
      expect(editorView('memory-content').state.doc.toString()).toBe('# 外部更新'),
    );
    expect(button('记忆保存').disabled).toBe(true);
  });

  it('外部刷新不覆盖未保存的真实草稿', async () => {
    vi.mocked(api.agentMemoryFile)
      .mockResolvedValueOnce(memoryFile)
      .mockResolvedValue({ ...memoryFile, content: '# 外部更新' });
    mount(createElement(MemoryPanel, { agentId: 'expert' }));

    await waitFor(() => editorView('memory-content'));
    await replaceContent('memory-content', '# 未保存草稿');
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['agent-memory-file', 'expert', 'MEMORY.md'],
      });
    });
    await flush();

    expect(editorView('memory-content').state.doc.toString()).toBe('# 未保存草稿');
    expect(button('记忆保存').disabled).toBe(false);
  });

  it('MEMORY.md 版本包含主题新建，摘要与查看取伴随索引并说明回滚删除主题', async () => {
    vi.mocked(api.agentMemory).mockResolvedValue({
      files: [
        { name: 'MEMORY.md', size: 4, updatedAt: '2026-01-01T00:00:00Z' },
        { name: 'topic.md', size: 8, updatedAt: '2026-01-01T00:00:00Z' },
      ],
      initialized: true,
    });
    vi.mocked(api.agentMemoryVersions).mockResolvedValue({ items: [topicCreation] });
    mount(createElement(MemoryPanel, { agentId: 'expert' }));

    await waitFor(() => buttonOrNull('查看'));
    expect(host.textContent).toContain('- [topic.md](topic.md)');
    expect(host.querySelector('ul.divide-y')?.textContent).not.toContain('# 新主题正文');

    await click(button('查看'));
    const view = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'));
    expect(view?.textContent).toContain('主题「topic.md」正文');
    expect(view?.textContent).toContain('# 新主题正文');
    expect(view?.textContent).toContain('MEMORY.md 索引');
    expect(view?.textContent).toContain('- [topic.md](topic.md)');
    await click(button('关闭', view as HTMLElement));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

    await click(button('回滚'));
    const confirm = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'));
    expect(confirm?.textContent).toContain('删除新建的主题「topic.md」');
    expect(confirm?.textContent).toContain('MEMORY.md');
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
