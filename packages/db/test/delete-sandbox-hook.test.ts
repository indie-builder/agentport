import type { AccessFilter, AccessScope } from '@agentport/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import * as agentsRepo from '../src/repo/agents.js';
import * as chatRepo from '../src/repo/chat.js';
import { agentRuns, agents, conversations } from '../src/schema.js';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const owner = 'delete-hook-owner';
const other = 'delete-hook-other';
const createdAgents: string[] = [];

function filter(scopes: AccessScope[], businessId = owner): AccessFilter {
  return { businessId, scopes };
}

function agentInput(id: string) {
  return {
    id,
    access: filter(['owned_agents']),
    readAccess: filter(['owned_agents']),
  };
}

function conversationInput(id: string, businessId = owner) {
  return { id, access: filter(['own_data'], businessId) };
}

async function newAgent(parentId: string | null = null): Promise<string> {
  const id = newId('agent');
  createdAgents.push(id);
  await db.insert(agents).values({
    id,
    slug: `delete-hook-${id.slice(4)}`,
    name: 'delete hook',
    model: 'test',
    createdBy: owner,
    ownerBusinessId: owner,
    parentId,
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
  await pool.end();
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
    expect(snapshot).toEqual({
      id: conversationId,
      agentId,
      agentSlug: (await agentsRepo.getAgent(db, agentId))?.slug,
      createdBy: owner,
      targets: [{ conversationId, sandboxIds: ['sandbox-a', 'sandbox-b'] }],
    });
    // tx A 已提交：事务外等待关闭确认期间实体必须仍可见。
    expect(await chatRepo.getConversation(db, conversationId)).not.toBeNull();

    expect(
      await chatRepo.deleteConversation(db, {
        ...conversationInput(conversationId),
        expected: snapshot!,
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

  it('snapshots an agent’s own conversations and affected delegation scope', async () => {
    const child = await newAgent();
    const parent = await newAgent();
    await db.update(agents).set({ parentId: parent }).where(eq(agents.id, child));
    const first = await newConversation(parent);
    const second = await newConversation(parent);
    const childConversation = await newConversation(child);
    const unrelated = await newAgent();
    const untouched = await newConversation(unrelated);
    await addRun(second, parent, 'sandbox-2');
    await addRun(first, parent, 'sandbox-1');
    await addRun(childConversation, child, 'sandbox-child');
    await addRun(untouched, unrelated, 'sandbox-other');

    const snapshot = await agentsRepo.prepareAgentDeletion(db, agentInput(parent));
    const sorted = [first, second].sort();
    expect(snapshot).toEqual({
      id: parent,
      slug: (await agentsRepo.getAgent(db, parent))?.slug,
      ownerBusinessId: owner,
      parentId: null,
      enabled: true,
      childIds: [child],
      affectedAgentIds: [parent, child].sort(),
      targets: [
        {
          conversationId: sorted[0],
          sandboxIds: sorted[0] === first ? ['sandbox-1'] : ['sandbox-2'],
        },
        {
          conversationId: sorted[1],
          sandboxIds: sorted[1] === first ? ['sandbox-1'] : ['sandbox-2'],
        },
      ],
    });
    expect(await agentsRepo.getAgent(db, parent)).not.toBeNull();

    expect(await agentsRepo.deleteAgent(db, { ...agentInput(parent), expected: snapshot! })).toBe(
      true,
    );
    expect(await agentsRepo.getAgent(db, parent)).toBeNull();
    expect(await repoChild(child)).toMatchObject({ id: child, parentId: null });
    expect(await chatRepo.getConversation(db, childConversation)).not.toBeNull();
    expect(await chatRepo.getConversation(db, untouched)).not.toBeNull();
  });

  async function repoChild(childId: string) {
    return (await agentsRepo.getAgent(db, childId)) ?? null;
  }

  it('rejects an agent when a conversation was added between A and B', async () => {
    const agentId = await newAgent();
    const first = await newConversation(agentId);
    await addRun(first, agentId, 'sandbox-1');
    const snapshot = await agentsRepo.prepareAgentDeletion(db, agentInput(agentId));

    const second = await newConversation(agentId);
    await expect(
      agentsRepo.deleteAgent(db, { ...agentInput(agentId), expected: snapshot! }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await agentsRepo.getAgent(db, agentId)).not.toBeNull();
    expect(await chatRepo.getConversation(db, first)).not.toBeNull();
    expect(await chatRepo.getConversation(db, second)).not.toBeNull();
  });

  it('rejects an agent when a child or owner/parent changes between A and B', async () => {
    const parent = await newAgent();
    const snapshot = await agentsRepo.prepareAgentDeletion(db, agentInput(parent));

    const lateChild = await newAgent();
    await db.update(agents).set({ parentId: parent }).where(eq(agents.id, lateChild));
    await expect(
      agentsRepo.deleteAgent(db, { ...agentInput(parent), expected: snapshot! }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await agentsRepo.getAgent(db, parent)).not.toBeNull();

    await db.update(agents).set({ parentId: null }).where(eq(agents.id, lateChild));
    const parentSnapshot = await agentsRepo.prepareAgentDeletion(db, agentInput(parent));
    await db.update(agents).set({ parentId: null }).where(eq(agents.id, lateChild));
    const newParent = await newAgent();
    await db.update(agents).set({ parentId: newParent }).where(eq(agents.id, parent));
    await expect(
      agentsRepo.deleteAgent(db, { ...agentInput(parent), expected: parentSnapshot! }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await db.update(agents).set({ parentId: null }).where(eq(agents.id, parent));
    const owned = await agentsRepo.prepareAgentDeletion(db, agentInput(parent));
    await db.update(agents).set({ ownerBusinessId: other }).where(eq(agents.id, parent));
    expect(await agentsRepo.deleteAgent(db, { ...agentInput(parent), expected: owned! })).toBe(
      false,
    );
    expect(await agentsRepo.getAgent(db, parent)).not.toBeNull();
  });

  it('rejects an agent whose run became active between A and B', async () => {
    const agentId = await newAgent();
    const conversationId = await newConversation(agentId);
    const snapshot = await agentsRepo.prepareAgentDeletion(db, agentInput(agentId));
    await addRun(conversationId, agentId, 'sandbox-live', 'queued');

    await expect(
      agentsRepo.deleteAgent(db, { ...agentInput(agentId), expected: snapshot! }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await agentsRepo.getAgent(db, agentId)).not.toBeNull();
    expect(await runCount(conversationId)).toBe(1);
  });

  it('requires both delete and read scope for the agent entity', async () => {
    const agentId = await newAgent();
    expect(
      await agentsRepo.prepareAgentDeletion(db, {
        id: agentId,
        access: filter(['owned_agents']),
        readAccess: filter(['authorized_agents'], other),
      }),
    ).toBeNull();
    expect(
      await agentsRepo.prepareAgentDeletion(db, {
        id: agentId,
        access: filter(['authorized_agents']),
        readAccess: filter(['authorized_agents']),
      }),
    ).toBeNull();
  });
});
