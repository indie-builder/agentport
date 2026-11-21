import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from '@agentport/db';
import { migrate } from 'drizzle-orm/bun-sql/migrator';

export interface IsolatedDatabase {
  readonly name: string;
  readonly url: string;
  close(): Promise<void>;
}

export interface BackendInfra {
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
}

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
      await admin.client.unsafe('select 1');
    } catch {
      return null;
    }
    await admin.client.unsafe(`create database "${name}"`);
  } finally {
    await admin.client.close();
  }

  const target = createDb(isolatedUrl);
  try {
    await migrate(target.db, {
      migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    const identity = await target.client.unsafe<{ name: string }[]>(
      'select current_database() as name',
    );
    if (identity[0]?.name !== name) {
      throw new Error(`isolated database identity mismatch: ${identity[0]?.name ?? 'none'}`);
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await target.client.close();
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
  await target.client.close();

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
    await admin.client.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.client.close();
  }
}
