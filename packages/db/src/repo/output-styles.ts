import { and, asc, eq } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { agentOutputStyles, agents } from '../schema.js';

export type OutputStyleRow = typeof agentOutputStyles.$inferSelect;

export interface OutputStyleWrite {
  slug: string;
  description: string;
  keepCodingInstructions: boolean;
  body: string;
}

export async function listOutputStyles(db: Database, agentId: string): Promise<OutputStyleRow[]> {
  return db
    .select()
    .from(agentOutputStyles)
    .where(eq(agentOutputStyles.agentId, agentId))
    .orderBy(asc(agentOutputStyles.slug));
}

export async function upsertOutputStyle(
  db: DbHandle,
  agentId: string,
  input: OutputStyleWrite,
): Promise<OutputStyleRow> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('no key update');
    await tx
      .update(agentOutputStyles)
      .set({ isSelected: false })
      .where(eq(agentOutputStyles.agentId, agentId));
    const [row] = await tx
      .insert(agentOutputStyles)
      .values({ id: newId('outputStyle'), agentId, ...input, isSelected: true })
      .onConflictDoUpdate({
        target: [agentOutputStyles.agentId, agentOutputStyles.slug],
        set: {
          description: input.description,
          keepCodingInstructions: input.keepCodingInstructions,
          body: input.body,
          isSelected: true,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('output style upsert returned no row');
    return row;
  });
}

export async function unselectOutputStyle(
  db: DbHandle,
  agentId: string,
  slug: string,
): Promise<boolean> {
  const rows = await db
    .update(agentOutputStyles)
    .set({ isSelected: false, updatedAt: new Date() })
    .where(and(eq(agentOutputStyles.agentId, agentId), eq(agentOutputStyles.slug, slug)))
    .returning({ slug: agentOutputStyles.slug });
  return rows.length > 0;
}

export async function deleteOutputStyle(
  db: DbHandle,
  agentId: string,
  slug: string,
): Promise<boolean> {
  const rows = await db
    .delete(agentOutputStyles)
    .where(and(eq(agentOutputStyles.agentId, agentId), eq(agentOutputStyles.slug, slug)))
    .returning({ slug: agentOutputStyles.slug });
  return rows.length > 0;
}
