import type { Agent, Schedule, ScheduleInput } from '@agentport/shared';
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

async function clickElement(element: HTMLElement) {
  await act(async () => element.click());
}

async function click(label: string) {
  await clickElement(button(label));
}

async function fill(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing input: ${id}`);
  }
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function selectOption(id: string, label: string) {
  const trigger = document.getElementById(id);
  if (!trigger) throw new Error(`Missing select: ${id}`);
  await clickElement(trigger);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!option) throw new Error(`Missing option: ${label}`);
  await clickElement(option);
}

function dialogByTitle(title: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
      (element) => element.querySelector('h2')?.textContent === title,
    ) ?? null
  );
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
    http.post('/api/schedules', async ({ request }) => {
      const input = (await request.json()) as ScheduleInput;
      const next: Schedule = {
        ...schedule,
        ...input,
        id: 'sch_2',
        agentName: agent.name,
        lastRunAt: null,
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      };
      schedules = [...schedules, next];
      return HttpResponse.json(next);
    }),
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

describe('schedule dialog fields and payload', () => {
  it('places the main editor fields before the execution conditions and states the UTC cron rule', async () => {
    await mount();
    await click('新建定时任务');

    const name = document.getElementById('schedule-name');
    const prompt = document.getElementById('schedule-prompt');
    const agentField = document.getElementById('schedule-agent');
    const cron = document.getElementById('schedule-cron');
    const enabled = document.getElementById('schedule-enabled');
    expect(name && prompt && agentField && cron && enabled).toBeTruthy();

    const groupOf = (element: Element | null) =>
      element?.closest('[data-slot="field-group"]') ?? null;
    expect(groupOf(name)).not.toBeNull();
    expect(groupOf(prompt)).toBe(groupOf(name));
    expect(groupOf(agentField)).not.toBe(groupOf(name));
    expect(groupOf(cron)).toBe(groupOf(agentField));
    expect(groupOf(enabled)).toBe(groupOf(agentField));

    // 主编辑区先于执行条件，键盘与读屏顺序和视觉左右一致。
    const order = [...document.querySelectorAll('[data-slot="field"]')]
      .map((element) => element.querySelector('input[id], textarea[id], button[id]')?.id)
      .filter(Boolean);
    expect(order).toEqual([
      'schedule-name',
      'schedule-prompt',
      'schedule-agent',
      'schedule-cron',
      'schedule-enabled',
    ]);

    const labelOf = (id: string) => document.querySelector(`label[for="${id}"]`)?.textContent ?? '';
    for (const [id, text] of [
      ['schedule-name', '名称'],
      ['schedule-prompt', '提示词'],
      ['schedule-agent', '专家'],
      ['schedule-cron', 'cron'],
    ]) {
      expect(labelOf(id)).toContain(text);
      expect(labelOf(id)).toContain('必填');
    }
    expect(labelOf('schedule-enabled')).toContain('启用');
    expect(labelOf('schedule-enabled')).not.toContain('必填');

    expect(cron?.getAttribute('aria-describedby')).toContain('schedule-cron-hint');
    expect(document.getElementById('schedule-cron-hint')?.textContent).toContain('UTC');
  });

  it('submits the full create payload from both regions', async () => {
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-agent', 'Expert A');
    await fill('schedule-name', 'Nightly digest');
    await fill('schedule-cron', '30 1 * * *');
    await fill('schedule-prompt', 'Summarize the day');
    await click('保存');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    const call = msw.calls.find(
      (entry) => entry.method === 'POST' && entry.path === '/api/schedules',
    );
    expect(call?.body).toEqual({
      agentId: 'agent-1',
      name: 'Nightly digest',
      cron: '30 1 * * *',
      prompt: 'Summarize the day',
      enabled: true,
    });
  });

  it('keeps the edit payload and expected version when conditions change', async () => {
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Evening report');
    await fill('schedule-cron', '0 18 * * *');
    await fill('schedule-prompt', 'Summarize the evening');
    await clickElement(document.getElementById('schedule-enabled') as HTMLElement);
    await click('保存');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    const call = msw.calls.find(
      (entry) => entry.method === 'PATCH' && entry.path === '/api/schedules/sch_1',
    );
    expect(call?.body).toEqual({
      name: 'Evening report',
      cron: '0 18 * * *',
      prompt: 'Summarize the evening',
      enabled: false,
      expectedUpdatedAt: schedule.updatedAt,
    });
  });

  it('reports missing fields in place, focuses the first invalid one, and keeps the dialog open', async () => {
    await mount();
    await click('新建定时任务');
    await click('保存');

    await vi.waitFor(() =>
      expect(document.getElementById('schedule-cron-error')?.textContent).toContain(
        'cron 需要 5 段',
      ),
    );
    expect(document.getElementById('schedule-name-error')?.textContent).toContain('不能为空');
    expect(document.getElementById('schedule-prompt-error')?.textContent).toContain('不能为空');
    const firstInvalid = document.querySelector<HTMLElement>('[aria-invalid="true"]');
    expect(firstInvalid).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(firstInvalid));
    expect(msw.calls.some((entry) => entry.method === 'POST')).toBe(false);
    expect(document.getElementById('schedule-name')).not.toBeNull();
  });

  it('confirms before discarding a dirty dialog and keeps the draft when cancelled', async () => {
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Draft name');
    await click('取消');

    const firstConfirm = dialogByTitle('放弃未保存的更改？');
    if (!firstConfirm) throw new Error('Missing discard confirm');
    const keepEditing = [...firstConfirm.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === '取消',
    );
    if (!keepEditing) throw new Error('Missing confirm cancel');
    await clickElement(keepEditing);
    await vi.waitFor(() => expect(dialogByTitle('放弃未保存的更改？')).toBeNull());
    expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe('Draft name');

    await click('取消');
    const secondConfirm = dialogByTitle('放弃未保存的更改？');
    if (!secondConfirm) throw new Error('Missing discard confirm');
    const discard = [...secondConfirm.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === '放弃并关闭',
    );
    if (!discard) throw new Error('Missing discard button');
    await clickElement(discard);
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
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
