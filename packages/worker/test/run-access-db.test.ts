import { createDb, newId, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkQueuedRunAccess, checkUserAgentAccess } from '../src/run-access.js';
import { createIsolatedDatabase } from './isolated-db.js';

const isolated = await createIsolatedDatabase('worker_run_access');
const ready = isolated !== null;
const dbHandle = createDb(isolated?.url ?? '');
const { db } = dbHandle;

const businessId = 'run-access-user';
const ownerBusinessId = 'run-access-owner';
const roleId = newId('role');
const agentId = newId('agent');
const userId = newId('user');
const conversationId = newId('conversation');

beforeAll(async () => {
  if (!ready) return;
  await db.insert(schema.authUsers).values({
    id: userId,
    businessId,
    name: 'run access user',
    email: `run-access-${userId.slice(4)}@test.local`,
  });
  await db.insert(schema.roles).values({ id: roleId, name: 'run access role' });
  await db.insert(schema.rolePermissions).values([
    { roleId, permissionId: 'agents.use', scope: 'authorized_agents' },
    { roleId, permissionId: 'schedules.manage', scope: 'maintained_agents' },
  ]);
  await db.insert(schema.userRoles).values({ businessId, roleId });
  await db.insert(schema.agents).values({
    id: agentId,
    slug: `run-access-${agentId.slice(4)}`,
    name: 'run access',
    model: 'test',
    createdBy: ownerBusinessId,
    ownerBusinessId,
  });
  await db.insert(schema.agentMembers).values({
    agentId,
    businessId,
    canUse: true,
    canMaintain: true,
  });
  await db.insert(schema.conversations).values({
    id: conversationId,
    agentId,
    title: 'run access chat',
    createdBy: businessId,
  });
});

afterAll(async () => {
  if (ready) {
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.conversationId, conversationId));
    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    await db.delete(schema.userRoles).where(eq(schema.userRoles.businessId, businessId));
    await db.delete(schema.roles).where(eq(schema.roles.id, roleId));
    await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
  }
  await dbHandle.pool.end();
  await isolated?.close();
});

describe.skipIf(!ready)('checkUserAgentAccess against real account and grants', () => {
  beforeEach(async () => {
    await db
      .update(schema.authUsers)
      .set({ disabled: false })
      .where(eq(schema.authUsers.id, userId));
    await db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
    await db.insert(schema.rolePermissions).values([
      { roleId, permissionId: 'agents.use', scope: 'authorized_agents' },
      { roleId, permissionId: 'schedules.manage', scope: 'maintained_agents' },
    ]);
  });

  it('allows a member with live use and manage grants', async () => {
    expect(
      await checkUserAgentAccess(db, {
        businessId,
        agentId,
        permissions: ['agents.use', 'schedules.manage'],
      }),
    ).toBeNull();
  });

  it('denies immediately after the role grants are revoked', async () => {
    await db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
    expect(
      await checkUserAgentAccess(db, {
        businessId,
        agentId,
        permissions: ['agents.use'],
      }),
    ).toMatchObject({ reason: 'permission_denied' });
  });

  it('denies after the authentication account is disabled', async () => {
    await db
      .update(schema.authUsers)
      .set({ disabled: true })
      .where(eq(schema.authUsers.id, userId));
    expect(
      await checkUserAgentAccess(db, {
        businessId,
        agentId,
        permissions: ['agents.use'],
      }),
    ).toMatchObject({ reason: 'account_inactive' });
  });
});

describe.skipIf(!ready)('checkQueuedRunAccess re-checks the DB source per trigger', () => {
  const queued = (trigger: 'chat' | 'schedule' | 'event' | 'review', runId = 'run-x') => ({
    runId,
    trigger,
    agentId,
    conversationId,
    businessId,
  });

  beforeEach(async () => {
    await db
      .update(schema.authUsers)
      .set({ disabled: false })
      .where(eq(schema.authUsers.id, userId));
    await db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
    await db.insert(schema.rolePermissions).values([
      { roleId, permissionId: 'agents.use', scope: 'authorized_agents' },
      { roleId, permissionId: 'schedules.manage', scope: 'maintained_agents' },
    ]);
  });

  it('requires conversations.create beyond agents.use for a chat run', async () => {
    expect(await checkQueuedRunAccess(db, queued('chat'))).toMatchObject({
      reason: 'permission_denied',
    });
    await db
      .insert(schema.rolePermissions)
      .values({ roleId, permissionId: 'conversations.create', scope: 'own_data' });
    expect(await checkQueuedRunAccess(db, queued('chat'))).toBeNull();
  });

  it('denies a schedule run once schedules.manage is revoked even with agents.use intact', async () => {
    const scheduleId = newId('schedule');
    await db.insert(schema.agentSchedules).values({
      id: scheduleId,
      agentId,
      name: 'nightly',
      createdBy: businessId,
      executeAsBusinessId: businessId,
      cron: '0 0 * * *',
      prompt: 'run',
    });
    expect(await checkQueuedRunAccess(db, queued('schedule'))).toBeNull();

    await db
      .delete(schema.rolePermissions)
      .where(
        and(
          eq(schema.rolePermissions.roleId, roleId),
          eq(schema.rolePermissions.permissionId, 'schedules.manage'),
        ),
      );
    expect(
      await checkQueuedRunAccess(db, { ...queued('schedule'), runId: newId('run') }),
    ).toMatchObject({ reason: 'permission_denied' });

    // 即使恢复授权，库里的执行主体与 run 主体不一致也必须拒绝。
    await db
      .insert(schema.rolePermissions)
      .values({ roleId, permissionId: 'schedules.manage', scope: 'maintained_agents' });
    await db
      .update(schema.agentSchedules)
      .set({ executeAsBusinessId: 'someone-else' })
      .where(eq(schema.agentSchedules.id, scheduleId));
    expect(
      await checkQueuedRunAccess(db, { ...queued('schedule'), runId: newId('run') }),
    ).toMatchObject({ reason: 'permission_denied' });

    await db.delete(schema.agentSchedules).where(eq(schema.agentSchedules.id, scheduleId));
  });

  it('requires a running eval for its event-sourced case runs', async () => {
    const evalRunId = newId('evalRun');
    await db.insert(schema.evalRuns).values({
      id: evalRunId,
      agentId,
      createdBy: businessId,
      status: 'running',
    });
    expect(await checkQueuedRunAccess(db, queued('event'))).toMatchObject({
      reason: 'permission_denied',
    });

    await db
      .insert(schema.rolePermissions)
      .values({ roleId, permissionId: 'eval.execute', scope: 'maintained_agents' });
    expect(await checkQueuedRunAccess(db, queued('event'))).toBeNull();

    await db
      .update(schema.evalRuns)
      .set({ status: 'succeeded' })
      .where(eq(schema.evalRuns.id, evalRunId));
    expect(await checkQueuedRunAccess(db, queued('event'))).toMatchObject({
      reason: 'permission_denied',
    });
    await db.delete(schema.evalRuns).where(eq(schema.evalRuns.id, evalRunId));
  });

  it('checks the review row owner and own_data review grant', async () => {
    const reviewRunId = newId('run');
    await db.insert(schema.agentRuns).values({
      id: reviewRunId,
      conversationId,
      agentId,
      trigger: 'review',
      subjectKind: 'user',
      initiatedBy: businessId,
    });
    await db.insert(schema.memoryReviews).values({
      runId: reviewRunId,
      businessId,
      requestKey: `review-${reviewRunId.slice(4)}`,
      requestHash: 'hash',
      modelAgentId: agentId,
      target: { kind: 'personal' },
      sources: [{ conversationId }],
      before: { content: null, globs: null },
    });
    expect(await checkQueuedRunAccess(db, queued('review', reviewRunId))).toMatchObject({
      reason: 'permission_denied',
    });

    // 平台范围也能覆盖本人的个人数据；own_data 是本人对象的最小授权。
    await db
      .insert(schema.rolePermissions)
      .values({ roleId, permissionId: 'personal_memory.review', scope: 'own_data' });
    expect(await checkQueuedRunAccess(db, queued('review', reviewRunId))).toBeNull();

    await db
      .update(schema.memoryReviews)
      .set({ businessId: 'someone-else' })
      .where(eq(schema.memoryReviews.runId, reviewRunId));
    expect(await checkQueuedRunAccess(db, queued('review', reviewRunId))).toMatchObject({
      reason: 'invalid_subject',
    });

    await db.delete(schema.memoryReviews).where(eq(schema.memoryReviews.runId, reviewRunId));
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, reviewRunId));
  });
});
