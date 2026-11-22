import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createDb, newId, schema } from '@agentport/db';
import { runStreamKey } from '@agentport/shared';
import { RedisClient } from 'bun';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { closeRunnerClient, configureRunnerClient } from '../src/runner-client.js';
import { LOST_RUN_ERROR, startReconciler } from '../src/scheduling/reconcile.js';
import { testAccess } from './fixtures/access.js';
import { probeBunRedis } from './fixtures/bun-redis.js';
import { createIsolatedDatabase } from './isolated-db.js';

const { agentOwnership, conversationSubject, runSubjectFields } = testAccess(import.meta.url);

async function probeInfra(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) return false;
  const { client } = createDb(databaseUrl);
  try {
    await client.unsafe('select 1');
    return await probeBunRedis(redisUrl);
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

const isolated = await createIsolatedDatabase('worker_reconcile_shutdown');
if (isolated) process.env.DATABASE_URL = isolated.url;
const ready = isolated !== null && (await probeInfra());
if (!ready && isolated) await isolated.close();

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

describe.skipIf(!ready)('startReconciler shutdown', () => {
  const redisUrl = process.env.REDIS_URL ?? '';
  let dbHandle: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>['db'];
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const runId = newId('run');
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  } as unknown as Logger;

  beforeAll(async () => {
    dbHandle = createDb(isolated?.url ?? '');
    db = dbHandle.db;
    configureRunnerClient(redisUrl, logger);

    await db.insert(schema.agents).values({
      id: agentId,
      slug: `reconcile-shutdown-${agentId.slice(4, 12)}`,
      name: 'reconcile-shutdown',
      model: 'test',
      timeoutMs: 1_000,
      ...agentOwnership,
    });
    await db
      .insert(schema.conversations)
      .values({ id: conversationId, agentId, ...conversationSubject });
    await db.insert(schema.agentRuns).values({
      id: runId,
      conversationId,
      agentId,
      status: 'running',
      sandboxId: `sbx-${runId}`,
      startedAt: new Date(Date.now() - 15 * 60_000),
      ...runSubjectFields,
    });
  });

  afterAll(async () => {
    const redis = new RedisClient(redisUrl);
    await redis.del(runStreamKey(runId)).catch(() => undefined);
    redis.close();
    await closeRunnerClient();
    await db.delete(schema.auditLog).where(eq(schema.auditLog.target, runId));
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    await dbHandle.client.close();
    await isolated?.close();
  });

  it('waits for in-flight reconcile cleanup and finalizes the orphaned run before stop resolves', async () => {
    let markCleanupEntered!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => {
      markCleanupEntered = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });

    const stop = startReconciler({
      db,
      logger,
      agentTimeoutMs: 1_000,
      redisUrl,
      cleanup: async () => {
        markCleanupEntered();
        await cleanupGate;
      },
    });

    await cleanupEntered;

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await flush();

    expect(stopped).toBe(false);

    releaseCleanup();
    await stopping;

    expect(stopped).toBe(true);

    const [row] = await db
      .select({
        status: schema.agentRuns.status,
        error: schema.agentRuns.error,
        endedAt: schema.agentRuns.endedAt,
      })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .limit(1);

    expect(row).toMatchObject({
      status: 'failed',
      error: LOST_RUN_ERROR,
    });
    expect(row?.endedAt).not.toBeNull();
  });
});
