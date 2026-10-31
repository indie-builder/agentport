import type { AuthMe, Server } from '@agentport/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServersPage } from '../src/pages/servers.js';
import { allAccessMe } from './me-fixture.js';

const state = vi.hoisted(() => ({
  me: undefined as unknown,
  mutate: vi.fn(),
  search: {} as Record<string, string>,
  blocker: undefined as { shouldBlockFn: () => boolean; enableBeforeUnload: boolean } | undefined,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
  useSearch: () => state.search,
  Link: 'a',
  useBlocker: (options: typeof state.blocker) => {
    state.blocker = options;
    return { status: 'idle', reset: vi.fn(), proceed: vi.fn() };
  },
}));

vi.mock('@tanstack/react-query', async (original) => {
  const actual = await original<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: () => ({ data: state.me, isSuccess: true, isPending: false, status: 'success' }),
    useQueryClient: () => ({}),
  };
});

vi.mock('../src/lib/toast.js', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../src/lib/queries.js', () => {
  const mutation = () => ({ isPending: false, mutate: state.mutate });
  return {
    meQuery: { queryKey: ['me'], queryFn: async () => state.me },
    useServers: () => ({
      data: [server],
      isPending: false,
      isError: false,
      status: 'success',
      refetch: vi.fn(),
    }),
    useAgents: () => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }),
    useRuntimeEnvironments: () => ({
      data: [],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useCreateServer: mutation,
    useUpdateServer: mutation,
    useDeleteServer: mutation,
    useTestServer: mutation,
    useImportMcpFile: mutation,
    useTools: () => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }),
    useCreateTool: mutation,
    useUpdateTool: mutation,
    useDeleteTool: mutation,
    useSetToolEnabled: mutation,
  };
});

const server: Server = {
  id: 'server',
  name: 'connector',
  description: '',
  kind: 'http',
  url: 'https://example.com/mcp',
  headers: {},
  createdAt: 'v1',
  updatedAt: 'v1',
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function meWith(...permissionIds: string[]): AuthMe {
  const granted = new Set(['servers.read', 'servers.test', ...permissionIds]);
  return {
    ...allAccessMe,
    grants: allAccessMe.grants.filter((grant) => granted.has(grant.permissionId)),
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ServersPage));
  });
  await flush();
}

async function rerender() {
  await act(async () => {
    root?.render(createElement(ServersPage));
  });
  await flush();
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === text,
  );
}

async function click(text: string) {
  const found = button(text);
  if (!found) throw new Error(`Missing button: ${text}`);
  await act(async () => found.click());
  await flush();
}

function input(id: string): HTMLInputElement {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  return found;
}

async function type(id: string, value: string) {
  const found = input(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(found, value);
    found.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function submit() {
  const form = document.querySelector('form');
  if (!form) throw new Error('Missing form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  state.me = undefined;
  state.search = {};
  state.blocker = undefined;
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

describe('server definition readonly audit', () => {
  it('opens the definition for reading without write actions or a request when update is missing', async () => {
    state.me = meWith();
    await mount();

    await click('connector');

    expect(document.body.textContent).toContain('查看「connector」');
    expect(input('server-name').value).toBe('connector');
    expect(input('server-url').value).toBe('https://example.com/mcp');
    expect(input('server-name').readOnly).toBe(true);
    expect(input('server-url').readOnly).toBe(true);
    expect(button('保存更改')).toBeUndefined();
    expect(button('创建')).toBeUndefined();
    expect(button('关闭')).toBeDefined();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('keeps saving and the failed draft when update is allowed', async () => {
    state.me = meWith('servers.update');
    state.mutate.mockImplementationOnce(
      (_input: unknown, callbacks: { onError: (error: Error) => void }) =>
        callbacks.onError(new Error('save failed')),
    );
    await mount();

    await click('connector');
    expect(document.body.textContent).toContain('编辑「connector」');
    expect(input('server-name').readOnly).toBe(false);

    await type('server-name', 'draft-name');
    await submit();

    expect(state.mutate).toHaveBeenCalledOnce();
    expect(input('server-name').value).toBe('draft-name');
    expect(button('保存更改')).toBeDefined();
  });

  it('keeps a dirty draft when the update permission disappears while the dialog is open', async () => {
    state.me = meWith('servers.update');
    await mount();

    await click('connector');
    await type('server-name', 'keep-draft');
    expect(state.blocker?.shouldBlockFn()).toBe(true);

    state.me = meWith();
    await rerender();

    expect(input('server-name').value).toBe('keep-draft');
    expect(input('server-name').readOnly).toBe(true);
    expect(document.body.textContent).toContain('查看「connector」');
    expect(button('保存更改')).toBeUndefined();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.blocker?.shouldBlockFn()).toBe(true);
  });
});
