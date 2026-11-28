import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createDb, isPgCode } from '@agentport/db';
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

const MIGRATIONS_DIR = Bun.fileURLToPath(new URL('../../db/migrations', import.meta.url));
const OBJECT_IN_USE_RETRIES = 20;
const OBJECT_IN_USE_DELAY_MS = 50;

let cachedMigrationsHash: Promise<string> | undefined;

function collectRelativeFiles(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return collectRelativeFiles(abs, root);
    if (entry.isFile()) return [relative(root, abs).split(sep).join('/')];
    return [];
  });
}

async function computeMigrationsHash(): Promise<string> {
  const files = collectRelativeFiles(MIGRATIONS_DIR).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hasher = new Bun.CryptoHasher('sha256');
  for (const relPath of files) {
    hasher.update(relPath);
    hasher.update('\0');
    hasher.update(new Uint8Array(await Bun.file(join(MIGRATIONS_DIR, relPath)).arrayBuffer()));
    hasher.update('\0');
  }
  return hasher.digest('hex').slice(0, 12);
}

function migrationsHash(): Promise<string> {
  cachedMigrationsHash ??= computeMigrationsHash().catch((error: unknown) => {
    cachedMigrationsHash = undefined;
    throw error;
  });
  return cachedMigrationsHash;
}

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function retryObjectInUse<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= OBJECT_IN_USE_RETRIES || !isPgCode(error, '55006')) throw error;
      await Bun.sleep(OBJECT_IN_USE_DELAY_MS);
    }
  }
}

export async function createIsolatedDatabase(
  prefix: string,
  adminUrl = process.env.DATABASE_URL ?? '',
): Promise<IsolatedDatabase | null> {
  if (!adminUrl) return null;
  const name = `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const isolatedUrl = databaseUrl(adminUrl, name);

  const admin = createDb(adminUrl, { max: 1 });
  try {
    try {
      await admin.client.unsafe('select 1');
    } catch {
      return null;
    }

    const hash = await migrationsHash();
    const templateName = `backend_test_tpl_${hash}`;
    const lockKey = `agentport_isolated_db_tpl_${hash}`;

    const session = await admin.client.reserve();
    let locked = false;
    try {
      await session.unsafe('set statement_timeout = 0');
      await session.unsafe('select pg_advisory_lock(hashtext($1))', [lockKey]);
      locked = true;

      const existing = await session.unsafe<unknown[]>(
        'select 1 from pg_database where datname = $1',
        [templateName],
      );
      if (existing.length === 0) {
        const tmpName = `backend_test_tpl_tmp_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
        await session.unsafe(`create database "${tmpName}"`);
        let tmpClient: ReturnType<typeof createDb>['client'] | undefined;
        try {
          const tmp = createDb(databaseUrl(adminUrl, tmpName), { max: 1 });
          tmpClient = tmp.client;
          await migrate(tmp.db, { migrationsFolder: MIGRATIONS_DIR });
          await tmp.client.close();
          tmpClient = undefined;
          await retryObjectInUse(() =>
            session.unsafe(`alter database "${tmpName}" rename to "${templateName}"`),
          );
        } catch (error) {
          const cleanupErrors: unknown[] = [];
          if (tmpClient) {
            try {
              await tmpClient.close();
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
          }
          try {
            await session.unsafe(`drop database if exists "${tmpName}" with (force)`);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [error, ...cleanupErrors],
              `template database ${templateName} setup failed and cleanup also failed`,
            );
          }
          throw error;
        }
      }

      await retryObjectInUse(() =>
        session.unsafe(`create database "${name}" template "${templateName}"`),
      );
    } finally {
      if (locked) {
        await session
          .unsafe('select pg_advisory_unlock(hashtext($1))', [lockKey])
          .catch(() => undefined);
      }
      session.release();
    }
  } finally {
    await admin.client.close();
  }

  const target = createDb(isolatedUrl, { max: 1 });
  try {
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
  const admin = createDb(adminUrl, { max: 1 });
  try {
    await admin.client.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.client.close();
  }
}
