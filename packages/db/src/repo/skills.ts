import { asc, count, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentSkills, skills } from '../schema.js';

export type SkillRow = typeof skills.$inferSelect;

export type SkillWithAgentCount = SkillRow & { agentCount: number };

export interface SkillWrite {
  slug: string;
  name: string;
  description: string;
  body: string;
}

/** 列表附带绑定的智能体数量；分组依据是主键，其余列在 PG 中函数依赖于它。 */
export async function listSkills(db: Database): Promise<SkillWithAgentCount[]> {
  return db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      description: skills.description,
      body: skills.body,
      createdAt: skills.createdAt,
      updatedAt: skills.updatedAt,
      agentCount: count(agentSkills.agentId),
    })
    .from(skills)
    .leftJoin(agentSkills, eq(agentSkills.skillId, skills.id))
    .groupBy(skills.id)
    .orderBy(asc(skills.createdAt), asc(skills.id));
}

export async function getSkill(db: Database, id: string): Promise<SkillRow | null> {
  const [row] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
  return row ?? null;
}

export async function createSkill(db: Database, input: SkillWrite): Promise<SkillRow> {
  const [row] = await db
    .insert(skills)
    .values({ id: newId('skill'), ...input })
    .returning();
  if (!row) throw new Error('skill insert returned no row');
  return row;
}

export async function updateSkill(
  db: Database,
  id: string,
  patch: Partial<SkillWrite>,
): Promise<SkillRow | null> {
  const [row] = await db
    .update(skills)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(skills.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSkill(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id });
  return rows.length > 0;
}
