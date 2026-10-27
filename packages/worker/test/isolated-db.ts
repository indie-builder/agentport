import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from '@agentport/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export interface IsolatedDatabase {
  readonly name: string;
  readonly url: string;
  close(): Promise<void>;
}

export interface BackendInfra {
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    backendInfra: BackendInfra;
  }
}

/**
 * 全表对账/共享库写入的套件每次独享一个随机库，用完只删自己创建的那个。
 * 连不上服务返回 null 交给调用方跳过；连上后的建库、迁移或身份不符必须抛出。
 * 不修改 process.env：调用方显式使用返回的 url。
 */
export async function createIsolatedDatabase(
  prefix: string,
  adminUrl = process.env.DATABASE_URL ?? '',
): Promise<IsolatedDatabase | null> {
  if (!adminUrl) return null;
  const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const isolatedUrl = url.toString();

  const admin = createDb(adminUrl);
  try {
    try {
      await admin.pool.query('select 1');
    } catch {
      return null;
    }
    // 随机库名撞名说明有缺陷，直接抛出，不接管别人的库。
    await admin.pool.query(`create database "${name}"`);
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
    const cleanupErrors: unknown[] = [];
    try {
      await target.pool.end();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await dropDatabase(adminUrl, name);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `isolated database ${name} setup failed and cleanup also failed`,
      );
    }
    throw error;
  }
  await target.pool.end();

  let closed = false;
  return {
    name,
    url: isolatedUrl,
    async close() {
      if (closed) return;
      await dropDatabase(adminUrl, name);
      closed = true;
    },
  };
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = createDb(adminUrl);
  try {
    await admin.pool.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.pool.end();
  }
}
