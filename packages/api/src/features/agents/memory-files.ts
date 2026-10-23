import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MemoryFile, MemoryFileContent, MemoryFileList } from '@agentport/shared';

const MEMORY_FILE_MODE = 0o600;
const MEMORY_DIR_MODE = 0o700;
/** 只允许普通 Markdown 记忆文件；正则同时挡住路径穿越与隐藏文件。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md$/;

/** 记忆目录：与 worker 写工作区用同一根目录，格式是 Claude Code 原生 auto-memory。 */
export function memoryDir(workspacesDir: string, slug: string): string {
  return resolve(workspacesDir, slug, 'agent-memory');
}

function safeName(name: string): string {
  if (!NAME_RE.test(name)) throw new Error('记忆文件名非法');
  return name;
}

export async function listMemoryFiles(
  workspacesDir: string,
  slug: string,
): Promise<MemoryFileList> {
  const dir = memoryDir(workspacesDir, slug);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { files: [], initialized: false };
  }
  const files: MemoryFile[] = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    files.push({ name, size: info.size, updatedAt: info.mtime.toISOString() });
  }
  // MEMORY.md 是索引，永远排最前；其余按名字稳定排序。
  files.sort((a, b) =>
    a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name),
  );
  return { files, initialized: names.includes('MEMORY.md') };
}

export async function readMemoryFile(
  workspacesDir: string,
  slug: string,
  name: string,
): Promise<MemoryFileContent | null> {
  const target = join(memoryDir(workspacesDir, slug), safeName(name));
  try {
    const [content, info] = await Promise.all([readFile(target, 'utf8'), stat(target)]);
    return { name, content, updatedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

export async function writeMemoryFile(
  workspacesDir: string,
  slug: string,
  name: string,
  content: string,
): Promise<MemoryFileContent> {
  const dir = memoryDir(workspacesDir, slug);
  await mkdir(dir, { recursive: true, mode: MEMORY_DIR_MODE });
  const target = join(dir, safeName(name));
  await writeFile(target, content, { encoding: 'utf8', mode: MEMORY_FILE_MODE });
  const info = await stat(target);
  return { name, content, updatedAt: info.mtime.toISOString() };
}

export async function deleteMemoryFile(
  workspacesDir: string,
  slug: string,
  name: string,
): Promise<boolean> {
  try {
    await rm(join(memoryDir(workspacesDir, slug), safeName(name)));
    return true;
  } catch {
    return false;
  }
}
