import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import * as chat from '../src/repo/chat.js';
import * as maintenance from '../src/repo/maintenance.js';
import { agents } from '../src/schema.js';

// pruneRuns/pruneOrphanMessages 是全库操作：与其它套件共用库时会互相删掉对方的数据。
const isolated = await createIsolatedDatabase('db_attach', process.env.DATABASE_URL ?? '');
const { db, pool } = createDb(isolated?.url ?? process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);
if (!(ready && isolated)) await isolated?.close();

const agentIds: string[] = [];

async function newAgent(): Promise<string> {
  const id = newId('agent');
  agentIds.push(id);
  await db.insert(agents).values({
    id,
    slug: `attach-repo-${id.slice(4)}`,
    name: 'attach-repo',
    model: 'test',
  });
  return id;
}

const attachment = (filename = 'notes.md') => ({
  id: randomUUID(),
  filename,
  mimeType: 'text/markdown' as const,
  size: 5,
  sha256: 'a'.repeat(64),
});

const old = (): Date => new Date(Date.now() - 36_501 * 86_400_000);

describe.skipIf(!(ready && isolated))('conversation attachment queries', () => {
  afterAll(async () => {
    try {
      for (const agentId of agentIds) {
        await db.delete(agents).where(eq(agents.id, agentId));
      }
      await pool.end();
    } finally {
      await isolated?.close();
    }
  });

  it('finds an attachment only inside the conversation that references it', async () => {
    const agentId = await newAgent();
    const source = newId('conversation');
    const other = newId('conversation');
    await chat.createConversation(db, { id: source, agentId, title: 'source' });
    await chat.createConversation(db, { id: other, agentId, title: 'other' });
    const metadata = attachment();
    await chat.appendMessage(db, {
      id: newId('message'),
      conversationId: source,
      role: 'user',
      content: { type: 'text', text: 'has file', attachments: [metadata] },
    });

    expect(await chat.findConversationAttachment(db, source, metadata.id)).toEqual(metadata);
    expect(await chat.findConversationAttachment(db, other, metadata.id)).toBeNull();
    expect(await chat.findConversationAttachment(db, source, randomUUID())).toBeNull();
  });

  it('dedupes attachment ids across messages and ignores malformed metadata', async () => {
    const agentId = await newAgent();
    const conversationId = newId('conversation');
    await chat.createConversation(db, { id: conversationId, agentId, title: 'ids' });
    const shared = attachment('shared.txt');
    const onlyOne = attachment('one.txt');
    const first = newId('message');
    const second = newId('message');
    await chat.insertMessages(db, [
      {
        id: first,
        conversationId,
        role: 'user',
        content: { type: 'text', text: 'a', attachments: [shared, onlyOne] },
      },
      {
        id: second,
        conversationId,
        role: 'user',
        content: { type: 'text', text: 'b', attachments: [shared] },
      },
      {
        id: newId('message'),
        conversationId,
        role: 'assistant',
        content: { type: 'text', text: 'no attachments' },
      },
    ]);

    expect(await chat.attachmentIdsForMessages(db, [first, second])).toEqual([
      shared.id,
      onlyOne.id,
    ]);
    expect(await chat.attachmentIdsForMessages(db, [])).toEqual([]);
  });

  it('prunes runs but keeps attachment messages and still resolves them', async () => {
    const agentId = await newAgent();
    const conversationId = newId('conversation');
    const runId = newId('run');
    await chat.createConversation(db, { id: conversationId, agentId, title: 'prune runs' });
    await chat.createRun(db, { id: runId, conversationId, agentId });
    await chat.updateRun(db, runId, { status: 'succeeded', endedAt: old() });
    const metadata = attachment();
    const kept = newId('message');
    await chat.insertMessages(db, [
      {
        id: kept,
        conversationId,
        runId,
        role: 'user',
        content: { type: 'text', text: 'keep', attachments: [metadata] },
        createdAt: old(),
      },
      {
        id: newId('message'),
        conversationId,
        runId,
        role: 'user',
        content: { type: 'text', text: 'drop plain' },
        createdAt: old(),
      },
      {
        id: newId('message'),
        conversationId,
        runId,
        role: 'assistant',
        content: { type: 'text', text: 'drop answer' },
        createdAt: old(),
      },
    ]);

    const pruned = await maintenance.pruneRuns(db, 36_500);
    expect(pruned).toEqual({ runs: 1, messages: 2 });

    const rows = await chat.listMessages(db, conversationId);
    expect(rows.map((row) => row.id)).toEqual([kept]);
    expect(rows[0]?.runId).toBeNull();
    expect(await chat.findConversationAttachment(db, conversationId, metadata.id)).toEqual(
      metadata,
    );
  });

  it('detaches published anchor messages before deleting their run', async () => {
    const agentId = await newAgent();
    const conversationId = newId('conversation');
    const runId = newId('run');
    await chat.createConversation(db, { id: conversationId, agentId, title: 'retained anchors' });
    await chat.createRun(db, { id: runId, conversationId, agentId });
    await chat.updateRun(db, runId, { status: 'succeeded', endedAt: old() });
    const user = newId('message');
    const after = newId('message');
    await chat.insertMessages(db, [
      {
        id: user,
        conversationId,
        runId,
        role: 'user',
        content: { type: 'text', text: 'anchor user' },
        createdAt: old(),
      },
      {
        id: after,
        conversationId,
        runId,
        role: 'assistant',
        content: { type: 'text', text: 'anchor after' },
        createdAt: old(),
      },
    ]);

    expect(await maintenance.pruneRuns(db, 36_500, { retainedMessageIds: [user, after] })).toEqual({
      runs: 1,
      messages: 0,
    });
    const rows = await chat.listMessages(db, conversationId);
    expect(rows.map((row) => [row.id, row.runId])).toEqual([
      [user, null],
      [after, null],
    ]);
    await pool.query('delete from conversations where id = $1', [conversationId]);
  });

  it('never deletes orphan messages that reference attachments', async () => {
    const agentId = await newAgent();
    const conversationId = newId('conversation');
    await chat.createConversation(db, { id: conversationId, agentId, title: 'orphans' });
    const metadata = attachment();
    const kept = newId('message');
    await chat.insertMessages(db, [
      {
        id: kept,
        conversationId,
        role: 'user',
        content: { type: 'text', text: 'keep orphan', attachments: [metadata] },
        createdAt: old(),
      },
      {
        id: newId('message'),
        conversationId,
        role: 'user',
        content: { type: 'text', text: 'delete orphan' },
        createdAt: old(),
      },
    ]);

    expect(await maintenance.pruneOrphanMessages(db, 36_500)).toBe(1);
    const rows = await chat.listMessages(db, conversationId);
    expect(rows.map((row) => row.id)).toEqual([kept]);
    expect(await chat.findConversationAttachment(db, conversationId, metadata.id)).toEqual(
      metadata,
    );
  });
});
