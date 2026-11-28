import { afterAll, describe, expect, it } from 'bun:test';
import type { AccessFilter, AccessScope } from '@agentport/shared';
import { eq, inArray } from 'drizzle-orm';
import { newId } from '../src/id.js';
import * as agentsRepo from '../src/repo/agents.js';
import * as chatRepo from '../src/repo/chat.js';
import { agentRuns, agents, conversations } from '../src/schema.js';
import { probeTestDb } from './db-probe.js';

const { db, client, ready } = await probeTestDb();

const owner = 'delete-hook-owner';
const other = 'delete-hook-other';
const createdAgents: string[] = [];

function filter(scopes: AccessScope[], businessId = owner): AccessFilter {
  return { businessId, scopes };
}

function conversationInput(id: string, businessId = owner) {
  return { id, access: filter(['own_data'], businessId) };
}

async function newAgent(): Promise<string> {
  const id = newId('agent');
  createdAgents.push(id);
  await db.insert(agents).values({
    id,
    slug: `delete-hook-${id.slice(4)}`,
    name: 'delete hook',
    model: 'test',
    createdBy: owner,
    ownerBusinessId: owner,
  });
  return id;
}

async function newConversation(agentId: string, createdBy = owner): Promise<string> {
  const id = newId('conversation');
  await chatRepo.createConversation(db, {
    id,
    agentId,
    title: 'to delete',
    subject: { kind: 'user', businessId: createdBy },
  });
  return id;
}

async function addRun(
  conversationId: string,
  agentId: string,
  sandboxId: string,
  status: 'succeeded' | 'queued' | 'running' = 'succeeded',
) {
  await db.insert(agentRuns).values({
    id: newId('run'),
    conversationId,
    agentId,
    status,
    subjectKind: 'user',
    initiatedBy: owner,
    sandboxId,
  });
}

async function runCount(conversationId: string): Promise<number> {
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.conversationId, conversationId));
  return rows.length;
}

afterAll(async () => {
  if (createdAgents.length > 0) {
    await db.delete(agents).where(inArray(agents.id, createdAgents));
  }
  await client.close();
});

describe.skipIf(!ready)('short delete transactions', () => {
  it('snapshots a conversation canonically and leaves it visible between A and B', async () => {
    const agentId = await newAgent();
    const conversationId = await newConversation(agentId);
    await addRun(conversationId, agentId, 'sandbox-b');
    await addRun(conversationId, agentId, 'sandbox-a');
    await addRun(conversationId, agentId, 'sandbox-a');

    const snapshot = await chatRepo.prepareConversationDeletion(
      db,
      conversationInput(conversationId),
    );
    const agent = await agentsRepo.getAgent(db, agentId);
    if (!agent || !snapshot) throw new Error('expected agent and snapshot');
    expect(snapshot).toEqual({
      id: conversationId,
      agentId,
      agentSlug: agent.slug,
      createdBy: owner,
      targets: [{ conversationId, sandboxIds: ['sandbox-a', 'sandbox-b'] }],
    });
    expect(await chatRepo.getConversation(db, conversationId)).not.toBeNull();

    expect(
      await chatRepo.deleteConversation(db, {
        ...conversationInput(conversationId),
        expected: snapshot,
      }),
    ).toBe(true);
    expect(await chatRepo.getConversation(db, conversationId)).toBeNull();
  });

  it('keeps an empty-sandbox conversation in the target snapshot', async () => {
    const agentId = await newAgent();
    const conversationId = await newConversation(agentId);
    const snapshot = await chatRepo.prepareConversationDeletion(
      db,
      conversationInput(conversationId),
    );
    expect(snapshot?.targets).toEqual([{ conversationId, sandboxIds: [] }]);
  });

  it('applies the delete scope in A/B and never returns another owner’s conversation', async () => {
    const agentId = await newAgent();
    const conversationId = await newConversation(agentId);

    expect(
      await chatRepo.prepareConversationDeletion(db, conversationInput(conversationId, other)),
    ).toBeNull();

    const snapshot = await chatRepo.prepareConversationDeletion(
      db,
      conversationInput(conversationId),
    );
    await db
      .update(conversations)
      .set({ createdBy: other })
      .where(eq(conversations.id, conversationId));
    expect(
      await chatRepo.deleteConversation(db, {
        ...conversationInput(conversationId),
        expected: snapshot!,
      }),
    ).toBe(false);
    expect(await chatRepo.getConversation(db, conversationId)).not.toBeNull();
  });

  it('rejects queued and running conversations during A without closing anything', async () => {
    for (const status of ['queued', 'running'] as const) {
      const agentId = await newAgent();
      const conversationId = await newConversation(agentId);
      await addRun(conversationId, agentId, `sandbox-${status}`, status);

      await expect(
        chatRepo.prepareConversationDeletion(db, conversationInput(conversationId)),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await chatRepo.getConversation(db, conversationId)).not.toBeNull();
      expect(await runCount(conversationId)).toBe(1);
    }
  });

  it('rejects a conversation whose sandbox targets changed between A and B', async () => {
    const agentId = await newAgent();
    const conversationId = await newConversation(agentId);
    await addRun(conversationId, agentId, 'sandbox-a');
    const snapshot = await chatRepo.prepareConversationDeletion(
      db,
      conversationInput(conversationId),
    );

    await addRun(conversationId, agentId, 'sandbox-new');
    await expect(
      chatRepo.deleteConversation(db, {
        ...conversationInput(conversationId),
        expected: snapshot!,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await chatRepo.getConversation(db, conversationId)).not.toBeNull();
    expect(await runCount(conversationId)).toBe(2);
  });
});
