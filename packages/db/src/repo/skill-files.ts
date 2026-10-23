import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { skillFiles } from '../schema.js';

export type SkillFileRow = typeof skillFiles.$inferSelect;

export async function listSkillFiles(db: Database, skillId: string): Promise<SkillFileRow[]> {
  return db
    .select()
    .from(skillFiles)
    .where(eq(skillFiles.skillId, skillId))
    .orderBy(asc(skillFiles.path), asc(skillFiles.id));
}

/** 批量取多个技能的资源文件（worker 一次运行要给所有已绑定技能铺文件）。 */
export async function getSkillFilesBySkillIds(
  db: Database,
  skillIds: string[],
): Promise<Map<string, SkillFileRow[]>> {
  const map = new Map<string, SkillFileRow[]>();
  if (skillIds.length === 0) return map;
  const rows = await db
    .select()
    .from(skillFiles)
    .where(inArray(skillFiles.skillId, skillIds))
    .orderBy(asc(skillFiles.path), asc(skillFiles.id));
  for (const row of rows) {
    const list = map.get(row.skillId) ?? [];
    list.push(row);
    map.set(row.skillId, list);
  }
  return map;
}

/** 写入或覆盖同路径资源文件（唯一键 skill_id+path）。 */
export async function upsertSkillFile(
  db: Database,
  skillId: string,
  path: string,
  content: string,
): Promise<SkillFileRow> {
  const [row] = await db
    .insert(skillFiles)
    .values({ id: newId('skillFile'), skillId, path, content })
    .onConflictDoUpdate({
      target: [skillFiles.skillId, skillFiles.path],
      set: { content },
    })
    .returning();
  if (!row) throw new Error('skill file upsert returned no row');
  return row;
}

export async function deleteSkillFile(
  db: Database,
  skillId: string,
  path: string,
): Promise<boolean> {
  const rows = await db
    .delete(skillFiles)
    .where(and(eq(skillFiles.skillId, skillId), eq(skillFiles.path, path)))
    .returning({ id: skillFiles.id });
  return rows.length > 0;
}
