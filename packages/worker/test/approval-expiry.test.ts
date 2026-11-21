import { afterAll, describe, expect, it } from 'bun:test';
import { createDb, newId, repo, schema } from '@agentport/db';
import { and, eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import { reconcileExpiredApprovals } from '../src/maintenance.js';
import { createIsolatedDatabase } from './isolated-db.js';

const isolated = await createIsolatedDatabase(
  'worker_approval_expiry',
  process.env.DATABASE_URL ?? '',
);
const { db, client } = createDb(isolated?.url ?? process.env.DATABASE_URL ?? '');
const ready = await client.unsafe('select 1').then(
  () => true,
  () => false,
);
if (!(ready && isolated)) await isolated?.close();
const logger = pino({ level: 'silent' });
const businessId = 'approval-expiry-owner';
const agentIds: string[] = [];
const serverIds: string[] = [];
const channelIds: string[] = [];
const runIds: string[] = [];

async function newRun(channelId: string | null = null) {
  const agentId = newId('agent');
  const serverId = newId('server');
  const conversationId = newId('conversation');
  const runId = newId('run');
  agentIds.push(agentId);
  serverIds.push(serverId);
  runIds.push(runId);
  await db.insert(schema.agents).values({
    id: agentId,
    slug: `approval-expiry-${agentId.slice(4)}`,
    name: 'approval expiry',
    model: 'test',
    createdBy: businessId,
    ownerBusinessId: businessId,
  });
  await db.insert(schema.servers).values({
    id: serverId,
    name: `approval-expiry-${serverId.slice(4)}`,
    kind: 'http',
    config: { url: 'https://example.com/mcp' },
  });
  await db.insert(schema.conversations).values({
    id: conversationId,
    agentId,
    channelId,
    title: 'approval expiry',
    createdBy: businessId,
  });
  await db.insert(schema.agentRuns).values({
    id: runId,
    conversationId,
    agentId,
    channelId,
    trigger: channelId === null ? 'chat' : 'channel',
    status: 'running',
    subjectKind: 'user',
    initiatedBy: businessId,
    startedAt: new Date(),
  });
  return { runId, serverId, conversationId, channelId };
}

async function addApproval(input: {
  runId: string;
  serverId: string;
  conversationId: string;
  channelId: string | null;
  toolName: string;
  expiresAt: Date | null;
  approvedAt?: Date | null;
  deniedAt?: Date | null;
  expiredAt?: Date | null;
}): Promise<string> {
  const id = newId('approval');
  await db.insert(schema.approvalRequests).values({ id, ...input });
  return id;
}

async function createNotification(sourceId: string): Promise<void> {
  await repo.notifications.createNotification(db, {
    businessId,
    kind: 'approval',
    title: '工具调用等待审批',
    body: '工具正在等待你的批准',
    link: '/runs',
    sourceId,
  });
}

async function readAtOf(sourceId: string): Promise<Date | null> {
  const [row] = await db
    .select({ readAt: schema.notifications.readAt })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.businessId, businessId),
        eq(schema.notifications.sourceId, sourceId),
      ),
    )
    .limit(1);
  return row?.readAt ?? null;
}

async function expiredAtOf(approvalId: string): Promise<Date | null> {
  const [row] = await db
    .select({ expiredAt: schema.approvalRequests.expiredAt })
    .from(schema.approvalRequests)
    .where(eq(schema.approvalRequests.id, approvalId))
    .limit(1);
  return row?.expiredAt ?? null;
}

async function expiryAudits(runId: string) {
  return db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, 'agent.run.approval.expired'),
        eq(schema.auditLog.target, runId),
      ),
    );
}

afterAll(async () => {
  if (ready && isolated) {
    await db.delete(schema.notifications).where(eq(schema.notifications.businessId, businessId));
    if (runIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.target, runIds));
    }
    if (agentIds.length > 0) {
      await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    }
    if (channelIds.length > 0) {
      await db.delete(schema.channels).where(inArray(schema.channels.id, channelIds));
    }
    if (serverIds.length > 0) {
      await db.delete(schema.servers).where(inArray(schema.servers.id, serverIds));
    }
  }
  await client.close();
  await isolated?.close();
});

describe.skipIf(!(ready && isolated))('reconcileExpiredApprovals', () => {
  it('expires stale approvals once, audits them and clears the waiting notification', async () => {
    const run = await newRun();
    const approvalId = await addApproval({
      ...run,
      toolName: 'web_search',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const sourceId = `approval:${run.runId}:${approvalId}`;
    await createNotification(sourceId);
    const now = new Date();

    expect(await reconcileExpiredApprovals(db, logger, now)).toBe(1);
    expect(await expiredAtOf(approvalId)).not.toBeNull();
    expect(await expiryAudits(run.runId)).toHaveLength(1);
    expect(await readAtOf(sourceId)).not.toBeNull();

    expect(await reconcileExpiredApprovals(db, logger, now)).toBe(0);
    expect(await expiryAudits(run.runId)).toHaveLength(1);
  });

  it('leaves approved, denied, unexpired and already expired approvals untouched', async () => {
    const run = await newRun();
    const approvedAt = new Date();
    const priorExpiry = new Date(Date.now() - 120_000);
    const approved = await addApproval({
      ...run,
      toolName: 'approved_tool',
      expiresAt: new Date(Date.now() - 60_000),
      approvedAt,
    });
    const denied = await addApproval({
      ...run,
      toolName: 'denied_tool',
      expiresAt: new Date(Date.now() - 60_000),
      deniedAt: new Date(),
    });
    const unexpired = await addApproval({
      ...run,
      toolName: 'unexpired_tool',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const alreadyExpired = await addApproval({
      ...run,
      toolName: 'already_expired_tool',
      expiresAt: new Date(Date.now() - 60_000),
      expiredAt: priorExpiry,
    });

    expect(await reconcileExpiredApprovals(db, logger, new Date())).toBe(0);
    expect(await expiredAtOf(approved)).toBeNull();
    expect(await expiredAtOf(denied)).toBeNull();
    expect(await expiredAtOf(unexpired)).toBeNull();
    expect(await expiredAtOf(alreadyExpired)).toEqual(priorExpiry);
    expect(await expiryAudits(run.runId)).toHaveLength(0);
  });

  it('clears the channel approval notification', async () => {
    const channelId = newId('channel');
    channelIds.push(channelId);
    await db.insert(schema.channels).values({
      id: channelId,
      name: `approval-expiry-${channelId.slice(4)}`,
      createdBy: businessId,
    });
    const run = await newRun(channelId);
    const approvalId = await addApproval({
      ...run,
      toolName: 'channel_tool',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const sourceId = `channel-approval:${approvalId}`;
    await createNotification(sourceId);

    expect(await reconcileExpiredApprovals(db, logger, new Date())).toBe(1);
    expect(await readAtOf(sourceId)).not.toBeNull();
  });
});
