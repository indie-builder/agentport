import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PERSONAL_MEMORY_FILENAME } from '@agentport/shared';
import { WORKSPACE_DIR_MODE, WORKSPACE_FILE_MODE } from './mcp-token.js';

/**
 * 个人偏好的唯一宿主投影实现。
 *
 * `WORKSPACES_DIR/_users/<sha256(UTF8(businessId)) 的 64 位小写 hex>/CLAUDE.md`
 *
 * businessId 最长 160 个 Unicode 字符，base64url 可达 640 字节、超过文件名上限；
 * 定长摘要不复用原始 ID，API 与 worker 必须用同一规则。
 * 目录 0700、文件 0600，目标缺失或为无链接普通文件；temp + rename 原子替换。
 */
export function personalMemoryDir(workspacesDir: string, businessId: string): string {
  return join(
    workspacesDir,
    '_users',
    createHash('sha256').update(businessId, 'utf8').digest('hex'),
  );
}

export function personalMemoryPath(workspacesDir: string, businessId: string): string {
  return join(personalMemoryDir(workspacesDir, businessId), PERSONAL_MEMORY_FILENAME);
}

async function ensurePersonalDir(dir: string): Promise<void> {
  // 先确认 _users 根是真实目录：否则链接可把某个用户的投影写到别处。
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

/** 目标文件可以是缺失（首次保存），但不能是链接或目录。 */
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

/** 原子投影：0700/0600，拒绝链接，temp + rename。 */
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
