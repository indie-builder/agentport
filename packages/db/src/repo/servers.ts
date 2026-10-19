import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { apiTools, servers } from '../schema.js';

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
  paramsIn: 'query' | 'body';
  requiresApproval: boolean;
}

export interface ApiToolPatch {
  enabled?: boolean;
  requiresApproval?: boolean;
}

export async function listServers(db: Database): Promise<ServerRow[]> {
  return db.select().from(servers).orderBy(asc(servers.createdAt), asc(servers.id));
}

export async function getServer(db: Database, id: string): Promise<ServerRow | null> {
  const [row] = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
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
  db: Database,
  id: string,
  patch: Partial<ServerWrite>,
  expectedUpdatedAt?: Date,
): Promise<ServerRow | null> {
  // Postgres 的 now() 带微秒，驱动解析成 JS Date 时只剩毫秒，比较前统一截断。
  const where =
    expectedUpdatedAt === undefined
      ? eq(servers.id, id)
      : and(
          eq(servers.id, id),
          sql`date_trunc('milliseconds', ${servers.updatedAt}) = date_trunc('milliseconds', ${expectedUpdatedAt}::timestamptz)`,
        );
  const [row] = await db
    .update(servers)
    .set({ ...patch, updatedAt: new Date() })
    .where(where)
    .returning();
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
