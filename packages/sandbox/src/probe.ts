import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  limitToolCatalog,
  SANDBOX_PROBE_CONNECT_TIMEOUT_MS,
  sandboxProbeTaskSchema,
} from '@agentport/shared';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/**
 * 容器内入口：从 stdin 读一行 stdio 配置，连一次并 listTools，向 stdout 写一行结果。
 * stdout 只放结果行；日志一律写 stderr。这里没有模型凭证，也不加载 Agent SDK。
 *
 * 进程级兜底：任何未捕获异常都要先写一行失败结果再退出，
 * 否则父进程只能看到「容器退出但没有结果」。
 */
interface ProbeResult {
  ok: boolean;
  serverInfo?: { name: string; version: string };
  tools: Array<{ name: string }>;
  error?: string;
}

function log(message: string): void {
  process.stderr.write(`[probe] ${message}\n`);
}

function emit(result: ProbeResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** 只取第一行，不读 EOF：宿主写完任务后保持 stdin 打开。 */
async function readTask(): Promise<unknown> {
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
  throw new Error('stdin closed before the probe task arrived');
}

/** 客户端 close 失败不能覆盖真正的结果；超时与 close 都过 `finally`。 */
async function probe(task: { command: string; args: string[]; env: Record<string, string> }) {
  const client = new Client({ name: 'agentport-probe', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: task.command,
    args: task.args,
    // 不继承容器环境：被测命令看不到任何平台或镜像注入的变量。
    env: task.env,
    stderr: 'pipe',
  });
  // SDK 把 stderr 类型声明成 node:stream 的基类，运行时是 PassThrough；
  // 只按需要的能力收窄，不做整段 cast。
  const stderr = transport.stderr;
  if (stderr && 'setEncoding' in stderr) {
    (stderr as Readable).setEncoding('utf8');
    (stderr as Readable).on('data', (chunk: string) => {
      process.stderr.write(chunk);
    });
  }

  try {
    await client.connect(transport, { timeout: SANDBOX_PROBE_CONNECT_TIMEOUT_MS });
    const listed = await client.listTools(undefined, {
      timeout: SANDBOX_PROBE_CONNECT_TIMEOUT_MS,
    });
    const version = client.getServerVersion();
    return {
      version: version ? { name: version.name, version: version.version } : undefined,
      listed,
    };
  } finally {
    await client.close().catch(() => undefined);
    // StdioClientTransport 兜底：connect 失败时 client.close 也会走 transport.close，
    // 但显式再关一次保证宿主机侧不留子进程。
    await transport.close().catch(() => undefined);
  }
}

try {
  const parsed = sandboxProbeTaskSchema.safeParse(await readTask());
  if (!parsed.success) throw new Error('试连任务格式无效');
  const { version, listed } = await probe(parsed.data);
  const tools = limitToolCatalog(listed.tools);
  emit({ ok: true, ...(version ? { serverInfo: version } : {}), tools });
} catch (err) {
  // 任何失败都只写一行结果：父进程只看 stdout，进程退出码不携带原因。
  const message = err instanceof Error ? err.message : String(err);
  log(`probe failed: ${message}`);
  emit({ ok: false, tools: [], error: message });
}
