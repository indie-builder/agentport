import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DbHandle } from '../client.js';
import { newId } from '../id.js';
import { messages, runFeedback } from '../schema.js';

export type RunFeedbackRow = typeof runFeedback.$inferSelect;

export type CreateRunFeedbackInput = Omit<typeof runFeedback.$inferInsert, 'id' | 'createdAt'>;

export async function createRunFeedback(
  db: DbHandle,
  input: CreateRunFeedbackInput,
): Promise<RunFeedbackRow> {
  const [row] = await db
    .insert(runFeedback)
    .values({ id: newId('runFeedback'), ...input })
    .returning();
  if (!row) throw new Error('run feedback insert returned no row');
  return row;
}

export async function listRunFeedback(db: DbHandle, runId: string): Promise<RunFeedbackRow[]> {
  return db
    .select()
    .from(runFeedback)
    .where(eq(runFeedback.runId, runId))
    .orderBy(asc(runFeedback.createdAt), asc(runFeedback.id));
}

export async function getRunFeedback(db: DbHandle, id: string): Promise<RunFeedbackRow | null> {
  const [row] = await db.select().from(runFeedback).where(eq(runFeedback.id, id)).limit(1);
  return row ?? null;
}

export async function setRunFeedbackEvalCase(
  db: DbHandle,
  id: string,
  evalCaseId: string,
): Promise<RunFeedbackRow | null> {
  const [row] = await db
    .update(runFeedback)
    .set({ evalCaseId })
    .where(and(eq(runFeedback.id, id), isNull(runFeedback.evalCaseId)))
    .returning();
  return row ?? null;
}

export async function getRunMessage(
  db: DbHandle,
  runId: string,
  messageId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(eq(messages.id, messageId), eq(messages.runId, runId), eq(messages.role, 'assistant')),
    )
    .limit(1);
  return row ?? null;
}
