import type { Readable } from 'node:stream';
import {
  errorText,
  limitToolCatalog,
  SANDBOX_PROBE_CONNECT_TIMEOUT_MS,
  sandboxProbeTaskSchema,
} from '@agentport/shared';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readTask } from './stdin-task.js';

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

async function probe(task: { command: string; args: string[]; env: Record<string, string> }) {
  const client = new Client({ name: 'agentport-probe', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: task.command,
    args: task.args,
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
  }
}

try {
  const parsed = sandboxProbeTaskSchema.safeParse(await readTask('probe task'));
  if (!parsed.success) throw new Error('试连任务格式无效');
  const { version, listed } = await probe(parsed.data);
  const tools = limitToolCatalog(listed.tools);
  emit({ ok: true, ...(version ? { serverInfo: version } : {}), tools });
} catch (err) {
  const message = errorText(err);
  log(`probe failed: ${message}`);
  emit({ ok: false, tools: [], error: message });
}
