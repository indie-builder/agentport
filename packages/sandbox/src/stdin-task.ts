import { createInterface } from 'node:readline';

/** 只取第一行，不读 EOF：宿主写完任务后保持 stdin 打开。 */
export async function readTask(label: string): Promise<unknown> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      return JSON.parse(trimmed);
    }
  } finally {
    rl.close();
  }
  throw new Error(`stdin closed before the ${label} arrived`);
}
