import { createDb, newId, schema } from '@agentport/db';
import { type ChannelEvent, channelStreamKey } from '@agentport/shared';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { publishChannelEventSafely } from '../src/channel-events.js';
import { finalizeRun, type RunFinishedEvent } from '../src/run-finish.js';
import { closeRunnerClient, configureRunnerClient } from '../src/runner-client.js';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const redisUrl = process.env.REDIS_URL ?? '';
const logger = pino({ level: 'silent' });
const agentIds: string[] = [];
const channelIds: string[] = [];

const dbReady = await pool.query('select 1').then(
  () => true,
  () => false,
);
let redis: Redis | undefined;
if (dbReady) {
  try {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 1_000 });
    await redis.ping();
    configureRunnerClient(redisUrl);
  } catch {
    await redis?.quit().catch(() => undefined);
    redis = undefined;
  }
}
const ready = dbReady && redis !== undefined;

async function newChannelRun(status: 'queued' | 'running'): Promise<{
  runId: string;
  agentId: string;
  channelId: string;
}> {
  const agentId = newId('agent');
  const channelId = newId('channel');
  const conversationId = newId('conversation');
  const runId = newId('run');
  agentIds.push(agentId);
  channelIds.push(channelId);
  await db.insert(schema.agents).values({
    id: agentId,
    slug: `channel-run-${agentId.slice(4)}`,
    name: 'channel run',
    model: 'test',
    createdBy: 'worker-test-user',
    ownerBusinessId: 'worker-test-user',
  });
  await db.insert(schema.channels).values({
    id: channelId,
    name: `channel-run-${channelId.slice(4)}`,
    createdBy: 'worker-test-user',
  });
  await db.insert(schema.conversations).values({
    id: conversationId,
    agentId,
    channelId,
    title: 'channel run lane',
    createdBy: 'worker-test-user',
  });
  await db.insert(schema.agentRuns).values({
    id: runId,
    conversationId,
    agentId,
    channelId,
    trigger: 'channel',
    status,
    subjectKind: 'user',
    initiatedBy: 'worker-test-user',
    ...(status === 'running' ? { startedAt: new Date() } : {}),
  });
  return { runId, agentId, channelId };
}

async function channelEvents(channelId: string): Promise<ChannelEvent[]> {
  const entries = await redis?.xrange(channelStreamKey(channelId), '-', '+');
  return (entries ?? []).map(([, fields]) => {
    const payload = fields[fields.indexOf('payload') + 1];
    return JSON.parse(payload ?? '{}') as ChannelEvent;
  });
}

afterAll(async () => {
  await closeRunnerClient();
  if (ready) {
    await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    await db.delete(schema.channels).where(inArray(schema.channels.id, channelIds));
  }
  await redis?.quit().catch(() => undefined);
  await pool.end();
});

describe.skipIf(!ready)('channel run lifecycle events', () => {
  it('publishes run.finished once, only for the CAS winner', async () => {
    const fixture = await newChannelRun('running');
    await redis?.del(channelStreamKey(fixture.channelId));
    const event: RunFinishedEvent = { type: 'run_finished', status: 'succeeded' };

    expect(
      await finalizeRun({
        db,
        logger,
        runId: fixture.runId,
        event,
        audit: { action: 'test.finished', status: 'ok' },
      }),
    ).toBe(true);
    expect(
      await finalizeRun({
        db,
        logger,
        runId: fixture.runId,
        event,
        audit: { action: 'test.finished', status: 'ok' },
      }),
    ).toBe(false);

    const events = (await channelEvents(fixture.channelId)).filter(
      (entry) => entry.type === 'run.finished',
    );
    expect(events).toEqual([
      {
        type: 'run.finished',
        channelId: fixture.channelId,
        runId: fixture.runId,
        agentId: fixture.agentId,
        status: 'succeeded',
      },
    ]);
  });

  it('publishes run.finished for a queued run denied before start', async () => {
    const fixture = await newChannelRun('queued');
    await redis?.del(channelStreamKey(fixture.channelId));

    expect(
      await finalizeRun({
        db,
        logger,
        runId: fixture.runId,
        fromStatus: 'queued',
        event: { type: 'run_finished', status: 'failed', error: 'denied' },
        values: { error: 'denied', errorKind: 'agent' },
        audit: { action: 'test.denied', status: 'error' },
      }),
    ).toBe(true);

    expect(await channelEvents(fixture.channelId)).toContainEqual({
      type: 'run.finished',
      channelId: fixture.channelId,
      runId: fixture.runId,
      agentId: fixture.agentId,
      status: 'failed',
    });
  });

  it('does not let a failed channel publish change the terminal state', async () => {
    const fixture = await newChannelRun('running');
    // 同键写成字符串让 XADD 返回 WRONGTYPE：真实发布失败，而不是 mock。
    await redis?.set(channelStreamKey(fixture.channelId), 'not-a-stream');

    await expect(
      finalizeRun({
        db,
        logger,
        runId: fixture.runId,
        event: { type: 'run_finished', status: 'succeeded' },
        audit: { action: 'test.finished', status: 'ok' },
      }),
    ).resolves.toBe(true);

    const [row] = await db
      .select({ status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId));
    expect(row?.status).toBe('succeeded');
  });

  it('publishes a run.started lifecycle event', async () => {
    const fixture = await newChannelRun('running');
    await redis?.del(channelStreamKey(fixture.channelId));

    await publishChannelEventSafely(
      fixture.channelId,
      {
        type: 'run.started',
        channelId: fixture.channelId,
        runId: fixture.runId,
        agentId: fixture.agentId,
      },
      logger,
      { runId: fixture.runId },
    );

    expect(await channelEvents(fixture.channelId)).toContainEqual({
      type: 'run.started',
      channelId: fixture.channelId,
      runId: fixture.runId,
      agentId: fixture.agentId,
    });
  });
});
