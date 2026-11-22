import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import { requireExecutionStack } from './support/execution-stack.js';
import { fixture } from './support/fixture.js';

await requireExecutionStack();

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);
const SHOT_DIR = '/tmp/schedule-lifecycle-shots';

interface Schedule {
  id: string;
  timezone: string;
  description: string;
  nextDueAt: string | null;
  lastRunAt: string | null;
}

interface ScheduleRun {
  id: string;
  status: string;
  error: string | null;
}

interface RunDetail {
  run: { id: string; status: string; scheduleId?: string | null; error: string | null };
}

interface NotificationList {
  items: Array<{ kind: string; title: string; link: string; createdAt: string }>;
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
  expected?: number,
): Promise<T> {
  const response = await browserFetch(browser, method, path, body);
  const ok =
    expected === undefined
      ? response.status >= 200 && response.status < 300
      : response.status === expected;
  if (!ok) throw new Error(`${method} ${path} ${response.status}: ${response.text}`);
  return (response.text === '' ? null : JSON.parse(response.text)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(1_000);
  }
  throw new Error(`等待超时：${label}`);
}

function scheduleCronFor(timeZone: string, minutesAhead = 2) {
  const expected = new Date(Date.now() + minutesAhead * 60_000);
  expected.setUTCSeconds(0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(expected);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute))
    throw new Error(`无法为 ${timeZone} 解析本地时/分：${JSON.stringify(parts)}`);
  return { cron: `${minute} ${hour} * * *`, expected, hour, minute };
}

test('schedule lifecycle: timezone firing, catch-up, failure notification and retry', {
  session: 'admin',
  timeout: 900_000,
}, async ({ app, screen, browser }) => {
  const testStartedAt = new Date().toISOString();
  const suffix = crypto.randomUUID().slice(0, 8);
  const shots = join(SHOT_DIR, suffix);
  const shot = async (label: string): Promise<string> => {
    mkdirSync(shots, { recursive: true });
    const source = await app.screenshot(label);
    const target = join(shots, `${label}.png`);
    copyFileSync(source, target);
    return target;
  };

  await app.open('/schedules');
  const agent = await apiJson<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-schedule-${suffix}`,
    name: `E2E 定时任务 ${suffix}`,
    systemPrompt: '你是定时任务验证智能体。收到消息后直接回复内容。',
  });
  const scheduleIds: string[] = [];

  try {
    const newYork = scheduleCronFor('America/New_York');
    const first = await apiJson<Schedule>(
      browser,
      'POST',
      '/api/schedules',
      {
        agentId: agent.id,
        name: `E2E 纽约 ${suffix}`,
        cron: newYork.cron,
        timezone: 'America/New_York',
        missedPolicy: 'run_once',
        prompt: `E2E schedule New York ${suffix}`,
        enabled: true,
      },
      201,
    );
    scheduleIds.push(first.id);
    expect(first.nextDueAt).toBe(newYork.expected.toISOString());
    expect(first.timezone).toBe('America/New_York');
    expect(first.description).toBe(
      `每天 ${String(newYork.hour).padStart(2, '0')}:${String(newYork.minute).padStart(2, '0')}`,
    );

    const firstRun = await waitFor('纽约定时运行成功', 240_000, async () => {
      const runs = await apiJson<ScheduleRun[]>(browser, 'GET', `/api/schedules/${first.id}/runs`);
      const failed = runs.find((run) => run.status === 'failed' || run.status === 'timeout');
      if (failed) throw new Error(`首次定时运行失败：${JSON.stringify(failed)}`);
      return runs.find((run) => run.status === 'succeeded') ?? null;
    });
    const firstDetail = await apiJson<RunDetail>(browser, 'GET', `/api/runs/${firstRun.id}`);
    expect(firstDetail.run.scheduleId).toBe(first.id);

    expect(await fixture('schedules', 'countScheduleRuns', first.id)).toBe(1);
    await fixture(
      'schedules',
      'setLastRunAt',
      first.id,
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );
    const caughtUp = await waitFor('对账补跑新增 1 条运行', 90_000, async () => {
      const count = await fixture('schedules', 'countScheduleRuns', first.id);
      return count >= 2 ? count : null;
    });
    expect(caughtUp).toBe(2);
    await waitFor('补跑运行成功且没有继续增加', 240_000, async () => {
      const runs = await apiJson<ScheduleRun[]>(browser, 'GET', `/api/schedules/${first.id}/runs`);
      return runs.length === 2 && runs.every((run) => run.status === 'succeeded');
    });
    await sleep(4_000);
    expect(await fixture('schedules', 'countScheduleRuns', first.id)).toBe(2);

    const shanghai = scheduleCronFor('Asia/Shanghai');
    const second = await apiJson<Schedule>(
      browser,
      'POST',
      '/api/schedules',
      {
        agentId: agent.id,
        name: `E2E 上海 ${suffix}`,
        cron: shanghai.cron,
        timezone: 'Asia/Shanghai',
        missedPolicy: 'run_once',
        prompt: `E2E-CHANNEL-FAIL 定时失败 ${suffix}`,
        enabled: true,
      },
      201,
    );
    scheduleIds.push(second.id);
    expect(second.nextDueAt).toBe(shanghai.expected.toISOString());

    const failedRun = await waitFor('定时运行失败', 600_000, async () => {
      const runs = await apiJson<ScheduleRun[]>(browser, 'GET', `/api/schedules/${second.id}/runs`);
      return runs.find((run) => run.status === 'failed') ?? null;
    });
    expect(typeof failedRun.error).toBe('string');
    expect(failedRun.error).not.toBe('');

    const notice = await waitFor('schedule_failed 通知', 60_000, async () => {
      const list = await apiJson<NotificationList>(browser, 'GET', '/api/notifications?limit=100');
      const matches = list.items.filter(
        (item) =>
          item.kind === 'schedule_failed' &&
          item.link === '/schedules' &&
          item.createdAt >= testStartedAt,
      );
      return matches.length === 1 ? (matches[0] ?? null) : null;
    });
    expect(notice.link).toBe('/schedules');

    await apiJson<Schedule>(
      browser,
      'PATCH',
      `/api/schedules/${second.id}`,
      { prompt: `E2E 定时重试 ${suffix}` },
      200,
    );
    const retriedRun = await apiJson<ScheduleRun>(
      browser,
      'POST',
      `/api/schedules/${second.id}/runs/${failedRun.id}/retry`,
      undefined,
      201,
    );
    const retriedDetail = await waitFor('重试运行成功', 300_000, async () => {
      const detail = await apiJson<RunDetail>(browser, 'GET', `/api/runs/${retriedRun.id}`);
      if (detail.run.status === 'succeeded') return detail;
      if (TERMINAL_STATUSES.has(detail.run.status))
        throw new Error(`重试运行终态 ${detail.run.status}：${JSON.stringify(detail.run)}`);
      return null;
    });
    expect(retriedDetail.run.scheduleId).toBe(second.id);
    const history = await apiJson<ScheduleRun[]>(
      browser,
      'GET',
      `/api/schedules/${second.id}/runs`,
    );
    expect(history.some((run) => run.id === failedRun.id && run.status === 'failed')).toBe(true);
    expect(history.some((run) => run.id === retriedRun.id && run.status === 'succeeded')).toBe(
      true,
    );

    await browser.setViewport({ width: 1440, height: 900 });
    await app.open('/schedules');
    await expect(screen.getByText(`E2E 纽约 ${suffix}`).first()).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByText(/Asia\/Shanghai/).first()).toBeVisible({ timeout: 15_000 });
    await expect(
      screen
        .getByText(
          `每天 ${String(shanghai.hour).padStart(2, '0')}:${String(shanghai.minute).padStart(2, '0')}`,
          { exact: false },
        )
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    expect((await shot('schedules-1440')).length).toBeGreaterThan(0);

    await screen.getByRole('button', { name: `执行历史 E2E 上海 ${suffix}` }).tap();
    const historyDialog = screen.getByRole('dialog', '执行历史');
    await expect(historyDialog).toBeVisible({ timeout: 15_000 });
    await expect(historyDialog.getByText('失败', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    const reasonPrefix = (failedRun.error ?? '').slice(0, 12);
    await expect(historyDialog.getByText(reasonPrefix, { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(historyDialog.getByRole('button', { name: `重试 ${failedRun.id}` })).toBeVisible({
      timeout: 15_000,
    });
    expect((await shot('schedule-history-1440')).length).toBeGreaterThan(0);

    await browser.keyboard.press('Escape');
    await expect(historyDialog).toHaveCount(0, { timeout: 15_000 });

    await browser.setViewport({ width: 1200, height: 900 });
    await app.open('/schedules');
    await expect(screen.getByText(/Asia\/Shanghai/).first()).toBeVisible({ timeout: 60_000 });
    expect((await shot('schedules-1200')).length).toBeGreaterThan(0);

    const newYorkRuns = await apiJson<ScheduleRun[]>(
      browser,
      'GET',
      `/api/schedules/${first.id}/runs`,
    );
    console.log(
      JSON.stringify({
        schedules: { newYork: first.id, shanghai: second.id },
        newYorkRuns,
        shanghaiRuns: history,
        failed: { id: failedRun.id, status: failedRun.status, error: failedRun.error },
        retried: { id: retriedRun.id, status: retriedDetail.run.status },
        shots,
      }),
    );
  } finally {
    for (const scheduleId of scheduleIds) {
      await apiJson(browser, 'DELETE', `/api/schedules/${scheduleId}`).catch(() => undefined);
    }
    await apiJson(browser, 'DELETE', `/api/agents/${agent.id}`).catch(() => undefined);
  }
});
