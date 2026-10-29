import type { SkillFile } from '@agentport/shared';
import { language } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { toastError, toastSuccess } from '../src/lib/toast.js';
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

function supportFile(path: string, content: string): SkillFile {
  return { id: `file-${path}`, path, content, createdAt: '2026-01-01' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function byLabel(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Missing button labelled: ${label}`);
  return found;
}

beforeEach(() => {
  state.saving = false;
  vi.clearAllMocks();
  state.update.mockImplementation((vars, options) => {
    options?.onSuccess?.({ ...skill, ...vars.input, updatedAt: 'v2' });
  });
  vi.spyOn(api, 'skillFiles').mockResolvedValue([]);
  vi.spyOn(api, 'deleteSkillFile').mockResolvedValue();
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

  it('keeps the dialog open after saving the body while a file draft is unsaved', async () => {
    const onClose = vi.fn();
    mount(createElement(SkillDialog, { skill, onClose }));
    await waitFor(() => editorView('skill-file-content'));

    fill('skill-file-path', 'scripts/draft.sh');
    await replaceContent('skill-file-content', 'echo draft');

    await click(button('保存'));
    expect(state.update).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(editorView('skill-file-content').state.doc.toString()).toBe('echo draft');
    expect((document.getElementById('skill-file-path') as HTMLInputElement).value).toBe(
      'scripts/draft.sh',
    );

    // 版本基线已更新，第二次保存不会带旧版本号触发冲突。
    await click(button('保存'));
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(state.update.mock.calls[1]?.[0].expectedUpdatedAt).toBe('v2');
  });

  it('closes after saving the body when there is no file draft', async () => {
    const onClose = vi.fn();
    mount(createElement(SkillDialog, { skill, onClose }));
    await waitFor(() => editorView('skill-file-content'));

    await click(button('保存'));
    await flush();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('loads a saved file into the editor and saves back to the same path', async () => {
    const path = 'references/a-very-long-directory-name/with-an-even-longer-file-name.md';
    vi.mocked(api.skillFiles).mockResolvedValue([supportFile(path, 'old body')]);
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));

    const select = await waitFor(() => byLabel(`编辑支持文件 ${path}`));
    expect(select.textContent).toBe(path);
    expect(select.title).toBe(path);
    await click(select);

    const input = document.getElementById('skill-file-path') as HTMLInputElement;
    expect(input.value).toBe(path);
    expect(input.readOnly).toBe(true);
    expect(editorView('skill-file-content').state.doc.toString()).toBe('old body');

    await replaceContent('skill-file-content', 'new body');
    await click(button('保存文件'));
    await waitFor(() => api.writeSkillFile.mock.calls.length > 0);
    expect(api.writeSkillFile).toHaveBeenCalledWith('skill', path, 'new body');
  });

  it('opens an empty saved file without losing the path', async () => {
    vi.mocked(api.skillFiles).mockResolvedValue([supportFile('empty.txt', '')]);
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));

    await click(await waitFor(() => byLabel('编辑支持文件 empty.txt')));
    expect((document.getElementById('skill-file-path') as HTMLInputElement).value).toBe(
      'empty.txt',
    );
    expect(editorView('skill-file-content').state.doc.toString()).toBe('');
    expect(document.getElementById('skill-file-content')?.getAttribute('contenteditable')).not.toBe(
      'false',
    );
  });

  it('asks before deleting a saved file', async () => {
    vi.mocked(api.skillFiles).mockResolvedValue([supportFile('scripts/run.sh', 'echo hi')]);
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));

    await click(await waitFor(() => byLabel('删除支持文件 scripts/run.sh')));
    expect(api.deleteSkillFile).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('删除支持文件');
    expect(document.body.textContent).toContain('scripts/run.sh');

    await click(button('删除文件'));
    await waitFor(() => api.deleteSkillFile.mock.calls.length > 0);
    expect(api.deleteSkillFile).toHaveBeenCalledWith('skill', 'scripts/run.sh');
  });

  it('disables file fields and the dialog close while an add is in flight', async () => {
    const gate = deferred<SkillFile>();
    vi.mocked(api.writeSkillFile).mockReturnValueOnce(gate.promise);
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));
    await waitFor(() => editorView('skill-file-content'));

    fill('skill-file-path', 'scripts/run.sh');
    await replaceContent('skill-file-content', 'echo hi');
    await click(button('添加文件'));
    await flush();

    expect((document.getElementById('skill-file-path') as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById('skill-file-content')?.getAttribute('contenteditable')).toBe(
      'false',
    );
    expect(button('处理中…').disabled).toBe(true);
    expect(button('保存中…').disabled).toBe(true);
    expect(byLabel('关闭').disabled).toBe(true);

    gate.resolve(supportFile('scripts/run.sh', 'echo hi'));
    await flush();
    expect((document.getElementById('skill-file-path') as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps the dialog pending until a slow file list refresh finishes', async () => {
    vi.mocked(api.skillFiles).mockResolvedValue([supportFile('scripts/run.sh', 'old body')]);
    const refresh = deferred<SkillFile[]>();
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));

    await click(await waitFor(() => byLabel('编辑支持文件 scripts/run.sh')));
    await replaceContent('skill-file-content', 'new body');
    vi.mocked(api.skillFiles).mockReturnValueOnce(refresh.promise);

    await click(button('保存文件'));
    await waitFor(() => api.writeSkillFile.mock.calls.length > 0);
    // 写入已完成，但列表刷新还没回来：仍锁住编辑，避免重选到旧内容。
    expect((document.getElementById('skill-file-path') as HTMLInputElement).disabled).toBe(true);
    expect(button('处理中…').disabled).toBe(true);
    expect(vi.mocked(toastSuccess)).not.toHaveBeenCalled();

    refresh.resolve([supportFile('scripts/run.sh', 'new body')]);
    await waitFor(() => !(document.getElementById('skill-file-path') as HTMLInputElement).disabled);
    expect(vi.mocked(toastSuccess)).toHaveBeenCalledWith('支持文件已保存');

    await click(byLabel('编辑支持文件 scripts/run.sh'));
    expect(editorView('skill-file-content').state.doc.toString()).toBe('new body');
  });

  it('blocks reselecting stale files after a refresh failure until retry succeeds', async () => {
    vi.mocked(api.skillFiles).mockResolvedValue([supportFile('scripts/run.sh', 'old body')]);
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));

    await click(await waitFor(() => byLabel('编辑支持文件 scripts/run.sh')));
    await replaceContent('skill-file-content', 'new body');
    vi.mocked(api.skillFiles).mockRejectedValueOnce(new Error('refresh failed'));

    await click(button('保存文件'));
    await waitFor(() => vi.mocked(toastError).mock.calls.length > 0);
    expect(vi.mocked(toastSuccess)).not.toHaveBeenCalled();
    expect((document.getElementById('skill-file-path') as HTMLInputElement).disabled).toBe(false);
    expect(editorView('skill-file-content').state.doc.toString()).toBe('new body');
    // 刷新失败时缓存仍是旧内容，重选会载入旧稿覆盖刚写入的版本。
    expect(byLabel('编辑支持文件 scripts/run.sh').disabled).toBe(true);

    vi.mocked(api.skillFiles).mockResolvedValueOnce([supportFile('scripts/run.sh', 'new body')]);
    await click(button('重试'));
    await waitFor(() => !byLabel('编辑支持文件 scripts/run.sh').disabled);

    await click(byLabel('编辑支持文件 scripts/run.sh'));
    await click(button('放弃更改'));
    expect(editorView('skill-file-content').state.doc.toString()).toBe('new body');
  });

  it('keeps the delete confirmation open and retries after a rejected delete', async () => {
    vi.mocked(api.skillFiles).mockResolvedValue([supportFile('scripts/run.sh', 'echo hi')]);
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));

    await click(await waitFor(() => byLabel('删除支持文件 scripts/run.sh')));
    vi.mocked(api.deleteSkillFile).mockRejectedValueOnce(new Error('network down'));
    await click(button('删除文件'));
    await flush();

    expect(vi.mocked(toastError)).toHaveBeenCalled();
    expect(document.body.textContent).toContain('删除支持文件');
    expect(button('删除文件').disabled).toBe(false);

    await click(button('删除文件'));
    await waitFor(() => !document.body.textContent?.includes('删除支持文件'));
    expect(api.deleteSkillFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(toastSuccess)).toHaveBeenCalledWith('已删除支持文件');
  });

  it('protects unsaved file edits when switching files or starting a new one', async () => {
    vi.mocked(api.skillFiles).mockResolvedValue([
      supportFile('a.md', 'alpha'),
      supportFile('b.md', 'beta'),
    ]);
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));

    await click(await waitFor(() => byLabel('编辑支持文件 a.md')));
    await replaceContent('skill-file-content', 'alpha draft');
    await click(byLabel('编辑支持文件 b.md'));

    expect(document.body.textContent).toContain('放弃未保存的文件更改？');
    expect(editorView('skill-file-content').state.doc.toString()).toBe('alpha draft');

    await click(button('放弃更改'));
    expect(editorView('skill-file-content').state.doc.toString()).toBe('beta');

    await replaceContent('skill-file-content', 'beta draft');
    await click(button('新建文件'));
    expect(document.body.textContent).toContain('放弃未保存的文件更改？');
    await click(button('放弃更改'));
    expect((document.getElementById('skill-file-path') as HTMLInputElement).value).toBe('');
    expect(editorView('skill-file-content').state.doc.toString()).toBe('');
  });

  it('protects the file draft when closing the dialog', async () => {
    const onClose = vi.fn();
    mount(createElement(SkillDialog, { skill, onClose }));
    await waitFor(() => editorView('skill-file-content'));

    fill('skill-file-path', 'scripts/draft.sh');
    await click(button('取消'));

    expect(document.body.textContent).toContain('放弃未保存的更改？');
    expect(onClose).not.toHaveBeenCalled();

    await click(button('放弃并关闭'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('skill support file path validation', () => {
  it.each([
    ['SKILL.md', '资源路径不能占用 SKILL.md'],
    ['skill.MD', '资源路径不能占用 SKILL.md'],
    ['refs//a.md', '路径必须是相对路径，且不能包含 .、.. 或空路径段'],
    ['./refs/a.md', '路径必须是相对路径，且不能包含 .、.. 或空路径段'],
  ])('rejects %s before writing and exposes an accessible error', async (path, message) => {
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));
    await waitFor(() => editorView('skill-file-content'));

    fill('skill-file-path', path);
    await click(button('添加文件'));

    const input = document.getElementById('skill-file-path') as HTMLInputElement;
    expect(api.writeSkillFile).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('skill-file-path-error');
    const error = document.getElementById('skill-file-path-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toBe(message);
  });

  it('keeps the form required message for an empty path', async () => {
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));
    await waitFor(() => editorView('skill-file-content'));

    await click(button('添加文件'));

    expect(api.writeSkillFile).not.toHaveBeenCalled();
    expect(document.getElementById('skill-file-path-error')?.textContent).toBe(
      '不能为空，请填写后再保存',
    );
  });

  it('saves a nested SKILL.md resource under a legal directory', async () => {
    mount(createElement(SkillDialog, { skill, onClose: vi.fn() }));
    await waitFor(() => editorView('skill-file-content'));

    fill('skill-file-path', 'references/nested/SKILL.md');
    await replaceContent('skill-file-content', 'nested body');
    await click(button('添加文件'));

    await waitFor(() => api.writeSkillFile.mock.calls.length > 0);
    expect(api.writeSkillFile).toHaveBeenCalledWith(
      'skill',
      'references/nested/SKILL.md',
      'nested body',
    );
    expect(document.getElementById('skill-file-path-error')).toBeNull();
  });
});
