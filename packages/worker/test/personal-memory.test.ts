import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { personalMemoryDir } from '@agentport/core';
import { createDb, schema } from '@agentport/db';
import { DEFAULT_MEMORY_POLICY } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import {
  personalMemoryBusinessIdForRun,
  projectPersonalMemory,
} from '../src/memory/personal-memory.js';

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;

async function probeDatabase(): Promise<boolean> {
  try {
    await dbHandle.client.unsafe('select 1');
    return true;
  } catch {
    return false;
  }
}

const ready = await probeDatabase();
const businessId = 'personal.projection';

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
  }
  await dbHandle.client.close();
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

      await projectPersonalMemory(db, dbHandle.client, root, businessId);

      const file = join(dir, 'CLAUDE.md');
      expect(await readFile(file, 'utf8')).toBe('恢复后的偏好');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits on the same business advisory lock used by API saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-projection-'));
    const client = await dbHandle.client.reserve();
    try {
      await client.unsafe('set statement_timeout = 0');
      await client.unsafe('select pg_advisory_lock(hashtext($1))', [`user:${businessId}`]);
      const projection = projectPersonalMemory(db, dbHandle.client, root, businessId);
      expect(
        await Promise.race([projection.then(() => 'done'), sleep(150).then(() => 'waiting')]),
      ).toBe('waiting');
      await client.unsafe('select pg_advisory_unlock(hashtext($1))', [`user:${businessId}`]);
      await projection;
    } finally {
      client.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('personalMemoryBusinessIdForRun', () => {
  const user = { kind: 'user' as const, businessId: 'user-1' };

  it('returns the business ID only for private user runs with injection enabled', () => {
    expect(
      personalMemoryBusinessIdForRun({
        subject: user,
        channelId: null,
        policy: DEFAULT_MEMORY_POLICY,
      }),
    ).toBe('user-1');
  });

  it('skips projection when injectPersonalMemory is false', () => {
    expect(
      personalMemoryBusinessIdForRun({
        subject: user,
        channelId: null,
        policy: { ...DEFAULT_MEMORY_POLICY, injectPersonalMemory: false },
      }),
    ).toBeUndefined();
  });

  it('does not relax the channel and service boundaries', () => {
    expect(
      personalMemoryBusinessIdForRun({
        subject: user,
        channelId: 'channel-1',
        policy: DEFAULT_MEMORY_POLICY,
      }),
    ).toBeUndefined();
    expect(
      personalMemoryBusinessIdForRun({
        subject: { kind: 'service', serviceId: 'system' },
        channelId: null,
        policy: DEFAULT_MEMORY_POLICY,
      }),
    ).toBeUndefined();
  });
});
