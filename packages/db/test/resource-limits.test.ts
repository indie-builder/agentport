import { expect, it } from 'bun:test';
import { createDb } from '../src/client.js';

const url = (): string => process.env.DATABASE_URL ?? '';

it('cancels slow SQL instead of holding a pool slot indefinitely', async () => {
  const { client } = createDb(url());
  try {
    let error: unknown;
    try {
      await client.unsafe('select pg_sleep(16)');
    } catch (caught) {
      error = caught;
    }
    expect((error as { errno?: string } | undefined)?.errno).toBe('57014');
  } finally {
    await client.close();
  }
}, 20_000);
it('times out waiting for an exhausted connection pool', async () => {
  const prior = process.env.DB_POOL_MAX;
  process.env.DB_POOL_MAX = '1';
  const { client } = createDb(url());
  if (prior === undefined) delete process.env.DB_POOL_MAX;
  else process.env.DB_POOL_MAX = prior;
  const held = await client.reserve();
  try {
    let error: unknown;
    try {
      const extra = await client.reserve();
      extra.release();
    } catch (caught) {
      error = caught;
    }
    expect(String((error as Error | undefined)?.message)).toMatch(/timeout/i);
  } finally {
    held.release();
    await client.close();
  }
}, 10_000);
