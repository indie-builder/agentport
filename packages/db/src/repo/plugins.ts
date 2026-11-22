import { AppError } from '@agentport/core';
import type { Agent, ResourceAccessFilter } from '@agentport/shared';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { agentPlugins, pluginFiles, plugins } from '../schema.js';
import { resourceScopeWhere } from './access.js';
import { notStale, touchUpdatedAt } from './freshness.js';
import { type CursorPage, keysetPage } from './pagination.js';

export type PluginRow = typeof plugins.$inferSelect;

export type PluginWithAgentCount = PluginRow & { agentCount: number };

export type PluginFileRow = typeof pluginFiles.$inferSelect;

export interface PluginFileWrite {
  path: string;
  content: string;
  executable?: boolean;
}

export type PluginWrite = Pick<PluginRow, 'slug' | 'runtimeName' | 'name'> &
  Partial<Pick<PluginRow, 'description' | 'version' | 'manifest' | 'sourceId' | 'ownerBusinessId'>>;

export interface AgentPluginBinding {
  plugin: PluginRow;
  allowHooks: boolean;
  allowMcp: boolean;
}

const pluginColumns = {
  id: plugins.id,
  slug: plugins.slug,
  runtimeName: plugins.runtimeName,
  name: plugins.name,
  description: plugins.description,
  version: plugins.version,
  manifest: plugins.manifest,
  sourceId: plugins.sourceId,
  ownerBusinessId: plugins.ownerBusinessId,
  createdAt: plugins.createdAt,
  updatedAt: plugins.updatedAt,
};

export async function listPlugins(
  db: Database,
  options: {
    access?: ResourceAccessFilter | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): Promise<CursorPage<PluginWithAgentCount> | null> {
  return keysetPage(db, {
    table: plugins,
    column: plugins.createdAt,
    direction: 'asc',
    limit: options.limit,
    cursor: options.cursor,
    where: [
      options.access === undefined
        ? undefined
        : resourceScopeWhere(options.access, plugins.id, plugins.ownerBusinessId),
    ],
    load: ({ where, limit }) =>
      db
        .select({ ...pluginColumns, agentCount: count(agentPlugins.agentId) })
        .from(plugins)
        .leftJoin(agentPlugins, eq(agentPlugins.pluginId, plugins.id))
        .where(where)
        .groupBy(plugins.id)
        .orderBy(asc(plugins.createdAt), asc(plugins.id))
        .limit(limit),
  });
}

export async function getPlugin(db: Database, id: string): Promise<PluginRow | null> {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id)).limit(1);
  return row ?? null;
}

export async function getPluginWithAgentCount(
  db: Database,
  id: string,
): Promise<PluginWithAgentCount | null> {
  const [row] = await db
    .select({ ...pluginColumns, agentCount: count(agentPlugins.agentId) })
    .from(plugins)
    .leftJoin(agentPlugins, eq(agentPlugins.pluginId, plugins.id))
    .where(eq(plugins.id, id))
    .groupBy(plugins.id)
    .limit(1);
  return row ?? null;
}

export async function getPluginBySourceId(
  db: Database,
  sourceId: string,
): Promise<PluginRow | null> {
  const [row] = await db.select().from(plugins).where(eq(plugins.sourceId, sourceId)).limit(1);
  return row ?? null;
}

export async function getImportedPluginSourceIds(
  db: Database,
  sourceIds: string[],
): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();
  const rows = await db
    .select({ sourceId: plugins.sourceId })
    .from(plugins)
    .where(inArray(plugins.sourceId, sourceIds));
  return new Set(rows.map((row) => row.sourceId).filter((id): id is string => id !== null));
}

export async function createPluginWithFiles(
  db: Database,
  input: PluginWrite,
  files: PluginFileWrite[],
): Promise<PluginRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(plugins)
      .values({ id: newId('plugin'), ...input })
      .returning();
    if (!row) throw new Error('plugin insert returned no row');
    if (files.length > 0) {
      await tx.insert(pluginFiles).values(
        files.map((file) => ({
          id: newId('pluginFile'),
          pluginId: row.id,
          path: file.path,
          content: file.content,
          executable: file.executable ?? false,
        })),
      );
    }
    return row;
  });
}

export async function replacePluginWithFiles(
  db: Database,
  id: string,
  patch: Partial<PluginWrite>,
  files: PluginFileWrite[],
): Promise<PluginRow | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(plugins)
      .set({ ...patch, updatedAt: touchUpdatedAt(plugins.updatedAt) })
      .where(eq(plugins.id, id))
      .returning();
    if (!row) return null;
    await tx.delete(pluginFiles).where(eq(pluginFiles.pluginId, id));
    if (files.length > 0) {
      await tx.insert(pluginFiles).values(
        files.map((file) => ({
          id: newId('pluginFile'),
          pluginId: id,
          path: file.path,
          content: file.content,
          executable: file.executable ?? false,
        })),
      );
    }
    return row;
  });
}

export async function updatePluginMeta(
  db: Database,
  id: string,
  patch: Partial<PluginWrite>,
  expectedUpdatedAt?: Date,
): Promise<PluginRow | null> {
  const [row] = await db
    .update(plugins)
    .set({ ...patch, updatedAt: touchUpdatedAt(plugins.updatedAt) })
    .where(
      expectedUpdatedAt === undefined
        ? eq(plugins.id, id)
        : and(eq(plugins.id, id), notStale(plugins.updatedAt, expectedUpdatedAt)),
    )
    .returning();
  if (row) return row;
  if (expectedUpdatedAt !== undefined && (await getPlugin(db, id)) !== null) {
    throw new AppError('CONFLICT_STALE', '插件已被修改，请刷新后重试');
  }
  return null;
}

export async function deletePlugin(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(plugins).where(eq(plugins.id, id)).returning({ id: plugins.id });
  return rows.length > 0;
}

export async function listPluginFiles(db: Database, pluginId: string): Promise<PluginFileRow[]> {
  return db
    .select()
    .from(pluginFiles)
    .where(eq(pluginFiles.pluginId, pluginId))
    .orderBy(asc(pluginFiles.path), asc(pluginFiles.id));
}

export async function getPluginFilesByPluginIds(
  db: DbHandle,
  pluginIds: string[],
): Promise<Map<string, PluginFileRow[]>> {
  if (pluginIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(pluginFiles)
    .where(inArray(pluginFiles.pluginId, pluginIds))
    .orderBy(asc(pluginFiles.path), asc(pluginFiles.id));
  return Map.groupBy(rows, (row) => row.pluginId);
}

export async function listAgentPluginBindings(
  db: Database,
  agentId: string,
): Promise<AgentPluginBinding[]> {
  const rows = await db
    .select({
      plugin: pluginColumns,
      allowHooks: agentPlugins.allowHooks,
      allowMcp: agentPlugins.allowMcp,
    })
    .from(agentPlugins)
    .innerJoin(plugins, eq(plugins.id, agentPlugins.pluginId))
    .where(eq(agentPlugins.agentId, agentId))
    .orderBy(asc(plugins.createdAt), asc(plugins.id));
  return rows;
}

export async function listAgentPluginBindingInputs(
  db: DbHandle,
  agentIds: string[],
): Promise<Map<string, Agent['pluginBindings']>> {
  const out = new Map<string, Agent['pluginBindings']>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({
      agentId: agentPlugins.agentId,
      pluginId: agentPlugins.pluginId,
      allowHooks: agentPlugins.allowHooks,
      allowMcp: agentPlugins.allowMcp,
    })
    .from(agentPlugins)
    .where(inArray(agentPlugins.agentId, agentIds))
    .orderBy(asc(agentPlugins.agentId), asc(agentPlugins.pluginId));
  for (const row of rows) {
    const list = out.get(row.agentId) ?? [];
    list.push({
      pluginId: row.pluginId,
      allowHooks: row.allowHooks,
      allowMcp: row.allowMcp,
    });
    out.set(row.agentId, list);
  }
  return out;
}
