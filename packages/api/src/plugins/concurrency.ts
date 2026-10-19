import pLimit from 'p-limit';

/**
 * /mcp 会话可能长时间挂着（SSE），进程内并发压到 4，超出排队。
 * 多进程部署时每个进程各自计数；全局限额由反向代理兜底。
 */
const mcp = pLimit(4);

export function runMcp<T>(task: () => Promise<T>): Promise<T> {
  return mcp(task);
}
