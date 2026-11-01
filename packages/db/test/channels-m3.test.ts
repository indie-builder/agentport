import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import * as channelsRepo from '../src/repo/channels.js';
import * as chat from '../src/repo/chat.js';
import {
  agents,
  approvalRequests,
  channelAgentBindings,
  channelMembers,
  channelMessages,
  channels,
  servers,
} from '../src/schema.js';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const owner = 'm3-owner';
const agentIds: string[] = [];
const channelIds: string[] = [];
const serverIds: string[] = [];

async function makeAgent(): Promise<string> {
  const id = newId('agent');
  agentIds.push(id);
  await db.insert(agents).values({
    id,
    slug: `m3-${id.slice(4)}`,
    name: 'm3',
    model: 'test',
    createdBy: owner,
    ownerBusinessId: owner,
  });
  return id;
}

async function makeServer(): Promise<string> {
  const id = newId('server');
  serverIds.push(id);
  await db.insert(servers).values({
    id,
    name: `m3-${id.slice(4)}`,
    kind: 'http',
    config: { url: 'https://example.com/mcp' },
  });
  return id;
}

async function makeChannel(): Promise<string> {
  const id = newId('channel');
  channelIds.push(id);
  await db.insert(channels).values({ id, name: `m3-${id.slice(4)}`, createdBy: owner });
  await db.insert(channelMembers).values({ channelId: id, businessId: owner, role: 'owner' });
  return id;
}

async function closeChannel(channelId: string): Promise<void> {
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channelId));
}

function post(channelId: string, body: string, extra: { mentions?: string[] } = {}) {
  return channelsRepo.postMessage(db, { businessId: owner }, channelId, {
    id: newId('channelMessage'),
    body,
    ...extra,
  });
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message?: string };
  }
  throw new Error('expected promise to reject');
}

afterAll(async () => {
  for (const channelId of channelIds) {
    await db.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of agentIds) {
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  for (const serverId of serverIds) {
    await db.delete(servers).where(eq(servers.id, serverId));
  }
  await pool.end();
});

describe.skipIf(!ready)('closed channels reject new content', () => {
  it('rejects posting to a closed channel inside the channel row lock', async () => {
    const channelId = await makeChannel();
    await closeChannel(channelId);

    const err = await rejection(post(channelId, 'after close'));
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('频道已关闭，不能发送消息');
  });

  it('does not write a busy notice to a closed channel', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await closeChannel(channelId);

    const row = await channelsRepo.postSystemMessage(db, {
      channelId,
      agentId,
      body: 'busy',
    });

    expect(row).toBeNull();
    const notices = await db
      .select({ id: channelMessages.id })
      .from(channelMessages)
      .where(and(eq(channelMessages.channelId, channelId), eq(channelMessages.kind, 'system')));
    expect(notices).toHaveLength(0);
  });

  it('keeps admission of new channel runs closed under the same row lock', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await db.insert(channelAgentBindings).values({
      channelId,
      agentId,
      addedBy: owner,
    });
    const posted = await post(channelId, 'before close');
    if (posted.kind !== 'ok') throw new Error('post failed');
    await closeChannel(channelId);

    const err = await rejection(
      chat.admitChatRun(db, {
        agentId,
        message: 'hello',
        trigger: 'channel',
        subject: { kind: 'user', businessId: owner },
        channel: { channelId, channelMessageId: posted.message.id },
      }),
    );
    expect(err.code).toBe('CONFLICT');
  });
});

describe.skipIf(!ready)('channel approvals', () => {
  it('records the channel and the approving business identity', async () => {
    const serverId = await makeServer();
    const channelId = await makeChannel();
    const id = newId('approval');

    const [row] = await db
      .insert(approvalRequests)
      .values({
        id,
        channelId,
        serverId,
        toolName: 'm3-write',
        approvedAt: new Date(),
        approvedByBusinessId: owner,
      })
      .returning();

    expect(row?.channelId).toBe(channelId);
    expect(row?.approvedByBusinessId).toBe(owner);
  });

  it('deletes channel approvals with the channel', async () => {
    const serverId = await makeServer();
    const channelId = await makeChannel();
    const id = newId('approval');
    await db.insert(approvalRequests).values({ id, channelId, serverId, toolName: 'm3-cascade' });

    await db.delete(channels).where(eq(channels.id, channelId));

    expect(
      await db.select().from(approvalRequests).where(eq(approvalRequests.id, id)),
    ).toHaveLength(0);
  });
});
