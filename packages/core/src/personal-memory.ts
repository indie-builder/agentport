import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PERSONAL_MEMORY_FILENAME } from '@agentport/shared';
import * as Bun from 'bun';
import { WORKSPACE_DIR_MODE, WORKSPACE_FILE_MODE } from './mcp-token.js';

export function personalMemoryDir(workspacesDir: string, businessId: string): string {
  return join(
    workspacesDir,
    '_users',
    new Bun.CryptoHasher('sha256').update(businessId, 'utf8').digest('hex'),
  );
}

export function personalMemoryPath(workspacesDir: string, businessId: string): string {
  return join(personalMemoryDir(workspacesDir, businessId), PERSONAL_MEMORY_FILENAME);
}

async function ensurePersonalDir(dir: string): Promise<void> {
  const usersDir = join(dir, '..');
  await mkdir(usersDir, { recursive: true, mode: WORKSPACE_DIR_MODE });
  const usersInfo = await lstat(usersDir);
  if (!usersInfo.isDirectory() || usersInfo.isSymbolicLink()) {
    throw new Error(`Personal memory root must be a real directory: ${usersDir}`);
  }
  await chmod(usersDir, WORKSPACE_DIR_MODE);
  await mkdir(dir, { recursive: true, mode: WORKSPACE_DIR_MODE });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Personal memory path must be a real directory: ${dir}`);
  }
  await chmod(dir, WORKSPACE_DIR_MODE);
}

async function assertReplaceableFile(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Personal memory file must be a regular file without links: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function writePersonalMemoryProjection(
  workspacesDir: string,
  businessId: string,
  content: string,
): Promise<void> {
  const dir = personalMemoryDir(workspacesDir, businessId);
  await ensurePersonalDir(dir);
  const file = personalMemoryPath(workspacesDir, businessId);
  await assertReplaceableFile(file);
  const temp = join(dir, `.${PERSONAL_MEMORY_FILENAME}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content, { mode: WORKSPACE_FILE_MODE, flag: 'wx' });
    await chmod(temp, WORKSPACE_FILE_MODE);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
