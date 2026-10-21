import { expect, it } from 'vitest';
import { createDb } from '../src/client.js';

it('cancels slow SQL instead of holding a pool slot indefinitely', async () => {
  const { pool } = createDb(process.env.DATABASE_URL!);
  try {
    await expect(pool.query('select pg_sleep(16)')).rejects.toMatchObject({ code: '57014' });
  } finally {
    await pool.end();
  }
}, 20_000);
it('times out waiting for an exhausted connection pool', async () => {
  const prior = process.env.DB_POOL_MAX;
  process.env.DB_POOL_MAX = '1';
  const { pool } = createDb(process.env.DATABASE_URL!);
  if (prior === undefined) delete process.env.DB_POOL_MAX;
  else process.env.DB_POOL_MAX = prior;
  const held = await pool.connect();
  try {
    await expect(pool.connect()).rejects.toThrow(/timeout/i);
  } finally {
    held.release();
    await pool.end();
  }
}, 10_000);
