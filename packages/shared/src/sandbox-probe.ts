import { z } from 'zod';
import { type McpToolSummary, serverTestResultSchema } from './mcp.js';
import { utf8Bytes } from './utf8.js';

export const SANDBOX_PROBES_QUEUE = 'sandbox-probes';

export const SANDBOX_PROBE_CONNECT_TIMEOUT_MS = 5_000;
export const SANDBOX_PROBE_STARTUP_TIMEOUT_MS = 10_000;
export const SANDBOX_PROBE_WAIT_TIMEOUT_MS =
  SANDBOX_PROBE_STARTUP_TIMEOUT_MS + SANDBOX_PROBE_CONNECT_TIMEOUT_MS * 2 + 5_000;
export const SANDBOX_PROBE_STDERR_MAX_BYTES = 8 * 1024;

export const sandboxProbeJobSchema = z.object({
  serverId: z.string().min(1),
  runtimeEnvironmentId: z.string().min(1).nullable().optional(),
});
export type SandboxProbeJob = z.infer<typeof sandboxProbeJobSchema>;

export const sandboxProbeTaskSchema = z.object({
  kind: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export const sandboxProbeOutputSchema = serverTestResultSchema.pick({
  ok: true,
  serverInfo: true,
  tools: true,
  error: true,
});
export type SandboxProbeOutput = z.infer<typeof sandboxProbeOutputSchema>;

const MAX_TOOLS = 1000;
const MAX_TOOLS_BYTES = 1_048_576;

export function limitToolCatalog(
  tools: ReadonlyArray<{
    name: string;
    title?: string | undefined;
    description?: string | undefined;
    inputSchema?: Record<string, unknown> | undefined;
  }>,
): McpToolSummary[] {
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
