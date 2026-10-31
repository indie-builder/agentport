import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PERSONAL_MEMORY_FILENAME } from '@agentport/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  personalMemoryDir,
  personalMemoryPath,
  writePersonalMemoryProjection,
} from '../src/personal-memory.js';

const fsFaults = vi.hoisted(() => ({ failRename: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFaults.failRename) throw new Error('injected rename failure');
      return actual.rename(...args);
    },
  };
});

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'personal-memory-'));
});

afterEach(async () => {
  fsFaults.failRename = false;
  await rm(root, { recursive: true, force: true });
});

function expectedDir(businessId: string): string {
  return join(root, '_users', createHash('sha256').update(businessId, 'utf8').digest('hex'));
}

describe('personal memory projection', () => {
  it('projects content into the sha256 directory with private permissions', async () => {
    const businessId = 'user.one';
    const dir = personalMemoryDir(root, businessId);
    expect(dir).toBe(expectedDir(businessId));
    expect(basename(dir)).toMatch(/^[0-9a-f]{64}$/);
    expect(personalMemoryPath(root, businessId)).toBe(join(dir, PERSONAL_MEMORY_FILENAME));

    await writePersonalMemoryProjection(root, businessId, '# 偏好\n');
    const file = personalMemoryPath(root, businessId);
    expect(await readFile(file, 'utf8')).toBe('# 偏好\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, '_users'))).mode & 0o777).toBe(0o700);

    await writePersonalMemoryProjection(root, businessId, 'next');
    expect(await readFile(file, 'utf8')).toBe('next');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps a 160-character Unicode business id in a fixed 64-character directory', async () => {
    const businessId = '人'.repeat(160);
    const dir = personalMemoryDir(root, businessId);
    expect(basename(dir)).toHaveLength(64);
    expect(dir).not.toBe(personalMemoryDir(root, 'user.other'));

    await writePersonalMemoryProjection(root, businessId, '长身份偏好');
    expect(await readFile(personalMemoryPath(root, businessId), 'utf8')).toBe('长身份偏好');
  });

  it('refuses a symlinked target and leaves the external file untouched', async () => {
    const businessId = 'user.symlink';
    const dir = personalMemoryDir(root, businessId);
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'do not touch');
    await mkdir(dir, { recursive: true });
    await symlink(outside, personalMemoryPath(root, businessId));

    await expect(writePersonalMemoryProjection(root, businessId, 'new')).rejects.toThrow(
      /without links/,
    );
    expect(await readFile(outside, 'utf8')).toBe('do not touch');
  });

  it('refuses an existing hard link and leaves the target untouched', async () => {
    const businessId = 'user.hardlink';
    const dir = personalMemoryDir(root, businessId);
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'original');
    await mkdir(dir, { recursive: true });
    await link(outside, personalMemoryPath(root, businessId));

    await expect(writePersonalMemoryProjection(root, businessId, 'new')).rejects.toThrow(
      /without links/,
    );
    expect(await readFile(outside, 'utf8')).toBe('original');
    expect((await stat(outside)).nlink).toBe(2);
  });

  it('refuses symlinked projection directories', async () => {
    const realRoot = join(root, 'real-users');
    await mkdir(realRoot);
    await symlink(realRoot, join(root, '_users'));
    await expect(writePersonalMemoryProjection(root, 'user.root', 'x')).rejects.toThrow(
      /real directory/,
    );
    expect(await readdir(realRoot)).toEqual([]);

    await rm(join(root, '_users'));
    await mkdir(join(root, '_users'));
    const outsideDir = join(root, 'outside-dir');
    await mkdir(outsideDir);
    await symlink(outsideDir, personalMemoryDir(root, 'user.dir'));
    await expect(writePersonalMemoryProjection(root, 'user.dir', 'x')).rejects.toThrow(
      /real directory/,
    );
    expect(await readdir(outsideDir)).toEqual([]);
  });

  it('removes its own temporary file after a failed rename', async () => {
    const businessId = 'user.fail';
    await writePersonalMemoryProjection(root, businessId, 'first');

    fsFaults.failRename = true;
    await expect(writePersonalMemoryProjection(root, businessId, 'second')).rejects.toThrow(
      'injected rename failure',
    );
    fsFaults.failRename = false;

    const dir = personalMemoryDir(root, businessId);
    expect(await readdir(dir)).toEqual([PERSONAL_MEMORY_FILENAME]);
    expect(await readFile(personalMemoryPath(root, businessId), 'utf8')).toBe('first');
  });
});
