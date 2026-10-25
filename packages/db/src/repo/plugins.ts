import { AppError } from '@agentport/core';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentPlugins, pluginFiles, plugins } from '../schema.js';
import { notStale } from './freshness.js';

export type PluginRow = typeof plugins.$inferSelect;

export type PluginWithAgentCount = PluginRow & { agentCount: number };

export type PluginFileRow = typeof pluginFiles.$inferSelect;

export interface PluginFileWrite {
  path: string;
  content: string;
  executable?: boolean;
}

export type PluginWrite = Pick<PluginRow, 'slug' | 'runtimeName' | 'name'> &
  Partial<Pick<PluginRow, 'description' | 'version' | 'manifest'>>;

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
  createdAt: plugins.createdAt,
  updatedAt: plugins.updatedAt,
};

/** 版本按毫秒推进：同一毫秒内的连续更新也要让旧 token 失效。 */
const touchUpdatedAt = sql`greatest(now(), date_trunc('milliseconds', ${plugins.updatedAt}) + interval '1 millisecond')`;

/** 列表附带绑定的智能体数量；分组依据是主键，其余列在 PG 中函数依赖于它。 */
export async function listPlugins(db: Database): Promise<PluginWithAgentCount[]> {
  return db
    .select({ ...pluginColumns, agentCount: count(agentPlugins.agentId) })
    .from(plugins)
    .leftJoin(agentPlugins, eq(agentPlugins.pluginId, plugins.id))
    .groupBy(plugins.id)
    .orderBy(asc(plugins.createdAt), asc(plugins.id));
}

export async function getPlugin(db: Database, id: string): Promise<PluginRow | null> {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id)).limit(1);
  return row ?? null;
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

/**
 * 乐观锁必须写进 SQL：先读再比再无条件更新，两个并发 PATCH 会都通过比较。
 * 返回 null 表示行不存在；抛 CONFLICT_STALE 表示 token 不匹配。
 */
export async function updatePluginMeta(
  db: Database,
  id: string,
  patch: Partial<PluginWrite>,
  expectedUpdatedAt?: Date,
): Promise<PluginRow | null> {
  const [row] = await db
    .update(plugins)
    .set({ ...patch, updatedAt: touchUpdatedAt })
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

/** 一次取回多个插件的文件（worker 一次运行要把所有已绑定插件铺进工作区）。 */
export async function getPluginFilesByPluginIds(
  db: Database,
  pluginIds: string[],
): Promise<Map<string, PluginFileRow[]>> {
  const map = new Map<string, PluginFileRow[]>();
  if (pluginIds.length === 0) return map;
  const rows = await db
    .select()
    .from(pluginFiles)
    .where(inArray(pluginFiles.pluginId, pluginIds))
    .orderBy(asc(pluginFiles.path), asc(pluginFiles.id));
  for (const row of rows) {
    const list = map.get(row.pluginId) ?? [];
    list.push(row);
    map.set(row.pluginId, list);
  }
  return map;
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
