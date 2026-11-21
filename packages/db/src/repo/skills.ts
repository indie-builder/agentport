import { AppError, fail, type SkillProvenance } from '@agentport/core';
import { findSkillResourcePathConflict, type ResourceAccessFilter } from '@agentport/shared';
import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentSkills, skillFiles, skills } from '../schema.js';
import { resourceScopeWhere } from './access.js';
import { notStale, touchUpdatedAt } from './freshness.js';
import { type CursorPage, keysetPage } from './pagination.js';

export type SkillRow = typeof skills.$inferSelect;

export type SkillWithAgentCount = SkillRow & { agentCount: number };

export function toSkillDefinition(
  row: Pick<
    SkillRow,
    'slug' | 'name' | 'description' | 'body' | 'license' | 'compatibility' | 'metadata'
  >,
): Pick<SkillRow, 'slug' | 'name' | 'description' | 'body'> & SkillProvenance {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: row.body,
    ...(row.license === null ? {} : { license: row.license }),
    ...(row.compatibility === null ? {} : { compatibility: row.compatibility }),
    ...(Object.keys(row.metadata).length === 0 ? {} : { metadata: row.metadata }),
  };
}

export interface SkillWrite {
  slug: string;
  name: string;
  description: string;
  body: string;
  license?: string | null | undefined;
  compatibility?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  sourceId?: string | null;
  ownerBusinessId?: string | null;
  status?: SkillRow['status'];
}

export async function listSkills(
  db: Database,
  options: {
    access?: ResourceAccessFilter | undefined;
    status?: SkillRow['status'] | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): Promise<CursorPage<SkillWithAgentCount> | null> {
  const page = await keysetPage(db, {
    table: skills,
    column: skills.name,
    direction: 'asc',
    limit: options.limit,
    cursor: options.cursor,
    valueCursor: (row: { cursorValue: string }) => row.cursorValue,
    cursorKind: 'text',
    where: [
      options.access === undefined
        ? undefined
        : resourceScopeWhere(options.access, skills.id, skills.ownerBusinessId),
      options.status === undefined ? undefined : eq(skills.status, options.status),
    ],
    load: ({ where, limit }: { where: SQL | undefined; limit: number }) =>
      db
        .select({
          id: skills.id,
          slug: skills.slug,
          name: skills.name,
          description: skills.description,
          body: skills.body,
          license: skills.license,
          compatibility: skills.compatibility,
          metadata: skills.metadata,
          sourceId: skills.sourceId,
          ownerBusinessId: skills.ownerBusinessId,
          status: skills.status,
          submittedAt: skills.submittedAt,
          reviewedAt: skills.reviewedAt,
          reviewedBy: skills.reviewedBy,
          reviewNote: skills.reviewNote,
          createdAt: skills.createdAt,
          updatedAt: skills.updatedAt,
          cursorValue: skills.name,
          agentCount: count(agentSkills.agentId),
        })
        .from(skills)
        .leftJoin(agentSkills, eq(agentSkills.skillId, skills.id))
        .where(where)
        .groupBy(skills.id)
        .orderBy(asc(skills.name), asc(skills.id))
        .limit(limit),
  });
  if (page === null) return null;
  return {
    items: page.items.map(({ cursorValue, ...row }) => row),
    nextCursor: page.nextCursor,
  };
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

export async function createSkillWithFiles(
  db: Database,
  input: SkillWrite,
  files: Array<{ path: string; content: string }>,
): Promise<SkillRow> {
  const conflict = findSkillResourcePathConflict(files.map((file) => file.path));
  if (conflict) {
    fail('INVALID_INPUT', `资源路径「${conflict.path}」与「${conflict.conflictingPath}」冲突`, {
      path: conflict.path,
    });
  }
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
      updatedAt: touchUpdatedAt(skills.updatedAt),
    })
    .where(
      expectedUpdatedAt === undefined
        ? eq(skills.id, id)
        : and(eq(skills.id, id), notStale(skills.updatedAt, expectedUpdatedAt)),
    )
    .returning();
  if (!row && expectedUpdatedAt !== undefined && (await getSkill(db, id))) {
    throw new AppError('CONFLICT_STALE', '技能已被修改，请刷新后重试');
  }
  return row ?? null;
}

export async function submitSkillForReview(db: Database, id: string): Promise<SkillRow | null> {
  const [row] = await db
    .update(skills)
    .set({
      status: 'pending',
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
      updatedAt: touchUpdatedAt(skills.updatedAt),
    })
    .where(and(eq(skills.id, id), inArray(skills.status, ['draft', 'rejected'])))
    .returning();
  return row ?? null;
}

export async function approveSkill(
  db: Database,
  id: string,
  reviewer: string,
): Promise<SkillRow | null> {
  const [row] = await db
    .update(skills)
    .set({
      status: 'published',
      reviewedAt: new Date(),
      reviewedBy: reviewer,
      reviewNote: null,
      updatedAt: touchUpdatedAt(skills.updatedAt),
    })
    .where(and(eq(skills.id, id), eq(skills.status, 'pending')))
    .returning();
  return row ?? null;
}

export async function rejectSkill(
  db: Database,
  id: string,
  reviewer: string,
  note: string,
): Promise<SkillRow | null> {
  const [row] = await db
    .update(skills)
    .set({
      status: 'rejected',
      reviewedAt: new Date(),
      reviewedBy: reviewer,
      reviewNote: note,
      updatedAt: touchUpdatedAt(skills.updatedAt),
    })
    .where(and(eq(skills.id, id), eq(skills.status, 'pending')))
    .returning();
  return row ?? null;
}

export async function deleteSkill(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id });
  return rows.length > 0;
}
