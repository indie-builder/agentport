import { conversations, messages, newId } from '../../../packages/db/src/index.js';
import { db, client as sql } from './database.js';

const TIES = new Date('2026-10-22T00:00:00.000Z');
const LATER = new Date('2026-10-22T00:00:01.000Z');

export async function createConversation(agentId: string, count: number, prefix: string) {
  const id = newId('conversation');
  const messageIds = Array.from({ length: count }, () => newId('message')).sort();
  await db.transaction(async (tx) => {
    await tx
      .insert(conversations)
      .values({ id, agentId, title: `E2E ${prefix}`, createdBy: 'bootstrap-admin' });
    await tx.insert(messages).values(
      messageIds.map((messageId, index) => ({
        id: messageId,
        conversationId: id,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: { type: 'text', text: `${prefix}${String(index).padStart(3, '0')}` },
        createdAt: TIES,
      })),
    );
  });
  return { id, messageIds };
}

export async function appendMessages(
  conversationId: string,
  firstIndex: number,
  count: number,
  prefix: string,
): Promise<void> {
  const ids = Array.from({ length: count }, () => newId('message')).sort();
  await db.insert(messages).values(
    ids.map((id, offset) => ({
      id,
      conversationId,
      role: (firstIndex + offset) % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: { type: 'text', text: `${prefix}${String(firstIndex + offset).padStart(3, '0')}` },
      createdAt: LATER,
    })),
  );
}

export async function cleanup(agentId: string, conversationId?: string): Promise<void> {
  await sql`delete from audit_log where target = any(${sql.array(conversationId ? [agentId, conversationId] : [agentId], 'TEXT')})`;
  await sql`delete from agents where id = ${agentId}`;
}
