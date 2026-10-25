import type { Server, ServerTestResult } from '@agentport/shared';
import { limitToolCatalog } from '@agentport/shared';
import type { Transport } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Cause, Effect, type Scope } from 'effect';
import { assertSafeUrl } from './ssrf.js';

const TIMEOUT_MS = 5000;

/**
 * 只依赖 warn 的形状，`request.log` 与 pino 都满足。
 * 失败原因进日志：审计表只有 digest，读不出原文。
 */
export interface TestLogger {
  warn: (obj: object, msg: string) => void;
}

/**
 * HTTP/generated 在 API 进程内直连；stdio 由用户提供任意命令，必须在沙盒镜像里跑
 * （见 features/servers/sandbox-probe.ts），API 主机不 spawn 任何用户进程。
 */
function transportFor(server: Server, self?: SelfMcp): Transport {
  if (server.kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      // 不跟随重定向：SSRF 检查只覆盖第一跳，302 到内网地址会绕过它。
      requestInit: { headers: server.headers, redirect: 'error' },
    });
  }
  if (server.kind === 'generated') {
    // generated server 的 MCP 端点是平台自己挂载的 /mcp/:id，不是上游 baseUrl。
    if (!self) throw new Error('generated server requires platform MCP endpoint info');
    return new StreamableHTTPClientTransport(new URL(`${self.baseUrl}/mcp/${server.id}`), {
      requestInit: { headers: { authorization: `Bearer ${self.token}` }, redirect: 'error' },
    });
  }
  throw new Error('stdio server 只能在沙盒内测试');
}

export interface SelfMcp {
  /** 平台自身可达地址，例如 http://127.0.0.1:3000 */
  baseUrl: string;
  /** 该 generated server 的 mcpToken */
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

/**
 * 真连一次并 listTools，任何异常都降级为结果对象，避免按钮因网络问题 500。
 * http server 的 url、generated server 的上游 baseUrl 都要走 SSRF 检查。
 * stdio 不在这里测：它需要用户命令，只能在沙盒镜像里执行。
 */
export async function testConnection(
  server: Server,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  self?: SelfMcp,
  logger?: TestLogger,
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

/** Exit/Cause 不可读；转成一句能贴到 UI 的话。 */
function describeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'connection failed';
}

/**
 * 与 packages/worker/src/redact.ts 同一套规则，但 API 不能依赖 worker 包。
 * shortcut: 两份实现需同步；要改规则就先把 helper 提到 shared。
 */
function mask(secret: string): string {
  return secret.length > 4 ? `${secret.slice(0, 4)}***` : '***';
}

const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const PROVIDER_KEY = /\b(?:sk-|ghp_)[A-Za-z0-9_-]{16,}/g;
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi;
const BASE64URL = /[A-Za-z0-9_-]{32,}/g;

/** UUID、全小写 hash 也会命中 base64url；要求大小写与数字同时出现才当密钥。 */
function looksRandom(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

function redactSecrets(text: string): string {
  return text
    .replace(BEARER, (_match, prefix: string, token: string) => `${prefix}${mask(token)}`)
    .replace(PROVIDER_KEY, (match) => mask(match))
    .replace(ASSIGNMENT, (_match, key: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      const body = quote ? value.slice(1, -1) : value;
      return `${key}=${quote}${mask(body)}${quote}`;
    })
    .replace(BASE64URL, (match) => (looksRandom(match) ? mask(match) : match));
}
