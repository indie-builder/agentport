import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserHistory, createRoute, RouterProvider } from '@tanstack/react-router';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type SkillFile } from '../src/lib/api.js';
import { SkillDialog } from '../src/pages/skills.js';
import { captureBlockedNavigations, routerFor, settled } from './navigation-blocker.js';

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
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

function Harness() {
  const [open, setOpen] = useState(true);
  return open
    ? createElement(SkillDialog, {
        skill,
        finalFocus: () => null,
        onClose: () => setOpen(false),
      })
    : createElement('p', null, '已关闭');
}

let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let history: ReturnType<typeof createBrowserHistory>;
let router: ReturnType<typeof routerFor>;
let blocked: Array<Promise<boolean>>;

async function flush() {
  await act(async () => {
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

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
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

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  window.history.replaceState(null, '', '/skills');
  history = createBrowserHistory();
  blocked = captureBlockedNavigations(history);
  history.replace('/skills/other');
  await new Promise((resolve) => setTimeout(resolve, 0));
  history.push('/skills');
  await new Promise((resolve) => setTimeout(resolve, 0));
  router = routerFor(history, (shell) => [
    createRoute({ getParentRoute: () => shell, path: '/skills', component: Harness }),
    createRoute({
      getParentRoute: () => shell,
      path: '/skills/other',
      component: () => createElement('p', null, '其他页面'),
    }),
  ]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await flush();
}

async function popWhileSaving() {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await flush();
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'skillFiles').mockResolvedValue([]);
  vi.spyOn(api, 'deleteSkillFile').mockResolvedValue();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  history?.destroy();
  host?.remove();
  vi.restoreAllMocks();
});

describe('skill editor blocked navigation', () => {
  it('settles a POP blocked during save before the successful save closes the dialog', async () => {
    let finishSave!: () => void;
    const update = vi.spyOn(api, 'updateSkill').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ ...skill, description: '新描述', updatedAt: 'v2' });
        }),
    );
    await mount();
    expect(document.body.textContent).toContain('编辑技能');

    fill('skill-desc', '新描述');
    await click(button('保存'));
    expect(update).toHaveBeenCalledOnce();

    await popWhileSaving();
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    const pending = blocked.at(-1);
    expect(pending).toBeDefined();

    await act(async () => finishSave());
    await flush();

    expect(await settled(pending as Promise<boolean>)).toBe(true);
    expect(document.body.textContent).toBe('已关闭');
    expect(document.body.textContent).not.toContain('放弃未保存的更改？');
    expect(history.location.pathname).toBe('/skills');
  });

  it('keeps a blocked navigation open after saving a support file that leaves the dialog open', async () => {
    let finishWrite!: (file: SkillFile) => void;
    vi.spyOn(api, 'writeSkillFile').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishWrite = resolve;
        }),
    );
    await mount();
    await waitFor(() => editorView('skill-file-content'));

    fill('skill-file-path', 'scripts/run.sh');
    await replaceContent('skill-file-content', 'echo hi');
    await click(button('添加文件'));
    await waitFor(() => button('处理中…'));

    await popWhileSaving();
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    const pending = blocked.at(-1);
    expect(pending).toBeDefined();

    await act(async () =>
      finishWrite({
        id: 'file',
        path: 'scripts/run.sh',
        content: 'echo hi',
        createdAt: '2026-01-01',
      }),
    );
    await flush();

    // 弹层仍保留，用户还有未清理的编辑上下文：不替用户取消这次被拦下的导航。
    expect(await settled(pending as Promise<boolean>)).toBe('timeout');
    expect(document.body.textContent).toContain('编辑技能');
    expect(document.body.textContent).toContain('放弃未保存的更改？');

    await click(button('取消'));
    expect(await settled(pending as Promise<boolean>)).toBe(true);
    expect(document.body.textContent).toBe('已关闭');
  });
});
