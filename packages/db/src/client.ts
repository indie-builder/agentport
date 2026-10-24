import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];

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
