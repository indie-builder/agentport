import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, WORKSPACE_DIR_MODE, WORKSPACE_FILE_MODE } from '@agentport/core';
import { type Database, type DbPool, repo } from '@agentport/db';
import type { MemoryChange } from '@agentport/shared';

/**
 * 个人偏好正文上限：9000 个 Unicode 字符（按码点计，不是 UTF-8 字节）。
 * 官方 UserPromptSubmit additionalContext 单次上限为 10,000 字符，这里留出余量。
 * 平台不是依赖官方用户级 CLAUDE.md 自动发现，而是把本文件只读挂载进沙盒后每轮经官方 hook 注入。
 */
export const PERSONAL_MEMORY_MAX_CHARS = 9000;

/** 异常内容护栏：9000 个字符最坏约 36 KB，超过说明文件异常，读写都拒绝。 */
const PERSONAL_MEMORY_MAX_BYTES = 36 * 1024;

export const PERSONAL_MEMORY_FILENAME = 'CLAUDE.md';

const PERSONAL_MEMORY_LIMIT_MESSAGE = '个人偏好最多 9000 个字符，请精简后保存';

/** 入口与审核采纳共用：超限直接拒绝，不静默截断。 */
function assertPersonalMemoryLimit(content: string): void {
  if (
    [...content].length > PERSONAL_MEMORY_MAX_CHARS ||
    Buffer.byteLength(content, 'utf8') > PERSONAL_MEMORY_MAX_BYTES
  ) {
    fail('PAYLOAD_TOO_LARGE', PERSONAL_MEMORY_LIMIT_MESSAGE);
  }
}

/**
 * 宿主投影目录：WORKSPACES_DIR/_users/<sha256(UTF8(businessId)) 的 64 位小写 hex>，只读挂载到沙盒。
 * businessId 最长 160 个 Unicode 字符，base64url 可达 640 字节、超过文件名上限；
 * 定长摘要不复用原始 ID，API 与 worker 必须用同一规则。
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

export interface PersonalMemory {
  content: string;
  revision: number;
  updatedAt: string | null;
}

export interface PersonalMemoryWriteResult extends PersonalMemory {
  changeId: string;
}

/** 文件投影失败只影响日志，不影响已提交的 DB 写入。 */
export interface MemoryWriteLogger {
  warn(obj: unknown, msg?: string): void;
}

/** 行不存在等价于空白记忆；updatedAt 只表示真实写入过的时刻。 */
export async function readPersonalMemory(
  db: Database,
  businessId: string,
): Promise<PersonalMemory> {
  const row = await repo.userPreferences.get(db, businessId);
  return row === null
    ? { content: '', revision: 0, updatedAt: null }
    : {
        content: row.content,
        revision: row.revision,
        updatedAt: row.updatedAt.toISOString(),
      };
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
async function projectPersonalFile(
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

/**
 * 锁内保存：条件更新与变更账本在同一事务提交，DB 是成功依据；
 * 文件只是投影，写失败只记录日志，下一次 worker 运行前会按 DB 重建。
 * 调用方必须已持有该用户的会话锁。
 */
export async function writePersonalMemoryLocked(input: {
  db: Database;
  workspacesDir: string;
  businessId: string;
  content: string;
  expectedRevision: number;
  /** 采纳/回滚要求目标仍是审核时的内容；手工保存不传。 */
  expectedContent?: string;
  /** 采纳审核提案时记录来源运行；手工保存不传。 */
  sourceReviewRunId?: string;
  /** 回滚时指向被撤销的变更；普通保存不传。 */
  reversesChangeId?: string;
  logger?: MemoryWriteLogger;
}): Promise<PersonalMemoryWriteResult | null> {
  assertPersonalMemoryLimit(input.content);
  const before = await repo.userPreferences.get(input.db, input.businessId);
  if (input.expectedContent !== undefined && (before?.content ?? '') !== input.expectedContent) {
    fail('CONFLICT', '目标内容在审核后已被修改，请刷新后重试');
  }

  const saved = await input.db.transaction(async (tx) => {
    // drizzle 的事务类型不带 $client；repo 统一接收 Database，运行时接口一致。
    const db = tx as unknown as Database;
    const row = await repo.userPreferences.upsertWithRevision(
      db,
      input.businessId,
      input.content,
      input.expectedRevision,
    );
    if (row === null) return null;
    const change = await repo.memoryChanges.insert(db, {
      businessId: input.businessId,
      target: { kind: 'personal' },
      before: { content: before?.content ?? '', globs: null },
      after: { content: input.content, globs: null },
      sourceReviewRunId: input.sourceReviewRunId ?? null,
      reversesChangeId: input.reversesChangeId ?? null,
    });
    if (input.sourceReviewRunId) {
      const decided = await repo.memoryReviews.updateDecisionIfPending(
        db,
        input.sourceReviewRunId,
        'applied',
        change.id,
      );
      // 锁内不应再有人改决定；走到这里说明数据被外部改写，回滚整个事务。
      if (!decided) throw new Error('review decision changed under memory lock');
    }
    return {
      content: row.content,
      revision: row.revision,
      updatedAt: row.updatedAt,
      changeId: change.id,
    };
  });
  if (saved === null) return null;

  try {
    await projectPersonalFile(input.workspacesDir, input.businessId, input.content);
  } catch (error) {
    input.logger?.warn(
      { err: error },
      'personal memory projection failed; database content will be projected before the next run',
    );
  }

  return {
    content: saved.content,
    revision: saved.revision,
    updatedAt: saved.updatedAt.toISOString(),
    changeId: saved.changeId,
  };
}

/** 手工保存入口：整段操作持有 user:<id> 会话锁，避免与 worker 投影交错。 */
export async function writePersonalMemory(input: {
  db: Database;
  pool: DbPool;
  workspacesDir: string;
  businessId: string;
  content: string;
  expectedRevision: number;
  logger?: MemoryWriteLogger;
}): Promise<PersonalMemoryWriteResult | null> {
  return repo.locks.withAdvisoryLock(
    input.pool,
    repo.locks.memoryTargetLockKey({ kind: 'personal' }, input.businessId),
    () => writePersonalMemoryLocked(input),
  );
}

function toMemoryChange(row: Awaited<ReturnType<typeof repo.memoryChanges.listByUser>>[number]) {
  return {
    id: row.id,
    target: row.target,
    before: row.before,
    after: row.after,
    sourceReviewRunId: row.sourceReviewRunId,
    reversesChangeId: row.reversesChangeId,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
  } satisfies MemoryChange;
}

/** 版本列表只读，不做任何补偿或投影写入。 */
export async function listPersonalMemoryVersions(
  db: Database,
  businessId: string,
  options: { before?: string; limit: number },
): Promise<MemoryChange[]> {
  const rows = await repo.memoryChanges.listByUser(db, businessId, options.limit);
  // shortcut: before 只在已取页内过滤；个人记忆变更量很小，需要跨页精确游标时给 repo.listByUser 加 before。
  if (options.before === undefined) return rows.map(toMemoryChange);
  const cutoff = new Date(options.before);
  return rows.filter((row) => row.createdAt < cutoff).map(toMemoryChange);
}
