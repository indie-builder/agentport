import type { Server, ServerTestResult } from '@agentport/shared';
import type { Transport } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Cause, Effect, type Scope } from 'effect';
import { assertSafeUrl } from './ssrf.js';

const TIMEOUT_MS = 5000;

function transportFor(server: Server, self?: SelfMcp): Transport {
  if (server.kind === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      // 不继承 API 进程环境：否则被测命令能读到 APP_SECRET_KEY / JWT_SECRET / 模型凭证。
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        ...server.env,
      },
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

interface ConnectResult {
  serverInfo?: { name: string; version: string };
  tools: Array<{ name: string; description?: string }>;
}

/**
 * 连接生命周期由 Scope 保证：无论 connect/listTools 成功、失败还是超时，
 * close 都执行一次——这正是手写 finally 在超时路径上保证不了的部分。
 */
function connectAndList(
  server: Server,
  self?: SelfMcp,
): Effect.Effect<ConnectResult, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const client = new Client({ name: 'agentport', version: '0.1.0' });
    yield* Effect.acquireRelease(
      Effect.sync(() => client),
      (c) => Effect.promise(() => c.close().catch(() => undefined)),
    );

    yield* Effect.tryPromise({
      try: () => client.connect(transportFor(server, self), { timeout: TIMEOUT_MS }),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(Effect.timeout(TIMEOUT_MS));

    const listed = yield* Effect.tryPromise({
      try: () => client.listTools(undefined, { timeout: TIMEOUT_MS }),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(Effect.timeout(TIMEOUT_MS));

    const version = client.getServerVersion();
    return {
      ...(version ? { serverInfo: { name: version.name, version: version.version } } : {}),
      tools: listed.tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
      })),
    };
  });
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

  const program = Effect.gen(function* () {
    if (server.kind === 'http') yield* Effect.promise(() => assertSafeUrl(server.url, nodeEnv));
    if (server.kind === 'generated') {
      yield* Effect.promise(() => assertSafeUrl(server.baseUrl, nodeEnv));
    }
    return yield* Effect.scoped(connectAndList(server, self));
  });

  const result = await Effect.runPromiseExit(program);
  if (result._tag === 'Success') {
    return {
      ok: true,
      ...(result.value.serverInfo ? { serverInfo: result.value.serverInfo } : {}),
      tools: result.value.tools,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    ok: false,
    tools: [],
    error: describeFailure(result.cause),
    durationMs: Date.now() - startedAt,
  };
}

/** Exit/Cause 不可读；转成一句能贴到 UI 的话。 */
function describeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'connection failed';
}
