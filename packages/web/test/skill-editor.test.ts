import { language } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { SkillDialog } from '../src/pages/skills.js';

const state = vi.hoisted(() => ({
  saving: false,
  update: vi.fn(),
}));

vi.mock('../src/lib/queries.js', () => ({
  useSkills: () => ({ data: [] }),
  useMarketSkills: () => ({}),
  useInstallMarketSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateSkill: () => ({ isPending: false, mutate: vi.fn() }),
  useUpdateSkill: () => ({ isPending: state.saving, mutate: state.update }),
  useDeleteSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useImportSkillFile: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: 'a',
  useNavigate: () => () => {},
  useSearch: () => ({}),
  useBlocker: () => ({ status: 'idle' }),
}));

const skill = {
  id: 'skill',
  slug: 'demo',
  name: 'Demo',
  description: '演示技能',
  body: '# 步骤',
  sourceId: null,
  createdAt: '2026-01-01',
  updatedAt: 'v1',
};

let client: QueryClient;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(element: ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false }, mutations: { retry: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(QueryClientProvider, { client }, element)));
}

function flush() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function waitFor<T>(probe: () => T, tries = 60): Promise<T> {
  for (let index = 0; index < tries; index += 1) {
    try {
      const value = probe();
      if (value) return value;
    } catch {
      // 懒加载的编辑器还没挂上，继续等。
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
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
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
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
  await flush();
}

function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) throw new Error(`Missing input: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  state.saving = false;
  vi.clearAllMocks();
  vi.spyOn(api, 'skillFiles').mockResolvedValue([]);
  vi.spyOn(api, 'writeSkillFile').mockResolvedValue({
    id: 'file',
    path: 'scripts/run.sh',
    content: 'echo hi',
    createdAt: '2026-01-01',
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  client.clear();
  host?.remove();
  root = undefined;
  host = undefined;
  vi.restoreAllMocks();
});

describe('skill body editor', () => {
  it('edits the body as markdown and marks the form dirty', async () => {
    const onClose = vi.fn();
    mount(createElement(SkillDialog, { onClose }));
    const view = await waitFor(() => editorView('skill-body'));

    expect(view.state.doc.toString()).toBe('');
    expect(view.state.facet(language)?.name).toBe('markdown');
    expect(document.querySelector('label[for="skill-body"]')?.textContent).toBe('步骤');
    expect(document.getElementById('skill-body')?.getAttribute('aria-label')).toBe('步骤');
    expect(document.body.textContent).toContain('支持 Markdown。');

    // 未编辑时关闭不需要放弃确认。
    await click(button('取消'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('放弃未保存的更改？');
  });

  it('marks the form dirty when the body editor changes', async () => {
    const onClose = vi.fn();
    mount(createElement(SkillDialog, { onClose }));
    await waitFor(() => editorView('skill-body'));

    await replaceContent('skill-body', '# 新步骤');

    await click(button('取消'));
    expect(document.body.textContent).toContain('放弃未保存的更改？');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('submits the markdown body from the editor', async () => {
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));
    await waitFor(() => editorView('skill-body'));

    await replaceContent('skill-body', '# 新步骤');
    expect(editorView('skill-body').state.doc.toString()).toBe('# 新步骤');

    await click(button('保存'));
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0].input.body).toBe('# 新步骤');
  });

  it('takes the body editor out of editing while saving', async () => {
    state.saving = true;
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));
    await waitFor(() => editorView('skill-body'));

    const editor = document.getElementById('skill-body');
    expect(editor?.getAttribute('contenteditable')).toBe('false');
    expect(editor?.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('skill support file editor', () => {
  it('edits file content as plain text and submits it with the path', async () => {
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));
    await waitFor(() => editorView('skill-file-content'));

    const editor = document.getElementById('skill-file-content');
    expect(editor?.getAttribute('aria-label')).toBe('文件内容');
    expect(editorView('skill-file-content').state.facet(language)).toBeNull();
    expect(document.querySelector('label[for="skill-file-content"]')).toBeNull();

    fill('skill-file-path', 'scripts/run.sh');
    await replaceContent('skill-file-content', 'echo hi');
    await click(button('添加文件'));

    await waitFor(() => api.writeSkillFile.mock.calls.length > 0);
    expect(api.writeSkillFile).toHaveBeenCalledWith('skill', 'scripts/run.sh', 'echo hi');
  });
});
