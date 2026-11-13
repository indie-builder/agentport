import { AppError } from '@agentport/core';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database, Transaction } from '../../client.js';
import { newId } from '../../id.js';
import {
  knowledgeDocumentSourceRanges,
  knowledgeDocuments,
  knowledgeSourceRanges,
  knowledgeSources,
} from '../../schema.js';
import { paginate } from '../keyset.js';
import {
  type KnowledgeDocumentRow,
  type KnowledgeSourceRangeRow,
  type KnowledgeSourceRow,
  type Page,
  type PageOptions,
  type SourceDocumentPatch,
  type SourceReadSnapshot,
  disableDocumentsBySourceTx,
  markWikiStaleByDocumentsTx,
  pageLimit,
  sourceSnapshotMatchesTx,
} from './shared.js';

/** 读来源授权快照：source FOR SHARE 后再读全部范围，调用方只消费这一份一致视图。 */
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
// ---------------------------------------------------------------------------
// 外部来源 / 同步

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
): Promise<Page<KnowledgeSourceRow>> {
  const limit = pageLimit(options);
  const filters: SQL[] = [eq(knowledgeSources.baseId, baseId)];
  if (options.cursor) {
    filters.push(sql`(${knowledgeSources.createdAt}, ${knowledgeSources.id}) < (
      select b.created_at, b.id from ${knowledgeSources} b where b.id = ${options.cursor}
    )`);
  }
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(and(...filters))
    .orderBy(desc(knowledgeSources.createdAt), desc(knowledgeSources.id))
    .limit(limit + 1);
  return paginate(rows, limit);
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

/** 范围删除/停用/路径收缩后，移除不再被任何有效范围覆盖的条目归属。 */
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

/**
 * 按 (sourceId, kind, externalId, ref) 保留范围 ID 更新；删除失效项并按新 paths 重核条目归属。
 * 范围收缩的撤权由 replaceSourceScope 统一完成。
 */
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
    if (!source) throw new AppError('NOT_FOUND', '来源不存在，可能已被删除');
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

/**
 * 同一事务内改来源配置/范围并立即撤权：
 * 移除失效归属，停用所有已无有效范围覆盖的文档（含 pending/processing/failed），
 * 并让引用它们的 Wiki 页显式 stale。锁序 source -> document（文档 ID 排序）。
 */
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
    if (!current) throw new AppError('NOT_FOUND', '来源不存在，可能已被删除');

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
    // 一次汇总本事务受影响的 Wiki 页并按全局页 ID 取锁：逐文档加锁会在双来源交叉引用时形成锁环。
    await markWikiStaleByDocumentsTx(tx, disabledDocumentIds);
    return { source, ranges, disabledDocumentIds };
  });
}

/**
 * 外部条目读取成功后的授权写入：快照、patch、实际范围归属与停用恢复同事务。
 * 锁序 source FOR SHARE -> document FOR UPDATE；快照已失效时零写返回 null。
 */
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
    // 只挂该条目实际命中的范围；范围必须仍在快照内且覆盖本次路径。
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
    // 人工停用不因来源同步复活；来源/范围/远端失权由成功读取恢复。
    const manualDisabled = document.disabledReason === 'manual';
    const [row] = await tx
      .update(knowledgeDocuments)
      .set({
        title: patch.title,
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
