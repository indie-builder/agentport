import { AppError } from '@agentport/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { apiTools, servers } from '../schema.js';
import { notStale } from './freshness.js';

export type ServerRow = typeof servers.$inferSelect;
export type ApiToolRow = typeof apiTools.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ServerWrite {
  name: string;
  kind: 'stdio' | 'http' | 'generated';
  description: string;
  config: Record<string, unknown>;
  secretsEncrypted: string | null;
}

export interface ApiToolWrite {
  serverId: string;
  name: string;
  description: string;
  method: string;
  pathTemplate: string;
  inputSchema: Record<string, unknown>;
  paramsIn: 'query' | 'body';
  requiresApproval: boolean;
}

/**
 * 工具的可编辑字段。定义类字段（name/method/path/params/schema）与开关类字段
 * 放在同一个 patch 里：编辑工具时前端只发一次 PATCH，不需要先删后建。
 */
export interface ApiToolPatch {
  name?: string;
  description?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate?: string;
  inputSchema?: Record<string, unknown>;
  paramsIn?: 'query' | 'body';
  enabled?: boolean;
  requiresApproval?: boolean;
}

export async function listServers(db: Database): Promise<ServerRow[]> {
  return db.select().from(servers).orderBy(asc(servers.createdAt), asc(servers.id));
}

/** 记录一次「测试连接」结果，供列表展示连接健康度；不影响配置本身。 */
export async function recordTestResult(
  db: Database,
  id: string,
  ok: boolean,
  toolCount: number | null,
): Promise<void> {
  await db
    .update(servers)
    .set({ lastTestedAt: new Date(), lastTestOk: ok, lastToolCount: toolCount })
    .where(eq(servers.id, id));
}

export async function getServer(db: Database | Tx, id: string): Promise<ServerRow | null> {
  const [row] = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  return row ?? null;
}

/**
 * 读取并锁住行，供「读 → 合并 → 写」跨请求串行化。
 * 必须在事务内调用；FOR UPDATE 之后的读取拿到的是锁释放后的最新值。
 */
export async function lockServer(tx: Tx, id: string): Promise<ServerRow | null> {
  const [row] = await tx.select().from(servers).where(eq(servers.id, id)).limit(1).for('update');
  return row ?? null;
}

export async function createServer(db: Database, input: ServerWrite): Promise<ServerRow> {
  const [row] = await db
    .insert(servers)
    .values({ id: newId('server'), ...input })
    .returning();
  if (!row) throw new Error('server insert returned no row');
  return row;
}

export async function updateServer(
  db: Database | Tx,
  id: string,
  patch: Partial<ServerWrite>,
  expectedUpdatedAt?: Date,
): Promise<ServerRow | null> {
  const where =
    expectedUpdatedAt === undefined
      ? eq(servers.id, id)
      : and(eq(servers.id, id), notStale(servers.updatedAt, expectedUpdatedAt));
  const [row] = await db
    .update(servers)
    .set({
      ...patch,
      // 同一毫秒内的连续写入也要推进版本，否则旧 updatedAt 还能再次命中。
      updatedAt: sql`greatest(now(), date_trunc('milliseconds', ${servers.updatedAt}) + interval '1 millisecond')`,
    })
    .where(where)
    .returning();
  // 条件更新落空且行还在 = 并发修改；行没了交给路由返回 404。
  if (!row && expectedUpdatedAt !== undefined && (await getServer(db, id))) {
    throw new AppError('CONFLICT_STALE', '配置已被修改，请刷新');
  }
  return row ?? null;
}

export async function deleteServer(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(servers).where(eq(servers.id, id)).returning({ id: servers.id });
  return rows.length > 0;
}

export async function listApiTools(db: Database, serverId: string): Promise<ApiToolRow[]> {
  return db
    .select()
    .from(apiTools)
    .where(eq(apiTools.serverId, serverId))
    .orderBy(asc(apiTools.createdAt), asc(apiTools.id));
}

export async function createApiTool(db: Database, input: ApiToolWrite): Promise<ApiToolRow> {
  const [row] = await db
    .insert(apiTools)
    .values({ id: newId('tool'), ...input })
    .returning();
  if (!row) throw new Error('api tool insert returned no row');
  return row;
}

export async function updateApiTool(
  db: Database,
  serverId: string,
  toolId: string,
  patch: ApiToolPatch,
): Promise<ApiToolRow | null> {
  const [row] = await db
    .update(apiTools)
    .set(patch)
    .where(and(eq(apiTools.id, toolId), eq(apiTools.serverId, serverId)))
    .returning();
  return row ?? null;
}

export async function deleteApiTool(
  db: Database,
  serverId: string,
  toolId: string,
): Promise<boolean> {
  const rows = await db
    .delete(apiTools)
    .where(and(eq(apiTools.id, toolId), eq(apiTools.serverId, serverId)))
    .returning({ id: apiTools.id });
  return rows.length > 0;
}
