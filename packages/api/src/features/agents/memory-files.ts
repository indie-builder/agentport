import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { fail } from '@agentport/core';
import {
  type MemoryFile,
  type MemoryFileContent,
  type MemoryFileList,
  memoryFileNamePattern,
} from '@agentport/shared';

const MEMORY_FILE_MODE = 0o600;
const MEMORY_DIR_MODE = 0o700;
const MAX_MEMORY_BYTES = 200_000;

function workspaceSubdir(workspacesDir: string, slug: string, leaf: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) fail('INVALID_INPUT', '智能体目录名非法');
  return resolve(workspacesDir, slug, leaf);
}

export function memoryDir(workspacesDir: string, slug: string): string {
  return workspaceSubdir(workspacesDir, slug, 'agent-memory');
}

function safeName(name: string): string {
  if (!memoryFileNamePattern.test(name)) fail('INVALID_INPUT', '记忆文件名非法：只允许 <name>.md');
  return name;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function invalidLink(): never {
  fail('INVALID_INPUT', '记忆目录与文件不允许符号链接');
}

async function directoryPath(handle: FileHandle): Promise<string> {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  if (process.platform === 'darwin') {
    const info = await handle.stat();
    return `/.vol/${info.dev}/${info.ino}`;
  }
  throw new Error('Secure memory directory handles are unsupported on this platform');
}

/** 用固定目录引用逐层打开，防止祖先目录在校验后被换成链接。 */
async function checkedDir(
  workspacesDir: string,
  slug: string,
  leaf: string,
  create = false,
): Promise<FileHandle> {
  const dir = workspaceSubdir(workspacesDir, slug, leaf);
  const root = parse(dir).root;
  let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of dir.slice(root.length).split(sep)) {
      const current = join(await directoryPath(handle), part);
      if (create) {
        try {
          await mkdir(current, { mode: MEMORY_DIR_MODE });
        } catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
        }
      }
      const info = await lstat(current);
      if (info.isSymbolicLink()) invalidLink();
      if (!info.isDirectory())
        throw Object.assign(new Error('Memory parent is not a directory'), { code: 'ENOTDIR' });
      const next = await open(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    if (hasCode(error, 'ELOOP')) invalidLink();
    throw error;
  }
}

async function withSubdir<T>(
  root: string,
  slug: string,
  leaf: string,
  create: boolean,
  operation: (dir: string) => Promise<T>,
): Promise<T> {
  const handle = await checkedDir(root, slug, leaf, create);
  try {
    return await operation(await directoryPath(handle));
  } finally {
    await handle.close();
  }
}

async function withMemoryDir<T>(
  root: string,
  slug: string,
  create: boolean,
  operation: (dir: string) => Promise<T>,
): Promise<T> {
  return withSubdir(root, slug, 'agent-memory', create, operation);
}

/** 专家工作区控制目录：与记忆目录一样逐层拒绝链接，只接受固定目录名。 */
export function withMemoryJournalDir<T>(
  root: string,
  slug: string,
  create: boolean,
  operation: (dir: string) => Promise<T>,
): Promise<T> {
  return withSubdir(root, slug, '.memory-journal', create, operation);
}

async function regularFile(target: string) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) invalidLink();
    if (!info.isFile()) fail('INVALID_INPUT', '记忆文件必须是普通 Markdown 文件');
    return info;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function listMemoryFiles(
  workspacesDir: string,
  slug: string,
): Promise<MemoryFileList> {
  try {
    return await withMemoryDir(workspacesDir, slug, false, async (dir) => {
      const files: MemoryFile[] = [];
      for (const name of await readdir(dir)) {
        if (!memoryFileNamePattern.test(name)) continue;
        const info = await regularFile(join(dir, name));
        if (info) files.push({ name, size: info.size, updatedAt: info.mtime.toISOString() });
      }
      files.sort((a, b) =>
        a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name),
      );
      return { files, initialized: files.some((file) => file.name === 'MEMORY.md') };
    });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { files: [], initialized: false };
    throw error;
  }
}

async function readMemoryFileData(
  workspacesDir: string,
  slug: string,
  name: string,
): Promise<{ data: Buffer; updatedAt: string } | null> {
  safeName(name);
  try {
    return await withMemoryDir(workspacesDir, slug, false, async (dir) => {
      const target = join(dir, name);
      if (!(await regularFile(target))) return null;
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile()) fail('INVALID_INPUT', '记忆文件必须是普通 Markdown 文件');
        if (info.size > MAX_MEMORY_BYTES) fail('PAYLOAD_TOO_LARGE', '记忆文件不能超过 200000 字节');
        const buffer = Buffer.alloc(MAX_MEMORY_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_MEMORY_BYTES) fail('PAYLOAD_TOO_LARGE', '记忆文件不能超过 200000 字节');
        return { data: buffer.subarray(0, size), updatedAt: info.mtime.toISOString() };
      } finally {
        await handle.close();
      }
    });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    if (hasCode(error, 'ELOOP')) invalidLink();
    throw error;
  }
}

export async function readMemoryFile(
  workspacesDir: string,
  slug: string,
  name: string,
): Promise<MemoryFileContent | null> {
  const file = await readMemoryFileData(workspacesDir, slug, name);
  return file === null
    ? null
    : { name, content: file.data.toString('utf8'), updatedAt: file.updatedAt };
}

/** 恢复原文件用：避免 UTF-8 解码改变原始字节。 */
export async function readMemoryFileBytes(
  workspacesDir: string,
  slug: string,
  name: string,
): Promise<Buffer | null> {
  return (await readMemoryFileData(workspacesDir, slug, name))?.data ?? null;
}

async function writeMemoryFileData(
  workspacesDir: string,
  slug: string,
  name: string,
  data: string | Uint8Array,
): Promise<string> {
  safeName(name);
  if (Buffer.byteLength(data) > MAX_MEMORY_BYTES)
    fail('PAYLOAD_TOO_LARGE', '记忆文件不能超过 200000 字节');
  return withMemoryDir(workspacesDir, slug, true, async (dir) => {
    const target = join(dir, name);
    await regularFile(target);
    const temporary = join(dir, `.memory-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      MEMORY_FILE_MODE,
    );
    try {
      let updatedAt: string;
      try {
        await handle.writeFile(data);
        updatedAt = (await handle.stat()).mtime.toISOString();
      } finally {
        await handle.close();
      }
      await regularFile(target);
      await rename(temporary, target);
      return updatedAt;
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!hasCode(cleanupError, 'ENOENT')) {
          throw new AggregateError([error, cleanupError], '记忆临时文件清理失败');
        }
      }
      throw error;
    }
  });
}

export async function writeMemoryFile(
  workspacesDir: string,
  slug: string,
  name: string,
  content: string,
): Promise<MemoryFileContent> {
  const updatedAt = await writeMemoryFileData(workspacesDir, slug, name, content);
  return { name, content, updatedAt };
}

/** 原样写回之前读到的字节（写入失败时的恢复路径）。 */
export async function restoreMemoryFile(
  workspacesDir: string,
  slug: string,
  name: string,
  data: Buffer,
): Promise<void> {
  await writeMemoryFileData(workspacesDir, slug, name, data);
}

export async function deleteMemoryFile(
  workspacesDir: string,
  slug: string,
  name: string,
): Promise<boolean> {
  safeName(name);
  try {
    return await withMemoryDir(workspacesDir, slug, false, async (dir) => {
      const target = join(dir, name);
      if (!(await regularFile(target))) return false;
      await unlink(target);
      return true;
    });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}
