import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '@agentport/core';
import { type MemoryReviewTarget, memoryFileNameSchema } from '@agentport/shared';
import { z } from 'zod';
import { withMemoryJournalDir } from '../agents/memory-files.js';

export type AgentMemoryTarget = Extract<MemoryReviewTarget, { kind: 'agent_memory' }>;

/** 一次写入可能同时改主题正文与伴随索引。 */
export type MemoryJournalOperation = 'review' | 'rollback' | 'manual';

/**
 * 两条文件上限合计 200000 + 25KB，journal 还要保存恢复用的原始字节（base64 约 4/3）；
 * 保留一倍余量，合法主题不会被日志自己的限额挡住。
 */
const MAX_JOURNAL_BYTES = 512 * 1024;
const operationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const journalFileSchema = z
  .object({
    name: memoryFileNameSchema,
    /** null 表示该文件当时不存在。 */
    beforeSha256: z.string().regex(sha256Pattern).nullable(),
    afterSha256: z.string().regex(sha256Pattern).nullable(),
    /** 恢复用原始字节；null 表示恢复时应删除该文件。 */
    beforeBase64: z.string().nullable(),
  })
  .strict();

const journalSchema = z
  .object({
    operation: z.enum(['review', 'rollback', 'manual']),
    /** 审核 run ID、回滚的变更 ID 或手工写入的随机 ID，同时也是日志文件名。 */
    operationId: z.string().regex(operationIdPattern),
    businessId: z.string().min(1),
    target: z
      .object({
        kind: z.literal('agent_memory'),
        agentId: z.string().min(1),
        name: memoryFileNameSchema,
      })
      .strict(),
    files: z.array(journalFileSchema).min(1).max(2),
  })
  .strict();

export type MemoryJournalFile = z.infer<typeof journalFileSchema>;
export type MemoryJournalEntry = z.infer<typeof journalSchema>;

/** 缺失文件用 null 参与比较，与空文件区分开。 */
export function memorySha256(content: string | null): string | null {
  return content === null ? null : createHash('sha256').update(content, 'utf8').digest('hex');
}

export function bufferSha256(content: Buffer | null): string | null {
  return content === null ? null : createHash('sha256').update(content).digest('hex');
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function journalName(operationId: string): string {
  if (!operationIdPattern.test(operationId)) fail('INVALID_INPUT', '记忆写入操作 ID 非法');
  return `${operationId}.json`;
}

function corrupt(file: string): Error {
  return new Error(`Memory write journal is invalid: ${file}`);
}

async function readJournalFile(dir: string, operationId: string): Promise<MemoryJournalEntry> {
  const file = join(dir, journalName(operationId));
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw corrupt(file);
  if (info.size > MAX_JOURNAL_BYTES) throw corrupt(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
  if (!entry.success || entry.data.operationId !== operationId) throw corrupt(file);
  return entry.data;
}

/** 按操作身份读取；不存在返回 null，损坏直接抛错，不静默忽略。 */
export async function readMemoryJournal(
  workspacesDir: string,
  slug: string,
  operationId: string,
): Promise<MemoryJournalEntry | null> {
  try {
    return await withMemoryJournalDir(workspacesDir, slug, false, async (dir) =>
      readJournalFile(dir, operationId),
    );
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/**
 * 扫描该专家全部日志：其它目标的有效记录原样返回，损坏记录直接报错。
 * 索引是共享资源，调用方据此判断是否还有未完成的写入。
 */
export async function listMemoryJournals(
  workspacesDir: string,
  slug: string,
): Promise<MemoryJournalEntry[]> {
  try {
    return await withMemoryJournalDir(workspacesDir, slug, false, async (dir) => {
      const entries: MemoryJournalEntry[] = [];
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.json')) continue;
        const operationId = name.slice(0, -'.json'.length);
        if (!operationIdPattern.test(operationId)) continue;
        entries.push(await readJournalFile(dir, operationId));
      }
      return entries;
    });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  }
}

export function journalMatchesTarget(
  entry: MemoryJournalEntry,
  target: AgentMemoryTarget,
): boolean {
  return entry.target.agentId === target.agentId && entry.target.name === target.name;
}

/** 锁内、rename 前写入；失败时调用方必须停止写文件。 */
export async function writeMemoryJournal(
  workspacesDir: string,
  slug: string,
  entry: MemoryJournalEntry,
): Promise<void> {
  journalSchema.parse(entry);
  if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > MAX_JOURNAL_BYTES) {
    throw new Error('memory write journal exceeds its size limit');
  }
  const name = journalName(entry.operationId);
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
  operationId: string,
): Promise<void> {
  const name = journalName(operationId);
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
