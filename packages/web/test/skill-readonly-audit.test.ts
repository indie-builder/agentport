import type { AuthMe, SkillFile, SkillWithAgentCount } from '@agentport/shared';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserHistory, createRoute, RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { SkillsPage } from '../src/pages/skills.js';
import { routerFor } from './navigation-blocker.js';

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const skill: SkillWithAgentCount = {
  id: 'skill',
  slug: 'demo',
  name: 'Demo',
  description: '演示技能',
  body: '# 步骤',
  sourceId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: 'v1',
  agentCount: 0,
};

const supportFile: SkillFile = {
  id: 'file-notes',
  path: 'notes.md',
  content: 'hello',
  createdAt: '2026-01-01',
};

function meWith(...permissionIds: string[]): AuthMe {
  return {
    authenticated: true,
    user: { businessId: 'test-admin', username: 'admin', name: '测试管理员' },
    roles: [],
    grants: permissionIds.map((permissionId) => ({ permissionId, scope: 'platform' })),
  } as AuthMe;
}

let client: QueryClient;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let history: ReturnType<typeof createBrowserHistory> | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

async function mount(me: AuthMe, staleTime = Infinity) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime },
      mutations: { retry: false },
    },
  });
  client.setQueryData(['me'], me);
  client.setQueryData(['skills'], [skill]);
  window.history.replaceState(null, '', '/skills');
  history = createBrowserHistory();
  const router = routerFor(history, (shell) => [
    createRoute({ getParentRoute: () => shell, path: '/skills', component: SkillsPage }),
  ]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

async function setMe(me: AuthMe) {
  await act(async () => {
    client.setQueryData(['me'], me);
  });
  await flush();
}

async function openSkill() {
  await click(button('Demo'));
  await waitFor(() => editorView('skill-body'));
}

function button(text: string): HTMLButtonElement {
  const found = buttonOrUndefined(text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function buttonOrUndefined(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
}

function byLabelOrUndefined(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label,
  );
}

function byLabel(label: string): HTMLButtonElement {
  const found = byLabelOrUndefined(label);
  if (!found) throw new Error(`Missing button labelled: ${label}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

function input(id: string): HTMLInputElement {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  return found;
}

async function typeInput(id: string, value: string) {
  const found = input(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(found, value);
    found.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
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

async function submitForm() {
  const form = document.querySelector('form');
  if (!form) throw new Error('Missing form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.spyOn(api, 'updateSkill');
  vi.spyOn(api, 'skillFiles').mockResolvedValue([]);
  vi.spyOn(api, 'writeSkillFile').mockResolvedValue({
    id: 'file',
    path: 'scripts/run.sh',
    content: 'echo hi',
    createdAt: '2026-01-01',
  });
  vi.spyOn(api, 'deleteSkillFile').mockResolvedValue();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  client.clear();
  history?.destroy();
  host?.remove();
  root = undefined;
  host = undefined;
  history = undefined;
  vi.restoreAllMocks();
});

describe('skill definition readonly audit', () => {
  it('opens the definition for reading without write actions or a request when update is missing', async () => {
    await mount(meWith('skills.read'));
    await openSkill();

    expect(document.body.textContent).toContain('查看「Demo」');
    expect(input('skill-name').value).toBe('Demo');
    expect(input('skill-name').readOnly).toBe(true);
    expect(input('skill-desc').readOnly).toBe(true);
    expect(editorView('skill-body').state.facet(EditorState.readOnly)).toBe(true);
    expect(buttonOrUndefined('保存')).toBeUndefined();
    expect(button('关闭')).toBeDefined();

    await submitForm();
    expect(api.updateSkill).not.toHaveBeenCalled();
  });

  it('keeps saving and the failed draft when update is allowed', async () => {
    vi.spyOn(api, 'updateSkill').mockRejectedValueOnce(new Error('save failed'));
    await mount(meWith('skills.read', 'skills.update'));
    await openSkill();

    expect(document.body.textContent).toContain('编辑技能');
    await typeInput('skill-name', 'draft-name');
    await submitForm();

    await waitFor(() => vi.mocked(api.updateSkill).mock.calls.length > 0);
    expect(api.updateSkill).toHaveBeenCalledOnce();
    expect(input('skill-name').value).toBe('draft-name');
    expect(button('保存')).toBeDefined();
  });

  it('keeps a dirty draft when the update permission disappears while the dialog is open', async () => {
    await mount(meWith('skills.read', 'skills.update'));
    await openSkill();
    await typeInput('skill-name', 'keep-draft');

    await setMe(meWith('skills.read'));

    expect(input('skill-name').value).toBe('keep-draft');
    expect(input('skill-name').readOnly).toBe(true);
    expect(document.body.textContent).toContain('查看「Demo」');
    expect(buttonOrUndefined('保存')).toBeUndefined();

    // 权限已失去时，即使表单被直接提交也不能发请求。
    await submitForm();
    expect(api.updateSkill).not.toHaveBeenCalled();
  });
});

describe('skill support file permissions', () => {
  it('does not mount the file query without files.read', async () => {
    await mount(meWith('skills.read', 'skills.update'));
    await openSkill();
    await flush();

    expect(api.skillFiles).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('支持文件');
    expect(document.getElementById('skill-file-content')).toBeNull();
  });

  it('shows file content but hides add, delete and save actions with files.read only', async () => {
    vi.mocked(api.skillFiles).mockResolvedValue([supportFile]);
    await mount(meWith('skills.read', 'skills.files.read'));
    await openSkill();

    await click(await waitFor(() => byLabel('查看支持文件 notes.md')));

    expect(editorView('skill-file-content').state.doc.toString()).toBe('hello');
    expect(editorView('skill-file-content').state.facet(EditorState.readOnly)).toBe(true);
    expect(input('skill-file-path').readOnly).toBe(true);
    expect(buttonOrUndefined('添加文件')).toBeUndefined();
    expect(buttonOrUndefined('保存文件')).toBeUndefined();
    expect(buttonOrUndefined('新建文件')).toBeUndefined();
    expect(byLabelOrUndefined('删除支持文件 notes.md')).toBeUndefined();
    expect(api.writeSkillFile).not.toHaveBeenCalled();
  });

  it('keeps file writing available without definition update permission', async () => {
    await mount(meWith('skills.read', 'skills.files.read', 'skills.files.write'));
    await openSkill();

    expect(document.body.textContent).toContain('查看「Demo」');
    expect(input('skill-name').readOnly).toBe(true);

    await waitFor(() => editorView('skill-file-content'));
    await typeInput('skill-file-path', 'scripts/run.sh');
    await replaceContent('skill-file-content', 'echo hi');
    await click(button('添加文件'));

    await waitFor(() => vi.mocked(api.writeSkillFile).mock.calls.length > 0);
    expect(api.writeSkillFile).toHaveBeenCalledWith('skill', 'scripts/run.sh', 'echo hi');
  });

  it('keeps a dirty file draft when files.write disappears while the dialog is open', async () => {
    await mount(meWith('skills.read', 'skills.files.read', 'skills.files.write'));
    await openSkill();
    await waitFor(() => editorView('skill-file-content'));
    await typeInput('skill-file-path', 'scripts/draft.sh');
    await replaceContent('skill-file-content', 'echo draft');

    await setMe(meWith('skills.read', 'skills.files.read'));

    expect(input('skill-file-path').value).toBe('scripts/draft.sh');
    expect(input('skill-file-path').readOnly).toBe(true);
    expect(editorView('skill-file-content').state.doc.toString()).toBe('echo draft');
    expect(buttonOrUndefined('添加文件')).toBeUndefined();
    expect(api.writeSkillFile).not.toHaveBeenCalled();
  });

  it('hides the file editor on read revocation and restores the dirty draft without refetching', async () => {
    vi.mocked(api.skillFiles).mockResolvedValue([supportFile]);
    await mount(meWith('skills.read', 'skills.files.read', 'skills.files.write'));
    await openSkill();
    await waitFor(() => editorView('skill-file-content'));
    await typeInput('skill-file-path', 'scripts/draft.sh');
    await replaceContent('skill-file-content', 'echo draft');
    expect(api.skillFiles).toHaveBeenCalledOnce();

    await setMe(meWith('skills.read', 'skills.files.write'));

    // 编辑器保持挂载但不再渲染正文；撤权期间不发起新的读取。
    expect(document.getElementById('skill-file-content')).toBeNull();
    expect(document.getElementById('skill-file-path')).toBeNull();
    expect(document.body.textContent).not.toContain('支持文件');
    expect(api.skillFiles).toHaveBeenCalledOnce();

    await setMe(meWith('skills.read', 'skills.files.read', 'skills.files.write'));

    expect(input('skill-file-path').value).toBe('scripts/draft.sh');
    expect(editorView('skill-file-content').state.doc.toString()).toBe('echo draft');
    expect(await waitFor(() => byLabel('编辑支持文件 notes.md'))).toBeDefined();
    expect(api.skillFiles).toHaveBeenCalledOnce();

    // 草稿仍是父层 dirty，关闭需要确认。
    await click(button('关闭'));
    expect(document.body.textContent).toContain('放弃未保存的更改？');
  });

  it('reselects the saved content when read access returns before the refresh resolves', async () => {
    const saving = deferred<SkillFile>();
    const refresh = deferred<SkillFile[]>();
    const updatedFile: SkillFile = { ...supportFile, content: 'after save' };
    vi.mocked(api.skillFiles)
      .mockResolvedValueOnce([supportFile])
      .mockReturnValueOnce(refresh.promise);
    vi.mocked(api.writeSkillFile).mockReturnValueOnce(saving.promise);
    // 生产默认 staleTime 为 5s：不标脏的话，刚恢复权限的缓存仍算新鲜。
    await mount(meWith('skills.read', 'skills.files.read', 'skills.files.write'), 5_000);
    await openSkill();
    await click(await waitFor(() => byLabel('编辑支持文件 notes.md')));
    await replaceContent('skill-file-content', 'after save');
    await click(button('保存文件'));
    expect(api.writeSkillFile).toHaveBeenCalledOnce();

    await setMe(meWith('skills.read', 'skills.files.write'));
    expect(document.getElementById('skill-file-content')).toBeNull();
    expect(api.skillFiles).toHaveBeenCalledOnce();

    await act(async () => saving.resolve(updatedFile));
    await flush();

    // 保存跨越撤权：成功结算并写回列表，但隐藏期间不补读。
    expect(button('关闭').disabled).toBe(false);
    expect(api.skillFiles).toHaveBeenCalledOnce();

    await setMe(meWith('skills.read', 'skills.files.read', 'skills.files.write'));
    await waitFor(() => api.skillFiles.mock.calls.length === 2);

    // 刷新还挂着也必须立即重选到保存后的正文，而不是撤权前的旧缓存。
    await click(await waitFor(() => byLabel('编辑支持文件 notes.md')));
    expect(editorView('skill-file-content').state.doc.toString()).toBe('after save');

    await act(async () => refresh.resolve([updatedFile]));
    await flush();
  });

  it('settles a hidden file save, skips refetch after read revocation, and continues on restore', async () => {
    const saving = deferred<SkillFile>();
    const savedFile: SkillFile = {
      id: 'file',
      path: 'scripts/run.sh',
      content: 'echo hi',
      createdAt: '2026-01-01',
    };
    const refresh = deferred<SkillFile[]>();
    vi.mocked(api.skillFiles)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValue([savedFile]);
    vi.mocked(api.writeSkillFile).mockReturnValueOnce(saving.promise);
    await mount(meWith('skills.read', 'skills.files.read', 'skills.files.write'));
    await openSkill();
    await waitFor(() => editorView('skill-file-content'));
    await typeInput('skill-file-path', 'scripts/run.sh');
    await replaceContent('skill-file-content', 'echo hi');
    await click(button('添加文件'));
    await waitFor(() => button('处理中…'));
    expect(api.writeSkillFile).toHaveBeenCalledOnce();
    expect(button('关闭').disabled).toBe(true);

    await setMe(meWith('skills.read', 'skills.files.write'));

    expect(document.getElementById('skill-file-content')).toBeNull();
    expect(api.skillFiles).toHaveBeenCalledOnce();

    await act(async () => saving.resolve(savedFile));
    await flush();

    // 子编辑器仍存活：即使正文被隐藏，在途保存也把 pending 结算回父层，且不主动 refetch。
    expect(button('关闭').disabled).toBe(false);
    expect(api.skillFiles).toHaveBeenCalledOnce();

    await setMe(meWith('skills.read', 'skills.files.read', 'skills.files.write'));
    // 刷新还挂着：新增文件已按写入结果写回列表，可立即选中。
    expect(await waitFor(() => byLabelOrUndefined('编辑支持文件 scripts/run.sh'))).toBeDefined();
    await act(async () => refresh.resolve([savedFile]));
    await flush();
    await waitFor(() => editorView('skill-file-content'));

    // 恢复权限后可继续编辑并再次保存。
    await typeInput('skill-file-path', 'scripts/again.sh');
    await replaceContent('skill-file-content', 'echo again');
    await click(button('添加文件'));
    await waitFor(() => vi.mocked(api.writeSkillFile).mock.calls.length === 2);
    expect(api.writeSkillFile).toHaveBeenLastCalledWith('skill', 'scripts/again.sh', 'echo again');

    // 恢复后的草稿仍然拦住关闭，不会因为权限变化丢失。
    await typeInput('skill-file-path', 'scripts/draft.sh');
    await click(button('关闭'));
    expect(document.body.textContent).toContain('放弃未保存的更改？');
  });

  it('drops a deleted file from the list when read access returns before the refresh resolves', async () => {
    const deleting = deferred<void>();
    const refresh = deferred<SkillFile[]>();
    vi.mocked(api.skillFiles)
      .mockResolvedValueOnce([supportFile])
      .mockReturnValueOnce(refresh.promise);
    vi.mocked(api.deleteSkillFile).mockReturnValueOnce(deleting.promise);
    await mount(meWith('skills.read', 'skills.files.read', 'skills.files.write'), 5_000);
    await openSkill();
    await click(await waitFor(() => byLabel('删除支持文件 notes.md')));
    await click(button('删除文件'));
    expect(api.deleteSkillFile).toHaveBeenCalledOnce();

    await setMe(meWith('skills.read', 'skills.files.write'));
    expect(api.skillFiles).toHaveBeenCalledOnce();

    await act(async () => deleting.resolve());
    await flush();

    await setMe(meWith('skills.read', 'skills.files.read', 'skills.files.write'));
    await waitFor(() => api.skillFiles.mock.calls.length === 2);

    // 刷新还挂着：删除事实已写回列表，恢复 read 后不能选到已删文件。
    expect(byLabelOrUndefined('编辑支持文件 notes.md')).toBeUndefined();

    await act(async () => refresh.resolve([]));
    await flush();
    expect(byLabelOrUndefined('编辑支持文件 notes.md')).toBeUndefined();
  });
});
