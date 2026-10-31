import { fail, writePersonalMemoryProjection } from '@agentport/core';
import { type Database, type DbPool, repo } from '@agentport/db';
import {
  type MemoryChange,
  PERSONAL_MEMORY_MAX_BYTES,
  PERSONAL_MEMORY_MAX_CHARS,
} from '@agentport/shared';

/**
 * 个人偏好正文上限由 shared 统一维护：9000 个 Unicode 字符（按码点计，不是 UTF-8 字节）。
 * 官方 UserPromptSubmit additionalContext 单次上限为 10,000 字符，这里留出余量。
 * 平台不是依赖官方用户级 CLAUDE.md 自动发现，而是把本文件只读挂载进沙盒后每轮经官方 hook 注入。
 */
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
      before: { content: before?.content ?? '', globs: null, index: null },
      after: { content: input.content, globs: null, index: null },
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
    await writePersonalMemoryProjection(input.workspacesDir, input.businessId, input.content);
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

/** 版本列表只读，不做任何补偿或投影写入。 */
export async function listPersonalMemoryVersions(
  db: Database,
  businessId: string,
  options: { before?: string; limit: number },
): Promise<MemoryChange[]> {
  const rows = await repo.memoryChanges.listPersonalByUser(db, businessId, {
    ...(options.before === undefined ? {} : { before: new Date(options.before) }),
    limit: options.limit,
  });
  return rows.map((row) => repo.memoryChanges.toMemoryChange(row));
}
