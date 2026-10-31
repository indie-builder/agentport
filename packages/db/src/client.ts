import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema.js';

/** pool 与 checked-out client 上的 Drizzle 实例共用同一查询类型，事务类型也随之统一。 */
export type Database = NodePgDatabase<typeof schema>;
export type DbPool = Pool;

export function createDb(connectionString: string) {
  // 池大小可配：压测显示 10 在高并发下成为第一瓶颈（db.waiting 峰值 115）。
  const max = Number(process.env.DB_POOL_MAX ?? 10);
  const pool = new Pool({
    connectionString,
    max: Number.isFinite(max) && max > 0 ? max : 10,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
