import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from '@agentport/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export interface IsolatedDatabase {
  readonly name: string;
  readonly url: string;
  close(): Promise<void>;
}

const ADMIN_DATABASE_URL = process.env.DATABASE_URL ?? '';

/**
 * 全表对账/共享库写入的套件每次独享一个随机库，用完只删自己创建的那个。
 * 连不上服务返回 null 交给调用方跳过；连上后的建库、迁移或身份不符必须抛出。
 */
export async function createIsolatedDatabase(prefix: string): Promise<IsolatedDatabase | null> {
  if (!ADMIN_DATABASE_URL) return null;
  const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const isolatedUrl = url.toString();

  const admin = createDb(ADMIN_DATABASE_URL);
  let created = false;
  try {
    try {
      await admin.pool.query('select 1');
    } catch {
      return null;
    }
    try {
      await admin.pool.query(`create database "${name}"`);
      created = true;
    } catch (error) {
      // 42P04：同名库已存在（重试），复用即可。
      if ((error as { code?: string }).code !== '42P04') throw error;
    }
  } finally {
    await admin.pool.end();
  }

  const target = createDb(isolatedUrl);
  try {
    await migrate(target.db, {
      migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    const identity = await target.pool.query<{ name: string }>('select current_database() as name');
    if (identity.rows[0]?.name !== name) {
      throw new Error(`isolated database identity mismatch: ${identity.rows[0]?.name ?? 'none'}`);
    }
  } catch (error) {
    await target.pool.end().catch(() => undefined);
    if (created) await dropDatabase(name).catch(() => undefined);
    throw error;
  }
  await target.pool.end();
  process.env.DATABASE_URL = isolatedUrl;

  let closed = false;
  return {
    name,
    url: isolatedUrl,
    async close() {
      if (closed || !created) return;
      closed = true;
      await dropDatabase(name);
    },
  };
}

async function dropDatabase(name: string): Promise<void> {
  const admin = createDb(ADMIN_DATABASE_URL);
  try {
    await admin.pool.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.pool.end();
  }
}
