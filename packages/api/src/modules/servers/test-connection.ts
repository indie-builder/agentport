import { assertSafeUrl, assertServerEndpoint } from '@agentport/core/net-guard';
import type { Server, ServerTestResult } from '@agentport/shared';
import { limitToolCatalog, mcpEndpointPath, redactSecrets } from '@agentport/shared';
import type { Transport } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Cause, Effect, type Scope } from 'effect';

const TIMEOUT_MS = 5000;

export interface TestLogger {
  warn: (obj: object, msg: string) => void;
}

function transportFor(server: Server, self?: SelfMcp): Transport {
  if (server.kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers, redirect: 'error' },
    });
  }
  if (server.kind === 'generated') {
    if (!self) throw new Error('generated server requires platform MCP endpoint info');
    const endpoint = new URL(`${self.baseUrl}${mcpEndpointPath(server.id)}`);
    return new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${self.token}` }, redirect: 'error' },
    });
  }
  throw new Error('stdio server 只能在沙盒内测试');
}

export interface SelfMcp {
  baseUrl: string;
  token: string;
}

interface ConnectResult {
  serverInfo?: { name: string; version: string };
  tools: ServerTestResult['tools'];
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
    const tools = yield* Effect.try({
      try: () => limitToolCatalog(listed.tools),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });
    return {
      ...(version ? { serverInfo: { name: version.name, version: version.version } } : {}),
      tools,
    };
  });
}

export async function testConnection(
  server: Server,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  self?: SelfMcp,
  logger?: TestLogger,
  privateHostAllowlist = '',
): Promise<ServerTestResult> {
  const startedAt = Date.now();

  const program = Effect.gen(function* () {
    if (server.kind === 'http') yield* Effect.promise(() => assertSafeUrl(server.url, nodeEnv));
    if (server.kind === 'generated') {
      yield* Effect.promise(() =>
        assertServerEndpoint(server.baseUrl, { nodeEnv, allowlist: privateHostAllowlist }),
      );
    }
    return yield* Effect.scoped(connectAndList(server, self));
  });

  const result = await Effect.runPromiseExit(program);
  const durationMs = Date.now() - startedAt;
  if (result._tag === 'Success') {
    return {
      ok: true,
      ...(result.value.serverInfo ? { serverInfo: result.value.serverInfo } : {}),
      tools: result.value.tools,
      durationMs,
    };
  }

  const error = redactSecrets(describeFailure(result.cause));
  logger?.warn(
    { serverId: server.id, kind: server.kind, durationMs, error },
    'mcp server test failed',
  );
  return { ok: false, tools: [], error, durationMs };
}

function describeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'connection failed';
}
