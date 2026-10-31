import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createDb, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalMemoryDir, projectPersonalMemory } from '../src/personal-memory.js';

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
const businessId = 'personal.projection';
const otherBusinessId = 'personal.projection.other';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  if (!ready) return;
  await db.insert(schema.userPreferences).values({ businessId, content: '初始偏好', revision: 1 });
});

afterAll(async () => {
  if (ready) {
    await db
      .delete(schema.userPreferences)
      .where(eq(schema.userPreferences.businessId, businessId));
    await db
      .delete(schema.userPreferences)
      .where(eq(schema.userPreferences.businessId, otherBusinessId));
  }
  await dbHandle.pool.end();
});

describe.skipIf(!ready)('projectPersonalMemory', () => {
  it('rewrites the projection under the sha256 directory with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    try {
      await db
        .update(schema.userPreferences)
        .set({ content: '恢复后的偏好', revision: 4 })
        .where(eq(schema.userPreferences.businessId, businessId));
      const dir = personalMemoryDir(root, businessId);
      expect(dir.startsWith(join(root, '_users'))).toBe(true);
      expect(basename(dir)).toMatch(/^[0-9a-f]{64}$/);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'CLAUDE.md'), 'stale');

      await projectPersonalMemory(db, dbHandle.pool, root, businessId);

      const file = join(dir, 'CLAUDE.md');
      expect(await readFile(file, 'utf8')).toBe('恢复后的偏好');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects a 160-character Unicode business ID without exceeding filesystem name limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    const longBusinessId = '人'.repeat(160);
    try {
      await db
        .insert(schema.userPreferences)
        .values({ businessId: longBusinessId, content: '长身份偏好' })
        .onConflictDoUpdate({
          target: schema.userPreferences.businessId,
          set: { content: '长身份偏好', revision: 1 },
        });

      await projectPersonalMemory(db, dbHandle.pool, root, longBusinessId);

      const dir = personalMemoryDir(root, longBusinessId);
      expect(basename(dir)).toHaveLength(64);
      expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe('长身份偏好');
    } finally {
      if (ready) {
        await db
          .delete(schema.userPreferences)
          .where(eq(schema.userPreferences.businessId, longBusinessId));
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps two business users in separate projections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    try {
      await db
        .update(schema.userPreferences)
        .set({ content: '第一个人的偏好', revision: 1 })
        .where(eq(schema.userPreferences.businessId, businessId));
      await db
        .insert(schema.userPreferences)
        .values({ businessId: otherBusinessId, content: '另一个人的偏好', revision: 1 })
        .onConflictDoUpdate({
          target: schema.userPreferences.businessId,
          set: { content: '另一个人的偏好', revision: 1 },
        });

      await projectPersonalMemory(db, dbHandle.pool, root, businessId);
      await projectPersonalMemory(db, dbHandle.pool, root, otherBusinessId);

      const first = personalMemoryDir(root, businessId);
      const second = personalMemoryDir(root, otherBusinessId);
      expect(first).not.toBe(second);
      expect(await readFile(join(first, 'CLAUDE.md'), 'utf8')).toBe('第一个人的偏好');
      expect(await readFile(join(second, 'CLAUDE.md'), 'utf8')).toBe('另一个人的偏好');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked projection and leaves the target untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    try {
      const dir = personalMemoryDir(root, businessId);
      const outside = join(root, 'outside.md');
      await writeFile(outside, 'do not touch');
      await mkdir(dir, { recursive: true });
      await symlink(outside, join(dir, 'CLAUDE.md'));

      await expect(projectPersonalMemory(db, dbHandle.pool, root, businessId)).rejects.toThrow(
        'without links',
      );
      expect(await readFile(outside, 'utf8')).toBe('do not touch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits on the same business advisory lock used by API saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    const client = await dbHandle.pool.connect();
    try {
      await client.query('set statement_timeout = 0');
      await client.query('select pg_advisory_lock(hashtext($1))', [`user:${businessId}`]);
      const projection = projectPersonalMemory(db, dbHandle.pool, root, businessId);
      expect(
        await Promise.race([projection.then(() => 'done'), sleep(150).then(() => 'waiting')]),
      ).toBe('waiting');
      await client.query('select pg_advisory_unlock(hashtext($1))', [`user:${businessId}`]);
      await projection;
    } finally {
      client.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
