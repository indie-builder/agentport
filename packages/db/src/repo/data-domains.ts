import { AppError } from '@agentport/core';
import { and, asc, desc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import {
  dataDomainEnrichmentProposals,
  dataDomainIdentities,
  dataDomainQueryApprovals,
  dataDomainQueryLogs,
  dataDomains,
  dataDomainVersions,
} from '../schema.js';
import { keysetBefore, paginate } from './keyset.js';
import { isPgCode } from './pg-errors.js';

export type DataDomainRow = typeof dataDomains.$inferSelect;
export type DataDomainVersionRow = typeof dataDomainVersions.$inferSelect;
export type DataDomainIdentityRow = typeof dataDomainIdentities.$inferSelect;
export type DataDomainQueryLogRow = typeof dataDomainQueryLogs.$inferSelect;
export type DataDomainQueryApprovalRow = typeof dataDomainQueryApprovals.$inferSelect;
export type DataDomainEnrichmentProposalRow = typeof dataDomainEnrichmentProposals.$inferSelect;

export const DATA_DOMAIN_VERSION_LOG_LIMIT = 64 * 1024;

function logTailFields(
  chunk: string,
  sourceTruncated: boolean,
): { logTail: SQL; logTruncated: SQL } {
  const joined = sql`${dataDomainVersions.logTail} || ${chunk}`;
  const slice = sql`substring(convert_to(${joined}, 'UTF8') from greatest(1, octet_length(convert_to(${joined}, 'UTF8')) - ${DATA_DOMAIN_VERSION_LOG_LIMIT} + 1))`;
  return {
    logTail: sql`(select convert_from(substring(tail.bytes from case
      when octet_length(tail.bytes) = 0 then 1
      when get_byte(tail.bytes, 0) < 128 or get_byte(tail.bytes, 0) >= 192 then 1
      when octet_length(tail.bytes) <= 1 then 2
      when get_byte(tail.bytes, 1) < 128 or get_byte(tail.bytes, 1) >= 192 then 2
      when octet_length(tail.bytes) <= 2 then 3
      when get_byte(tail.bytes, 2) < 128 or get_byte(tail.bytes, 2) >= 192 then 3
      else 4
    end), 'UTF8') from (select ${slice} as bytes) tail)`,
    logTruncated: sql`${dataDomainVersions.logTruncated} or ${sourceTruncated} or octet_length(${joined}) > ${DATA_DOMAIN_VERSION_LOG_LIMIT}`,
  };
}

export type DataDomainInput = Pick<
  typeof dataDomains.$inferInsert,
  | 'name'
  | 'slug'
  | 'description'
  | 'datasource'
  | 'connectionEncrypted'
  | 'queryApprovalMode'
  | 'createdBy'
>;

export type DataDomainPatch = Partial<
  Pick<
    DataDomainInput,
    'name' | 'slug' | 'description' | 'datasource' | 'connectionEncrypted' | 'queryApprovalMode'
  >
>;

function rethrowSlugConflict(err: unknown): never {
  if (isPgCode(err, '23505')) {
    throw new AppError('CONFLICT', '数据域标识已被占用，请换一个');
  }
  throw err;
}

export async function listDataDomains(db: DbHandle): Promise<DataDomainRow[]> {
  return db.select().from(dataDomains).orderBy(asc(dataDomains.createdAt), asc(dataDomains.id));
}

export async function getDataDomain(db: DbHandle, id: string): Promise<DataDomainRow | null> {
  const [row] = await db.select().from(dataDomains).where(eq(dataDomains.id, id)).limit(1);
  return row ?? null;
}

export async function getDataDomainBySlug(
  db: DbHandle,
  slug: string,
): Promise<DataDomainRow | null> {
  const [row] = await db.select().from(dataDomains).where(eq(dataDomains.slug, slug)).limit(1);
  return row ?? null;
}

export async function createDataDomain(
  db: DbHandle,
  input: DataDomainInput,
): Promise<DataDomainRow> {
  try {
    const [row] = await db
      .insert(dataDomains)
      .values({ id: newId('dataDomain'), ...input })
      .returning();
    if (!row) throw new Error('data domain insert returned no row');
    return row;
  } catch (err) {
    rethrowSlugConflict(err);
  }
}

export async function updateDataDomain(
  db: DbHandle,
  id: string,
  patch: DataDomainPatch,
): Promise<DataDomainRow | null> {
  try {
    const [row] = await db
      .update(dataDomains)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(dataDomains.id, id))
      .returning();
    return row ?? null;
  } catch (err) {
    rethrowSlugConflict(err);
  }
}

export async function deleteDataDomain(db: DbHandle, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: dataDomains.id })
    .from(dataDomains)
    .where(eq(dataDomains.id, id))
    .limit(1)
    .for('update');
  if (!row) return false;
  const [busy] = await db
    .select({ id: dataDomainVersions.id })
    .from(dataDomainVersions)
    .where(
      and(
        eq(dataDomainVersions.dataDomainId, id),
        inArray(dataDomainVersions.status, ['queued', 'building']),
      ),
    )
    .limit(1);
  if (busy) {
    throw new AppError('CONFLICT', '数据域仍有排队或构建中的版本，请等待构建结束');
  }
  await db.update(dataDomains).set({ onlineVersionId: null }).where(eq(dataDomains.id, id));
  await db.delete(dataDomains).where(eq(dataDomains.id, id));
  return true;
}

export async function insertDataDomainVersion(
  db: DbHandle,
  dataDomainId: string,
  projectFiles: Record<string, string>,
): Promise<DataDomainVersionRow> {
  const [row] = await db
    .insert(dataDomainVersions)
    .values({ id: newId('dataDomainVersion'), dataDomainId, projectFiles })
    .returning();
  if (!row) throw new Error('data domain version insert returned no row');
  return row;
}

export async function createDataDomainVersion(
  db: Database,
  dataDomainId: string,
  projectFiles: Record<string, string>,
): Promise<DataDomainVersionRow | null> {
  return db.transaction(async (tx) => {
    const [domain] = await tx
      .select({ id: dataDomains.id })
      .from(dataDomains)
      .where(eq(dataDomains.id, dataDomainId))
      .limit(1)
      .for('share');
    if (!domain) return null;
    return insertDataDomainVersion(tx, dataDomainId, projectFiles);
  });
}

export async function getDataDomainVersion(
  db: DbHandle,
  versionId: string,
): Promise<DataDomainVersionRow | null> {
  const [row] = await db
    .select()
    .from(dataDomainVersions)
    .where(eq(dataDomainVersions.id, versionId))
    .limit(1);
  return row ?? null;
}

export async function listDataDomainVersions(
  db: DbHandle,
  dataDomainId: string,
): Promise<DataDomainVersionRow[]> {
  return db
    .select()
    .from(dataDomainVersions)
    .where(eq(dataDomainVersions.dataDomainId, dataDomainId))
    .orderBy(desc(dataDomainVersions.createdAt), desc(dataDomainVersions.id));
}

export async function claimDataDomainVersionBuild(
  db: DbHandle,
  versionId: string,
): Promise<DataDomainVersionRow | null> {
  const [row] = await db
    .update(dataDomainVersions)
    .set({ status: 'building', updatedAt: new Date() })
    .where(and(eq(dataDomainVersions.id, versionId), eq(dataDomainVersions.status, 'queued')))
    .returning();
  return row ?? null;
}

export async function completeDataDomainVersionBuild(
  db: DbHandle,
  versionId: string,
  mdlManifest: string,
): Promise<DataDomainVersionRow | null> {
  const [row] = await db
    .update(dataDomainVersions)
    .set({ status: 'ready', mdlManifest, updatedAt: new Date() })
    .where(and(eq(dataDomainVersions.id, versionId), eq(dataDomainVersions.status, 'building')))
    .returning();
  return row ?? null;
}

export async function failDataDomainVersionBuild(
  db: DbHandle,
  versionId: string,
  expectedStatus: 'queued' | 'building',
): Promise<DataDomainVersionRow | null> {
  const [row] = await db
    .update(dataDomainVersions)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(and(eq(dataDomainVersions.id, versionId), eq(dataDomainVersions.status, expectedStatus)))
    .returning();
  return row ?? null;
}

export async function listStaleBuildingDataDomainVersions(
  db: DbHandle,
  olderThan: Date,
): Promise<DataDomainVersionRow[]> {
  return db
    .select()
    .from(dataDomainVersions)
    .where(
      and(eq(dataDomainVersions.status, 'building'), lt(dataDomainVersions.updatedAt, olderThan)),
    );
}

export async function failStaleDataDomainVersionBuild(
  db: DbHandle,
  versionId: string,
  olderThan: Date,
  text: string,
): Promise<DataDomainVersionRow | null> {
  const [row] = await db
    .update(dataDomainVersions)
    .set({ status: 'failed', ...logTailFields(text, false), updatedAt: new Date() })
    .where(
      and(
        eq(dataDomainVersions.id, versionId),
        eq(dataDomainVersions.status, 'building'),
        lt(dataDomainVersions.updatedAt, olderThan),
      ),
    )
    .returning();
  return row ?? null;
}

export async function appendDataDomainVersionLog(
  db: DbHandle,
  versionId: string,
  chunk: string,
  sourceTruncated = false,
): Promise<void> {
  if (chunk === '' && !sourceTruncated) return;
  await db
    .update(dataDomainVersions)
    .set({ ...logTailFields(chunk, sourceTruncated), updatedAt: new Date() })
    .where(and(eq(dataDomainVersions.id, versionId), eq(dataDomainVersions.status, 'building')));
}

export async function publishDataDomainVersion(
  db: Database,
  dataDomainId: string,
  versionId: string,
): Promise<DataDomainRow | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: dataDomains.id })
      .from(dataDomains)
      .where(eq(dataDomains.id, dataDomainId))
      .limit(1)
      .for('update');
    if (!locked) return null;
    const [version] = await tx
      .select({ id: dataDomainVersions.id, status: dataDomainVersions.status })
      .from(dataDomainVersions)
      .where(
        and(
          eq(dataDomainVersions.id, versionId),
          eq(dataDomainVersions.dataDomainId, dataDomainId),
        ),
      )
      .limit(1);
    if (!version) {
      throw new AppError('NOT_FOUND', '该版本不属于当前数据域');
    }
    if (version.status !== 'ready') {
      throw new AppError('CONFLICT', '只有构建完成的版本才能设为线上版本');
    }
    const [row] = await tx
      .update(dataDomains)
      .set({ onlineVersionId: versionId, updatedAt: new Date() })
      .where(eq(dataDomains.id, dataDomainId))
      .returning();
    return row ?? null;
  });
}

export async function listDataDomainIdentities(
  db: DbHandle,
  dataDomainId: string,
): Promise<DataDomainIdentityRow[]> {
  return db
    .select()
    .from(dataDomainIdentities)
    .where(eq(dataDomainIdentities.dataDomainId, dataDomainId))
    .orderBy(asc(dataDomainIdentities.businessId));
}

export async function upsertDataDomainIdentity(
  db: DbHandle,
  dataDomainId: string,
  businessId: string,
  properties: Record<string, string>,
): Promise<DataDomainIdentityRow> {
  const [row] = await db
    .insert(dataDomainIdentities)
    .values({ id: newId('dataDomainIdentity'), dataDomainId, businessId, properties })
    .onConflictDoUpdate({
      target: [dataDomainIdentities.dataDomainId, dataDomainIdentities.businessId],
      set: { properties, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('data domain identity upsert returned no row');
  return row;
}

export async function deleteDataDomainIdentity(
  db: DbHandle,
  dataDomainId: string,
  businessId: string,
): Promise<boolean> {
  const rows = await db
    .delete(dataDomainIdentities)
    .where(
      and(
        eq(dataDomainIdentities.dataDomainId, dataDomainId),
        eq(dataDomainIdentities.businessId, businessId),
      ),
    )
    .returning({ id: dataDomainIdentities.id });
  return rows.length > 0;
}

export async function resolveDataDomainSessionProperties(
  db: DbHandle,
  dataDomainId: string,
  businessId: string,
): Promise<Record<string, string> | null> {
  const [row] = await db
    .select({ properties: dataDomainIdentities.properties })
    .from(dataDomainIdentities)
    .where(
      and(
        eq(dataDomainIdentities.dataDomainId, dataDomainId),
        eq(dataDomainIdentities.businessId, businessId),
      ),
    )
    .limit(1);
  return row?.properties ?? null;
}

export async function writeDataDomainQueryLog(
  db: DbHandle,
  entry: {
    dataDomainId: string;
    versionId: string | null;
    serverId: string;
    runId: string;
    actorBusinessId: string | null;
    sqlSummary: string;
    rowCount: number | null;
    status: 'ok' | 'error';
    durationMs: number;
  },
): Promise<void> {
  await db.insert(dataDomainQueryLogs).values({ id: newId('dataDomainQueryLog'), ...entry });
}

export async function listDataDomainQueryLogs(
  db: DbHandle,
  options: {
    dataDomainId: string;
    limit: number;
    cursor?: string;
    status?: 'ok' | 'error';
    runId?: string;
  },
): Promise<{ items: DataDomainQueryLogRow[]; nextCursor: string | null }> {
  const filters = [eq(dataDomainQueryLogs.dataDomainId, options.dataDomainId)];
  if (options.status !== undefined) filters.push(eq(dataDomainQueryLogs.status, options.status));
  if (options.runId !== undefined) filters.push(eq(dataDomainQueryLogs.runId, options.runId));
  if (options.cursor !== undefined) filters.push(keysetBefore(dataDomainQueryLogs, options.cursor));
  const rows = await db
    .select()
    .from(dataDomainQueryLogs)
    .where(and(...filters))
    .orderBy(desc(dataDomainQueryLogs.createdAt), desc(dataDomainQueryLogs.id))
    .limit(options.limit + 1);
  return paginate(rows, options.limit);
}

export async function getLatestDataDomainQueryApproval(
  db: DbHandle,
  options: { dataDomainId: string; runId: string; sqlHash: string },
): Promise<DataDomainQueryApprovalRow | null> {
  const [row] = await db
    .select()
    .from(dataDomainQueryApprovals)
    .where(
      and(
        eq(dataDomainQueryApprovals.dataDomainId, options.dataDomainId),
        eq(dataDomainQueryApprovals.runId, options.runId),
        eq(dataDomainQueryApprovals.sqlHash, options.sqlHash),
      ),
    )
    .orderBy(desc(dataDomainQueryApprovals.requestedAt), desc(dataDomainQueryApprovals.id))
    .limit(1);
  return row ?? null;
}

export async function requestDataDomainQueryApproval(
  db: DbHandle,
  entry: {
    dataDomainId: string;
    serverId: string;
    runId: string;
    actorBusinessId: string | null;
    sqlText: string;
    sqlHash: string;
  },
): Promise<DataDomainQueryApprovalRow> {
  const [inserted] = await db
    .insert(dataDomainQueryApprovals)
    .values({ id: newId('dataDomainQueryApproval'), ...entry })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const existing = await getLatestDataDomainQueryApproval(db, {
    dataDomainId: entry.dataDomainId,
    runId: entry.runId,
    sqlHash: entry.sqlHash,
  });
  if (existing) return existing;
  throw new Error('data domain query approval insert returned no row');
}

export async function decideDataDomainQueryApproval(
  db: DbHandle,
  options: {
    dataDomainId: string;
    approvalId: string;
    status: 'approved' | 'rejected';
    decidedByBusinessId: string;
    note: string;
  },
): Promise<DataDomainQueryApprovalRow | null> {
  const [row] = await db
    .update(dataDomainQueryApprovals)
    .set({
      status: options.status,
      decidedAt: new Date(),
      decidedByBusinessId: options.decidedByBusinessId,
      decisionNote: options.note,
    })
    .where(
      and(
        eq(dataDomainQueryApprovals.id, options.approvalId),
        eq(dataDomainQueryApprovals.dataDomainId, options.dataDomainId),
        eq(dataDomainQueryApprovals.status, 'pending'),
      ),
    )
    .returning();
  return row ?? null;
}

export async function listDataDomainQueryApprovals(
  db: DbHandle,
  options: {
    dataDomainId: string;
    limit: number;
    cursor?: string;
    status?: 'pending' | 'approved' | 'rejected';
  },
): Promise<{ items: DataDomainQueryApprovalRow[]; nextCursor: string | null }> {
  const filters = [eq(dataDomainQueryApprovals.dataDomainId, options.dataDomainId)];
  if (options.status !== undefined)
    filters.push(eq(dataDomainQueryApprovals.status, options.status));
  if (options.cursor !== undefined) {
    filters.push(
      sql`(${dataDomainQueryApprovals.requestedAt}, ${dataDomainQueryApprovals.id}) < (select cursor.requested_at, cursor.id from ${dataDomainQueryApprovals} cursor where cursor.id = ${options.cursor})`,
    );
  }
  const rows = await db
    .select()
    .from(dataDomainQueryApprovals)
    .where(and(...filters))
    .orderBy(desc(dataDomainQueryApprovals.requestedAt), desc(dataDomainQueryApprovals.id))
    .limit(options.limit + 1);
  return paginate(rows, options.limit);
}

export async function createDataDomainEnrichmentProposal(
  db: Database,
  input: {
    dataDomainId: string;
    sourceVersionId: string;
    instruction: string;
    createdBy: string;
  },
): Promise<DataDomainEnrichmentProposalRow | null> {
  return db.transaction(async (tx) => {
    const [domain] = await tx
      .select({ id: dataDomains.id })
      .from(dataDomains)
      .where(eq(dataDomains.id, input.dataDomainId))
      .limit(1)
      .for('share');
    if (!domain) return null;
    const [row] = await tx
      .insert(dataDomainEnrichmentProposals)
      .values({ id: newId('dataDomainEnrichmentProposal'), ...input })
      .returning();
    if (!row) throw new Error('data domain enrichment proposal insert returned no row');
    return row;
  });
}

export async function getDataDomainEnrichmentProposal(
  db: DbHandle,
  id: string,
): Promise<DataDomainEnrichmentProposalRow | null> {
  const [row] = await db
    .select()
    .from(dataDomainEnrichmentProposals)
    .where(eq(dataDomainEnrichmentProposals.id, id))
    .limit(1);
  return row ?? null;
}

export async function listDataDomainEnrichmentProposals(
  db: DbHandle,
  dataDomainId: string,
): Promise<DataDomainEnrichmentProposalRow[]> {
  return db
    .select()
    .from(dataDomainEnrichmentProposals)
    .where(eq(dataDomainEnrichmentProposals.dataDomainId, dataDomainId))
    .orderBy(desc(dataDomainEnrichmentProposals.createdAt), desc(dataDomainEnrichmentProposals.id));
}

export async function completeDataDomainEnrichmentProposal(
  db: DbHandle,
  id: string,
  input: { summary: string; projectFiles: Record<string, string> },
): Promise<DataDomainEnrichmentProposalRow | null> {
  const [row] = await db
    .update(dataDomainEnrichmentProposals)
    .set({
      status: 'ready',
      summary: input.summary,
      projectFiles: input.projectFiles,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dataDomainEnrichmentProposals.id, id),
        eq(dataDomainEnrichmentProposals.status, 'generating'),
      ),
    )
    .returning();
  return row ?? null;
}

export async function failDataDomainEnrichmentProposal(
  db: DbHandle,
  id: string,
  error: string,
): Promise<DataDomainEnrichmentProposalRow | null> {
  const [row] = await db
    .update(dataDomainEnrichmentProposals)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(
      and(
        eq(dataDomainEnrichmentProposals.id, id),
        eq(dataDomainEnrichmentProposals.status, 'generating'),
      ),
    )
    .returning();
  return row ?? null;
}

export async function decideDataDomainEnrichmentProposal(
  db: DbHandle,
  input: {
    id: string;
    dataDomainId: string;
    status: 'approved' | 'rejected';
    decidedBy: string;
  },
): Promise<DataDomainEnrichmentProposalRow | null> {
  const [row] = await db
    .update(dataDomainEnrichmentProposals)
    .set({
      status: input.status,
      decidedAt: new Date(),
      decidedByBusinessId: input.decidedBy,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dataDomainEnrichmentProposals.id, input.id),
        eq(dataDomainEnrichmentProposals.dataDomainId, input.dataDomainId),
        eq(dataDomainEnrichmentProposals.status, 'ready'),
      ),
    )
    .returning();
  return row ?? null;
}
