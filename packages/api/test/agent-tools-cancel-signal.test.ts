import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { repo } from '@agentport/db';
import { RUN_CANCEL_PAYLOAD, runCancelKey, runStreamKey } from '@agentport/shared';
import { RedisClient } from 'bun';
import { createInvoker } from '../src/modules/servers/agent-invoker.js';
import { getQueue } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  infraReady,
  loginCookie,
  queueIdle,
  startApp,
  type TestApp,
  testConfig,
  unique,
  waitFor,
} from './helpers.js';

const ready = (await infraReady) && (await queueIdle);

async function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!ready)('platform agent tools: abort signals reach the worker', () => {
  let app: TestApp;
  let cookie: string;
  let redis: RedisClient;
  const createdAgents: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    redis = new RedisClient(testConfig().REDIS_URL);
  });

  afterAll(async () => {
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
      await redis.del(runCancelKey(runId), runStreamKey(runId)).catch(() => undefined);
    }
    await cleanup(app, { agentSlugs: createdAgents, runIds });
    redis.close();
    await app.close();
  });

  const ownRun = async (agentId: string): Promise<string | undefined> => {
    const rows = await app.client.unsafe<{ id: string }[]>(
      'select id from agent_runs where agent_id = $1 order by created_at desc limit 1',
      [agentId],
    );
    return rows[0]?.id;
  };

  const statusOf = async (runId: string): Promise<string | undefined> => {
    const rows = await app.client.unsafe<{ status: string }[]>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    return rows[0]?.status;
  };

  const awaitQueuedJob = async (agentId: string): Promise<string> => {
    const found = await waitFor(async () => {
      const id = await ownRun(agentId);
      if (id === undefined) return false;
      if (!runIds.includes(id)) runIds.push(id);
      return (await getQueue().getJob(id)) !== undefined;
    });
    expect(found).toBe(true);
    const runId = runIds.at(-1);
    if (runId === undefined) throw new Error('run was never enqueued');
    return runId;
  };

  it('publishes the cancel signal and keeps the job when a claimed run is aborted', {
    timeout: 15_000,
  }, async () => {
    const slug = unique('signal-running');
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<{
      id: string;
    }>();
    const controller = new AbortController();
    const pending = createInvoker(app).invoke({
      slug,
      prompt: 'cancel a claimed run',
      timeoutMs: 8_000,
      signal: controller.signal,
    });
    pending.catch(() => undefined);

    const runId = await awaitQueuedJob(agent.id);
    await repo.chat.updateRun(app.db, runId, { status: 'running', startedAt: new Date() });

    const channel = runCancelKey(runId);
    const subscriber = new RedisClient(testConfig().REDIS_URL);
    try {
      let received: string | undefined;
      const signalled = Promise.withResolvers<void>();
      await subscriber.subscribe(channel, (message, incoming) => {
        if (incoming !== channel) return;
        received = message;
        signalled.resolve();
      });

      controller.abort();
      await expect(pending).rejects.toThrow(/cancelled/);
      expect(await settledWithin(signalled.promise, 5_000)).toBe(true);
      expect(received).toBe(RUN_CANCEL_PAYLOAD);
    } finally {
      subscriber.close();
    }
    expect(await redis.get(channel)).toBe(RUN_CANCEL_PAYLOAD);
    expect(await statusOf(runId)).toBe('running');
    expect(await getQueue().getJob(runId)).toBeDefined();
  });

  it('removes the waiting job and publishes the terminal event for a queued run', {
    timeout: 15_000,
  }, async () => {
    const slug = unique('signal-queued');
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<{
      id: string;
    }>();
    const controller = new AbortController();
    const pending = createInvoker(app).invoke({
      slug,
      prompt: 'cancel a queued run',
      timeoutMs: 8_000,
      signal: controller.signal,
    });
    pending.catch(() => undefined);

    const runId = await awaitQueuedJob(agent.id);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);

    expect(await waitFor(async () => (await getQueue().getJob(runId)) === undefined, 5_000)).toBe(
      true,
    );
    expect(await statusOf(runId)).toBe('cancelled');

    const streamKey = runStreamKey(runId);
    const terminal = await waitFor(async () => {
      const entries = (await redis.xrange(streamKey, '-', '+')) as Array<[string, string[]]>;
      return entries.some(([, fields]) => {
        const payload = fields[fields.indexOf('payload') + 1];
        return payload?.includes('"run_finished"') === true && payload.includes('"cancelled"');
      });
    }, 5_000);
    expect(terminal).toBe(true);
  });
});
