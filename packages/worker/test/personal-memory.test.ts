import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectPersonalMemory } from '../src/personal-memory.js';

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;

async function probeDatabase(): Promise<boolean> {
  try {
    await dbHandle.pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

const ready = await probeDatabase();
const userId = newId('user');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  if (!ready) return;
  await db.insert(schema.authUsers).values({
    id: userId,
    name: 'personal projection',
    email: `personal-projection-${userId.slice(4)}@test.local`,
  });
});

afterAll(async () => {
  if (ready) await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
  await dbHandle.pool.end();
});

describe.skipIf(!ready)('projectPersonalMemory', () => {
  it('rewrites the projection with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    try {
      await db.insert(schema.userPreferences).values({
        userId,
        content: '恢复后的偏好',
        revision: 4,
      });
      await mkdir(join(root, '_user'), { recursive: true });
      await writeFile(join(root, '_user', 'CLAUDE.md'), 'stale');

      await projectPersonalMemory(db, dbHandle.pool, root, userId);

      const file = join(root, '_user', 'CLAUDE.md');
      expect(await readFile(file, 'utf8')).toBe('恢复后的偏好');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, '_user'))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked projection and leaves the target untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    try {
      const outside = join(root, 'outside.md');
      await writeFile(outside, 'do not touch');
      await mkdir(join(root, '_user'), { recursive: true });
      await symlink(outside, join(root, '_user', 'CLAUDE.md'));

      await expect(projectPersonalMemory(db, dbHandle.pool, root, userId)).rejects.toThrow(
        'without links',
      );
      expect(await readFile(outside, 'utf8')).toBe('do not touch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits on the same user advisory lock used by API saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    const client = await dbHandle.pool.connect();
    try {
      await client.query('set statement_timeout = 0');
      await client.query('select pg_advisory_lock(hashtext($1))', [`user:${userId}`]);
      const projection = projectPersonalMemory(db, dbHandle.pool, root, userId);
      expect(
        await Promise.race([projection.then(() => 'done'), sleep(150).then(() => 'waiting')]),
      ).toBe('waiting');
      await client.query('select pg_advisory_unlock(hashtext($1))', [`user:${userId}`]);
      await projection;
    } finally {
      client.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
