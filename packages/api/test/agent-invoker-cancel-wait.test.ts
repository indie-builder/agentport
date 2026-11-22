import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId, schema } from '@agentport/db';
import { runCancelKey, runStreamKey } from '@agentport/shared';
import { RedisClient } from 'bun';
import { and, eq } from 'drizzle-orm';
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

interface RunRow {
  id: string;
  conversation_id: string;
  status: string;
  ended_at: Date | null;
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected promise to reject');
}

describe.skipIf(!ready)('agent invoker cancellable wait', () => {
  let app: TestApp;
  let cookie: string;
  let redis: RedisClient;
  const agentIds: string[] = [];
  const agentSlugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    redis = new RedisClient(testConfig().REDIS_URL);
  });

  afterAll(async () => {
    const discovered =
      agentIds.length === 0
        ? []
        : (
            await app.client.unsafe<{ id: string }[]>(
              'select id from agent_runs where agent_id = any($1::text[])',
              [app.client.array(agentIds, 'TEXT')],
            )
          ).map((row) => row.id);
    for (const runId of discovered) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
      await redis.del(runCancelKey(runId), runStreamKey(runId)).catch(() => undefined);
    }
    await cleanup(app, { agentSlugs, runIds: discovered });
    redis.close();
    await app.close();
  });

  const newAgent = async (prefix: string) => {
    const slug = unique(prefix);
    const res = await createAgent(app, cookie, { slug, track: agentSlugs });
    const agent = res.json<{ id: string }>();
    agentIds.push(agent.id);
    return { id: agent.id, slug };
  };

  const runsOf = async (agentId: string): Promise<RunRow[]> =>
    app.client.unsafe<RunRow[]>(
      'select id, conversation_id, status, ended_at from agent_runs where agent_id = $1 order by created_at desc',
      [agentId],
    );

  it('cancels a pending poll immediately, marks the real run cancelled, audits it, and removes the queued job', async () => {
    const agent = await newAgent('cancel-wait');
    const controller = new AbortController();
    const pending = createInvoker(app).invoke({
      slug: agent.slug,
      prompt: 'cancel during poll',
      signal: controller.signal,
    });
    pending.catch(() => undefined);

    let runId: string | undefined;
    const enqueued = await waitFor(async () => {
      const candidate = (await runsOf(agent.id))[0]?.id;
      if (candidate === undefined) return false;
      if ((await getQueue().getJob(candidate)) === undefined) return false;
      const [requested] = await app.db
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.target, candidate),
            eq(schema.auditLog.action, 'agent.run.requested'),
          ),
        )
        .limit(1);
      if (!requested) return false;
      runId = candidate;
      return true;
    });
    expect(enqueued).toBe(true);
    if (!runId) throw new Error('run was not created');

    const abortedAt = performance.now();
    controller.abort();

    const err = await rejectionOf(pending);
    expect(err.code).toBe('UPSTREAM_FAILED');
    expect(err.message).toBe('agent run cancelled');
    expect(performance.now() - abortedAt).toBeLessThan(500);

    const [run] = await runsOf(agent.id);
    expect(run?.status).toBe('cancelled');
    expect(run?.ended_at).not.toBeNull();
    expect(await getQueue().getJob(runId)).toBeUndefined();

    const [audit] = await app.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.target, runId), eq(schema.auditLog.action, 'agent.run.cancelled')),
      )
      .limit(1);
    expect(audit).toMatchObject({
      actor: 'mcp',
      actorKind: 'service',
      action: 'agent.run.cancelled',
      target: runId,
      status: 'ok',
    });
  });

  it('reads the run after a normal wait and returns assistant text from real Postgres', async () => {
    const agent = await newAgent('normal-wait');
    const pending = createInvoker(app).invoke({ slug: agent.slug, prompt: 'hello' });

    const created = await waitFor(async () => (await runsOf(agent.id)).length === 1);
    expect(created).toBe(true);
    const [run] = await runsOf(agent.id);
    if (!run) throw new Error('run was not created');

    await app.db
      .update(schema.agentRuns)
      .set({ status: 'succeeded', startedAt: new Date(), endedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    await app.db.insert(schema.messages).values({
      id: newId('message'),
      conversationId: run.conversation_id,
      role: 'assistant',
      content: { type: 'text', text: 'assistant reply' },
      runId: run.id,
    });

    const text = await pending;
    expect(text).toBe('assistant reply');
  });
});
