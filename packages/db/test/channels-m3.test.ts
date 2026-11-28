import { afterAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { newId } from '../src/id.js';
import * as channelsRepo from '../src/repo/channels.js';
import * as chat from '../src/repo/chat.js';
import {
  agents,
  channelAgentBindings,
  channelMembers,
  channelMessages,
  channels,
} from '../src/schema.js';
import { probeTestDb } from './db-probe.js';

const { db, client, ready } = await probeTestDb();

const owner = 'm3-owner';
const agentIds: string[] = [];
const channelIds: string[] = [];

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
  await client.close();
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
