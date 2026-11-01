import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { persistRunMessages } from '../../worker/src/messages.js';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import * as channelsRepo from '../src/repo/channels.js';
import * as chat from '../src/repo/chat.js';
import * as runs from '../src/repo/runs.js';
import {
  agents,
  approvalRequests,
  channelAgentBindings,
  channelMembers,
  channelMessages,
  channels,
  conversations,
  messages,
  servers,
} from '../src/schema.js';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const owner = 'm2-owner';
const member = 'm2-member';
const outsider = 'm2-outsider';
const agentIds: string[] = [];
const channelIds: string[] = [];

async function makeAgent(enabled = true): Promise<string> {
  const id = newId('agent');
  agentIds.push(id);
  await db.insert(agents).values({
    id,
    slug: `m2-${id.slice(4)}`,
    name: 'm2',
    model: 'test',
    createdBy: owner,
    ownerBusinessId: owner,
    enabled,
  });
  return id;
}

async function makeChannel(createdBy = owner): Promise<string> {
  const id = newId('channel');
  channelIds.push(id);
  await db.insert(channels).values({ id, name: `m2-${id.slice(4)}`, createdBy });
  await db.insert(channelMembers).values({ channelId: id, businessId: createdBy, role: 'owner' });
  return id;
}

async function addMember(
  channelId: string,
  businessId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
): Promise<void> {
  await db.insert(channelMembers).values({ channelId, businessId, role });
}

async function bindAgent(
  channelId: string,
  agentId: string,
  options: { status?: 'active' | 'paused' | 'disconnected'; autoWakeOnAll?: boolean } = {},
): Promise<void> {
  await db.insert(channelAgentBindings).values({
    channelId,
    agentId,
    status: options.status ?? 'active',
    autoWakeOnAll: options.autoWakeOnAll ?? false,
    addedBy: owner,
  });
}

const asMember = (businessId: string) => ({ businessId });

function post(
  channelId: string,
  businessId: string,
  body: string,
  extra: { mentions?: string[]; mentionAll?: boolean; clientMessageId?: string } = {},
) {
  return channelsRepo.postMessage(db, asMember(businessId), channelId, {
    id: newId('channelMessage'),
    body,
    ...extra,
  });
}

async function messageCount(channelId: string, body: string): Promise<number> {
  const rows = await db
    .select({ id: channelMessages.id })
    .from(channelMessages)
    .where(and(eq(channelMessages.channelId, channelId), eq(channelMessages.body, body)));
  return rows.length;
}

function admit(
  channelId: string,
  agentId: string,
  channelMessageId: string,
  businessId = owner,
  message = 'hello',
) {
  return chat.admitChatRun(db, {
    agentId,
    message,
    trigger: 'channel',
    subject: { kind: 'user', businessId },
    channel: { channelId, channelMessageId },
  });
}

const CONTEXT_HEADER = '【频道上下文】\n';
const CURRENT_HEADER = '【当前消息】\n';
const OMITTED_NOTICE = '更早的消息已省略\n';

function memberLine(businessId: string, body: string): string {
  return `成员 ${businessId.slice(-6)}：${body}\n`;
}

function agentLine(agentId: string, body: string): string {
  return `智能体 ${agentId}：${body}\n`;
}

function systemLine(body: string): string {
  return `系统：${body}\n`;
}

async function laneUserContent(runId: string): Promise<unknown> {
  const [row] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.runId, runId), eq(messages.role, 'user')))
    .limit(1);
  if (!row) throw new Error('expected a lane user message');
  return row.content;
}

async function laneUserText(runId: string): Promise<string> {
  const content = (await laneUserContent(runId)) as { text?: unknown };
  if (typeof content.text !== 'string') throw new Error('expected text lane content');
  return content.text;
}

async function bindingContextSeq(channelId: string, agentId: string): Promise<number> {
  const [row] = await db
    .select({ contextSeq: channelAgentBindings.contextSeq })
    .from(channelAgentBindings)
    .where(
      and(eq(channelAgentBindings.channelId, channelId), eq(channelAgentBindings.agentId, agentId)),
    );
  if (!row) throw new Error('expected a binding');
  return row.contextSeq;
}

async function finish(admitted: Awaited<ReturnType<typeof admit>>) {
  await chat.updateRun(db, admitted.run.id, { status: 'running', startedAt: new Date() });
  await persistRunMessages(db, {
    agentId: admitted.run.agentId,
    conversationId: admitted.conversationId,
    runId: admitted.run.id,
    events: [],
    sdkSessionId: `sdk-${admitted.run.id}`,
    modelExecuted: true,
  });
  return chat.updateRun(db, admitted.run.id, { status: 'succeeded', endedAt: new Date() });
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string };
  }
  throw new Error('expected promise to reject');
}

function first<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('expected a row');
  return row;
}

afterAll(async () => {
  for (const channelId of channelIds) {
    await db.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of agentIds) {
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await pool.end();
});

describe.skipIf(!ready)('channel lane admission', () => {
  it('creates one lane bound to the channel and links the triggering message', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    const posted = await post(channelId, owner, 'first');
    if (posted.kind !== 'ok') throw new Error('post failed');

    const admitted = await admit(channelId, agentId, posted.message.id);

    expect(admitted.run.trigger).toBe('channel');
    expect(admitted.run.channelId).toBe(channelId);
    expect(admitted.run.channelTriggerMessageId).toBe(posted.message.id);
    expect(admitted.run.subjectKind).toBe('user');
    expect(admitted.run.initiatedBy).toBe(owner);

    const lane = first(
      await db.select().from(conversations).where(eq(conversations.id, admitted.conversationId)),
    );
    expect(lane.channelId).toBe(channelId);
    expect(lane.agentId).toBe(agentId);
    expect(lane.createdBy).toBe(owner);

    const [binding] = await db
      .select()
      .from(channelAgentBindings)
      .where(
        and(
          eq(channelAgentBindings.channelId, channelId),
          eq(channelAgentBindings.agentId, agentId),
        ),
      );
    expect(binding?.conversationId).toBe(admitted.conversationId);

    const [userMessage] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, lane.id), eq(messages.role, 'user')))
      .limit(1);
    expect(userMessage?.channelMessageId).toBe(posted.message.id);
  });

  it('reuses the lane for the next message once the previous run ended', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    const first = await post(channelId, owner, 'one');
    const second = await post(channelId, owner, 'two');
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('post failed');

    const admitted = await admit(channelId, agentId, first.message.id);
    await chat.updateRun(db, admitted.run.id, { status: 'succeeded', endedAt: new Date() });
    const next = await admit(channelId, agentId, second.message.id);

    expect(next.conversationId).toBe(admitted.conversationId);
    expect(next.run.channelTriggerMessageId).toBe(second.message.id);
  });

  it('reuses an orphan lane when the agent is bound again', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    const first = await post(channelId, owner, 'one');
    if (first.kind !== 'ok') throw new Error('post failed');
    const admitted = await admit(channelId, agentId, first.message.id);
    await chat.updateRun(db, admitted.run.id, { status: 'succeeded', endedAt: new Date() });

    await db
      .delete(channelAgentBindings)
      .where(
        and(
          eq(channelAgentBindings.channelId, channelId),
          eq(channelAgentBindings.agentId, agentId),
        ),
      );
    await bindAgent(channelId, agentId);
    const second = await post(channelId, owner, 'two');
    if (second.kind !== 'ok') throw new Error('post failed');

    const next = await admit(channelId, agentId, second.message.id);
    expect(next.conversationId).toBe(admitted.conversationId);
  });

  it('rejects a second admission while the lane still has an active run', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    const first = await post(channelId, owner, 'one');
    const second = await post(channelId, owner, 'two');
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('post failed');

    await admit(channelId, agentId, first.message.id);
    expect((await rejection(admit(channelId, agentId, second.message.id))).code).toBe('CONFLICT');
  });

  it('keeps a single lane when two admissions race for the same binding', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    const first = await post(channelId, owner, 'one');
    const second = await post(channelId, owner, 'two');
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('post failed');

    const results = await Promise.allSettled([
      admit(channelId, agentId, first.message.id),
      admit(channelId, agentId, second.message.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
      code: 'CONFLICT',
    });
    const lanes = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.channelId, channelId), eq(conversations.agentId, agentId)));
    expect(lanes).toHaveLength(1);
  });

  it('rejects paused bindings, outsiders and viewers', async () => {
    const pausedAgent = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, pausedAgent, { status: 'paused' });
    const posted = await post(channelId, owner, 'hi');
    if (posted.kind !== 'ok') throw new Error('post failed');

    expect((await rejection(admit(channelId, pausedAgent, posted.message.id))).code).toBe(
      'CONFLICT',
    );

    const activeAgent = await makeAgent();
    await bindAgent(channelId, activeAgent);
    expect((await rejection(admit(channelId, activeAgent, posted.message.id, outsider))).code).toBe(
      'NOT_FOUND',
    );

    await addMember(channelId, 'm2-viewer', 'viewer');
    expect(
      (await rejection(admit(channelId, activeAgent, posted.message.id, 'm2-viewer'))).code,
    ).toBe('FORBIDDEN');
  });

  it('does not inherit one member approval into another member channel run but preserves private inheritance', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    await addMember(channelId, member, 'member');
    const serverId = newId('server');
    await db.insert(servers).values({
      id: serverId,
      name: `m2-${serverId}`,
      kind: 'http',
      config: { url: 'https://example.com/mcp' },
    });
    try {
      const first = await post(channelId, owner, 'A');
      const second = await post(channelId, member, 'B');
      if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('post failed');
      const admitted = await admit(channelId, agentId, first.message.id);
      await db.insert(approvalRequests).values({
        id: newId('approval'),
        runId: admitted.run.id,
        channelId,
        serverId,
        toolName: 'approved-by-A',
        approvedAt: new Date(),
        approvedByBusinessId: owner,
      });
      await finish(admitted);
      const next = await admit(channelId, agentId, second.message.id, member);
      expect.soft(next.inherited).toEqual([]);
      expect.soft(await runs.getApprovedToolNames(db, next.run.id, serverId)).toEqual([]);

      const privateRun = await chat.admitChatRun(db, {
        agentId,
        message: 'private A',
        subject: { kind: 'user', businessId: owner },
      });
      await db.insert(approvalRequests).values({
        id: newId('approval'),
        runId: privateRun.run.id,
        serverId,
        toolName: 'private-approved',
        approvedAt: new Date(),
      });
      await finish(privateRun);
      const privateNext = await chat.admitChatRun(db, {
        agentId,
        conversationId: privateRun.conversationId,
        message: 'private B',
        subject: { kind: 'user', businessId: owner },
      });
      expect(privateNext.inherited).toEqual(['private-approved']);
      expect(await runs.getApprovedToolNames(db, privateNext.run.id, serverId)).toEqual([
        'private-approved',
      ]);
    } finally {
      await db.delete(servers).where(eq(servers.id, serverId));
    }
  });

  it('only accepts a trigger message from the same channel and the same author', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    const otherChannelId = await makeChannel();
    await bindAgent(channelId, agentId);
    await addMember(channelId, member, 'member');

    const foreign = await post(otherChannelId, owner, 'elsewhere');
    const own = await post(channelId, owner, 'here');
    if (foreign.kind !== 'ok' || own.kind !== 'ok') throw new Error('post failed');

    expect((await rejection(admit(channelId, agentId, foreign.message.id))).code).toBe('NOT_FOUND');
    expect((await rejection(admit(channelId, agentId, own.message.id, member))).code).toBe(
      'FORBIDDEN',
    );
  });
});

describe.skipIf(!ready)('channel mentions', () => {
  it('wakes explicitly mentioned active and enabled agents, once each', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);

    const result = await post(channelId, owner, '@agent', {
      mentions: [agentId, agentId],
    });
    if (result.kind !== 'ok') throw new Error('post failed');
    expect(result.wakeAgentIds).toEqual([agentId]);
  });

  it('rejects mentions that are paused, disabled or unknown and writes no message', async () => {
    const paused = await makeAgent();
    const disabled = await makeAgent(false);
    const missing = newId('agent');
    const channelId = await makeChannel();
    await bindAgent(channelId, paused, { status: 'paused' });
    await bindAgent(channelId, disabled);

    for (const [index, agentId] of [paused, disabled, missing].entries()) {
      const body = `invalid-${index}`;
      const result = await post(channelId, owner, body, { mentions: [agentId] });
      expect(result).toEqual({ kind: 'invalid_mentions' });
      expect(await messageCount(channelId, body)).toBe(0);
    }
  });

  it('mentionAll only wakes active enabled bindings that opted in', async () => {
    const optedIn = await makeAgent();
    const notOptedIn = await makeAgent();
    const disabled = await makeAgent(false);
    const paused = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, optedIn, { autoWakeOnAll: true });
    await bindAgent(channelId, notOptedIn);
    await bindAgent(channelId, disabled, { autoWakeOnAll: true });
    await bindAgent(channelId, paused, { autoWakeOnAll: true, status: 'paused' });

    const result = await post(channelId, owner, '@all', {
      mentionAll: true,
      mentions: [notOptedIn],
    });
    if (result.kind !== 'ok') throw new Error('post failed');
    expect([...result.wakeAgentIds].sort()).toEqual([optedIn, notOptedIn].sort());
  });

  it('does not wake anyone again when the message is a duplicate', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);

    const first = await post(channelId, owner, 'once', {
      clientMessageId: 'k',
      mentions: [agentId],
    });
    const repeated = await post(channelId, owner, 'once', {
      clientMessageId: 'k',
      mentions: [agentId],
    });
    if (first.kind !== 'ok' || repeated.kind !== 'ok') throw new Error('post failed');
    expect(first.duplicate).toBe(false);
    expect(repeated.duplicate).toBe(true);
    expect(repeated.wakeAgentIds).toEqual([]);
  });

  it('rejects non-member posts and viewer mentions', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    await addMember(channelId, 'm2-viewer', 'viewer');

    const outsiderMention = await channelsRepo.postMessage(
      db,
      { businessId: outsider },
      channelId,
      { id: newId('channelMessage'), body: '@agent', mentions: [agentId] },
    );
    expect(outsiderMention).toEqual({ kind: 'not_found', target: 'channel' });

    const viewerMention = await channelsRepo.postMessage(
      db,
      { businessId: 'm2-viewer' },
      channelId,
      { id: newId('channelMessage'), body: '@agent', mentions: [agentId] },
    );
    expect(viewerMention).toEqual({ kind: 'forbidden', reason: 'channel_role' });

    const outsiderPlain = await channelsRepo.postMessage(db, { businessId: outsider }, channelId, {
      id: newId('channelMessage'),
      body: 'no mention',
    });
    expect(outsiderPlain).toEqual({ kind: 'not_found', target: 'channel' });
  });
});

describe.skipIf(!ready)('channel system messages', () => {
  it('inserts an agent system message and bumps the channel timestamp', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    const past = new Date(Date.now() - 60_000);
    await db.update(channels).set({ updatedAt: past }).where(eq(channels.id, channelId));

    const row = await channelsRepo.postSystemMessage(db, {
      channelId,
      agentId,
      body: 'busy',
    });

    expect(row.kind).toBe('system');
    expect(row.agentId).toBe(agentId);
    expect(row.authorBusinessId).toBeNull();
    expect(row.body).toBe('busy');
    const channel = first(await db.select().from(channels).where(eq(channels.id, channelId)));
    expect(channel.updatedAt.getTime()).toBeGreaterThan(past.getTime());
  });

  it('rejects a system message for a missing channel', async () => {
    const agentId = await makeAgent();
    expect(
      (
        await rejection(
          channelsRepo.postSystemMessage(db, {
            channelId: newId('channel'),
            agentId,
            body: 'busy',
          }),
        )
      ).code,
    ).toBe('NOT_FOUND');
  });
});

describe.skipIf(!ready)('channel data isolation', () => {
  it('hides channel lanes from private conversation reads, lists and search', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    const posted = await post(channelId, owner, 'lane');
    if (posted.kind !== 'ok') throw new Error('post failed');
    const admitted = await admit(channelId, agentId, posted.message.id);
    await chat.updateRun(db, admitted.run.id, { status: 'succeeded', endedAt: new Date() });

    const privateId = newId('conversation');
    await chat.createConversation(db, {
      id: privateId,
      agentId,
      title: 'private',
      subject: { kind: 'user', businessId: owner },
    });

    expect(await chat.getConversation(db, admitted.conversationId)).toBeNull();
    expect(await chat.getConversation(db, privateId)).not.toBeNull();

    const list = await chat.listConversations(db, {
      access: { businessId: owner, scopes: ['platform'] },
    });
    expect(list.map((row) => row.id)).toContain(privateId);
    expect(list.map((row) => row.id)).not.toContain(admitted.conversationId);

    const search = await chat.searchConversations(db, {
      q: '',
      limit: 50,
      access: { businessId: owner, scopes: ['platform'] },
    });
    expect(search.items.map((row) => row.id)).toContain(privateId);
    expect(search.items.map((row) => row.id)).not.toContain(admitted.conversationId);
  });

  it('enforces one lane per channel and agent, and one source message per reply', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    const posted = await post(channelId, owner, 'lane');
    if (posted.kind !== 'ok') throw new Error('post failed');
    const admitted = await admit(channelId, agentId, posted.message.id);

    await expect(
      db.insert(conversations).values({
        id: newId('conversation'),
        agentId,
        createdBy: owner,
        channelId,
        title: 'duplicate lane',
      }),
    ).rejects.toThrow();

    const source = first(
      await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, admitted.conversationId))
        .limit(1),
    );
    await db.insert(channelMessages).values({
      id: newId('channelMessage'),
      channelId,
      kind: 'agent',
      agentId,
      body: 'reply one',
      sourceMessageId: source.id,
    });
    await expect(
      db.insert(channelMessages).values({
        id: newId('channelMessage'),
        channelId,
        kind: 'agent',
        agentId,
        body: 'reply two',
        sourceMessageId: source.id,
      }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!ready)('channel lane context injection', () => {
  it('exports the context limits', () => {
    expect(chat.CHANNEL_CONTEXT_MESSAGE_LIMIT).toBe(20);
    expect(chat.CHANNEL_CONTEXT_CHAR_LIMIT).toBe(8000);
  });

  it('injects only messages between the cursor and the trigger without consuming on admission', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);

    const first = await post(channelId, owner, 'first body');
    await db.insert(channelMessages).values({
      id: newId('channelMessage'),
      channelId,
      kind: 'agent',
      agentId,
      body: 'agent body',
    });
    const system = await channelsRepo.postSystemMessage(db, {
      channelId,
      agentId,
      body: 'system body',
    });
    const trigger = await post(channelId, owner, 'trigger body');
    const future = await post(channelId, owner, 'future body');
    if (first.kind !== 'ok' || trigger.kind !== 'ok' || future.kind !== 'ok' || system === null) {
      throw new Error('seed failed');
    }

    const admitted = await admit(channelId, agentId, trigger.message.id, owner, 'trigger body');

    expect(await laneUserText(admitted.run.id)).toBe(
      `${CONTEXT_HEADER}${memberLine(owner, 'first body')}${agentLine(agentId, 'agent body')}${systemLine('system body')}${CURRENT_HEADER}trigger body`,
    );
    expect(await laneUserText(admitted.run.id)).not.toContain('future body');
    expect(await bindingContextSeq(channelId, agentId)).toBe(0);
  });

  it('keeps the original content when the lane has no new messages', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    const trigger = await post(channelId, owner, 'only');
    if (trigger.kind !== 'ok') throw new Error('post failed');

    const admitted = await admit(channelId, agentId, trigger.message.id, owner, 'only');

    expect(await laneUserContent(admitted.run.id)).toEqual({ type: 'text', text: 'only' });
    expect(await bindingContextSeq(channelId, agentId)).toBe(0);
  });

  it('does not repeat consumed messages and never moves the cursor backwards', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);

    const m1 = await post(channelId, owner, 'm1');
    const m2 = await post(channelId, owner, 'm2');
    if (m1.kind !== 'ok' || m2.kind !== 'ok') throw new Error('post failed');
    const first = await admit(channelId, agentId, m2.message.id, owner, 'm2');
    expect(await laneUserText(first.run.id)).toBe(
      `${CONTEXT_HEADER}${memberLine(owner, 'm1')}${CURRENT_HEADER}m2`,
    );
    await finish(first);

    const m3 = await post(channelId, owner, 'm3');
    const m4 = await post(channelId, owner, 'm4');
    if (m3.kind !== 'ok' || m4.kind !== 'ok') throw new Error('post failed');
    const second = await admit(channelId, agentId, m4.message.id, owner, 'm4');
    expect(await laneUserText(second.run.id)).toBe(
      `${CONTEXT_HEADER}${memberLine(owner, 'm3')}${CURRENT_HEADER}m4`,
    );
    await finish(second);

    const old = await admit(channelId, agentId, m2.message.id, owner, 'm2');
    expect(await laneUserContent(old.run.id)).toEqual({ type: 'text', text: 'm2' });
    expect(await bindingContextSeq(channelId, agentId)).toBe(m4.message.seq);
    await finish(old);

    const m5 = await post(channelId, owner, 'm5');
    if (m5.kind !== 'ok') throw new Error('post failed');
    const next = await admit(channelId, agentId, m5.message.id, owner, 'm5');
    expect(await laneUserContent(next.run.id)).toEqual({ type: 'text', text: 'm5' });
    expect(await bindingContextSeq(channelId, agentId)).toBe(m4.message.seq);
    await finish(next);
    expect(await bindingContextSeq(channelId, agentId)).toBe(m5.message.seq);
  });

  it('injects only the latest 20 messages and marks older ones as omitted', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);

    const limit = chat.CHANNEL_CONTEXT_MESSAGE_LIMIT;
    const bodies = Array.from({ length: limit + 5 }, (_, index) => `m${index + 1}`);
    const posted = [];
    for (const body of bodies) posted.push(await post(channelId, owner, body));
    const trigger = posted.at(-1);
    if (trigger?.kind !== 'ok') throw new Error('post failed');

    const admitted = await admit(channelId, agentId, trigger.message.id, owner, 'm25');

    const priorCount = bodies.length - 1;
    const expectedLines = bodies
      .slice(priorCount - limit, priorCount)
      .map((body) => memberLine(owner, body))
      .join('');
    const text = await laneUserText(admitted.run.id);
    expect(text).toBe(`${CONTEXT_HEADER}${OMITTED_NOTICE}${expectedLines}${CURRENT_HEADER}m25`);
    expect(text).not.toContain(memberLine(owner, 'm4'));
  });

  it('drops the earliest whole messages to stay within the character limit', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);

    const older = 'a'.repeat(5000);
    const newer = 'b'.repeat(5000);
    const olderPost = await post(channelId, owner, older);
    const newerPost = await post(channelId, owner, newer);
    const trigger = await post(channelId, owner, 'go');
    if (olderPost.kind !== 'ok' || newerPost.kind !== 'ok' || trigger.kind !== 'ok') {
      throw new Error('post failed');
    }

    const admitted = await admit(channelId, agentId, trigger.message.id, owner, 'go');
    const text = await laneUserText(admitted.run.id);

    expect(text).toBe(
      `${CONTEXT_HEADER}${OMITTED_NOTICE}${memberLine(owner, newer)}${CURRENT_HEADER}go`,
    );
    expect(text.length - 'go'.length).toBeLessThanOrEqual(chat.CHANNEL_CONTEXT_CHAR_LIMIT);
  });

  it('degrades an oversized single message to only the omission notice', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);

    const huge = await post(channelId, owner, 'x'.repeat(9000));
    const trigger = await post(channelId, owner, 'go');
    if (huge.kind !== 'ok' || trigger.kind !== 'ok') throw new Error('post failed');

    const admitted = await admit(channelId, agentId, trigger.message.id, owner, 'go');
    const text = await laneUserText(admitted.run.id);

    expect(text).toBe(`${CONTEXT_HEADER}${OMITTED_NOTICE}${CURRENT_HEADER}go`);
    expect(text.length - 'go'.length).toBeLessThanOrEqual(chat.CHANNEL_CONTEXT_CHAR_LIMIT);
  });

  it('leaves the cursor untouched when admission is rejected', async () => {
    const agentId = await makeAgent();
    const channelId = await makeChannel();
    await bindAgent(channelId, agentId);
    await addMember(channelId, 'm2-viewer', 'viewer');

    const first = await post(channelId, owner, 'first');
    if (first.kind !== 'ok') throw new Error('post failed');
    expect((await rejection(admit(channelId, agentId, first.message.id, 'm2-viewer'))).code).toBe(
      'FORBIDDEN',
    );
    expect(await bindingContextSeq(channelId, agentId)).toBe(0);

    const admitted = await admit(channelId, agentId, first.message.id, owner, 'first');
    const busy = await post(channelId, owner, 'busy');
    if (busy.kind !== 'ok') throw new Error('post failed');
    expect((await rejection(admit(channelId, agentId, busy.message.id, owner, 'busy'))).code).toBe(
      'CONFLICT',
    );
    expect((await rejection(admit(channelId, agentId, busy.message.id, outsider))).code).toBe(
      'NOT_FOUND',
    );
    expect(await bindingContextSeq(channelId, agentId)).toBe(0);
    expect((await chat.getRun(db, admitted.run.id))?.status).toBe('queued');
  });

  it('keeps private conversations and custom content unchanged', async () => {
    const agentId = await makeAgent();
    const subject = { kind: 'user' as const, businessId: owner };

    const plain = await chat.admitChatRun(db, { agentId, message: 'plain', subject });
    expect(await laneUserContent(plain.run.id)).toEqual({ type: 'text', text: 'plain' });

    const custom = [
      { type: 'text', text: 'custom' },
      {
        type: 'openui_action',
        params: { card: 'x' },
        context: { source: 'card' },
        formState: { days: 3 },
        formName: 'form',
        messageId: newId('message'),
        blockKey: 's0',
      },
    ];
    const admitted = await chat.admitChatRun(db, {
      agentId,
      message: 'custom',
      userContent: custom,
      subject,
    });
    expect(await laneUserContent(admitted.run.id)).toEqual(custom);
  });
});
