import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import { getRunDetail } from '../src/repo/runs.js';
import { agentRuns, agents, conversations } from '../src/schema.js';

const url = process.env.DATABASE_URL ?? 'postgres://unreachable@127.0.0.1:1/unavailable';
const { db, pool } = createDb(url);
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

describe.skipIf(!ready)('run detail runtime environment identity', () => {
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const startedRunId = newId('run');
  const queuedRunId = newId('run');
  const identity = {
    environmentId: 'rte_01JABCDEFGHJKMNPQRSTVWXYZ',
    environmentName: '旧环境',
    versionId: 'rtv_01JABCDEFGHJKMNPQRSTVWXYZ',
    imageId: `sha256:${'a'.repeat(64)}`,
  };

  beforeAll(async () => {
    await db.insert(agents).values({
      id: agentId,
      slug: `rt-identity-${agentId.slice(4)}`,
      name: 'identity',
      model: 'test',
    });
    await db.insert(conversations).values({ id: conversationId, agentId });
    await db.insert(agentRuns).values([
      { id: queuedRunId, conversationId, agentId },
      {
        id: startedRunId,
        conversationId,
        agentId,
        runtimeEnvironmentId: identity.environmentId,
        runtimeEnvironmentName: identity.environmentName,
        runtimeEnvironmentVersionId: identity.versionId,
        runtimeEnvironmentImageId: identity.imageId,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(agentRuns).where(eq(agentRuns.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await pool.end();
  });

  it('returns the stored identity as one environment object', async () => {
    expect((await getRunDetail(db, startedRunId))?.run.runtimeEnvironment).toEqual(identity);
  });

  it('returns null while the run has not created a container', async () => {
    expect((await getRunDetail(db, queuedRunId))?.run.runtimeEnvironment).toBeNull();
  });
});
