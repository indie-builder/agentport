import type { Server, ServerTestResult } from '@agentport/shared';
import type { Transport } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { assertSafeUrl } from './ssrf.js';

const TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function transportFor(server: Server, self?: SelfMcp): Transport {
  if (server.kind === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...(process.env as Record<string, string>), ...server.env },
      stderr: 'pipe',
    });
  }
  if (server.kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    });
  }
  // generated server 的 MCP 端点是平台自己挂载的 /mcp/:id，不是上游 baseUrl。
  if (!self) throw new Error('generated server requires platform MCP endpoint info');
  return new StreamableHTTPClientTransport(new URL(`${self.baseUrl}/mcp/${server.id}`), {
    requestInit: { headers: { authorization: `Bearer ${self.token}` } },
  });
}

export interface SelfMcp {
  /** 平台自身可达地址，例如 http://127.0.0.1:3000 */
  baseUrl: string;
  /** 该 generated server 的 mcpToken */
  token: string;
}

/**
 * 真连一次并 listTools，任何异常都降级为结果对象，避免按钮因网络问题 500。
 * http server 的 url、generated server 的上游 baseUrl 都要走 SSRF 检查。
 */
export async function testConnection(
  server: Server,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  self?: SelfMcp,
): Promise<ServerTestResult> {
  const startedAt = Date.now();
  let client: Client | undefined;
  try {
    if (server.kind === 'http') await assertSafeUrl(server.url, nodeEnv);
    if (server.kind === 'generated') await assertSafeUrl(server.baseUrl, nodeEnv);

    client = new Client({ name: 'agentport', version: '0.1.0' });
    await withTimeout(
      client.connect(transportFor(server, self), { timeout: TIMEOUT_MS }),
      TIMEOUT_MS,
    );
    const { tools } = await withTimeout(
      client.listTools(undefined, { timeout: TIMEOUT_MS }),
      TIMEOUT_MS,
    );
    const version = client.getServerVersion();
    return {
      ok: true,
      ...(version ? { serverInfo: { name: version.name, version: version.version } } : {}),
      tools: tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
      })),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // close 自身失败不能覆盖测试结果。
    await client?.close().catch(() => {});
  }
}
