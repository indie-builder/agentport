import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SCHEDULE_TRIGGERS_QUEUE, type ScheduleTriggerJob } from '@agentport/shared';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 只替换队列获取这一个既有边界：注入带私有 prefix 的真队列，
 * 让测试写入的 scheduler 不落到开发/其它套件的 `schedule-triggers` 键上。
 * 其余同步函数与 Fastify schema 都走真实实现。
 */
const state = vi.hoisted(() => ({
  queue: undefined as unknown as Queue<ScheduleTriggerJob>,
}));

vi.mock('../src/features/ops/schedule-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/ops/schedule-sync.js')>()),
  getScheduleQueue: () => state.queue,
}));

const { cleanup, createAgent, infraReady, loginCookie, startApp, unique } = await import(
  './helpers.js'
);

const ready = await infraReady;
const REDIS_URL = process.env.REDIS_URL ?? '';
const PREFIX = `schedule-routes-test-${randomUUID().slice(0, 8)}`;

interface ScheduleBody {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  nextDueAt: string | null;
}

describe.skipIf(!ready)('schedule routes', () => {
  let app: FastifyInstance;
  let cookie: string;
  let agentId: string;
  let queue: Queue<ScheduleTriggerJob>;
  let nextFromStrategy: () => number;
  let agentSlug: string;
  const scheduleIds: string[] = [];

  /** 自定义 repeatStrategy 让 pending job 在秒级到期，不用等真实的 5/10 分钟窗口。 */
  async function createSchedule(overrides: Record<string, unknown> = {}): Promise<ScheduleBody> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: { cookie },
      payload: {
        agentId,
        name: 'digest',
        cron: '*/5 * * * *',
        prompt: 'summarize',
        ...overrides,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<ScheduleBody>();
    scheduleIds.push(body.id);
    return body;
  }

  async function patchSchedule(
    id: string,
    payload: Record<string, unknown>,
  ): Promise<ScheduleBody> {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/schedules/${id}`,
      headers: { cookie },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ScheduleBody>();
  }

  async function auditActions(target: string): Promise<string[]> {
    const { rows } = await app.pool.query<{ action: string; status: string }>(
      'select action, status from audit_log where target = $1 order by created_at',
      [target],
    );
    return rows.map((row) => `${row.action}:${row.status}`);
  }

  async function clearSchedulers(): Promise<void> {
    const schedulers = await queue.getJobSchedulers();
    await Promise.all(schedulers.map((scheduler) => queue.removeJobScheduler(scheduler.key)));
  }

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    agentSlug = unique('sched-agent');
    agentId = (await createAgent(app, cookie, { slug: agentSlug })).json().id;
    queue = new Queue<ScheduleTriggerJob>(SCHEDULE_TRIGGERS_QUEUE, {
      connection: { url: REDIS_URL, maxRetriesPerRequest: null },
      prefix: PREFIX,
      settings: { repeatStrategy: () => nextFromStrategy() },
    });
    state.queue = queue;
  });

  beforeEach(async () => {
    nextFromStrategy = () => Date.now() + 3_600_000;
    await clearSchedulers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (queue) {
      await clearSchedulers().catch(() => undefined);
      await queue.close();
    }
    if (app) {
      if (scheduleIds.length > 0) {
        await app.pool.query('delete from audit_log where target = any($1::text[])', [scheduleIds]);
        await app.pool.query('delete from agent_schedules where id = any($1::text[])', [
          scheduleIds,
        ]);
      }
      await cleanup(app, { agentSlugs: [agentSlug] });
      await app.close();
    }
  });

  it.each(['not a cron', '60 0 * * *', '0 0 31 2 *', '*/0 * * * *', '0 0 * * 9', '0 0 1 13 *'])(
    'rejects an unschedulable cron before writing: %s',
    async (cron) => {
      const name = unique('invalid');
      const response = await app.inject({
        method: 'POST',
        url: '/api/schedules',
        headers: { cookie },
        payload: { agentId, name, cron, prompt: 'summarize' },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_INPUT' });
      const { rows } = await app.pool.query('select id from agent_schedules where name = $1', [
        name,
      ]);
      expect(rows).toHaveLength(0);
    },
  );

  it('keeps the pending job and next when only name/prompt/enabled=true are saved', async () => {
    // 先让下一次触发在 1.5s 后：随后 sleep 到逾期，模拟 worker 停机时的积压 pending job。
    nextFromStrategy = () => Date.now() + 1_500;
    const created = await createSchedule();
    const before = await queue.getJobScheduler(created.id);
    expect(before?.next).toEqual(expect.any(Number));
    const [pending] = await queue.getDelayed();
    expect(pending?.id).toBe(`repeat:${created.id}:${before?.next}`);

    await delay(1_700);
    // 若被错误地 upsert，就会用这个更晚的时间重算 next，旧 job 同时被删除。
    nextFromStrategy = () => Date.now() + 3_600_000;

    const body = await patchSchedule(created.id, {
      name: 'renamed',
      prompt: 'new prompt',
      enabled: true,
      cron: created.cron,
    });
    expect(body).toMatchObject({
      name: 'renamed',
      prompt: 'new prompt',
      enabled: true,
      nextDueAt: new Date(before?.next ?? 0).toISOString(),
    });

    const after = await queue.getJobScheduler(created.id);
    expect(after?.next).toBe(before?.next);
    const delayed = await queue.getDelayed();
    expect(delayed.map((job) => job.id)).toEqual([pending?.id]);

    const { rows } = await app.pool.query<{ prompt: string }>(
      'select prompt from agent_schedules where id = $1',
      [created.id],
    );
    expect(rows[0]?.prompt).toBe('new prompt');
    expect(await auditActions(created.id)).toContain('schedule.updated:ok');
  });

  it('registers the scheduler after creating and returns its next run', async () => {
    const created = await createSchedule();
    const entry = await queue.getJobScheduler(created.id);
    expect(entry?.pattern).toBe('*/5 * * * *');
    expect(entry?.tz).toBe('UTC');
    expect(created.nextDueAt).toBe(new Date(entry?.next ?? 0).toISOString());
  });

  it('enables a disabled schedule by registering its scheduler', async () => {
    const created = await createSchedule({ enabled: false });
    expect(await queue.getJobScheduler(created.id)).toBeUndefined();

    const body = await patchSchedule(created.id, { enabled: true });
    expect(body.nextDueAt).toEqual(expect.any(String));
    const entry = await queue.getJobScheduler(created.id);
    expect(entry?.pattern).toBe('*/5 * * * *');
  });

  it('replaces the scheduler when the cron actually changes', async () => {
    const created = await createSchedule();
    const before = await queue.getJobScheduler(created.id);
    nextFromStrategy = () => Date.now() + 7_200_000;

    const body = await patchSchedule(created.id, { cron: '*/10 * * * *' });
    expect(body.nextDueAt).toEqual(expect.any(String));
    const after = await queue.getJobScheduler(created.id);
    expect(after?.pattern).toBe('*/10 * * * *');
    expect(after?.next).not.toBe(before?.next);
  });

  it('removes the scheduler when the schedule is disabled', async () => {
    const created = await createSchedule();
    expect(await queue.getJobScheduler(created.id)).toBeDefined();

    const body = await patchSchedule(created.id, { enabled: false });
    expect(body.nextDueAt).toBeNull();
    expect(await queue.getJobScheduler(created.id)).toBeUndefined();
  });

  it('keeps the created schedule when redis is unavailable, and audits it', async () => {
    vi.spyOn(queue, 'upsertJobScheduler').mockRejectedValueOnce(new Error('redis down'));
    const created = await createSchedule();
    expect(created.nextDueAt).toBeNull();
    expect(await auditActions(created.id)).toContain('schedule.sync_failed:error');
  });

  it('keeps the schedule update when redis is unavailable during a cron change, and audits it', async () => {
    const created = await createSchedule();
    vi.spyOn(queue, 'upsertJobScheduler').mockRejectedValueOnce(new Error('redis down'));

    const body = await patchSchedule(created.id, { cron: '*/10 * * * *' });
    expect(body.nextDueAt).toBeNull();
    expect(await auditActions(created.id)).toContain('schedule.updated:ok');
    expect(await auditActions(created.id)).toContain('schedule.sync_failed:error');

    const { rows } = await app.pool.query<{ cron: string }>(
      'select cron from agent_schedules where id = $1',
      [created.id],
    );
    expect(rows[0]?.cron).toBe('*/10 * * * *');
  });

  it('removes the scheduler after deleting, and survives redis failures', async () => {
    const created = await createSchedule();
    vi.spyOn(queue, 'removeJobScheduler').mockRejectedValueOnce(new Error('redis down'));
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/schedules/${created.id}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(204);
    expect(await auditActions(created.id)).toContain('schedule.deleted:ok');
    expect(await auditActions(created.id)).toContain('schedule.sync_failed:error');
  });

  it('removes the scheduler after deleting', async () => {
    const created = await createSchedule();
    expect(await queue.getJobScheduler(created.id)).toBeDefined();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/schedules/${created.id}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(204);
    expect(await queue.getJobScheduler(created.id)).toBeUndefined();
  });
});
