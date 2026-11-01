import type { Agent, Schedule } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
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
import { SchedulesPage } from '../src/pages/ops.js';
import { allAccessMe } from './me-fixture.js';
import { createMsw } from './msw.js';

// 静态 import 早于模块体执行，必须在 hoisted 阶段切时区，否则宿主为 UTC 时
// 删掉产品的显式 timeZone 也测不出来。
const { originalTimeZone } = vi.hoisted(() => {
  const originalTimeZone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  return { originalTimeZone };
});

const msw = createMsw();
const agent = { id: 'agent-1', name: 'Expert A' } as Agent;
const dueAt = '2026-10-29T09:00:00.000Z';

const schedule: Schedule = {
  id: 'sch_1',
  agentId: 'agent-1',
  agentName: 'Expert A',
  name: 'Morning report',
  cron: '0 9 * * *',
  prompt: 'Summarize the inbox',
  enabled: true,
  lastRunAt: null,
  nextDueAt: dueAt,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const utcDisplay = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).format(new Date(dueAt));

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let schedules: Schedule[];

async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  client.setQueryData(['me'], allAccessMe);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  const schedulesRoute = createRoute({
    getParentRoute: () => shell,
    path: '/schedules',
    component: SchedulesPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([schedulesRoute])]),
    history: createMemoryHistory({ initialEntries: ['/schedules'] }),
  });
  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(container.textContent).toContain(schedules[0]?.name ?? ''));
  });
}

function header(text: string): HTMLTableCellElement | undefined {
  return [...container.querySelectorAll<HTMLTableCellElement>('thead th')].find(
    (cell) => cell.textContent?.trim() === text,
  );
}

function row(rowIndex = 0): HTMLTableRowElement {
  const match = container.querySelectorAll<HTMLTableRowElement>('tbody tr')[rowIndex];
  if (!match) throw new Error(`Missing row ${rowIndex}`);
  return match;
}

function nextDueCell(rowIndex = 0): HTMLTableCellElement {
  const cell = row(rowIndex).querySelectorAll<HTMLTableCellElement>('td')[1];
  if (!cell) throw new Error(`Missing next due cell in row ${rowIndex}`);
  return cell;
}

function lastRunCell(rowIndex = 0): HTMLTableCellElement {
  const cell = row(rowIndex).querySelectorAll<HTMLTableCellElement>('td')[2];
  if (!cell) throw new Error(`Missing last run cell in row ${rowIndex}`);
  return cell;
}

function narrowSummary(rowIndex = 0): string {
  const match = [...row(rowIndex).querySelectorAll('th span')].find((element) =>
    element.textContent?.includes('下次'),
  );
  if (!match) throw new Error(`Missing narrow summary in row ${rowIndex}`);
  return match.textContent ?? '';
}

beforeAll(() => msw.listen());
afterAll(() => {
  msw.close();
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
});

beforeEach(() => {
  schedules = [{ ...schedule }];
  msw.reset();
  msw.server.use(
    http.get('/api/agents', () => HttpResponse.json([agent])),
    http.get('/api/schedules', () => HttpResponse.json(schedules)),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  msw.assertClean();
});

describe('schedule next due display', () => {
  it('reads the next trigger in UTC even when the browser timezone is not UTC', async () => {
    const localDisplay = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(dueAt));
    expect(localDisplay).not.toBe(utcDisplay);
    expect(localDisplay).toContain('17:00');

    schedules = [{ ...schedule, lastRunAt: new Date(Date.now() - 5 * 60_000).toISOString() }];
    await mount();

    expect(header('下次触发（UTC）')).toBeTruthy();
    expect(nextDueCell().textContent?.trim()).toBe(utcDisplay);
    expect(utcDisplay).toContain('09:00');
    expect(nextDueCell().textContent).not.toContain('17:00');
    expect(narrowSummary()).toContain(`下次 UTC ${utcDisplay}`);
    expect(narrowSummary()).not.toContain('17:00');
    expect(lastRunCell().textContent).toContain('分钟前');
    expect(row().querySelectorAll('td')[0]?.textContent).toBe(schedule.cron);
  });

  it('shows an em dash for missing or invalid next trigger times', async () => {
    schedules = [
      { ...schedule, id: 'sch_null', name: 'No next run', nextDueAt: null },
      { ...schedule, id: 'sch_invalid', name: 'Broken next run', nextDueAt: 'not-a-date' },
    ];
    await mount();

    for (const index of [0, 1]) {
      expect(nextDueCell(index).textContent?.trim()).toBe('—');
      expect(narrowSummary(index)).toContain('下次 UTC —');
    }
    expect(container.textContent).not.toContain('Invalid Date');
  });
});
