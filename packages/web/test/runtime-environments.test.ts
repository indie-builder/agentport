import type { RuntimeEnvironment, RuntimeEnvironmentVersionSummary } from '@agentport/shared';
import { act, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/components/ui/button.js';
import { ApiError } from '../src/lib/api.js';
import { buildShouldPoll } from '../src/lib/queries.js';
import { toastError, toastSuccess } from '../src/lib/toast.js';
import { RuntimeEnvironmentDetailPage } from '../src/pages/runtime-environment-detail.js';
import { RuntimeEnvironmentsPage } from '../src/pages/runtime-environments.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  environment: null as unknown,
  versions: [] as unknown[],
  versionDetail: null as unknown,
  search: {} as Record<string, string | undefined>,
  navigate: vi.fn(),
  build: vi.fn(),
  publish: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  updatePending: false,
  blockerOptions: [] as Array<{
    shouldBlockFn: (args?: {
      current: { pathname: string };
      next: { pathname: string };
    }) => boolean;
    enableBeforeUnload: boolean;
  }>,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
    createElement('a', { href: to }, children),
  useNavigate: () => state.navigate,
  useSearch: () => state.search,
  useParams: () => ({ environmentId: 'rte_1' }),
  useBlocker: (options: (typeof state.blockerOptions)[number]) => {
    state.blockerOptions.push(options);
    return { status: 'idle', proceed: vi.fn(), reset: vi.fn() };
  },
}));

vi.mock('../src/lib/queries.js', async (original) => {
  const queries = await original<typeof import('../src/lib/queries.js')>();
  return {
    ...queries,
    useRuntimeEnvironments: () => ({
      data: state.environments,
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useRuntimeEnvironment: () => ({
      data: state.environment,
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useRuntimeEnvironmentVersions: () => ({
      data: state.versions,
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useRuntimeEnvironmentVersion: () => ({
      data: state.versionDetail,
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useCreateRuntimeEnvironment: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useUpdateRuntimeEnvironment: () => ({
      isPending: state.updatePending,
      mutateAsync: state.update,
    }),
    useDeleteRuntimeEnvironment: () => ({ isPending: false, mutateAsync: state.remove }),
    useBuildRuntimeEnvironment: () => ({ isPending: false, mutate: state.build }),
    usePublishRuntimeEnvironment: () => ({ isPending: false, mutate: state.publish }),
  };
});

const environment: RuntimeEnvironment = {
  id: 'rte_1',
  name: '数据分析',
  dockerfile: 'FROM base',
  isDefault: false,
  onlineVersionId: 'rtev_aaaaaaaa',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

function version(
  id: string,
  status: RuntimeEnvironmentVersionSummary['status'],
  imageId: string | null,
): RuntimeEnvironmentVersionSummary {
  return {
    id,
    environmentId: environment.id,
    baseImageId: 'base',
    status,
    imageTag: null,
    imageId,
    logTruncated: false,
    error: status === 'failed' ? '构建失败原因' : null,
    startedAt: '2026-01-02T00:00:00.000Z',
    finishedAt: status === 'ready' ? '2026-01-02T00:01:00.000Z' : null,
    createdAt: '2026-01-02T00:00:00.000Z',
  };
}

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [
    node,
    ...elements(node.props.children as ReactNode),
    ...elements(node.props.actions as ReactNode),
    ...elements(node.props.action as ReactNode),
  ];
}
function flatText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(flatText).join(' ');
  if (typeof node === 'string') return node;
  if (isValidElement<Record<string, unknown>>(node))
    return flatText(node.props.children as ReactNode);
  return '';
}
function buttonWith(tree: Element[], label: string): Element | undefined {
  return tree.find(
    (node) =>
      node.type === Button &&
      typeof node.props.onClick === 'function' &&
      flatText(node.props.children as ReactNode).includes(label),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mountPage(page: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(page));
  await flush();
  return {
    host,
    root,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

function dialog(title: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (item) => item.querySelector('h2')?.textContent === title,
  );
  if (!element) throw new Error(`Missing dialog: ${title}`);
  return element;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await flush();
}

async function editInput(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updatePending = false;
  state.blockerOptions = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('runtime environments page', () => {
  it('lists named environments with the online version and one h1', () => {
    state.environments = [environment];
    state.search = {};
    const html = renderToStaticMarkup(createElement(RuntimeEnvironmentsPage));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('数据分析');
    expect(html).toContain('线上');
    expect(html).toContain('aaaaaaaa');
    expect(html).not.toContain('新建第一个运行环境');
  });

  it('shows the create action for an empty list', () => {
    state.environments = [];
    state.search = {};
    const html = renderToStaticMarkup(createElement(RuntimeEnvironmentsPage));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('新建第一个运行环境');
    expect(html).toContain('新建环境');
  });

  it('reuses the shared search input and writes the query to the URL', async () => {
    state.environments = [environment];
    state.search = {};
    const page = await mountPage(createElement(RuntimeEnvironmentsPage));
    const search = page.host.querySelector<HTMLInputElement>('[aria-label="搜索运行环境"]');
    if (!search) throw new Error('Missing environment search');
    await editInput(search, '数据');
    expect(state.navigate).toHaveBeenCalled();
    const options = state.navigate.mock.calls.at(-1)?.[0] as {
      search?: (current: Record<string, string | undefined>) => object;
      replace?: boolean;
    };
    expect(options.replace).toBe(true);
    expect(options.search?.({})).toEqual({ q: '数据' });
    await page.unmount();
  });
});

describe('runtime environment detail page', () => {
  it('marks the online version and only offers publishing for other ready versions', () => {
    state.environment = environment;
    state.versions = [
      version('rtev_aaaaaaaa', 'ready', 'sha256:online'),
      version('rtev_bbbbbbbb', 'ready', 'sha256:older'),
      version('rtev_cccccccc', 'failed', null),
      version('rtev_dddddddd', 'building', null),
    ];
    state.search = {};
    const html = renderToStaticMarkup(createElement(RuntimeEnvironmentDetailPage));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('线上');
    expect(html.match(/设为线上/g)).toHaveLength(1);
    expect(html).toContain('失败');
    expect(html).toContain('构建中');
  });

  it('applies the URL status filter', () => {
    state.environment = environment;
    state.versions = [
      version('rtev_aaaaaaaa', 'ready', 'sha256:online'),
      version('rtev_bbbbbbbb', 'failed', null),
    ];
    state.search = { status: 'failed' };
    const html = renderToStaticMarkup(createElement(RuntimeEnvironmentDetailPage));
    expect(html).toContain('bbbbbbbb');
    expect(html).not.toContain('aaaaaaaa');
  });

  it('publishes only the chosen ready version from the version row', () => {
    state.publish.mockClear();
    state.environment = environment;
    state.versions = [
      version('rtev_aaaaaaaa', 'ready', 'sha256:online'),
      version('rtev_bbbbbbbb', 'ready', 'sha256:older'),
    ];
    state.search = {};
    let tree: Element[] = [];
    renderToStaticMarkup(
      createElement(function Probe() {
        tree = elements(RuntimeEnvironmentDetailPage());
        return null;
      }),
    );
    const build = buttonWith(tree, '构建新版本');
    const publish = buttonWith(tree, '设为线上');
    if (!build || !publish) throw new Error('Missing environment actions');
    (publish.props.onClick as () => void)();
    expect(state.publish).toHaveBeenCalledWith(
      { id: 'rte_1', versionId: 'rtev_bbbbbbbb' },
      expect.anything(),
    );
  });

  it('deletes from the detail header only after confirmation and returns to the list', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    state.remove.mockResolvedValueOnce(undefined);
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    await click(button('删除'));
    const confirmation = dialog('删除运行环境');
    expect(confirmation.textContent).toContain('数据分析');
    await click(button('删除', confirmation));
    expect(state.remove).toHaveBeenCalledWith('rte_1');
    expect(toastSuccess).toHaveBeenCalledWith('已删除运行环境');
    expect(state.navigate).toHaveBeenCalledWith({ to: '/runtime-environments' });
    await page.unmount();
  });

  it('keeps the deletion dialog with the real 409 reason when the environment is bound', async () => {
    const conflict = new ApiError(409, '运行环境仍被智能体绑定，请先解除绑定');
    state.environment = environment;
    state.versions = [];
    state.search = {};
    state.remove.mockRejectedValueOnce(conflict);
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    await click(button('删除'));
    await click(button('删除', dialog('删除运行环境')));
    expect(toastError).toHaveBeenCalledWith(conflict);
    expect(toastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: '运行环境仍被智能体绑定，请先解除绑定' }),
    );
    expect(dialog('删除运行环境')).toBeDefined();
    expect(state.navigate).not.toHaveBeenCalled();
    await page.unmount();
  });

  it('disables deletion for the default environment', async () => {
    state.environment = { ...environment, isDefault: true };
    state.versions = [];
    state.search = {};
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const remove = button('删除');
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe('默认运行环境不能删除');
    await page.unmount();
  });

  it('guards unsaved edits on navigation and unload', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const input = page.host.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!input) throw new Error('Missing environment name');
    await editInput(input, '未保存的环境');
    const blocker = state.blockerOptions.at(-1);
    expect(blocker?.shouldBlockFn()).toBe(true);
    expect(
      blocker?.shouldBlockFn({
        current: { pathname: '/runtime-environments/rte_1' },
        next: { pathname: '/runtime-environments/rte_1' },
      }),
    ).toBe(false);
    expect(blocker?.enableBeforeUnload).toBe(true);
    await page.unmount();
  });

  it('keeps the leave guard while a save is pending', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    state.updatePending = true;
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const blocker = state.blockerOptions.at(-1);
    expect(blocker?.shouldBlockFn()).toBe(true);
    expect(blocker?.enableBeforeUnload).toBe(true);
    await page.unmount();
  });

  it('keeps an unsaved draft when the environment query refreshes', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const draftInput = page.host.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!draftInput) throw new Error('Missing environment name');
    await editInput(draftInput, '未保存的草稿');
    state.environment = { ...environment };
    await act(async () => page.root.render(createElement(RuntimeEnvironmentDetailPage)));
    await flush();
    expect(page.host.querySelector<HTMLInputElement>('#runtime-environment-name')?.value).toBe(
      '未保存的草稿',
    );
    await page.unmount();
  });

  it('saves the trimmed name, clears dirty and lets the new version build', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    state.update.mockResolvedValueOnce({ ...environment, name: '新环境' });
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const saveInput = page.host.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!saveInput) throw new Error('Missing environment name');
    await editInput(saveInput, ' 新环境 ');
    await click(button('保存更改'));
    expect(state.update).toHaveBeenCalledWith({
      id: 'rte_1',
      patch: { name: '新环境', dockerfile: 'FROM base' },
    });
    expect(page.host.querySelector<HTMLInputElement>('#runtime-environment-name')?.value).toBe(
      '新环境',
    );
    expect(button('保存更改').disabled).toBe(true);
    await click(button('构建新版本'));
    expect(state.build).toHaveBeenCalledWith('rte_1', expect.anything());
    await page.unmount();
  });
});

describe('runtime environment build polling', () => {
  it('polls queued and building versions only', () => {
    expect(buildShouldPoll([{ status: 'queued' }])).toBe(true);
    expect(buildShouldPoll([{ status: 'building' }])).toBe(true);
    expect(buildShouldPoll([{ status: 'ready' }, { status: 'failed' }])).toBe(false);
    expect(buildShouldPoll(undefined)).toBe(false);
  });
});
