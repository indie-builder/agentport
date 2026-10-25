import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * fork 后的 transcript 里，每条被复制的消息都带 `forkedFrom: { sessionId, messageUuid }`。
 * 用这个来源标记建映射：不能按两侧下标对齐，会话压缩后顺序会不同。
 *
 * 在宿主侧读，因为容器只发一个 `session_forked` 事件；映射可能上千条，
 * 放进事件会撞上事件大小与条数上限。
 */
export async function readForkUuidMap(
  sessionsRoot: string,
  newSessionId: string,
  wanted: ReadonlySet<string>,
): Promise<Array<{ from: string; to: string }>> {
  const file = await findSessionFile(sessionsRoot, newSessionId);
  if (file === null) return [];
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
    }
  } finally {
    rl.close();
  }
  return map;
}

/** transcript 文件名是 `<sessionId>.jsonl`；cwd 编码变化时可能出现在别的 project 目录。 */
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
