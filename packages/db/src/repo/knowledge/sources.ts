import { AppError, KNOWLEDGE_SOURCE_NOT_FOUND_MESSAGE } from '@agentport/core';
import { asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../client.js';
import { newId } from '../../id.js';
import {
  knowledgeDocumentSourceRanges,
  knowledgeDocuments,
  knowledgeSourceRanges,
  knowledgeSources,
} from '../../schema.js';
import { keysetPage } from '../pagination.js';
import {
  clampDocumentTitle,
  disableDocumentsBySourceTx,
  type KnowledgeDocumentRow,
  type KnowledgeSourceRangeRow,
  type KnowledgeSourceRow,
  markWikiStaleByDocumentsTx,
  type Page,
  type PageOptions,
  pageLimit,
  type SourceDocumentPatch,
  type SourceReadSnapshot,
  sourceSnapshotMatchesTx,
} from './shared.js';

export async function getSourceReadSnapshot(
  db: Database,
  sourceId: string,
): Promise<{ source: KnowledgeSourceRow; snapshot: SourceReadSnapshot } | null> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .for('share');
    if (!source) return null;
    const ranges = await tx
      .select({
        id: knowledgeSourceRanges.id,
        kind: knowledgeSourceRanges.kind,
        externalId: knowledgeSourceRanges.externalId,
        ref: knowledgeSourceRanges.ref,
        paths: knowledgeSourceRanges.paths,
        enabled: knowledgeSourceRanges.enabled,
      })
      .from(knowledgeSourceRanges)
      .where(eq(knowledgeSourceRanges.sourceId, sourceId))
      .orderBy(asc(knowledgeSourceRanges.id));
    return {
      source,
      snapshot: {
        sourceId: source.id,
        baseId: source.baseId,
        type: source.type,
        config: source.config,
        secretsEncrypted: source.secretsEncrypted,
        ranges,
      },
    };
  });
}
function rangeCoversSourcePath(
  range: Pick<KnowledgeSourceRangeRow, 'paths'>,
  sourcePath: string | null,
): boolean {
  if (range.paths.length === 0) return true;
  if (sourcePath === null) return false;
  return range.paths.some((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`));
}

export interface CreateSourceInput {
  baseId: string;
  type: KnowledgeSourceRow['type'];
  name: string;
  config: Record<string, unknown>;
  secretsEncrypted: string | null;
  syncCron: string | null;
  ranges: RangeInput[];
}

export async function createSource(
  db: Database,
  input: CreateSourceInput,
): Promise<{ source: KnowledgeSourceRow; ranges: KnowledgeSourceRangeRow[] }> {
  const { ranges, ...fields } = input;
  return db.transaction(async (tx) => {
    const [source] = await tx
      .insert(knowledgeSources)
      .values({ id: newId('knowledgeSource'), ...fields })
      .returning();
    if (!source) throw new Error('knowledge source insert returned no row');
    return { source, ranges: await replaceRangesTx(tx, source.id, ranges) };
  });
}

export async function getSource(db: Database, id: string): Promise<KnowledgeSourceRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, id))
    .limit(1);
  return row ?? null;
}

export async function listSources(
  db: Database,
  baseId: string,
  options: PageOptions = {},
): Promise<Page<KnowledgeSourceRow> | null> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeSources.baseId, baseId)];
  return keysetPage(db, {
    table: knowledgeSources,
    cursor: options.cursor,
    limit,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select()
        .from(knowledgeSources)
        .where(where)
        .orderBy(desc(knowledgeSources.createdAt), desc(knowledgeSources.id))
        .limit(limit),
  });
}

export interface SourcePatch {
  name?: string | undefined;
  config?: Record<string, unknown> | undefined;
  secretsEncrypted?: string | null | undefined;
  status?: KnowledgeSourceRow['status'] | undefined;
  syncCron?: string | null | undefined;
  cursor?: Record<string, unknown> | undefined;
  lastSyncAt?: Date | null | undefined;
  lastSyncStatus?: string | null | undefined;
  lastError?: string | null | undefined;
}

export async function updateSource(
  db: Database,
  id: string,
  patch: SourcePatch,
): Promise<KnowledgeSourceRow | null> {
  const [row] = await db
    .update(knowledgeSources)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeSources.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSource(
  db: Database,
  id: string,
  documents: 'keep' | 'delete',
): Promise<{ documents: 'keep' | 'delete'; affected: number } | null> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, id))
      .for('update');
    if (!source) return null;
    const rows = await tx
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceConnectionId, id))
      .orderBy(asc(knowledgeDocuments.id))
      .for('update');
    const affectedRows = documents === 'keep' ? await disableDocumentsBySourceTx(tx, id) : rows;
    const documentIds = affectedRows.map((row) => row.id);
    await markWikiStaleByDocumentsTx(tx, documentIds);
    if (documents === 'delete' && documentIds.length > 0) {
      await tx.delete(knowledgeDocuments).where(inArray(knowledgeDocuments.id, documentIds));
    }
    await tx.delete(knowledgeSources).where(eq(knowledgeSources.id, id));
    return { documents, affected: affectedRows.length };
  });
}

export interface RangeInput {
  kind: KnowledgeSourceRangeRow['kind'];
  externalId: string;
  ref: string | null;
  paths: string[];
  enabled: boolean;
}

function rangeKey(range: { kind: string; externalId: string; ref: string | null }): string {
  return `${range.kind}\u0000${range.externalId}\u0000${range.ref ?? ''}`;
}

async function pruneSourceRangeMemberships(tx: Transaction, sourceId: string): Promise<void> {
  await tx.execute(sql`
    delete from knowledge_document_source_ranges dsr
    using knowledge_source_ranges r, knowledge_documents d
    where dsr.range_id = r.id
      and dsr.document_id = d.id
      and r.source_id = ${sourceId}
      and (
        d.source_connection_id is distinct from ${sourceId}
        or not (
          r.enabled
          and (
            jsonb_array_length(r.paths) = 0
            or (
              d.source_path is not null
              and exists (
                select 1 from jsonb_array_elements_text(r.paths) p
                where d.source_path = p or left(d.source_path, char_length(p) + 1) = p || '/'
              )
            )
          )
        )
      )
  `);
}

async function replaceRangesTx(
  tx: Transaction,
  sourceId: string,
  ranges: RangeInput[],
): Promise<KnowledgeSourceRangeRow[]> {
  const existing = await tx
    .select()
    .from(knowledgeSourceRanges)
    .where(eq(knowledgeSourceRanges.sourceId, sourceId))
    .for('update');
  const byKey = new Map(existing.map((row) => [rangeKey(row), row]));
  const seen = new Set<string>();
  const keepIds = new Set<string>();
  const rows: KnowledgeSourceRangeRow[] = [];
  for (const range of ranges) {
    const key = rangeKey(range);
    if (seen.has(key)) throw new AppError('CONFLICT', '存在重复的来源范围');
    seen.add(key);
    const current = byKey.get(key);
    if (current) {
      const [updated] = await tx
        .update(knowledgeSourceRanges)
        .set({ paths: range.paths, enabled: range.enabled })
        .where(eq(knowledgeSourceRanges.id, current.id))
        .returning();
      if (!updated) throw new Error('knowledge source range update returned no row');
      rows.push(updated);
      keepIds.add(updated.id);
    } else {
      const [inserted] = await tx
        .insert(knowledgeSourceRanges)
        .values({ id: newId('knowledgeSourceRange'), sourceId, ...range })
        .returning();
      if (!inserted) throw new Error('knowledge source range insert returned no row');
      rows.push(inserted);
      keepIds.add(inserted.id);
    }
  }
  const removed = existing.filter((row) => !keepIds.has(row.id)).map((row) => row.id);
  if (removed.length > 0) {
    await tx.delete(knowledgeSourceRanges).where(inArray(knowledgeSourceRanges.id, removed));
  }
  await pruneSourceRangeMemberships(tx, sourceId);
  return rows;
}

export async function replaceRanges(
  db: Database,
  sourceId: string,
  ranges: RangeInput[],
): Promise<KnowledgeSourceRangeRow[]> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .for('update');
    if (!source) throw new AppError('NOT_FOUND', KNOWLEDGE_SOURCE_NOT_FOUND_MESSAGE);
    return replaceRangesTx(tx, sourceId, ranges);
  });
}

export async function listRanges(
  db: Database,
  sourceId: string,
): Promise<KnowledgeSourceRangeRow[]> {
  return db
    .select()
    .from(knowledgeSourceRanges)
    .where(eq(knowledgeSourceRanges.sourceId, sourceId))
    .orderBy(asc(knowledgeSourceRanges.id));
}

export async function listRangesBySourceIds(
  db: Database,
  sourceIds: string[],
): Promise<Map<string, KnowledgeSourceRangeRow[]>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(knowledgeSourceRanges)
    .where(inArray(knowledgeSourceRanges.sourceId, sourceIds))
    .orderBy(asc(knowledgeSourceRanges.sourceId), asc(knowledgeSourceRanges.id));
  return Map.groupBy(rows, (row) => row.sourceId);
}

export interface SourceScopePatch {
  name?: string | undefined;
  config?: Record<string, unknown> | undefined;
  secretsEncrypted?: string | null | undefined;
  status?: KnowledgeSourceRow['status'] | undefined;
  syncCron?: string | null | undefined;
  ranges?: RangeInput[] | undefined;
}

export interface SourceScopeResult {
  source: KnowledgeSourceRow;
  ranges: KnowledgeSourceRangeRow[];
  disabledDocumentIds: string[];
}

export async function replaceSourceScope(
  db: Database,
  sourceId: string,
  patch: SourceScopePatch,
): Promise<SourceScopeResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .for('update');
    if (!current) throw new AppError('NOT_FOUND', KNOWLEDGE_SOURCE_NOT_FOUND_MESSAGE);

    const fields: Partial<KnowledgeSourceRow> = { updatedAt: new Date() };
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.config !== undefined) fields.config = patch.config;
    if (patch.secretsEncrypted !== undefined) fields.secretsEncrypted = patch.secretsEncrypted;
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.syncCron !== undefined) fields.syncCron = patch.syncCron;
    const [source] = await tx
      .update(knowledgeSources)
      .set(fields)
      .where(eq(knowledgeSources.id, sourceId))
      .returning();
    if (!source) throw new Error('knowledge source update returned no row');

    const ranges =
      patch.ranges === undefined
        ? await tx
            .select()
            .from(knowledgeSourceRanges)
            .where(eq(knowledgeSourceRanges.sourceId, sourceId))
            .orderBy(asc(knowledgeSourceRanges.id))
        : await replaceRangesTx(tx, sourceId, patch.ranges);

    const documents = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceConnectionId, sourceId))
      .orderBy(asc(knowledgeDocuments.id))
      .for('update');
    const covered = await tx.execute<{ id: string }>(sql`
      select distinct dsr.document_id as id
      from knowledge_document_source_ranges dsr
      join knowledge_source_ranges r on r.id = dsr.range_id
      join knowledge_documents d on d.id = dsr.document_id
      where r.source_id = ${sourceId}
        and d.source_connection_id = ${sourceId}
        and r.enabled
        and (
          jsonb_array_length(r.paths) = 0
          or (
            d.source_path is not null
            and exists (
              select 1 from jsonb_array_elements_text(r.paths) p
              where d.source_path = p or left(d.source_path, char_length(p) + 1) = p || '/'
            )
          )
        )
    `);
    const coveredIds = new Set(covered.map((row) => row.id));
    const statusAllowsRead = source.status === 'active' || source.status === 'paused';
    const reason: Exclude<KnowledgeDocumentRow['disabledReason'], null> =
      source.status === 'disabled' ? 'source' : source.status === 'auth_error' ? 'remote' : 'range';
    const disabledDocumentIds: string[] = [];
    for (const document of documents) {
      if (statusAllowsRead && coveredIds.has(document.id)) continue;
      await tx
        .update(knowledgeDocuments)
        .set({
          status: 'disabled',
          disabledReason: document.disabledReason === 'manual' ? 'manual' : reason,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, document.id));
      disabledDocumentIds.push(document.id);
    }
    await markWikiStaleByDocumentsTx(tx, disabledDocumentIds);
    return { source, ranges, disabledDocumentIds };
  });
}

export async function setDocumentSourceRanges(
  db: Database,
  documentId: string,
  rangeIds: string[],
  snapshot: SourceReadSnapshot,
  patch: SourceDocumentPatch,
): Promise<KnowledgeDocumentRow | null> {
  const unique = [...new Set(rangeIds)];
  return db.transaction(async (tx) => {
    if (!(await sourceSnapshotMatchesTx(tx, snapshot))) return null;
    const [document] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .for('update');
    if (
      !document ||
      document.baseId !== snapshot.baseId ||
      document.sourceConnectionId !== snapshot.sourceId
    ) {
      return null;
    }
    const selected: SourceReadSnapshot['ranges'] = [];
    for (const rangeId of unique) {
      const range = snapshot.ranges.find((entry) => entry.id === rangeId);
      if (!range?.enabled) {
        throw new AppError('INVALID_INPUT', '范围不属于该来源的当前快照');
      }
      selected.push(range);
    }
    if (!selected.some((range) => rangeCoversSourcePath(range, patch.sourcePath))) {
      throw new AppError('INVALID_INPUT', '来源范围未覆盖条目路径');
    }
    const manualDisabled = document.disabledReason === 'manual';
    const [row] = await tx
      .update(knowledgeDocuments)
      .set({
        title: clampDocumentTitle(patch.title),
        sourceUrl: patch.sourceUrl,
        sourcePath: patch.sourcePath,
        mimeType: patch.mimeType,
        sizeBytes: patch.sizeBytes,
        metadata: patch.metadata,
        lastSyncedAt: new Date(),
        ...(manualDisabled
          ? {}
          : {
              status: document.currentVersionId ? ('ready' as const) : ('processing' as const),
              disabledReason: null,
            }),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, documentId))
      .returning();
    await tx
      .delete(knowledgeDocumentSourceRanges)
      .where(eq(knowledgeDocumentSourceRanges.documentId, documentId));
    await tx
      .insert(knowledgeDocumentSourceRanges)
      .values(unique.map((rangeId) => ({ documentId, rangeId })));
    return row ?? null;
  });
}
