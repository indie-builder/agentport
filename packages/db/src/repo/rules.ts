import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentRules } from '../schema.js';

export type AgentRuleRow = typeof agentRules.$inferSelect;

export interface RuleWrite {
  slug: string;
  content: string;
  globs: string;
}

export async function listRules(db: Database, agentId: string): Promise<AgentRuleRow[]> {
  return db
    .select()
    .from(agentRules)
    .where(eq(agentRules.agentId, agentId))
    .orderBy(asc(agentRules.slug));
}

export async function upsertRule(
  db: Database,
  agentId: string,
  input: RuleWrite,
): Promise<AgentRuleRow> {
  const [row] = await db
    .insert(agentRules)
    .values({ id: newId('rule'), agentId, ...input })
    .onConflictDoUpdate({
      target: [agentRules.agentId, agentRules.slug],
      set: { content: input.content, globs: input.globs, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('rule upsert returned no row');
  return row;
}

export async function deleteRule(db: Database, agentId: string, slug: string): Promise<boolean> {
  const rows = await db
    .delete(agentRules)
    .where(and(eq(agentRules.agentId, agentId), eq(agentRules.slug, slug)))
    .returning({ slug: agentRules.slug });
  return rows.length > 0;
}
