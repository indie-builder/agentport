import { AppError } from '@agentport/core';
import type {
  ApiToolInput,
  ResolvedRuntimeEnvironment,
  ResourceAccessFilter,
} from '@agentport/shared';
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../client.js';
import { newId } from '../id.js';
import { apiTools, servers } from '../schema.js';
import { resourceScopeWhere } from './access.js';
import { notStale, touchUpdatedAt } from './freshness.js';
import { type CursorPage, keysetPage } from './pagination.js';

export type ServerRow = typeof servers.$inferSelect;
export type ApiToolRow = typeof apiTools.$inferSelect;

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
  outputSchema?: Record<string, unknown> | null;
  paramsIn: 'query' | 'body';
  approvalMode: 'allow' | 'ask' | 'deny';
}

export interface ApiToolPatch {
  name?: string;
  description?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  paramsIn?: 'query' | 'body';
  enabled?: boolean;
  approvalMode?: 'allow' | 'ask' | 'deny';
}

export function listServerPage(
  db: Database,
  options: {
    access?: ResourceAccessFilter | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<CursorPage<ServerRow> | null> {
  return keysetPage(db, {
    table: servers,
    cursor: options.cursor,
    limit: options.limit,
    direction: 'asc',
    where: [
      options.access === undefined
        ? undefined
        : resourceScopeWhere(options.access, servers.id, servers.ownerBusinessId),
      ne(servers.kind, 'knowledge'),
    ],
    load: ({ where, limit }) =>
      db
        .select()
        .from(servers)
        .where(where)
        .orderBy(asc(servers.createdAt), asc(servers.id))
        .limit(limit),
  });
}

/**
 * 记录一次「测试连接」结果，供列表展示连接健康度；不影响配置本身。
 * 单条 UPDATE 只写 last-test 四列，不与并发 PATCH 的读改写互相覆盖；
 * 不推进 updatedAt（试连不是配置修改）。
 */
export async function recordTestResult(
  db: Database,
  id: string,
  ok: boolean,
  toolCount: number | null,
  runtimeEnvironment: ResolvedRuntimeEnvironment | null,
): Promise<void> {
  await db
    .update(servers)
    .set({
      lastTestedAt: new Date(),
      lastTestOk: ok,
      lastToolCount: toolCount,
      lastTestRuntimeEnvironment: runtimeEnvironment,
    })
    .where(eq(servers.id, id));
}

export async function getServer(db: DbHandle, id: string): Promise<ServerRow | null> {
  const [row] = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  return row ?? null;
}

export async function getServerAccessRow(
  db: DbHandle,
  id: string,
): Promise<{ id: string; ownerBusinessId: string | null } | null> {
  const [row] = await db
    .select({ id: servers.id, ownerBusinessId: servers.ownerBusinessId })
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * 读取并锁住行，供「读 → 合并 → 写」跨请求串行化。
 * 必须在事务内调用；FOR UPDATE 之后的读取拿到的是锁释放后的最新值。
 */
export async function lockServer(tx: Transaction, id: string): Promise<ServerRow | null> {
  const [row] = await tx.select().from(servers).where(eq(servers.id, id)).limit(1).for('update');
  return row ?? null;
}

export async function createServer(
  db: DbHandle,
  input: ServerWrite,
  ownerBusinessId: string | null,
): Promise<ServerRow> {
  const [row] = await db
    .insert(servers)
    .values({ id: newId('server'), ...input, ownerBusinessId })
    .returning();
  if (!row) throw new Error('server insert returned no row');
  return row;
}

export async function updateServer(
  db: DbHandle,
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
      updatedAt: touchUpdatedAt(servers.updatedAt),
    })
    .where(where)
    .returning();
  if (!row && expectedUpdatedAt !== undefined && (await getServer(db, id))) {
    throw new AppError('CONFLICT_STALE', '配置已被修改，请刷新');
  }
  return row ?? null;
}

export async function deleteServer(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(servers).where(eq(servers.id, id)).returning({ id: servers.id });
  return rows.length > 0;
}

export async function countApiTools(db: Database, serverId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(apiTools)
    .where(eq(apiTools.serverId, serverId));
  return row?.total ?? 0;
}

export async function listApiTools(db: Database, serverId: string): Promise<ApiToolRow[]> {
  return db
    .select()
    .from(apiTools)
    .where(eq(apiTools.serverId, serverId))
    .orderBy(asc(apiTools.createdAt), asc(apiTools.id));
}

export async function listToolApprovalModes(db: Database, serverIds: string[]) {
  return db
    .select({
      serverId: apiTools.serverId,
      toolName: apiTools.name,
      approvalMode: apiTools.approvalMode,
    })
    .from(apiTools)
    .innerJoin(servers, eq(servers.id, apiTools.serverId))
    .where(
      and(
        inArray(apiTools.serverId, serverIds),
        eq(servers.kind, 'generated'),
        eq(apiTools.enabled, true),
      ),
    );
}

export async function getApiToolByName(db: Database, serverId: string, toolName: string) {
  const [row] = await db
    .select()
    .from(apiTools)
    .where(and(eq(apiTools.serverId, serverId), eq(apiTools.name, toolName)))
    .limit(1);
  return row ?? null;
}

export async function createApiTool(db: DbHandle, input: ApiToolWrite): Promise<ApiToolRow> {
  const [row] = await db
    .insert(apiTools)
    .values({ id: newId('tool'), ...input })
    .returning();
  if (!row) throw new Error('api tool insert returned no row');
  return row;
}

export async function createApiTools(
  db: Database,
  serverId: string,
  inputs: ApiToolInput[],
): Promise<ApiToolRow[]> {
  if (inputs.length === 0) return [];
  return db.transaction((tx) =>
    tx
      .insert(apiTools)
      .values(inputs.map((input) => ({ id: newId('tool'), serverId, ...input })))
      .returning(),
  );
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
