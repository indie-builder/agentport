import { AppError } from '@agentport/core';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { dataDomains, dataDomainVersions } from '../schema.js';
import { isPgCode } from './pg-errors.js';

export type DataDomainRow = typeof dataDomains.$inferSelect;
export type DataDomainVersionRow = typeof dataDomainVersions.$inferSelect;

export const DATA_DOMAIN_VERSION_LOG_LIMIT = 64 * 1024;

export type DataDomainInput = Pick<
  typeof dataDomains.$inferInsert,
  'name' | 'slug' | 'description' | 'datasource' | 'connectionEncrypted' | 'createdBy'
>;

export type DataDomainPatch = Partial<
  Pick<DataDomainInput, 'name' | 'slug' | 'description' | 'datasource' | 'connectionEncrypted'>
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

export async function deleteDataDomain(db: Database, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: dataDomains.id })
      .from(dataDomains)
      .where(eq(dataDomains.id, id))
      .limit(1)
      .for('update');
    if (!row) return false;
    const [busy] = await tx
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
    await tx.update(dataDomains).set({ onlineVersionId: null }).where(eq(dataDomains.id, id));
    await tx.delete(dataDomains).where(eq(dataDomains.id, id));
    return true;
  });
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
    const [row] = await tx
      .insert(dataDomainVersions)
      .values({ id: newId('dataDomainVersion'), dataDomainId, projectFiles })
      .returning();
    if (!row) throw new Error('data domain version insert returned no row');
    return row;
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
): Promise<DataDomainVersionRow | null> {
  const [row] = await db
    .update(dataDomainVersions)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(
      and(
        eq(dataDomainVersions.id, versionId),
        inArray(dataDomainVersions.status, ['queued', 'building']),
      ),
    )
    .returning();
  return row ?? null;
}

export async function appendDataDomainVersionLog(
  db: DbHandle,
  versionId: string,
  chunk: string,
): Promise<void> {
  if (chunk === '') return;
  await db
    .update(dataDomainVersions)
    .set({
      logTail: sql`right(${dataDomainVersions.logTail} || ${chunk}, ${DATA_DOMAIN_VERSION_LOG_LIMIT})`,
      logTruncated: sql`${dataDomainVersions.logTruncated} or length(${dataDomainVersions.logTail} || ${chunk}) > ${DATA_DOMAIN_VERSION_LOG_LIMIT}`,
      updatedAt: new Date(),
    })
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
