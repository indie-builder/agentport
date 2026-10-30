import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_MODE, WORKSPACE_FILE_MODE } from '@agentport/core';
import { ADMIN_USER_ID, type Database, type DbPool, repo } from '@agentport/db';

/**
 * 每轮聊天运行前按 DB 最新个人偏好重写 `_user/CLAUDE.md`。
 * 与 API 保存共用 user:<id> 会话锁：不会再出现 worker 读到旧值、随后覆盖 API 新投影的情况。
 */
export async function projectPersonalMemory(
  db: Database,
  pool: DbPool,
  workspacesDir: string,
  userId: string = ADMIN_USER_ID,
): Promise<void> {
  await repo.locks.withAdvisoryLock(
    pool,
    repo.locks.memoryTargetLockKey({ kind: 'personal' }, userId),
    async () => {
      const row = await repo.userPreferences.get(db, userId);
      await project(workspacesDir, row?.content ?? '');
    },
  );
}

async function project(workspacesDir: string, content: string): Promise<void> {
  const dir = join(workspacesDir, '_user');
  await mkdir(dir, { recursive: true, mode: WORKSPACE_DIR_MODE });
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    throw new Error(`Personal memory path must be a real directory: ${dir}`);
  }
  await chmod(dir, WORKSPACE_DIR_MODE);

  const target = join(dir, 'CLAUDE.md');
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Personal memory file must be a regular file without links: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temp = join(dir, `.CLAUDE.md.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content, { mode: WORKSPACE_FILE_MODE, flag: 'wx' });
    await chmod(temp, WORKSPACE_FILE_MODE);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
