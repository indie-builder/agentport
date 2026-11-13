import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import { knowledgeDocumentTags, knowledgeTags } from '../../schema.js';
import { INSERT_CHUNK, type KnowledgeTagRow } from './shared.js';

export async function findTagByName(
  db: Database,
  baseId: string,
  name: string,
): Promise<KnowledgeTagRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeTags)
    .where(and(eq(knowledgeTags.baseId, baseId), eq(knowledgeTags.name, name)))
    .limit(1);
  return row ?? null;
}

export async function upsertTag(
  db: Database,
  baseId: string,
  name: string,
): Promise<KnowledgeTagRow> {
  const [row] = await db
    .insert(knowledgeTags)
    .values({ id: newId('knowledgeTag'), baseId, name })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(knowledgeTags)
    .where(and(eq(knowledgeTags.baseId, baseId), eq(knowledgeTags.name, name)))
    .limit(1);
  if (!existing) throw new Error('knowledge tag upsert lost its row');
  return existing;
}

export async function upsertTags(
  db: DbHandle,
  baseId: string,
  names: string[],
): Promise<KnowledgeTagRow[]> {
  if (names.length === 0) return [];
  const unique = [...new Set(names)];
  const rows: KnowledgeTagRow[] = [];
  for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
    rows.push(
      ...(await db
        .insert(knowledgeTags)
        .values(
          unique
            .slice(i, i + INSERT_CHUNK)
            .map((name) => ({ id: newId('knowledgeTag'), baseId, name })),
        )
        .onConflictDoNothing()
        .returning()),
    );
  }
  const returned = new Set(rows.map((row) => row.name));
  const missing = unique.filter((name) => !returned.has(name));
  if (missing.length > 0) {
    rows.push(
      ...(await db
        .select()
        .from(knowledgeTags)
        .where(and(eq(knowledgeTags.baseId, baseId), inArray(knowledgeTags.name, missing)))),
    );
  }
  const byName = new Map(rows.map((row) => [row.name, row]));
  return unique.map((name) => {
    const row = byName.get(name);
    if (!row) throw new Error('knowledge tag upsert lost its row');
    return row;
  });
}

export async function listTags(db: Database, baseId: string): Promise<KnowledgeTagRow[]> {
  return db
    .select()
    .from(knowledgeTags)
    .where(eq(knowledgeTags.baseId, baseId))
    .orderBy(asc(knowledgeTags.name));
}

export async function updateTag(
  db: Database,
  id: string,
  name: string,
): Promise<KnowledgeTagRow | null> {
  const [row] = await db
    .update(knowledgeTags)
    .set({ name })
    .where(eq(knowledgeTags.id, id))
    .returning();
  return row ?? null;
}

export async function deleteTag(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(knowledgeTags)
    .where(eq(knowledgeTags.id, id))
    .returning({ id: knowledgeTags.id });
  return rows.length > 0;
}

export async function setDocumentTags(
  db: Database,
  documentId: string,
  tagIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(knowledgeDocumentTags).where(eq(knowledgeDocumentTags.documentId, documentId));
    if (tagIds.length > 0) {
      await tx.insert(knowledgeDocumentTags).values(tagIds.map((tagId) => ({ documentId, tagId })));
    }
  });
}

export async function getDocumentTagNames(
  db: Database,
  documentIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>(documentIds.map((id) => [id, []]));
  if (documentIds.length === 0) return result;
  const rows = await db
    .select({ documentId: knowledgeDocumentTags.documentId, name: knowledgeTags.name })
    .from(knowledgeDocumentTags)
    .innerJoin(knowledgeTags, eq(knowledgeTags.id, knowledgeDocumentTags.tagId))
    .where(inArray(knowledgeDocumentTags.documentId, documentIds))
    .orderBy(asc(knowledgeTags.name));
  for (const row of rows) result.get(row.documentId)?.push(row.name);
  return result;
}
