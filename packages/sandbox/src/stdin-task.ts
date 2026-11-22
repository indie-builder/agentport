import { createStdinLines } from './stdin-lines.js';

/** 只取第一行，不读 EOF：宿主写完任务后保持 stdin 打开。 */
export async function readTask(label: string): Promise<unknown> {
  const stdin = createStdinLines();
  for (;;) {
    const line = await stdin.next();
    if (line === null) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return JSON.parse(trimmed);
  }
  throw new Error(`stdin closed before the ${label} arrived`);
}
