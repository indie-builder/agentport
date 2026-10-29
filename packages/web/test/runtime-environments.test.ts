import type {
  RuntimeEnvironment,
  RuntimeEnvironmentVersion,
  RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
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

const state = vi.hoisted(() => {
  const createListeners = new Set<() => void>();
  const state = {
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
    createPending: false,
    removePending: false,
    create: vi.fn(),
    realRouter: false,
    setCreatePending(value: boolean) {
      state.createPending = value;
      for (const listener of createListeners) listener();
    },
    subscribeCreatePending(listener: () => void) {
      createListeners.add(listener);
      return () => {
        createListeners.delete(listener);
      };
    },
    blockerOptions: [] as Array<{
      shouldBlockFn: (args?: {
        current: { pathname: string };
        next: { pathname: string };
      }) => boolean;
      enableBeforeUnload: boolean;
    }>,
  };
  return state;
});

// 同一份用例既覆盖轻量 mock，也在 realRouter 下跑真实 Router 的离开/刷新拦截。
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  // 别名调用避开 hooks 命名规则：用例整体切换真实/轻量 Router，挂载期间标志不变。
  const realNavigate = actual.useNavigate;
  const realSearch = actual.useSearch;
  const realParams = actual.useParams;
  const realBlocker = actual.useBlocker;
  return {
    ...actual,
    Link: (props: { to: string; children?: ReactNode }) =>
      state.realRouter
        ? createElement(actual.Link, props as never)
        : createElement('a', { href: props.to }, props.children),
    useNavigate: () => (state.realRouter ? realNavigate() : state.navigate),
    useSearch: (options?: never) => (state.realRouter ? realSearch(options) : state.search),
    useParams: (options?: never) =>
      state.realRouter ? realParams(options) : { environmentId: 'rte_1' },
    useBlocker: (options?: never) => {
      if (state.realRouter) return realBlocker(options);
      state.blockerOptions.push(options as (typeof state.blockerOptions)[number]);
      return { status: 'idle', proceed: vi.fn(), reset: vi.fn() };
    },
  };
});

vi.mock('../src/lib/queries.js', async (original) => {
  const [queries, React] = await Promise.all([
    original<typeof import('../src/lib/queries.js')>(),
    import('react'),
  ]);
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
    useCreateRuntimeEnvironment: () => {
      // 真实 Router 用例需要请求中状态在提交后实时生效，模拟 React Query 的重渲染。
      React.useSyncExternalStore(state.subscribeCreatePending, () => state.createPending);
      return {
        isPending: state.createPending,
        mutateAsync: async (input: unknown) => {
          state.setCreatePending(true);
          try {
            return await state.create(input);
          } finally {
            state.setCreatePending(false);
          }
        },
      };
    },
    useUpdateRuntimeEnvironment: () => ({
      isPending: state.updatePending,
      mutateAsync: state.update,
    }),
    useDeleteRuntimeEnvironment: () => ({
      isPending: state.removePending,
      mutateAsync: state.remove,
    }),
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

function versionDetail(
  id: string,
  status: RuntimeEnvironmentVersion['status'],
  imageId: string | null,
  overrides: Partial<RuntimeEnvironmentVersion> = {},
): RuntimeEnvironmentVersion {
  return {
    id,
    environmentId: environment.id,
    dockerfile: 'FROM base',
    baseImageId: 'base',
    status,
    imageTag: null,
    imageId,
    buildLog: '',
    logTruncated: false,
    error: null,
    startedAt: '2026-01-02T00:00:00.000Z',
    finishedAt: status === 'ready' ? '2026-01-02T00:01:00.000Z' : null,
    createdAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
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

// 真实 Router：用 createBrowserHistory 才能触发后退（POP）拦截与 beforeunload。
async function mountWithRouter(initialPath: string) {
  state.realRouter = true;
  window.history.replaceState(null, '', initialPath);
  const history = createBrowserHistory();
  const blockedNavigations: Promise<boolean>[] = [];
  const block = history.block.bind(history);
  // 包装真实注册，捕获 useBlocker 交给 history 的 Promise，观察它最终 resolve 什么。
  vi.spyOn(history, 'block').mockImplementation((blocker) =>
    block({
      ...blocker,
      blockerFn: (args) => {
        const pending = Promise.resolve(blocker.blockerFn(args)) as Promise<boolean>;
        blockedNavigations.push(pending);
        return pending;
      },
    }),
  );
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const list = createRoute({
    getParentRoute: () => shell,
    path: '/runtime-environments/',
    component: RuntimeEnvironmentsPage,
  });
  const detail = createRoute({
    getParentRoute: () => shell,
    path: '/runtime-environments/$environmentId',
    component: RuntimeEnvironmentDetailPage,
  });
  const away = createRoute({
    getParentRoute: () => shell,
    path: '/away',
    component: () => createElement('h1', null, 'Destination'),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([list, detail, away])]),
    history,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(createElement(RouterProvider, { router }));
  });
  await flush();
  return {
    router,
    host,
    blockedNavigations,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
      history.destroy();
    },
  };
}

function unloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
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

function hasDialog(title: string): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
    (item) => item.querySelector('h2')?.textContent === title,
  );
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
  state.realRouter = false;
  state.updatePending = false;
  state.createPending = false;
  state.removePending = false;
  state.create = vi.fn();
  state.remove = vi.fn();
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

describe('create environment dialog', () => {
  it('asks before discarding a dirty draft, and keeps it when the user stays', async () => {
    state.environments = [];
    state.search = {};
    const page = await mountPage(createElement(RuntimeEnvironmentsPage));
    await click(button('新建环境'));
    const form = dialog('新建运行环境');
    const name = form.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!name) throw new Error('Missing create name');
    await editInput(name, '未保存的新环境');
    await click(button('取消', form));
    const confirmation = dialog('放弃未保存的更改？');
    expect(hasDialog('新建运行环境')).toBe(true);
    await click(button('取消', confirmation));
    expect(hasDialog('放弃未保存的更改？')).toBe(false);
    expect(hasDialog('新建运行环境')).toBe(true);
    await click(button('取消', form));
    await click(button('放弃并关闭', dialog('放弃未保存的更改？')));
    expect(hasDialog('新建运行环境')).toBe(false);
    await page.unmount();
  });

  it('routes cancel, Escape, the close button and the backdrop through the discard confirmation', async () => {
    state.environments = [];
    state.search = {};
    const page = await mountPage(createElement(RuntimeEnvironmentsPage));
    await click(button('新建环境'));
    const form = dialog('新建运行环境');
    const name = form.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!name) throw new Error('Missing create name');
    await editInput(name, '未保存的新环境');

    await click(button('取消', form));
    await click(button('取消', dialog('放弃未保存的更改？')));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    await click(button('取消', dialog('放弃未保存的更改？')));

    await click(button('关闭', form));
    await click(button('取消', dialog('放弃未保存的更改？')));

    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    if (!overlay) throw new Error('Missing dialog overlay');
    await click(overlay);
    expect(hasDialog('放弃未保存的更改？')).toBe(true);
    await click(button('取消', dialog('放弃未保存的更改？')));
    expect(hasDialog('新建运行环境')).toBe(true);
    await page.unmount();
  });

  it('cancels close attempts while creation is pending', async () => {
    state.environments = [];
    state.search = {};
    state.createPending = true;
    const page = await mountPage(createElement(RuntimeEnvironmentsPage));
    await click(button('新建环境'));
    const form = dialog('新建运行环境');
    expect(button('取消', form).disabled).toBe(true);
    expect(form.querySelector<HTMLInputElement>('#runtime-environment-name')?.disabled).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(hasDialog('新建运行环境')).toBe(true);
    await page.unmount();
  });

  it('keeps the draft and the dialog when creation fails', async () => {
    state.environments = [];
    state.search = {};
    state.create.mockRejectedValueOnce(new Error('网络错误'));
    const page = await mountPage(createElement(RuntimeEnvironmentsPage));
    await click(button('新建环境'));
    const form = dialog('新建运行环境');
    const name = form.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!name) throw new Error('Missing create name');
    await editInput(name, '失败后保留');
    await click(button('创建', form));
    expect(toastError).toHaveBeenCalled();
    expect(hasDialog('新建运行环境')).toBe(true);
    expect(form.querySelector<HTMLInputElement>('#runtime-environment-name')?.value).toBe(
      '失败后保留',
    );
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

  it('shows the frozen Dockerfile and the build log for a version', async () => {
    state.environment = environment;
    state.versions = [version('rtev_cccccccc', 'failed', null)];
    state.search = { version: 'rtev_cccccccc' };
    state.versionDetail = versionDetail('rtev_cccccccc', 'failed', null, {
      dockerfile: 'FROM registry/custom:1\nRUN echo hi',
      buildLog: 'step 1/2\nstep 2/2',
      error: 'exit code 1',
    });
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const details = dialog('版本详情 · cccccccc');
    expect(details.textContent).toContain('失败');
    expect(
      details.querySelector<HTMLTextAreaElement>('#runtime-environment-version-dockerfile')?.value,
    ).toBe('FROM registry/custom:1\nRUN echo hi');
    expect(
      details.querySelector<HTMLTextAreaElement>('#runtime-environment-version-log')?.value,
    ).toBe('step 1/2\nstep 2/2');
    expect(details.textContent).toContain('rtev_cccccccc');
    expect(details.textContent).toContain('exit code 1');
    expect(details.textContent).toContain('检查 Dockerfile');
    await page.unmount();
  });

  it('shows the failure reason even when the build log is empty', async () => {
    state.environment = environment;
    state.versions = [version('rtev_cccccccc', 'failed', null)];
    state.search = { version: 'rtev_cccccccc' };
    state.versionDetail = versionDetail('rtev_cccccccc', 'failed', null, {
      error: '基础镜像拉取失败',
    });
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const details = dialog('版本详情 · cccccccc');
    expect(details.textContent).toContain('基础镜像拉取失败');
    expect(
      details.querySelector<HTMLTextAreaElement>('#runtime-environment-version-log')?.value,
    ).toBe('');
    await page.unmount();
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
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/runtime-environments',
      ignoreBlocker: true,
    });
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

  it('releases the draft guard and returns to the list after a dirty environment is deleted', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    state.remove.mockResolvedValueOnce(undefined);
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const input = page.host.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!input) throw new Error('Missing environment name');
    await editInput(input, '删除前的草稿');
    expect(state.blockerOptions.at(-1)?.shouldBlockFn()).toBe(true);
    await click(button('删除'));
    await click(button('删除', dialog('删除运行环境')));
    expect(state.blockerOptions.at(-1)?.shouldBlockFn()).toBe(false);
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/runtime-environments',
      ignoreBlocker: true,
    });
    await page.unmount();
  });

  it('keeps the leave guard while the deletion request is pending', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    state.removePending = true;
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const blocker = state.blockerOptions.at(-1);
    expect(blocker?.shouldBlockFn()).toBe(true);
    expect(blocker?.enableBeforeUnload).toBe(true);
    await page.unmount();
  });

  it('keeps the draft and stays on the page when deletion fails', async () => {
    const conflict = new ApiError(409, '运行环境仍被智能体绑定，请先解除绑定');
    state.environment = environment;
    state.versions = [];
    state.search = {};
    state.remove.mockRejectedValueOnce(conflict);
    const page = await mountPage(createElement(RuntimeEnvironmentDetailPage));
    const input = page.host.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!input) throw new Error('Missing environment name');
    await editInput(input, '失败后保留的草稿');
    await click(button('删除'));
    await click(button('删除', dialog('删除运行环境')));
    expect(state.navigate).not.toHaveBeenCalled();
    expect(page.host.querySelector<HTMLInputElement>('#runtime-environment-name')?.value).toBe(
      '失败后保留的草稿',
    );
    expect(state.blockerOptions.at(-1)?.shouldBlockFn()).toBe(true);
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

describe('runtime environment navigation guards with the real router', () => {
  it('keeps a dirty create draft when a back navigation is cancelled and leaves when confirmed', async () => {
    state.environments = [];
    state.search = {};
    const page = await mountWithRouter('/away');
    await act(async () => {
      await page.router.navigate({ to: '/runtime-environments/' });
    });
    await flush();
    await click(button('新建环境'));
    const form = dialog('新建运行环境');
    const name = form.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!name) throw new Error('Missing create name');
    await editInput(name, '未保存的新环境');
    expect(unloadPrevented()).toBe(true);

    await act(async () => {
      page.router.history.back();
    });
    await vi.waitFor(() => expect(hasDialog('放弃未保存的更改？')).toBe(true));
    expect(page.router.state.location.pathname).not.toBe('/away');

    await click(button('取消', dialog('放弃未保存的更改？')));
    expect(hasDialog('新建运行环境')).toBe(true);
    expect(form.querySelector<HTMLInputElement>('#runtime-environment-name')?.value).toBe(
      '未保存的新环境',
    );

    await act(async () => {
      page.router.history.back();
    });
    await vi.waitFor(() => expect(hasDialog('放弃未保存的更改？')).toBe(true));
    await click(button('放弃并离开', dialog('放弃未保存的更改？')));
    await vi.waitFor(() => expect(page.router.state.location.pathname).toBe('/away'));
    expect(page.host.textContent).toContain('Destination');
    expect(unloadPrevented()).toBe(false);
    await page.unmount();
  });

  it('blocks a back navigation while creation is pending and says to wait', async () => {
    state.environments = [];
    state.search = {};
    state.createPending = true;
    const page = await mountWithRouter('/away');
    await act(async () => {
      await page.router.navigate({ to: '/runtime-environments/' });
    });
    await flush();
    await click(button('新建环境'));
    expect(hasDialog('新建运行环境')).toBe(true);

    await act(async () => {
      page.router.history.back();
    });
    await vi.waitFor(() => expect(hasDialog('放弃未保存的更改？')).toBe(true));
    const confirmation = dialog('放弃未保存的更改？');
    expect(confirmation.textContent).toContain('正在创建，请等待请求完成。');
    expect(button('放弃并离开', confirmation).disabled).toBe(true);
    expect(page.router.state.location.pathname).not.toBe('/away');

    await click(button('取消', confirmation));
    expect(hasDialog('新建运行环境')).toBe(true);
    await page.unmount();
  });

  it('releases the guard and settles the blocked navigation once creation succeeds', async () => {
    state.environments = [];
    state.search = {};
    let finish!: (environment: RuntimeEnvironment) => void;
    state.create.mockImplementation(
      () =>
        new Promise<RuntimeEnvironment>((resolve) => {
          finish = resolve;
        }),
    );
    const page = await mountWithRouter('/away');
    await act(async () => {
      await page.router.navigate({ to: '/runtime-environments/' });
    });
    await flush();
    await click(button('新建环境'));
    const form = dialog('新建运行环境');
    const name = form.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!name) throw new Error('Missing create name');
    await editInput(name, '待创建');
    await click(button('创建', form));
    expect(button('创建中…', form).disabled).toBe(true);

    await act(async () => {
      page.router.history.back();
    });
    await vi.waitFor(() => expect(page.blockedNavigations).toHaveLength(1));
    expect(button('放弃并离开', dialog('放弃未保存的更改？')).disabled).toBe(true);

    const created: RuntimeEnvironment = { ...environment, id: 'rte_new', name: '待创建' };
    state.environment = created;
    state.versions = [];
    await act(async () => {
      finish(created);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // 不点取消：创建成功必须亲自结算被拦下的导航。
    await expect(
      Promise.race([
        page.blockedNavigations[0],
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
      ]),
    ).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(page.router.state.location.pathname).toBe('/runtime-environments/rte_new'),
    );
    expect(hasDialog('新建运行环境')).toBe(false);
    expect(unloadPrevented()).toBe(false);
    await page.unmount();
  });

  it('keeps a dirty environment draft on a real back navigation until leaving is confirmed', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    const page = await mountWithRouter('/away');
    await act(async () => {
      await page.router.navigate({
        to: '/runtime-environments/$environmentId',
        params: { environmentId: 'rte_1' },
      });
    });
    await flush();
    const input = page.host.querySelector<HTMLInputElement>('#runtime-environment-name');
    if (!input) throw new Error('Missing environment name');
    await editInput(input, '未保存的环境');
    expect(unloadPrevented()).toBe(true);

    await act(async () => {
      page.router.history.back();
    });
    await vi.waitFor(() => expect(hasDialog('放弃未保存的更改？')).toBe(true));
    await click(button('取消', dialog('放弃未保存的更改？')));
    expect(page.host.querySelector<HTMLInputElement>('#runtime-environment-name')?.value).toBe(
      '未保存的环境',
    );

    await act(async () => {
      page.router.history.back();
    });
    await vi.waitFor(() => expect(hasDialog('放弃未保存的更改？')).toBe(true));
    await click(button('放弃并离开', dialog('放弃未保存的更改？')));
    await vi.waitFor(() => expect(page.router.state.location.pathname).toBe('/away'));
    expect(unloadPrevented()).toBe(false);
    await page.unmount();
  });

  it('states that deletion is pending and refuses the leave confirmation', async () => {
    state.environment = environment;
    state.versions = [];
    state.search = {};
    state.removePending = true;
    const page = await mountWithRouter('/away');
    await act(async () => {
      await page.router.navigate({
        to: '/runtime-environments/$environmentId',
        params: { environmentId: 'rte_1' },
      });
    });
    await flush();

    await act(async () => {
      page.router.history.back();
    });
    await vi.waitFor(() => expect(hasDialog('放弃未保存的更改？')).toBe(true));
    const confirmation = dialog('放弃未保存的更改？');
    expect(confirmation.textContent).toContain('正在删除，请等待请求完成。');
    expect(button('放弃并离开', confirmation).disabled).toBe(true);
    expect(page.router.state.location.pathname).toBe('/runtime-environments/rte_1');

    await click(button('取消', confirmation));
    expect(page.router.state.location.pathname).toBe('/runtime-environments/rte_1');
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
