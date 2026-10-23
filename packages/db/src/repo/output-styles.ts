import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentOutputStyles } from '../schema.js';

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

export async function getSelectedOutputStyle(
  db: Database,
  agentId: string,
): Promise<OutputStyleRow | null> {
  const [row] = await db
    .select()
    .from(agentOutputStyles)
    .where(and(eq(agentOutputStyles.agentId, agentId), eq(agentOutputStyles.isSelected, true)))
    .limit(1);
  return row ?? null;
}

/** 写入并选中指定风格；同一事务里先把该 agent 的其它风格取消选中。 */
export async function upsertOutputStyle(
  db: Database,
  agentId: string,
  input: OutputStyleWrite,
): Promise<OutputStyleRow> {
  return db.transaction(async (tx) => {
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

/** 取消某个风格的选中（回到默认输出）。 */
export async function unselectOutputStyle(
  db: Database,
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
  db: Database,
  agentId: string,
  slug: string,
): Promise<boolean> {
  const rows = await db
    .delete(agentOutputStyles)
    .where(and(eq(agentOutputStyles.agentId, agentId), eq(agentOutputStyles.slug, slug)))
    .returning({ slug: agentOutputStyles.slug });
  return rows.length > 0;
}
