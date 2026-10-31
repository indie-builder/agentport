import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_DIR_MODE, WORKSPACE_FILE_MODE } from '@agentport/core';
import { type Database, type DbPool, repo } from '@agentport/db';

/**
 * 个人目录名不能直接拼业务 ID，也不用 base64url：160 个 Unicode 字符编码后可达 640 字节，
 * 超过单文件名上限。改用 Node 原生 SHA-256 的 64 位小写 hex，长度固定且不暴露原值。
 * API 保存个人偏好时必须使用同一规则计算目录。
 */
export function personalMemoryDir(workspacesDir: string, businessId: string): string {
  return join(
    workspacesDir,
    '_users',
    createHash('sha256').update(businessId, 'utf8').digest('hex'),
  );
}

/**
 * 每轮用户聊天运行前按 DB 最新个人偏好重写该用户的 `CLAUDE.md`。
 * businessId 必传：服务主体没有个人记忆，也不存在默认管理员回退。
 * 与 API 保存共用 user:<businessId> 会话锁：worker 不会读到旧值后又覆盖 API 新投影。
 */
export async function projectPersonalMemory(
  db: Database,
  pool: DbPool,
  workspacesDir: string,
  businessId: string,
): Promise<void> {
  await repo.locks.withAdvisoryLock(
    pool,
    repo.locks.memoryTargetLockKey({ kind: 'personal' }, businessId),
    async () => {
      const row = await repo.userPreferences.get(db, businessId);
      await project(personalMemoryDir(workspacesDir, businessId), row?.content ?? '');
    },
  );
}

async function project(dir: string, content: string): Promise<void> {
  const usersDir = join(dir, '..');
  await mkdir(usersDir, { recursive: true, mode: WORKSPACE_DIR_MODE });
  const usersInfo = await lstat(usersDir);
  if (usersInfo.isSymbolicLink() || !usersInfo.isDirectory()) {
    throw new Error(`Personal memory root must be a real directory: ${usersDir}`);
  }
  await chmod(usersDir, WORKSPACE_DIR_MODE);

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
