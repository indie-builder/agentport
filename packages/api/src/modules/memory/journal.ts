import { constants } from 'node:fs';
import { chmod, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, sha256Hex } from '@agentport/core';
import { hasErrorCode, type MemoryReviewTarget, memoryFileNameSchema } from '@agentport/shared';
import { z } from 'zod';
import { withMemoryJournalDir } from './memory-files.js';

export type AgentMemoryTarget = Extract<MemoryReviewTarget, { kind: 'agent_memory' }>;

const MAX_JOURNAL_BYTES = 512 * 1024;
const operationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const journalFileSchema = z
  .object({
    name: memoryFileNameSchema,
    beforeSha256: z.string().regex(sha256Pattern).nullable(),
    afterSha256: z.string().regex(sha256Pattern).nullable(),
    beforeBase64: z.string().nullable(),
  })
  .strict();

const journalSchema = z
  .object({
    operation: z.enum(['review', 'rollback', 'manual']),
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

export type MemoryJournalEntry = z.infer<typeof journalSchema>;

export function memorySha256(content: string | null): string | null {
  return content === null ? null : sha256Hex(content);
}

export function bufferSha256(content: Buffer | null): string | null {
  return content === null ? null : sha256Hex(content);
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
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
}

export function journalMatchesTarget(
  entry: MemoryJournalEntry,
  target: AgentMemoryTarget,
): boolean {
  return entry.target.agentId === target.agentId && entry.target.name === target.name;
}

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
    await chmod(dir, 0o700);
    const temp = join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
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
        if (!hasErrorCode(error, 'ENOENT')) throw error;
      }
    });
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}
