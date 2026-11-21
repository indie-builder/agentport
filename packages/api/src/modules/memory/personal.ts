import { fail, writePersonalMemoryProjection } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import {
  type MemoryChange,
  PERSONAL_MEMORY_MAX_BYTES,
  PERSONAL_MEMORY_MAX_CHARS,
} from '@agentport/shared';
import type { SQL } from 'bun';
import { recordMemoryChange } from './ledger.js';

const PERSONAL_MEMORY_LIMIT_MESSAGE = `个人偏好最多 ${PERSONAL_MEMORY_MAX_CHARS} 个字符，请精简后保存`;

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

export interface MemoryWriteLogger {
  warn(obj: unknown, msg?: string): void;
}

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

export async function writePersonalMemoryLocked(input: {
  db: Database;
  workspacesDir: string;
  businessId: string;
  content: string;
  expectedRevision: number;
  expectedContent?: string;
  sourceReviewRunId?: string;
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
    const change = await recordMemoryChange(db, {
      businessId: input.businessId,
      target: { kind: 'personal' },
      before: { content: before?.content ?? '', globs: null, index: null },
      after: { content: input.content, globs: null, index: null },
      sourceReviewRunId: input.sourceReviewRunId ?? null,
      reversesChangeId: input.reversesChangeId ?? null,
    });
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

export async function writePersonalMemory(input: {
  db: Database;
  client: SQL;
  workspacesDir: string;
  businessId: string;
  content: string;
  expectedRevision: number;
  logger?: MemoryWriteLogger;
}): Promise<PersonalMemoryWriteResult | null> {
  return repo.locks.withAdvisoryLock(
    input.client,
    repo.locks.memoryTargetLockKey({ kind: 'personal' }, input.businessId),
    () => writePersonalMemoryLocked(input),
  );
}

export async function listPersonalMemoryVersions(
  db: Database,
  businessId: string,
  options: { before?: Date; limit: number },
): Promise<MemoryChange[]> {
  const rows = await repo.memoryChanges.listPersonalByUser(db, businessId, options);
  return rows.map((row) => repo.memoryChanges.toMemoryChange(row));
}
