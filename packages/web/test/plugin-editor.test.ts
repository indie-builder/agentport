import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { toastError } from '../src/lib/toast.js';
import { PluginsPage } from '../src/pages/plugins.js';

const state = vi.hoisted(() => ({
  saving: false,
  update: vi.fn(),
  installing: false,
  install: vi.fn(),
  importingNative: false,
  importNative: vi.fn(),
  importZip: vi.fn(),
  search: {} as Record<string, string>,
  navigate: [] as Array<{ to?: string; params?: Record<string, string>; search?: unknown }>,
  blocker: undefined as { shouldBlockFn: () => boolean; enableBeforeUnload: boolean } | undefined,
  native: {
    data: { installed: [] as Array<{ pluginId: string; version: string; imported: boolean }> },
    isPending: false,
    isError: false,
    error: null as unknown,
    isFetching: false,
    refetch: () => {},
  },
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
  sourceId: null,
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
  useImportPlugin: () => ({ mutateAsync: state.importZip, isPending: false }),
  useDeletePlugin: () => ({ mutate: vi.fn(), isPending: false }),
  useNativePlugins: () => state.native,
  useInstallNativePlugin: () => ({ isPending: state.installing, mutate: state.install }),
  useImportNativePlugin: () => ({ isPending: state.importingNative, mutate: state.importNative }),
}));
vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    Link: ({ to, params, ...rest }: { to: string; params?: Record<string, string> }) =>
      createElement('a', {
        href: params ? to.replace('$pluginId', params.pluginId ?? '') : to,
        ...rest,
      }),
    useNavigate: () => (options: (typeof state.navigate)[number]) => {
      state.navigate.push(options);
    },
    useSearch: () => state.search,
    useBlocker: (options: typeof state.blocker) => {
      state.blocker = options;
      return { status: 'idle' };
    },
  };
});

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

async function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) throw new Error(`Missing input: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
  state.saving = false;
  state.installing = false;
  state.importingNative = false;
  state.search = {};
  state.navigate = [];
  state.blocker = undefined;
  state.importZip = vi.fn().mockResolvedValue({ plugin, warnings: [] });
  state.native = {
    data: { installed: [] },
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: () => {},
  };
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('plugin editor dialog', () => {
  it('shares the plugins query prefix so list invalidations reach the detail', async () => {
    const actual =
      await vi.importActual<typeof import('../src/lib/queries.js')>('../src/lib/queries.js');
    const fetchPlugin = vi.spyOn(api, 'plugin').mockResolvedValue(plugin as never);
    const query = actual.pluginQuery('plugin');
    expect(query.queryKey).toEqual(['plugins', 'plugin']);
    await query.queryFn?.({} as never);
    expect(fetchPlugin).toHaveBeenCalledWith('plugin');
  });

  it('opens the detail page from the card title and footer', async () => {
    mount();

    const titleLink = document.querySelector<HTMLAnchorElement>('h2 a[href="/plugins/plugin"]');
    expect(titleLink?.textContent).toContain('Demo 插件');
    const footerLink = [...document.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent?.trim() === '查看详情',
    );
    expect(footerLink?.getAttribute('href')).toBe('/plugins/plugin');
    expect(document.body.textContent).not.toContain('编辑插件');
  });

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

  it('blocks route changes and page unload while the form has unsaved changes', async () => {
    await openEditor();
    expect(state.blocker?.shouldBlockFn()).toBe(false);

    await type('plugin-description', '新描述');

    expect(state.blocker?.shouldBlockFn()).toBe(true);
    expect(state.blocker?.enableBeforeUnload).toBe(true);
  });

  it('blocks route changes and page unload while saving', async () => {
    state.saving = true;
    mount();
    await click(button('编辑'));

    expect(state.blocker?.shouldBlockFn()).toBe(true);
    expect(state.blocker?.enableBeforeUnload).toBe(true);
  });

  it('associates the description error with its field', async () => {
    await openEditor();
    await type('plugin-description', 'x'.repeat(501));
    await submitForm();

    const description = document.getElementById('plugin-description') as HTMLInputElement;
    expect(description.getAttribute('aria-invalid')).toBe('true');
    expect(description.getAttribute('aria-describedby')).toBe('plugin-description-error');
    expect(document.getElementById('plugin-description-error')?.textContent).toBeTruthy();
    expect(state.update).not.toHaveBeenCalled();
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

describe('plugin zip import', () => {
  it('opens the imported plugin even when the current filter hides it', async () => {
    state.search = { q: 'missing', sort: 'name' };
    mount();

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Missing import input');
    const file = new File(['zip'], 'demo.zip', { type: 'application/zip' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();

    expect(state.importZip).toHaveBeenCalledWith({ file, slug: 'demo' });
    expect(state.navigate.at(-1)).toEqual({
      to: '/plugins/$pluginId',
      params: { pluginId: 'plugin' },
    });
    // 只是压入详情页，返回时列表仍保留原筛选。
    expect(state.navigate.at(-1)?.search).toBeUndefined();
  });
});

describe('native plugin install dialog', () => {
  async function openInstall() {
    mount();
    await click(button('安装插件'));
    expect(document.body.textContent).toContain('从市场安装');
  }

  it('submits marketplace and plugin name, omitting an empty slug', async () => {
    await openInstall();
    await type('plugin-marketplace', 'acme/plugins');
    await type('plugin-name-input', 'demo');
    await submitForm();

    expect(state.install).toHaveBeenCalledWith(
      { marketplace: 'acme/plugins', plugin: 'demo' },
      expect.anything(),
    );
  });

  it('shows an actionable error and recovers when the install fails', async () => {
    state.install.mockImplementationOnce(
      (_input: unknown, options: { onError: (error: Error) => void }) =>
        options.onError(new Error('市场里没有这个插件')),
    );
    await openInstall();
    await type('plugin-marketplace', 'acme/plugins');
    await type('plugin-name-input', 'demo');
    await submitForm();

    expect(toastError).toHaveBeenCalled();
    expect(button('安装').disabled).toBe(false);
  });

  it('blocks closing and labels the button while installing', async () => {
    state.installing = true;
    await openInstall();

    const close = document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
    expect(close?.disabled).toBe(true);
    expect(button('安装中…').disabled).toBe(true);
  });

  it('keeps the dialog open and links to the plugin after a market install', async () => {
    state.install.mockImplementationOnce(
      (_input: unknown, options: { onSuccess: (result: unknown) => void }) =>
        options.onSuccess({ plugin, warnings: [], reused: false }),
    );
    await openInstall();
    await type('plugin-marketplace', 'acme/plugins');
    await type('plugin-name-input', 'demo');
    await submitForm();

    expect(document.body.textContent).toContain('从市场安装');
    expect(
      [...document.querySelectorAll<HTMLAnchorElement>('a[href="/plugins/plugin"]')].some(
        (link) => link.textContent?.trim() === '打开「Demo 插件」',
      ),
    ).toBe(true);
  });

  it('links every batch add-to-library result without closing the dialog', async () => {
    state.native.data = {
      installed: [
        { pluginId: 'demo@acme', version: '1.0.0', imported: false },
        { pluginId: 'other@acme', version: '', imported: false },
      ],
    };
    state.importNative.mockImplementation(
      (input: { pluginId: string }, options: { onSuccess: (result: unknown) => void }) =>
        options.onSuccess({
          plugin: { ...plugin, id: `plugin-${input.pluginId}` },
          warnings: [],
          reused: false,
        }),
    );
    await openInstall();
    await click(button('已安装'));

    const addButtons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (item) => item.textContent?.trim() === '加入插件库',
    );
    expect(addButtons).toHaveLength(2);
    for (const add of addButtons) await click(add);

    expect(document.body.textContent).toContain('已加入插件库');
    expect(document.querySelector('a[href="/plugins/plugin-demo@acme"]')).not.toBeNull();
    expect(document.querySelector('a[href="/plugins/plugin-other@acme"]')).not.toBeNull();
  });

  it('lists installed plugins read-only and imports the ones missing from the library', async () => {
    state.native.data = {
      installed: [
        { pluginId: 'demo@acme', version: '1.2.0', imported: true },
        { pluginId: 'other@acme', version: '', imported: false },
      ],
    };
    await openInstall();
    await click(button('已安装'));

    expect(document.body.textContent).toContain('demo@acme');
    expect(document.body.textContent).toContain('已加入');
    expect(document.body.textContent).not.toContain('加入中…');

    await click(button('加入插件库'));
    expect(state.importNative).toHaveBeenCalledWith({ pluginId: 'other@acme' }, expect.anything());
  });
});
