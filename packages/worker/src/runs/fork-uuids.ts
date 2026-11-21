import { createReadStream } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fail } from '@agentport/core';

const FORK_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const FORK_TRANSCRIPT_MAX_ENTRIES = 100_000;
const FORK_TRANSCRIPT_MAX_PROJECT_DIRS = 1_000;

export async function readForkUuidMap(
  sessionsRoot: string,
  newSessionId: string,
  wanted: ReadonlySet<string>,
): Promise<Array<{ from: string; to: string }>> {
  const file = await findSessionFile(sessionsRoot, newSessionId);
  if (file === null) return [];
  const info = await lstat(file).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
    fail('INVALID_INPUT', 'fork 转写文件不是普通文件');
  if (info.size > FORK_TRANSCRIPT_MAX_BYTES) fail('INVALID_INPUT', 'fork 转写文件超过上限');
  const map: Array<{ from: string; to: string }> = [];
  const rl = createInterface({
    input: createReadStream(file, { end: FORK_TRANSCRIPT_MAX_BYTES }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== 'object' || entry === null) continue;
      const { uuid, forkedFrom } = entry as { uuid?: unknown; forkedFrom?: unknown };
      if (typeof uuid !== 'string' || typeof forkedFrom !== 'object' || forkedFrom === null) {
        continue;
      }
      const from = (forkedFrom as { messageUuid?: unknown }).messageUuid;
      if (typeof from === 'string' && wanted.has(from) && from !== uuid)
        map.push({ from, to: uuid });
      if (map.length > FORK_TRANSCRIPT_MAX_ENTRIES)
        fail('INVALID_INPUT', 'fork 转写映射条数超过上限');
    }
  } finally {
    rl.close();
  }
  return map;
}

async function findSessionFile(sessionsRoot: string, sessionId: string): Promise<string | null> {
  const projects = join(sessionsRoot, 'projects');
  const projectsInfo = await lstat(projects).catch(() => null);
  if (projectsInfo === null) return null;
  if (projectsInfo.isSymbolicLink() || !projectsInfo.isDirectory())
    fail('INVALID_INPUT', 'fork 转写目录不是普通目录');
  const reader = await opendir(projects);
  try {
    let seen = 0;
    for await (const entry of reader) {
      seen += 1;
      if (seen > FORK_TRANSCRIPT_MAX_PROJECT_DIRS)
        fail('INVALID_INPUT', 'fork 转写项目目录超过上限');
      if (!entry.isDirectory()) continue;
      const projectDir = join(projects, entry.name);
      const projectInfo = await lstat(projectDir).catch(() => null);
      if (projectInfo === null || projectInfo.isSymbolicLink() || !projectInfo.isDirectory())
        fail('INVALID_INPUT', 'fork 转写目录不是普通目录');
      const candidate = join(projectDir, `${sessionId}.jsonl`);
      const fileInfo = await lstat(candidate).catch(() => null);
      if (
        fileInfo !== null &&
        !fileInfo.isSymbolicLink() &&
        fileInfo.isFile() &&
        fileInfo.nlink === 1
      )
        return candidate;
    }
  } finally {
    await reader.close().catch(() => undefined);
  }
  return null;
}
