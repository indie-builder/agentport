import { createDb, newId, repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testAccess } from './fixtures/access.js';

const { agentOwnership, conversationSubject, userSubject } = testAccess(import.meta.url);

/**
 * 第 9 轮把认领条件收紧成「只认 queued」。回归审计发现这会让重试失效：
 * 可重试失败抛错时行仍是 running，下一次投递被自己的守卫跳过。
 * 这里锁住「重试前必须把行改回 queued」这条契约。
 */
const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;
const agentId = newId('agent');
const conversationId = newId('conversation');

async function claim(runId: string): Promise<number> {
  const rows = await db
    .update(schema.agentRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')))
    .returning({ id: schema.agentRuns.id });
  return rows.length;
}

async function requeue(runId: string): Promise<number> {
  const rows = await db
    .update(schema.agentRuns)
    .set({ status: 'queued', startedAt: null })
    .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'running')))
    .returning({ id: schema.agentRuns.id });
  return rows.length;
}

describe('run claim and retry contract', () => {
  beforeAll(async () => {
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `claim-${agentId.slice(4, 12)}`,
      name: 'claim',
      model: 'test',
      ...agentOwnership,
    });
    await db
      .insert(schema.conversations)
      .values({ id: conversationId, agentId, ...conversationSubject });
  });

  afterAll(async () => {
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.conversationId, conversationId));
    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    await dbHandle.pool.end();
  });

  it('claims a queued run exactly once', async () => {
    const runId = newId('run');
    await repo.chat.createRun(db, { id: runId, conversationId, agentId, subject: userSubject });
    expect(await claim(runId)).toBe(1);
    // 第二次认领必须失败：这是 BullMQ 重复投递时的保护。
    expect(await claim(runId)).toBe(0);
  });

  it('a retryable failure can be requeued and claimed again', async () => {
    const runId = newId('run');
    await repo.chat.createRun(db, { id: runId, conversationId, agentId, subject: userSubject });
    expect(await claim(runId)).toBe(1);
    // 模拟可重试失败：先回 queued 再抛错。
    expect(await requeue(runId)).toBe(1);
    expect(await claim(runId)).toBe(1);
  });

  it('requeue refuses a run that is not running', async () => {
    const runId = newId('run');
    await repo.chat.createRun(db, { id: runId, conversationId, agentId, subject: userSubject });
    expect(await requeue(runId)).toBe(0);
  });
});
