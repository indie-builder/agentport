import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { writeAudit, upsertScheduler, removeScheduler, schedulerNextRun } = vi.hoisted(() => ({
  writeAudit: vi.fn(async () => undefined),
  upsertScheduler: vi.fn(
    async (_queue: unknown, _schedule: { id: string; cron: string }) => undefined,
  ),
  removeScheduler: vi.fn(async (_queue: unknown, _id: string) => undefined),
  schedulerNextRun: vi.fn(async () => new Date(1_800_000_000_000).toISOString()),
}));

vi.mock('../src/plugins/audit.js', () => ({ writeAudit }));
// cron 判定保留真实实现（BullMQ 的 getNextMillis），只挡掉 Redis 连接。
vi.mock('../src/features/ops/schedule-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/ops/schedule-sync.js')>()),
  getScheduleQueue: () => ({}),
  upsertScheduler,
  removeScheduler,
  schedulerNextRun,
}));

const { registerOpsRoutes } = await import('../src/features/ops/routes.js');
const { registerErrorHandler } = await import('../src/plugins/errors.js');
const { loadConfig } = await import('../src/config.js');

const agent = { id: 'agent_1', name: 'Agent' };
let app: FastifyInstance;
let inserted: unknown[];

function scheduleRow(input: Record<string, unknown>) {
  return {
    id: 'schedule_1',
    agentId: 'agent_1',
    name: input.name,
    cron: input.cron,
    prompt: input.prompt,
    enabled: true,
    lastRunAt: null,
    nextDueAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

beforeEach(async () => {
  inserted = [];
  upsertScheduler.mockClear().mockResolvedValue(undefined);
  removeScheduler.mockClear().mockResolvedValue(undefined);
  writeAudit.mockClear();
  // 只在需要模拟 Redis 失败时改行为。
  schedulerNextRun.mockClear().mockResolvedValue(new Date(1_800_000_000_000).toISOString());
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [agent] }) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(values);
          return [scheduleRow(values)];
        },
      }),
    }),
    delete: () => ({ where: () => ({ returning: async () => [{ id: 'schedule_1' }] }) }),
  };
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('requireAuth', async () => {});
  app.decorate('config', loadConfig({ ...process.env, REDIS_URL: 'redis://localhost:6379' }));
  app.decorate('db', db as unknown as FastifyInstance['db']);
  registerErrorHandler(app);
  registerOpsRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const validBody = { agentId: 'agent_1', name: 'digest', cron: '*/5 * * * *', prompt: 'summarize' };

describe('schedule routes', () => {
  it.each(['not a cron', '60 0 * * *', '0 0 31 2 *', '*/0 * * * *', '0 0 * * 9', '0 0 1 13 *'])(
    'rejects an unschedulable cron before writing: %s',
    async (cron) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: { ...validBody, cron },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_INPUT' });
      expect(inserted).toHaveLength(0);
      expect(upsertScheduler).not.toHaveBeenCalled();
    },
  );

  it('registers the scheduler after creating and returns its next run', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: validBody,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(upsertScheduler).toHaveBeenCalledTimes(1);
    expect(upsertScheduler.mock.calls[0]?.[1]).toMatchObject({
      id: 'schedule_1',
      cron: '*/5 * * * *',
    });
    expect(response.json()).toMatchObject({
      id: 'schedule_1',
      nextDueAt: new Date(1_800_000_000_000).toISOString(),
    });
  });

  it('keeps the created schedule when redis is unavailable, and audits it', async () => {
    upsertScheduler.mockRejectedValue(new Error('redis down'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: validBody,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ id: 'schedule_1', nextDueAt: null });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'schedule.sync_failed', target: 'schedule_1' }),
    );
  });

  it('removes the scheduler after deleting, and survives redis failures', async () => {
    removeScheduler.mockRejectedValue(new Error('redis down'));
    const response = await app.inject({ method: 'DELETE', url: '/api/schedules/schedule_1' });
    expect(response.statusCode, response.body).toBe(204);
    expect(removeScheduler).toHaveBeenCalledWith(expect.anything(), 'schedule_1');
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'schedule.sync_failed', target: 'schedule_1' }),
    );
  });
});
