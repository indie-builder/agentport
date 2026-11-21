import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const FORK_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const FORK_TRANSCRIPT_MAX_ENTRIES = 100_000;

export async function readForkUuidMap(
  sessionsRoot: string,
  newSessionId: string,
  wanted: ReadonlySet<string>,
): Promise<Array<{ from: string; to: string }>> {
  const file = await findSessionFile(sessionsRoot, newSessionId);
  if (file === null) return [];
  const info = await lstat(file).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
    throw new Error('fork 转写文件不是普通文件');
  if (info.size > FORK_TRANSCRIPT_MAX_BYTES) throw new Error('fork 转写文件超过上限');
  const map: Array<{ from: string; to: string }> = [];
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
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
      if (map.length > FORK_TRANSCRIPT_MAX_ENTRIES) throw new Error('fork 转写映射条数超过上限');
    }
  } finally {
    rl.close();
  }
  return map;
}

async function findSessionFile(sessionsRoot: string, sessionId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(join(sessionsRoot, 'projects'), { withFileTypes: true }).then((items) =>
      items.filter((item) => item.isDirectory()).map((item) => item.name),
    );
  } catch {
    return null;
  }
  for (const entry of entries) {
    const dir = join(sessionsRoot, 'projects', entry);
    try {
      const files = await readdir(dir);
      if (files.includes(`${sessionId}.jsonl`)) return join(dir, `${sessionId}.jsonl`);
    } catch {}
  }
  return null;
}
