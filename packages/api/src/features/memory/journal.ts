import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '@agentport/core';
import type { MemoryReviewTarget } from '@agentport/shared';
import { z } from 'zod';
import { withMemoryJournalDir } from '../agents/memory-files.js';

export type AgentMemoryTarget = Extract<MemoryReviewTarget, { kind: 'agent_memory' }>;

const MAX_JOURNAL_BYTES = 64 * 1024;
const runIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const journalSchema = z
  .object({
    reviewRunId: z.string().min(1),
    target: z.object({ kind: z.literal('agent_memory'), agentId: z.string().min(1) }).strict(),
    beforeSha256: z.string().regex(sha256Pattern).nullable(),
    afterSha256: z.string().regex(sha256Pattern),
  })
  .strict();

export type MemoryJournalEntry = z.infer<typeof journalSchema>;

/** 缺失文件用 null 参与比较，与空文件区分开。 */
export function memorySha256(content: string | null): string | null {
  return content === null ? null : createHash('sha256').update(content, 'utf8').digest('hex');
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function journalName(reviewRunId: string): string {
  if (!runIdPattern.test(reviewRunId)) fail('INVALID_INPUT', '记忆审核运行 ID 非法');
  return `${reviewRunId}.json`;
}

function corrupt(file: string): Error {
  return new Error(`Memory write journal is invalid: ${file}`);
}

export async function readMemoryJournal(
  workspacesDir: string,
  slug: string,
  reviewRunId: string,
  target: AgentMemoryTarget,
): Promise<MemoryJournalEntry | null> {
  const name = journalName(reviewRunId);
  try {
    return await withMemoryJournalDir(workspacesDir, slug, false, async (dir) => {
      const file = join(dir, name);
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) throw corrupt(file);
      if (info.size > MAX_JOURNAL_BYTES) throw corrupt(file);
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let text: string;
      try {
        text = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw corrupt(file);
      }
      const entry = journalSchema.safeParse(parsed);
      if (
        !entry.success ||
        entry.data.reviewRunId !== reviewRunId ||
        entry.data.target.agentId !== target.agentId
      ) {
        throw corrupt(file);
      }
      return entry.data;
    });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/**
 * 按目标扫描未完成的写入日志：手工保存/删除/回滚不能只看自己拿到的 reviewRunId，
 * 同一目标上任何残留日志都说明文件与账本可能尚未对齐。
 */
export async function findMemoryJournalForTarget(
  workspacesDir: string,
  slug: string,
  target: AgentMemoryTarget,
): Promise<MemoryJournalEntry | null> {
  try {
    return await withMemoryJournalDir(workspacesDir, slug, false, async (dir) => {
      for (const name of await readdir(dir)) {
        const reviewRunId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
        if (!runIdPattern.test(reviewRunId)) continue;
        const entry = await readMemoryJournal(workspacesDir, slug, reviewRunId, target);
        if (entry) return entry;
      }
      return null;
    });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** 锁内、rename 前写入；失败时调用方必须停止写文件。 */
export async function writeMemoryJournal(
  workspacesDir: string,
  slug: string,
  entry: MemoryJournalEntry,
): Promise<void> {
  journalSchema.parse(entry);
  const name = journalName(entry.reviewRunId);
  await withMemoryJournalDir(workspacesDir, slug, true, async (dir) => {
    // 目录可能是上次遗留或外部预建的：强制收紧到 0700。
    await chmod(dir, 0o700);
    const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(JSON.stringify(entry), 'utf8');
      await handle.close();
      handle = undefined;
      await rename(temp, join(dir, name));
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
    }
  });
}

export async function deleteMemoryJournal(
  workspacesDir: string,
  slug: string,
  reviewRunId: string,
): Promise<void> {
  const name = journalName(reviewRunId);
  try {
    await withMemoryJournalDir(workspacesDir, slug, false, async (dir) => {
      try {
        await unlink(join(dir, name));
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    });
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}
