import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import { agentRuns, agents, conversations, messages } from '../schema.js';

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type RunStatus = NonNullable<typeof agentRuns.$inferInsert.status>;

/** 只更新我关心的字段；worker 也可复用。 */
export interface RunPatch {
  status?: RunStatus;
  sessionId?: string | null;
  sandboxId?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  error?: string | null;
  costUsd?: string | null;
  turns?: number | null;
}

// id 由调用方生成（TypeID），db 层只负责持久化。
export async function agentExists(db: Database, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows.length > 0;
}

export async function createConversation(
  db: Database,
  input: { id: string; agentId: string; title: string },
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({ id: input.id, agentId: input.agentId, title: input.title })
    .returning();
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

export async function getConversation(
  db: Database,
  conversationId: string,
): Promise<Conversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

export async function listMessages(db: Database, conversationId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

export async function appendMessage(
  db: Database,
  input: { id: string; conversationId: string; role: string; content: unknown; runId?: string },
): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      runId: input.runId ?? null,
    })
    .returning();
  if (!row) throw new Error('message insert returned no row');
  return row;
}

export async function createRun(
  db: Database,
  input: { id: string; conversationId: string; agentId: string },
): Promise<AgentRun> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      agentId: input.agentId,
      status: 'queued',
    })
    .returning();
  if (!row) throw new Error('agent run insert returned no row');
  return row;
}

export async function getRun(db: Database, runId: string): Promise<AgentRun | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return row ?? null;
}

export async function updateRun(
  db: Database,
  runId: string,
  patch: RunPatch,
): Promise<AgentRun | null> {
  if (Object.keys(patch).length === 0) return getRun(db, runId);
  const [row] = await db.update(agentRuns).set(patch).where(eq(agentRuns.id, runId)).returning();
  return row ?? null;
}

/** 已结束的 run 不能被取消覆盖。 */
export async function cancelRun(db: Database, runId: string): Promise<AgentRun | null> {
  const [row] = await db
    .update(agentRuns)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['queued', 'running'])))
    .returning();
  return row ?? null;
}
