import { RETENTION_DEFAULTS, type RetentionUpdate } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { platformSettings } from '../../schema.js';

const SINGLETON_ID = 'singleton';

export interface RetentionSettingsRow {
  runDays: number;
  messageDays: number;
  agentVersions: number;
  updatedAt: Date;
  updatedBy: string | null;
}

const retentionColumns = {
  runDays: platformSettings.retentionRunDays,
  messageDays: platformSettings.retentionMessageDays,
  agentVersions: platformSettings.retentionAgentVersions,
  updatedAt: platformSettings.updatedAt,
  updatedBy: platformSettings.updatedBy,
};

export async function getRetentionSettings(db: DbHandle): Promise<RetentionSettingsRow | null> {
  const [row] = await db
    .select(retentionColumns)
    .from(platformSettings)
    .where(eq(platformSettings.id, SINGLETON_ID))
    .limit(1);
  return row ?? null;
}

export async function upsertRetentionSettings(
  db: Database,
  patch: RetentionUpdate,
  updatedBy: string,
): Promise<RetentionSettingsRow> {
  const existing = await getRetentionSettings(db);
  const next = {
    runDays: patch.runDays ?? existing?.runDays ?? RETENTION_DEFAULTS.runDays,
    messageDays: patch.messageDays ?? existing?.messageDays ?? RETENTION_DEFAULTS.messageDays,
    agentVersions:
      patch.agentVersions ?? existing?.agentVersions ?? RETENTION_DEFAULTS.agentVersions,
  };
  const [row] = await db
    .insert(platformSettings)
    .values({
      id: SINGLETON_ID,
      retentionRunDays: next.runDays,
      retentionMessageDays: next.messageDays,
      retentionAgentVersions: next.agentVersions,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: {
        retentionRunDays: next.runDays,
        retentionMessageDays: next.messageDays,
        retentionAgentVersions: next.agentVersions,
        updatedAt: new Date(),
        updatedBy,
      },
    })
    .returning(retentionColumns);
  if (!row) throw new Error('retention settings upsert returned no row');
  return row;
}

export async function ensureRetentionDefaults(
  db: Database,
  defaults: { runDays: number; messageDays: number; agentVersions: number },
): Promise<void> {
  await db
    .insert(platformSettings)
    .values({
      id: SINGLETON_ID,
      retentionRunDays: defaults.runDays,
      retentionMessageDays: defaults.messageDays,
      retentionAgentVersions: defaults.agentVersions,
    })
    .onConflictDoNothing();
}
