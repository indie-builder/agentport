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
import { allAccessMe } from './me-fixture.js';
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

const other: Schedule = {
  ...schedule,
  id: 'sch_2',
  name: 'Evening digest',
  cron: '0 18 * * *',
  prompt: 'Summarize the evening',
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
  client.setQueryData(['me'], allAccessMe);
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

function rowSwitch(label: string): HTMLElement {
  const match = document.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);
  if (!match) throw new Error(`Missing switch: ${label}`);
  return match;
}

function switchDisabled(label: string): boolean {
  return rowSwitch(label).hasAttribute('data-disabled');
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

function frequencyText(): string {
  return (
    document.querySelector('#schedule-frequency [data-slot="select-value"]')?.textContent?.trim() ??
    ''
  );
}

function timeValue(): string {
  return (document.getElementById('schedule-time') as HTMLInputElement | null)?.value ?? '';
}

function cronValue(): string {
  return (document.getElementById('schedule-cron') as HTMLInputElement | null)?.value ?? '';
}

function weekdayButton(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!match) throw new Error(`Missing weekday: ${label}`);
  return match;
}

function selectedDays(): string[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[aria-labelledby="schedule-weekdays-label"] button',
    ),
  ]
    .filter((element) => element.getAttribute('aria-pressed') === 'true')
    .map((element) => element.textContent?.trim() ?? '');
}

function weekdayGroup(): HTMLElement {
  const group = document.querySelector<HTMLElement>('[aria-labelledby="schedule-weekdays-label"]');
  if (!group) throw new Error('Missing weekday group');
  return group;
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
  schedules = [{ ...schedule }, { ...other }];
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
      schedules = [next, ...schedules.slice(1)];
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
    expect(button('保存更改').disabled).toBe(false);
    await click('保存更改');
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
  it('places the editor fields on the left and the frequency controls on the right', async () => {
    await mount();
    await click('新建定时任务');

    const name = document.getElementById('schedule-name');
    const prompt = document.getElementById('schedule-prompt');
    const agentField = document.getElementById('schedule-agent');
    const frequency = document.getElementById('schedule-frequency');
    const time = document.getElementById('schedule-time');
    const enabled = document.getElementById('schedule-enabled');
    expect(name && prompt && agentField && frequency && time && enabled).toBeTruthy();

    const groupOf = (element: Element | null) =>
      element?.closest('[data-slot="field-group"]') ?? null;
    expect(groupOf(name)).not.toBeNull();
    expect(groupOf(prompt)).toBe(groupOf(name));
    expect(groupOf(agentField)).toBe(groupOf(name));
    expect(groupOf(frequency)).not.toBe(groupOf(name));
    expect(groupOf(time)).toBe(groupOf(frequency));
    expect(groupOf(enabled)).toBe(groupOf(frequency));

    // 主编辑区先于执行条件，键盘与读屏顺序和视觉左右一致。
    const order = [...document.querySelectorAll('[data-slot="field"]')]
      .map((element) => element.querySelector('input[id], textarea[id], button[id]')?.id)
      .filter(Boolean);
    expect(order).toEqual([
      'schedule-name',
      'schedule-prompt',
      'schedule-agent',
      'schedule-frequency',
      'schedule-time',
      'schedule-enabled',
    ]);

    const labelOf = (id: string) => document.querySelector(`label[for="${id}"]`)?.textContent ?? '';
    for (const [id, text] of [
      ['schedule-name', '名称'],
      ['schedule-prompt', '任务内容'],
      ['schedule-agent', '专家'],
      ['schedule-time', '时间（UTC）'],
    ]) {
      expect(labelOf(id)).toContain(text);
      expect(labelOf(id)).toContain('必填');
    }
    expect(labelOf('schedule-enabled')).toContain('启用');
    expect(labelOf('schedule-enabled')).not.toContain('必填');
    expect(document.getElementById('schedule-prompt')?.getAttribute('placeholder')).toBe(
      '希望专家定期完成什么？',
    );
    expect(document.getElementById('schedule-cron')).toBeNull();

    await selectOption('schedule-frequency', '自定义 cron');
    expect(labelOf('schedule-cron')).toContain('cron');
    expect(labelOf('schedule-cron')).toContain('必填');
    expect(document.getElementById('schedule-cron')?.getAttribute('aria-describedby')).toContain(
      'schedule-cron-hint',
    );
    const hint = document.getElementById('schedule-cron-hint')?.textContent ?? '';
    expect(hint).toContain('五段：分 时 日 月 周');
    expect(hint).toContain('UTC');
    expect(hint).toContain('切换频率会替换此表达式');
  });

  it('opens a pristine daily 09:00 draft without an unsaved-change guard', async () => {
    await mount();
    await click('新建定时任务');

    expect(frequencyText()).toBe('每天');
    expect(timeValue()).toBe('09:00');
    expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('schedule-prompt') as HTMLTextAreaElement).value).toBe('');
    expect((document.getElementById('schedule-enabled') as HTMLInputElement).checked).toBe(true);
    expect(unloadPrevented()).toBe(false);
  });

  it('submits the full create payload from both regions', async () => {
    let finish!: () => void;
    msw.server.use(
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
        return new Promise<Response>((resolve) => {
          finish = () => {
            schedules = [...schedules, next];
            resolve(HttpResponse.json(next));
          };
        });
      }),
    );
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-agent', 'Expert A');
    await fill('schedule-name', 'Nightly digest');
    await selectOption('schedule-frequency', '自定义 cron');
    await fill('schedule-cron', '30 1 * * *');
    await fill('schedule-prompt', 'Summarize the day');
    expect(button('创建任务').disabled).toBe(false);
    await click('创建任务');
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(button('创建中…').disabled).toBe(true);
    await act(async () => {
      finish();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
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
    await selectOption('schedule-frequency', '自定义 cron');
    await fill('schedule-cron', '0 18 * * *');
    await fill('schedule-prompt', 'Summarize the evening');
    await clickElement(document.getElementById('schedule-enabled') as HTMLElement);
    await click('保存更改');
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

  it('serializes a daily schedule as minute and hour in UTC', async () => {
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-agent', 'Expert A');
    await fill('schedule-name', 'Nightly digest');
    await fill('schedule-prompt', 'Summarize the day');
    await fill('schedule-time', '18:30');
    await click('创建任务');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    const call = msw.calls.find(
      (entry) => entry.method === 'POST' && entry.path === '/api/schedules',
    );
    expect(call?.body).toEqual({
      agentId: 'agent-1',
      name: 'Nightly digest',
      cron: '30 18 * * *',
      prompt: 'Summarize the day',
      enabled: true,
    });
  });

  it('submits weekly days in ascending numeric order with Sunday as 0', async () => {
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-agent', 'Expert A');
    await fill('schedule-name', 'Weekday digest');
    await fill('schedule-prompt', 'Summarize the weekdays');
    await selectOption('schedule-frequency', '每周');
    expect(selectedDays()).toEqual(['一', '二', '三', '四', '五']);
    await clickElement(weekdayButton('周日'));
    await fill('schedule-time', '07:05');
    await click('创建任务');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    const call = msw.calls.find(
      (entry) => entry.method === 'POST' && entry.path === '/api/schedules',
    );
    expect(call?.body).toMatchObject({ cron: '5 7 * * 0,1,2,3,4,5' });
  });

  it('keeps a cleared time empty and blocks saving instead of restoring 09:00', async () => {
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-agent', 'Expert A');
    await fill('schedule-name', 'Nightly digest');
    await fill('schedule-prompt', 'Summarize the day');
    await fill('schedule-time', '');
    await click('创建任务');

    await vi.waitFor(() =>
      expect(document.getElementById('schedule-time-error')?.textContent).toContain('请选择时间'),
    );
    expect(timeValue()).toBe('');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById('schedule-time')),
    );
    expect(msw.calls.some((entry) => entry.method === 'POST')).toBe(false);
  });

  it('blocks an emptied weekday selection without refilling it later', async () => {
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-agent', 'Expert A');
    await fill('schedule-name', 'Weekday digest');
    await fill('schedule-prompt', 'Summarize the weekdays');
    await selectOption('schedule-frequency', '每周');
    for (const day of ['周一', '周二', '周三', '周四', '周五']) {
      await clickElement(weekdayButton(day));
    }
    expect(selectedDays()).toEqual([]);

    await click('创建任务');
    await vi.waitFor(() =>
      expect(document.getElementById('schedule-weekdays-error')?.textContent).toContain(
        '至少选择一天',
      ),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(weekdayGroup()));
    expect(msw.calls.some((entry) => entry.method === 'POST')).toBe(false);

    await selectOption('schedule-frequency', '每天');
    await selectOption('schedule-frequency', '每周');
    expect(selectedDays()).toEqual([]);
  });

  it('keeps time across daily and weekly and projects the current schedule into custom', async () => {
    await mount();
    await click('新建定时任务');
    await fill('schedule-time', '18:30');
    await selectOption('schedule-frequency', '每周');
    expect(timeValue()).toBe('18:30');
    expect(selectedDays()).toEqual(['一', '二', '三', '四', '五']);

    await selectOption('schedule-frequency', '自定义 cron');
    expect(cronValue()).toBe('30 18 * * 1,2,3,4,5');
    await fill('schedule-cron', '*/15 2-5 1 * 1-5');
    expect(frequencyText()).toBe('自定义 cron');

    await selectOption('schedule-frequency', '每天');
    expect(frequencyText()).toBe('每天');
    expect(timeValue()).toBe('09:00');
    await selectOption('schedule-frequency', '每周');
    expect(selectedDays()).toEqual(['一', '二', '三', '四', '五']);
  });

  it('restores only canonical custom expressions into time', async () => {
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-frequency', '自定义 cron');
    await fill('schedule-cron', '15 2 * * *');
    await selectOption('schedule-frequency', '每天');
    expect(timeValue()).toBe('02:15');

    await selectOption('schedule-frequency', '自定义 cron');
    expect(cronValue()).toBe('15 2 * * *');
    await fill('schedule-cron', '05 09 1 * 1-5');
    await selectOption('schedule-frequency', '每天');
    expect(timeValue()).toBe('09:00');
  });

  it('closes an unchanged daily round trip through custom without a discard confirmation', async () => {
    await mount();
    await click('编辑 Morning report');
    await selectOption('schedule-frequency', '自定义 cron');

    // 还没回到原来的模式，仍是未保存改动。
    await click('取消');
    const confirm = dialogByTitle('放弃未保存的更改？');
    if (!confirm) throw new Error('Missing discard confirm');
    const keepEditing = [...confirm.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === '取消',
    );
    if (!keepEditing) throw new Error('Missing confirm cancel');
    await clickElement(keepEditing);
    await vi.waitFor(() => expect(dialogByTitle('放弃未保存的更改？')).toBeNull());

    await selectOption('schedule-frequency', '每天');
    await click('取消');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    expect(dialogByTitle('放弃未保存的更改？')).toBeNull();
    expect(unloadPrevented()).toBe(false);
  });

  it('fills default weekdays when a canonical daily custom expression enters weekly', async () => {
    schedules = [{ ...schedule, cron: '30 18 * * *' }, { ...other }];
    await mount();
    await click('编辑 Morning report');
    expect(frequencyText()).toBe('每天');
    expect(timeValue()).toBe('18:30');
    await selectOption('schedule-frequency', '自定义 cron');
    expect(cronValue()).toBe('30 18 * * *');

    await selectOption('schedule-frequency', '每周');
    expect(timeValue()).toBe('18:30');
    expect(selectedDays()).toEqual(['一', '二', '三', '四', '五']);
  });

  it('does not restore default weekdays after the user clears them and passes through custom', async () => {
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-frequency', '每周');
    for (const day of ['周一', '周二', '周三', '周四', '周五']) {
      await clickElement(weekdayButton(day));
    }
    expect(selectedDays()).toEqual([]);

    await selectOption('schedule-frequency', '每天');
    await selectOption('schedule-frequency', '自定义 cron');
    await selectOption('schedule-frequency', '每周');
    expect(selectedDays()).toEqual([]);
  });

  it('keeps a complex cron as raw text and leaves it untouched when only the name changes', async () => {
    schedules = [{ ...schedule, cron: '*/15 09 1 * 1-5' }, { ...other }];
    await mount();
    await click('编辑 Morning report');
    expect(frequencyText()).toBe('自定义 cron');
    expect(cronValue()).toBe('*/15 09 1 * 1-5');

    await fill('schedule-name', 'Renamed report');
    await click('保存更改');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    const call = msw.calls.find(
      (entry) => entry.method === 'PATCH' && entry.path === '/api/schedules/sch_1',
    );
    expect(call?.body).toMatchObject({
      name: 'Renamed report',
      cron: '*/15 09 1 * 1-5',
    });
  });

  it('round-trips a canonical daily cron when only the name changes', async () => {
    await mount();
    await click('编辑 Morning report');
    expect(frequencyText()).toBe('每天');
    expect(timeValue()).toBe('09:00');
    await fill('schedule-name', 'Renamed report');
    await click('保存更改');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    const call = msw.calls.find(
      (entry) => entry.method === 'PATCH' && entry.path === '/api/schedules/sch_1',
    );
    expect(call?.body).toMatchObject({ cron: '0 9 * * *' });
  });

  it('binds custom cron errors to the visible field instead of a hidden input', async () => {
    await mount();
    await click('新建定时任务');
    await selectOption('schedule-agent', 'Expert A');
    await fill('schedule-name', 'Nightly digest');
    await fill('schedule-prompt', 'Summarize the day');
    await selectOption('schedule-frequency', '自定义 cron');
    await fill('schedule-cron', '0 9 * *');
    await click('创建任务');

    await vi.waitFor(() =>
      expect(document.getElementById('schedule-cron-error')?.textContent).toContain('5 段'),
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById('schedule-cron')),
    );
    expect(msw.calls.some((entry) => entry.method === 'POST')).toBe(false);
  });

  it('disables every new frequency control while saving', async () => {
    schedules = [{ ...schedule, cron: '30 18 * * 1,2,3,4,5' }, { ...other }];
    let finish!: () => void;
    msw.server.use(
      http.patch(
        '/api/schedules/sch_1',
        () =>
          new Promise<Response>((resolve) => {
            finish = () => {
              schedules = [{ ...schedules[0], name: 'Saving name' }];
              resolve(HttpResponse.json(schedules[0]));
            };
          }),
      ),
    );
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Saving name');
    await click('保存更改');
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect((document.getElementById('schedule-frequency') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((document.getElementById('schedule-time') as HTMLInputElement).disabled).toBe(true);
    for (const day of ['周一', '周二', '周三', '周四', '周五']) {
      expect(weekdayButton(day).disabled).toBe(true);
    }
    expect((document.getElementById('schedule-enabled') as HTMLInputElement).disabled).toBe(true);
    expect(
      document.querySelector('[role="dialog"] [role="switch"]')?.hasAttribute('data-disabled'),
    ).toBe(true);

    await act(async () => {
      finish();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
  });

  it('reports missing fields in place, focuses the first visible invalid one, and keeps the dialog open', async () => {
    await mount();
    await click('新建定时任务');
    await click('创建任务');

    await vi.waitFor(() =>
      expect(document.getElementById('schedule-name-error')?.textContent).toContain('不能为空'),
    );
    expect(document.getElementById('schedule-prompt-error')?.textContent).toContain('不能为空');
    expect(document.getElementById('schedule-agent-error')?.textContent).toContain('不能为空');
    // 默认每天 09:00 已满足频率条件；未显示的自定义 cron 不参与本次校验。
    expect(document.getElementById('schedule-cron')).toBeNull();
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

describe('schedule row mutation locking', () => {
  it('locks every row operation while a toggle is pending and recovers after success', async () => {
    let finish!: () => void;
    msw.server.use(
      http.patch(
        '/api/schedules/sch_1',
        () =>
          new Promise<Response>((resolve) => {
            finish = () => {
              schedules = schedules.map((item) =>
                item.id === 'sch_1' ? { ...item, enabled: false } : item,
              );
              resolve(HttpResponse.json(schedules[0]));
            };
          }),
      ),
    );
    await mount();
    await clickElement(rowSwitch('暂停 Morning report'));

    // 共用一个 mutation 时不能只锁最新 variables 那一行：其余行也必须停用。
    await vi.waitFor(() => expect(switchDisabled('暂停 Evening digest')).toBe(true));
    expect(switchDisabled('暂停 Morning report')).toBe(true);
    expect(button('编辑 Evening digest').disabled).toBe(true);
    expect(button('删除 Evening digest').disabled).toBe(true);

    const patchCalls = msw.calls.filter((entry) => entry.method === 'PATCH').length;
    await clickElement(rowSwitch('暂停 Evening digest'));
    await clickElement(button('编辑 Evening digest'));
    await clickElement(button('删除 Evening digest'));
    await msw.waitForRequests();
    expect(msw.calls.filter((entry) => entry.method === 'PATCH')).toHaveLength(patchCalls);
    expect(document.getElementById('schedule-name')).toBeNull();
    expect(dialogByTitle('删除定时任务')).toBeNull();

    await act(async () => {
      finish();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(rowSwitch('启用 Morning report')).toBeTruthy());
    expect(switchDisabled('暂停 Evening digest')).toBe(false);
    expect(button('编辑 Evening digest').disabled).toBe(false);
    expect(button('删除 Evening digest').disabled).toBe(false);
  });

  it('re-enables every row after a failed toggle and keeps the server state', async () => {
    msw.server.use(
      http.patch('/api/schedules/sch_1', () =>
        HttpResponse.json({ message: 'Toggle failed' }, { status: 500 }),
      ),
    );
    await mount();
    await clickElement(rowSwitch('暂停 Morning report'));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    await vi.waitFor(() => expect(button('编辑 Evening digest').disabled).toBe(false));
    expect(switchDisabled('暂停 Morning report')).toBe(false);
    expect(switchDisabled('暂停 Evening digest')).toBe(false);
    expect(button('删除 Evening digest').disabled).toBe(false);
  });

  it('locks other rows while deletion is pending and refuses duplicate deletes', async () => {
    let finish!: () => void;
    msw.server.use(
      http.delete(
        '/api/schedules/sch_1',
        () =>
          new Promise<Response>((resolve) => {
            finish = () => {
              schedules = schedules.filter((item) => item.id !== 'sch_1');
              resolve(new HttpResponse(null, { status: 204 }));
            };
          }),
      ),
    );
    await mount();
    await click('删除 Morning report');
    await click('删除');
    await vi.waitFor(() => expect(button('编辑 Evening digest').disabled).toBe(true));
    expect(switchDisabled('暂停 Evening digest')).toBe(true);
    expect(switchDisabled('暂停 Morning report')).toBe(true);

    const deleteCalls = msw.calls.filter((entry) => entry.method === 'DELETE').length;
    await clickElement(button('处理中…'));
    await msw.waitForRequests();
    expect(msw.calls.filter((entry) => entry.method === 'DELETE')).toHaveLength(deleteCalls);

    await act(async () => {
      finish();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(container.textContent).not.toContain('Morning report'));
    expect(button('编辑 Evening digest').disabled).toBe(false);
  });
});

describe('schedule stale conflict recovery', () => {
  const stale = () =>
    HttpResponse.json(
      { code: 'CONFLICT_STALE', message: '该定时任务已被修改，请刷新后重试' },
      { status: 409 },
    );

  it('keeps the draft in place on a stale conflict and never resends it as a new schedule', async () => {
    msw.server.use(http.patch('/api/schedules/sch_1', stale));
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Local draft');
    await click('保存更改');

    await vi.waitFor(() => expect(document.body.textContent).toContain('当前草稿已保留'));
    expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe(
      'Local draft',
    );
    expect(button('重新加载')).toBeTruthy();
    expect(msw.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    expect(msw.calls.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);
  });

  it('reloads the latest schedule, resets every field, and advances the version baseline', async () => {
    let patchCount = 0;
    msw.server.use(
      http.patch('/api/schedules/sch_1', async ({ request }) => {
        patchCount += 1;
        if (patchCount === 1) return stale();
        const patch = (await request.json()) as Partial<Schedule>;
        const next = { ...schedules[0], ...patch } as Schedule;
        schedules = [next, ...schedules.slice(1)];
        return HttpResponse.json(next);
      }),
    );
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Local draft');
    await click('保存更改');
    await vi.waitFor(() => expect(button('重新加载')).toBeTruthy());

    const remote: Schedule = {
      ...schedule,
      name: 'Remote name',
      cron: '30 18 * * 1,3,5',
      prompt: 'Remote prompt',
      enabled: false,
      updatedAt: '2026-10-05T00:00:00.000Z',
    };
    schedules = [remote, schedules[1]];

    await click('重新加载');
    expect(dialogByTitle('放弃草稿并加载最新版本？')).not.toBeNull();
    await click('放弃并加载');
    await vi.waitFor(() =>
      expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe(
        'Remote name',
      ),
    );
    expect(frequencyText()).toBe('每周');
    expect(timeValue()).toBe('18:30');
    expect(selectedDays()).toEqual(['一', '三', '五']);
    expect(document.getElementById('schedule-cron')).toBeNull();
    expect((document.getElementById('schedule-prompt') as HTMLTextAreaElement).value).toBe(
      'Remote prompt',
    );
    expect((document.getElementById('schedule-enabled') as HTMLInputElement).checked).toBe(false);
    expect(document.body.textContent).not.toContain('当前草稿已保留');
    expect(unloadPrevented()).toBe(false);

    await fill('schedule-name', 'After reload');
    await click('保存更改');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    const saves = msw.calls.filter(
      (entry) => entry.method === 'PATCH' && entry.path === '/api/schedules/sch_1',
    );
    expect(saves).toHaveLength(2);
    expect(saves[1].body).toMatchObject({
      name: 'After reload',
      cron: '30 18 * * 1,3,5',
      expectedUpdatedAt: remote.updatedAt,
    });
  });

  it('keeps the draft when reload confirmation is cancelled', async () => {
    msw.server.use(http.patch('/api/schedules/sch_1', stale));
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Local draft');
    await click('保存更改');
    await vi.waitFor(() => expect(button('重新加载')).toBeTruthy());

    await click('重新加载');
    await click('取消');
    await vi.waitFor(() => expect(dialogByTitle('放弃草稿并加载最新版本？')).toBeNull());
    expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe(
      'Local draft',
    );
    expect(document.body.textContent).toContain('当前草稿已保留');
  });

  it('keeps the draft when loading the latest schedule fails', async () => {
    msw.server.use(http.patch('/api/schedules/sch_1', stale));
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Local draft');
    await click('保存更改');
    await vi.waitFor(() => expect(button('重新加载')).toBeTruthy());

    msw.server.use(
      http.get('/api/schedules', () =>
        HttpResponse.json({ message: 'Reload failed' }, { status: 500 }),
      ),
    );
    vi.mocked(toastError).mockClear();
    await vi.waitFor(() => expect(button('重新加载').disabled).toBe(false));
    await click('重新加载');
    await click('放弃并加载');
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe(
      'Local draft',
    );
    expect(document.body.textContent).toContain('当前草稿已保留');
  });

  it('reports a deleted schedule and only saves the draft as new on request', async () => {
    msw.server.use(http.patch('/api/schedules/sch_1', stale));
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Local draft');
    await click('保存更改');
    await vi.waitFor(() => expect(button('重新加载')).toBeTruthy());

    msw.server.use(http.get('/api/schedules', () => HttpResponse.json([])));
    vi.mocked(toastError).mockClear();
    await click('重新加载');
    await click('放弃并加载');
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    const lastCall = vi.mocked(toastError).mock.calls.at(-1);
    if (!lastCall) throw new Error('Missing toast');
    const message = (lastCall[0] as Error).message;
    expect(message).toContain('已被删除');
    expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe(
      'Local draft',
    );
    expect(document.body.textContent).toContain('当前草稿已保留');
    expect(msw.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    expect(msw.calls.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);

    await click('另存为新建');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    const created = msw.calls.find((entry) => entry.method === 'POST');
    expect(created?.body).toMatchObject({
      agentId: schedule.agentId,
      name: 'Local draft',
      cron: schedule.cron,
      prompt: schedule.prompt,
      enabled: true,
    });
  });

  it('treats a 404 on save as deleted and only creates on explicit save-as', async () => {
    msw.server.use(
      http.patch('/api/schedules/sch_1', () =>
        HttpResponse.json({ code: 'NOT_FOUND', message: '定时任务不存在' }, { status: 404 }),
      ),
    );
    await mount();
    await click('编辑 Morning report');
    await fill('schedule-name', 'Local draft');
    await click('保存更改');

    await vi.waitFor(() => expect(button('另存为新建')).toBeTruthy());
    const lastCall = vi.mocked(toastError).mock.calls.at(-1);
    if (!lastCall) throw new Error('Missing toast');
    expect((lastCall[0] as Error).message).toContain('已被删除');
    expect((document.getElementById('schedule-name') as HTMLInputElement).value).toBe(
      'Local draft',
    );
    expect(document.body.textContent).toContain('当前草稿已保留');
    expect(document.body.textContent).not.toContain('重新加载');
    expect(msw.calls.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    expect(msw.calls.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);

    await click('另存为新建');
    await vi.waitFor(() => expect(document.getElementById('schedule-name')).toBeNull());
    await msw.waitForRequests();
    expect(msw.calls.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);
    const created = msw.calls.find((entry) => entry.method === 'POST');
    expect(created?.body).toMatchObject({
      agentId: schedule.agentId,
      name: 'Local draft',
      cron: schedule.cron,
      prompt: schedule.prompt,
      enabled: true,
    });
  });
});
