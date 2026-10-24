import { AppError } from '@agentport/core';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentSkills, skillFiles, skills } from '../schema.js';
import { notStale } from './freshness.js';

export type SkillRow = typeof skills.$inferSelect;

export type SkillWithAgentCount = SkillRow & { agentCount: number };

export interface SkillWrite {
  slug: string;
  name: string;
  description: string;
  body: string;
  sourceId?: string | null;
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
      sourceId: skills.sourceId,
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

export async function getSkillBySourceId(db: Database, sourceId: string): Promise<SkillRow | null> {
  const [row] = await db.select().from(skills).where(eq(skills.sourceId, sourceId)).limit(1);
  return row ?? null;
}

export async function createSkill(db: Database, input: SkillWrite): Promise<SkillRow> {
  const [row] = await db
    .insert(skills)
    .values({ id: newId('skill'), ...input, sourceId: input.sourceId ?? null })
    .returning();
  if (!row) throw new Error('skill insert returned no row');
  return row;
}

/** 市场安装：技能行与资源文件同一事务落库，避免只留下半套技能。 */
export async function createSkillWithFiles(
  db: Database,
  input: SkillWrite,
  files: Array<{ path: string; content: string }>,
): Promise<SkillRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(skills)
      .values({ id: newId('skill'), ...input, sourceId: input.sourceId ?? null })
      .returning();
    if (!row) throw new Error('skill insert returned no row');
    if (files.length > 0) {
      await tx.insert(skillFiles).values(
        files.map((file) => ({
          id: newId('skillFile'),
          skillId: row.id,
          path: file.path,
          content: file.content,
        })),
      );
    }
    return row;
  });
}

export async function updateSkill(
  db: Database,
  id: string,
  patch: Partial<SkillWrite>,
  expectedUpdatedAt?: Date,
): Promise<SkillRow | null> {
  const [row] = await db
    .update(skills)
    .set({
      ...patch,
      // 版本按毫秒比较，同一毫秒内的连续更新也要推进，否则旧 token 仍会命中。
      updatedAt: sql`greatest(now(), date_trunc('milliseconds', ${skills.updatedAt}) + interval '1 millisecond')`,
    })
    .where(
      expectedUpdatedAt === undefined
        ? eq(skills.id, id)
        : and(eq(skills.id, id), notStale(skills.updatedAt, expectedUpdatedAt)),
    )
    .returning();
  // 条件更新落空且行还在 = 并发修改；行没了交给路由返回 404。
  if (!row && expectedUpdatedAt !== undefined && (await getSkill(db, id))) {
    throw new AppError('CONFLICT_STALE', '技能已被修改，请刷新后重试');
  }
  return row ?? null;
}

export async function deleteSkill(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id });
  return rows.length > 0;
}
