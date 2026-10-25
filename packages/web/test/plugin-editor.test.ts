import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginsPage } from '../src/pages/plugins.js';

const state = vi.hoisted(() => ({
  saving: false,
  update: vi.fn(),
}));

const plugin = {
  id: 'plugin',
  slug: 'demo',
  runtimeName: 'demo',
  name: 'Demo 插件',
  description: '演示插件',
  version: '1.0.0',
  capabilities: { skills: [], agents: [], hasHooks: false, mcpServers: [] },
  files: [],
  agentCount: 1,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

vi.mock('../src/lib/queries.js', () => ({
  usePlugins: () => ({
    data: [plugin],
    status: 'success',
    isPending: false,
    isError: false,
    error: null,
    refetch: () => {},
  }),
  useUpdatePlugin: () => ({ isPending: state.saving, mutate: state.update }),
  useImportPlugin: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePlugin: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: 'a',
  useNavigate: () => () => {},
  useSearch: () => ({}),
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PluginsPage)));
}

function flush() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
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

async function openEditor() {
  mount();
  await click(button('编辑'));
  expect(document.body.textContent).toContain('编辑插件');
}

beforeEach(() => {
  state.saving = false;
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('plugin editor dialog', () => {
  it('opens from the card action and closes when untouched', async () => {
    await openEditor();

    const name = document.getElementById('plugin-name') as HTMLInputElement | null;
    expect(name?.value).toBe('Demo 插件');
    expect(document.getElementById('plugin-slug')?.getAttribute('value')).toBe('demo');

    await click(button('取消'));
    expect(document.body.textContent).not.toContain('编辑插件');
    expect(state.update).not.toHaveBeenCalled();
  });

  it('asks before discarding an edited name', async () => {
    await openEditor();

    const name = document.getElementById('plugin-name') as HTMLInputElement | null;
    if (!name) throw new Error('Missing plugin name input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(name, '新名称');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    await click(button('取消'));
    expect(document.body.textContent).toContain('放弃未保存的更改？');
    expect(document.body.textContent).toContain('编辑插件');

    await click(button('放弃并关闭'));
    expect(document.body.textContent).not.toContain('编辑插件');
  });

  it('blocks closing while saving', async () => {
    state.saving = true;
    mount();
    await click(button('编辑'));

    const close = document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
    expect(close?.disabled).toBe(true);
    expect(button('取消').disabled).toBe(true);
    expect(button('保存中…').disabled).toBe(true);
  });
});
