import { z } from 'zod';

/** stdio 试连独立队列：与 agent run 分开，试连不会占住运行并发。 */
export const SANDBOX_PROBES_QUEUE = 'sandbox-probes';

/** 容器内 MCP client 的 connect / listTools 上限；试连只验证可用性，不等长任务。 */
export const SANDBOX_PROBE_CONNECT_TIMEOUT_MS = 5_000;
/** Docker 启动余量（拉镜像、docker run）；容器起来后另有同长的结果预算。 */
export const SANDBOX_PROBE_STARTUP_TIMEOUT_MS = 10_000;
/** API 等待整个试连的上限，必须大于启动余量 + 结果预算。 */
export const SANDBOX_PROBE_WAIT_TIMEOUT_MS = 25_000;
/** 容器 stderr 只留尾部：失败时这是「为什么起不来」的唯一证据。 */
export const SANDBOX_PROBE_STDERR_MAX_BYTES = 8 * 1024;

/** job 只带 serverId：配置与密钥由 worker 从库里读并解密，不经队列。 */
export const sandboxProbeJobSchema = z.object({ serverId: z.string().min(1) });
export type SandboxProbeJob = z.infer<typeof sandboxProbeJobSchema>;

/** 容器 stdin 的唯一任务形状；kind 固定，因为 http/generated 仍走 API 现路径。 */
export const sandboxProbeTaskSchema = z.object({
  kind: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
export type SandboxProbeTask = z.infer<typeof sandboxProbeTaskSchema>;

export const sandboxProbeToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type SandboxProbeTool = z.infer<typeof sandboxProbeToolSchema>;

/** 容器 stdout 的单行结果；durationMs/stderr 由宿主侧补，避免进程内自计时。 */
export const sandboxProbeOutputSchema = z.object({
  ok: z.boolean(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).optional(),
  tools: z.array(sandboxProbeToolSchema).default([]),
  error: z.string().optional(),
});
export type SandboxProbeOutput = z.infer<typeof sandboxProbeOutputSchema>;

const MAX_TOOLS = 1000;
const MAX_TOOLS_BYTES = 1_048_576;

/** shared 不带 Node lib；手算 UTF-8 字节数，避免为一行校验引入 Buffer/TextEncoder。 */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * 工具目录是唯一由上游控制的变长部分。超限时明确失败，不做静默截断，
 * 否则用户会以为工具真的只有这些；只保留契约里的四个字段。
 */
export function limitToolCatalog(
  tools: ReadonlyArray<{
    name: string;
    title?: string | undefined;
    description?: string | undefined;
    inputSchema?: Record<string, unknown> | undefined;
  }>,
): SandboxProbeTool[] {
  const catalog = tools.map((tool) => ({
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
  }));
  if (catalog.length > MAX_TOOLS) {
    throw new Error(`工具目录过大（${catalog.length} 个工具，上限 ${MAX_TOOLS}），已拒绝返回`);
  }
  if (utf8Bytes(JSON.stringify(catalog)) > MAX_TOOLS_BYTES) {
    throw new Error(`工具目录超过 ${MAX_TOOLS_BYTES} 字节上限，已拒绝返回`);
  }
  return catalog;
}
