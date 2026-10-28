import type { Agent, Schedule } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { HttpResponse, http } from 'msw';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toastError } from '../src/lib/toast.js';
import { SchedulesPage } from '../src/pages/ops.js';
import { createMsw } from './msw.js';

vi.mock('../src/lib/toast.js', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const msw = createMsw();

const agent = { id: 'agent-1', name: 'Expert A' } as Agent;
const schedule: Schedule = {
  id: 'sch_1',
  agentId: 'agent-1',
  agentName: 'Expert A',
  name: 'Morning report',
  cron: '0 9 * * *',
  prompt: 'Summarize the inbox',
  enabled: true,
  lastRunAt: null,
  nextDueAt: '2026-10-29T09:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let history: ReturnType<typeof createBrowserHistory>;
let schedules: Schedule[];
let blockedNavigations: Promise<boolean>[];

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const schedulesRoute = createRoute({
    getParentRoute: () => shell,
    path: '/schedules',
    component: SchedulesPage,
  });
  const away = createRoute({
    getParentRoute: () => shell,
    path: '/away',
    component: () => createElement('h1', null, 'Destination'),
  });
  window.history.replaceState(null, '', '/schedules');
  history = createBrowserHistory();
  // 包装真实注册，捕获 useBlocker 交给 history 的 Promise，观察它最终 resolve 什么。
  const block = history.block.bind(history);
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([schedulesRoute, away])]),
    history,
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await vi.waitFor(() => expect(container.textContent).toContain('Morning report'));
  return router;
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].findLast(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function unloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeAll(() => msw.listen());
afterAll(() => msw.close());

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  schedules = [{ ...schedule }];
  blockedNavigations = [];
  msw.reset();
  msw.server.use(
    http.get('/api/agents', () => HttpResponse.json([agent])),
    http.get('/api/schedules', () => HttpResponse.json(schedules)),
    http.patch('/api/schedules/sch_1', async ({ request }) => {
      const patch = (await request.json()) as Partial<Schedule>;
      const next = { ...schedules[0], ...patch } as Schedule;
      schedules = [next];
      return HttpResponse.json(next);
    }),
    http.delete('/api/schedules/sch_1', () => {
      schedules = [];
      return new HttpResponse(null, { status: 204 });
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client?.clear();
  history?.destroy();
  container.remove();
  vi.restoreAllMocks();
  msw.assertClean();
});

describe('schedule draft navigation', () => {
  it('keeps a dirty edit draft when leaving is cancelled and lets it go when confirmed', async () => {
    const router = await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Unsaved name');
    expect(unloadPrevented()).toBe(true);

    let navigation: Promise<unknown> | undefined;
    await act(async () => {
      navigation = router.navigate({ to: '/away' });
    });
    expect(document.body.textContent).toContain('放弃未保存的更改？');
    expect(router.state.location.pathname).toBe('/schedules');
    await click('取消');
    // 被拦下的导航在取消后不会落定（history 直接丢弃这次 push），不能再 await 它。
    expect(router.state.location.pathname).toBe('/schedules');
    expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe(
      'Unsaved name',
    );

    await act(async () => {
      navigation = router.navigate({ to: '/away' });
    });
    await click('放弃并离开');
    await act(async () => {
      await navigation;
    });
    expect(container.textContent).toBe('Destination');
    expect(unloadPrevented()).toBe(false);
  });

  it('leaves an unmodified create dialog without confirmation', async () => {
    const router = await mount();
    await click('新建定时任务');
    expect(document.getElementById('schedule-name')).not.toBeNull();
    await act(async () => {
      await router.navigate({ to: '/away' });
    });
    expect(container.textContent).toBe('Destination');
  });

  it('blocks leaving while saving and settles the blocked navigation after success', async () => {
    let finish!: () => void;
    msw.server.use(
      http.patch(
        '/api/schedules/sch_1',
        () =>
          new Promise<Response>((resolve) => {
            finish = () => {
              schedules = [{ ...schedule, name: 'Saved name' }];
              resolve(HttpResponse.json(schedules[0]));
            };
          }),
      ),
    );
    const router = await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Saved name');
    await click('保存');
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(button('保存中…').disabled).toBe(true);
    expect(unloadPrevented()).toBe(true);

    await act(async () => {
      void router.navigate({ to: '/away' });
    });
    await vi.waitFor(() => expect(blockedNavigations).toHaveLength(1));
    expect(document.body.textContent).toContain('正在保存，请等待请求完成。');
    expect(button('放弃并离开').disabled).toBe(true);
    expect(router.state.location.pathname).toBe('/schedules');

    // 不点取消：保存成功时 finish 必须亲自结算被拦下的导航。
    await act(async () => {
      finish();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // 未结算时用哨兵值立刻断言，避免把悬挂的 Promise 拖成超时。
    await expect(
      Promise.race([
        blockedNavigations[0],
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
      ]),
    ).resolves.toBe(true);
    expect(router.state.location.pathname).toBe('/schedules');
    expect(document.getElementById('schedule-name')).toBeNull();
    expect(unloadPrevented()).toBe(false);

    await act(async () => {
      await router.navigate({ to: '/away' });
    });
    expect(container.textContent).toBe('Destination');
  });
});

describe('schedule delete focus', () => {
  it('moves focus to the header create button after a successful delete', async () => {
    await mount();
    await click('删除 Morning report');
    await click('删除');
    await vi.waitFor(() => expect(container.textContent).not.toContain('Morning report'));
    const headerCreate = container.querySelector<HTMLButtonElement>(
      '[data-slot="page-header"] button',
    );
    expect(headerCreate?.textContent).toContain('新建定时任务');
    await vi.waitFor(() => expect(document.activeElement).toBe(headerCreate));
  });

  it('restores focus to the row delete button when deletion fails and keeps the row', async () => {
    msw.server.use(
      http.delete('/api/schedules/sch_1', () =>
        HttpResponse.json({ message: 'Deletion failed' }, { status: 500 }),
      ),
    );
    await mount();
    const rowDelete = button('删除 Morning report');
    await act(async () => rowDelete.focus());
    await click('删除 Morning report');
    await click('删除');
    // 失败时确认框保持打开并给出错误；取消后列表与触发按钮都还在。
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(document.body.textContent).toContain('删除定时任务');
    await click('取消');
    await vi.waitFor(() => expect(document.activeElement).toBe(rowDelete));
    expect(document.activeElement).not.toBe(document.body);
    expect(container.textContent).toContain('Morning report');
  });
});
