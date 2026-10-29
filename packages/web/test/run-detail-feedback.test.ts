import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type RunDetail, type RunStatus } from '../src/lib/api.js';
import { toastError } from '../src/lib/toast.js';
import { RunDetailPage } from '../src/pages/run-detail.js';
import { runDetailSearchSchema } from '../src/routes/-search.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const at = '2026-10-28T00:00:00Z';
const LARGE = 'x'.repeat(64 * 1024 + 1);

function detail(status: RunStatus, steps: RunDetail['steps']): RunDetail {
  return {
    run: {
      id: 'run-1',
      agentId: 'agent-1',
      agentName: '专家',
      status,
      startedAt: at,
      endedAt: status === 'queued' || status === 'running' ? null : at,
      costUsd: null,
      turns: 1,
      latencyMs: 1000,
      error: null,
      inputTokens: null,
      outputTokens: null,
      conversationId: 'conv-1',
      sessionId: null,
      sandboxId: null,
      runtimeEnvironment: null,
    },
    steps,
    conversation: { id: 'conv-1', agentId: 'agent-1', title: '会话' },
  };
}

const userStep: RunDetail['steps'][number] = { kind: 'user', at, text: '原问题' };
const toolStep: RunDetail['steps'][number] = {
  kind: 'tool',
  at,
  name: 'Read',
  toolUseId: 'toolu_1',
  content: LARGE,
  result: '旧结果',
  parentToolUseId: null,
};

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let history: ReturnType<typeof createMemoryHistory>;

function stepButtons(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('ol button')];
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
}

async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(path = '/runs/run-1') {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const runs = createRoute({
    getParentRoute: () => shell,
    path: '/runs/',
    component: () => createElement('h1', null, '运行'),
  });
  const runDetail = createRoute({
    getParentRoute: () => shell,
    path: '/runs/$runId',
    validateSearch: runDetailSearchSchema,
    component: RunDetailPage,
  });
  history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([runs, runDetail])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  return router;
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(api, 'runApprovals').mockResolvedValue({ items: [] });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(toastError).mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  history?.destroy();
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('run detail keeps its tree across a failed refresh', () => {
  it('keeps the selected step, expanded content and focus after a refresh error, then updates on retry', async () => {
    let resolveRetry!: (value: RunDetail) => void;
    vi.spyOn(api, 'run')
      .mockResolvedValueOnce(detail('succeeded', [userStep, toolStep]))
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          }),
      )
      .mockResolvedValue(detail('succeeded', [userStep, { ...toolStep, result: '新结果' }]));
    const router = await mount();
    await vi.waitFor(() => expect(stepButtons()).toHaveLength(2));

    await act(async () => stepButtons()[1]?.click());
    expect(router.state.location.search).toMatchObject({ step: 1 });
    await act(async () => button('内容过大，点击查看')?.click());
    expect(button('收起内容')).not.toBeUndefined();
    await act(async () => stepButtons()[1]?.focus());

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['run', 'run-1'] });
    });
    await flush();

    expect(host.textContent).toContain('刷新失败，内容仍是上次结果');
    expect(host.textContent).toContain('network down');
    expect(button('重试')).not.toBeUndefined();
    // 同一个详情树：trace、检查器、URL 选择与展开状态都不重置。
    expect(host.querySelectorAll('ol button')).toHaveLength(2);
    expect(router.state.location.search).toMatchObject({ step: 1 });
    expect(stepButtons()[1]?.getAttribute('aria-current')).toBe('step');
    expect(document.activeElement).toBe(stepButtons()[1]);
    expect(button('收起内容')).not.toBeUndefined();
    expect((host.querySelector('pre')?.textContent ?? '').length).toBeGreaterThan(64 * 1024);

    await act(async () => button('重试')?.click());
    // 重试进行中内容仍保留，提示不提前消失；成功后提示消失、内容更新。
    expect(host.textContent).toContain('刷新失败，内容仍是上次结果');
    expect((host.querySelector('pre')?.textContent ?? '').length).toBeGreaterThan(64 * 1024);
    await act(async () =>
      resolveRetry(detail('succeeded', [userStep, { ...toolStep, result: '新结果' }])),
    );
    await flush();

    expect(host.textContent).toContain('新结果');
    expect(host.textContent).not.toContain('刷新失败，内容仍是上次结果');
    expect(router.state.location.search).toMatchObject({ step: 1 });
    expect(button('收起内容')).not.toBeUndefined();
  });

  it('shows the full error state only when no detail data was ever loaded', async () => {
    vi.spyOn(api, 'run').mockRejectedValue(new Error('cannot load'));
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('cannot load'));
    expect(host.textContent).toContain('内容没有加载出来');
    expect(host.textContent).not.toContain('刷新失败，内容仍是上次结果');
  });
});

describe('run detail runtime environment identity', () => {
  it('shows the stored environment name and version with the full version id available', async () => {
    const versionId = 'rtv_01JABCDEFGHJKMNPQRSTVWXYZ';
    const data = detail('succeeded', [userStep]);
    data.run.runtimeEnvironment = {
      environmentId: 'rte_01JABCDEFGHJKMNPQRSTVWXYZ',
      environmentName: '默认环境',
      versionId,
      imageId: `sha256:${'a'.repeat(64)}`,
    };
    vi.spyOn(api, 'run').mockResolvedValue(data);
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('默认环境'));

    const version = [...host.querySelectorAll('span')].find(
      (element) => element.textContent === versionId,
    );
    expect(version?.getAttribute('title')).toBe(versionId);
    expect(button('复制环境版本')).not.toBeUndefined();
  });

  it('shows no identity before the run has created a container', async () => {
    vi.spyOn(api, 'run').mockResolvedValue(detail('queued', [userStep]));
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('原问题'));

    expect(host.textContent).toContain('运行环境');
    expect(host.textContent).toContain('环境版本');
    expect(button('复制环境版本')).toBeUndefined();
  });
});

describe('rerun visibility and delivery', () => {
  it.each(['queued', 'running'] as const)(
    'does not offer rerun while %s even with a user prompt',
    async (status) => {
      vi.spyOn(api, 'run').mockResolvedValue(detail(status, [userStep]));
      await mount();
      await vi.waitFor(() => expect(host.textContent).toContain('原问题'));
      expect(button('重跑')).toBeUndefined();
    },
  );

  it('does not offer rerun for a terminal run without a user prompt', async () => {
    vi.spyOn(api, 'run').mockResolvedValue(detail('succeeded', [toolStep]));
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('Read'));
    expect(button('重跑')).toBeUndefined();
    expect(button('存为技能')).toBeUndefined();
  });

  it('sends once from the same conversation, disables while pending, and navigates on success', async () => {
    const detailData = detail('succeeded', [userStep]);
    vi.spyOn(api, 'run').mockImplementation((runId) =>
      runId === 'run-1' ? Promise.resolve(detailData) : new Promise(() => {}),
    );
    const send = vi
      .spyOn(api, 'sendChat')
      .mockRejectedValueOnce(new Error('send failed'))
      .mockResolvedValueOnce({ runId: 'run-2', conversationId: 'conv-1' });
    const router = await mount();
    await vi.waitFor(() => expect(button('重跑')).not.toBeUndefined());

    await act(async () => button('重跑')?.click());
    await flush();

    expect(send).toHaveBeenCalledWith({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      message: '原问题',
    });
    expect(vi.mocked(toastError)).toHaveBeenCalled();
    expect(button('重跑')?.disabled).toBe(false);
    expect(router.state.location.pathname).toBe('/runs/run-1');

    await act(async () => button('重跑')?.click());
    await flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(router.state.location.pathname).toBe('/runs/run-2');
  });

  it('disables rerun while the resend is in flight', async () => {
    vi.spyOn(api, 'run').mockResolvedValue(detail('succeeded', [userStep]));
    let finish!: (value: { runId: string; conversationId: string }) => void;
    vi.spyOn(api, 'sendChat').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const router = await mount();
    await vi.waitFor(() => expect(button('重跑')).not.toBeUndefined());

    await act(async () => button('重跑')?.click());
    await flush();

    expect(button('提交中…')?.disabled).toBe(true);
    expect(router.state.location.pathname).toBe('/runs/run-1');

    await act(async () => finish({ runId: 'run-2', conversationId: 'conv-1' }));
    await flush();
    expect(router.state.location.pathname).toBe('/runs/run-2');
  });
});
