import type { Readable } from 'node:stream';
import type { Server, ServerTestResult } from '@agentport/shared';
import type { Transport } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Cause, Effect, type Scope } from 'effect';
import { assertSafeUrl } from './ssrf.js';

const TIMEOUT_MS = 5000;
/** stdio server 的 stderr 只留尾部；失败时这是唯一能说明「为什么起不来」的证据。 */
const STDERR_MAX_BYTES = 8192;

/**
 * 「测试连接」在 API 主机上 spawn 进程，而 server 的 command/args 完全由用户提供：
 * 不设限就是一个已认证用户的任意命令执行。运行时本身在沙盒里跑，这里只做试连，
 * 没有理由允许 shell 与绝对路径的任意二进制。
 *
 * shortcut: 白名单只覆盖常见的 MCP 启动方式；要支持任意命令，应改为在沙盒镜像里
 * 执行测试，而不是放宽这里。
 */
const ALLOWED_COMMANDS = new Set(['npx', 'uvx', 'node', 'python', 'python3', 'deno', 'bun']);

/**
 * 只依赖 warn 的形状，`request.log` 与 pino 都满足。
 * 失败原因进日志：审计表只有 digest，读不出原文。
 */
export interface TestLogger {
  warn: (obj: object, msg: string) => void;
}

/** 给路由用：stderr 只进审计与日志，`serverTestResultSchema.parse` 会把它剥掉。 */
export interface ServerTestOutcome extends ServerTestResult {
  stderr?: string;
}

function transportFor(
  server: Server,
  self?: SelfMcp,
  onStderr?: (stream: Readable) => void,
): Transport {
  if (server.kind === 'stdio') {
    if (!ALLOWED_COMMANDS.has(server.command)) {
      throw new Error(
        `不支持测试该命令（${server.command}）：只允许 ${[...ALLOWED_COMMANDS].join('、')}。运行时的执行在沙盒内，不受此限制。`,
      );
    }
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      // 不继承 API 进程环境：否则被测命令能读到 APP_SECRET_KEY / JWT_SECRET / 模型凭证。
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        ...server.env,
      },
      // pipe：stderr 由我们自己读，失败时留证；inherit 会丢进 API 进程的 stderr。
      stderr: 'pipe',
    });
    // getter 在 start() 前就返回 PassThrough，早到的报错也能收到。
    if (transport.stderr) onStderr?.(transport.stderr as Readable);
    return transport;
  }
  if (server.kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      // 不跟随重定向：SSRF 检查只覆盖第一跳，302 到内网地址会绕过它。
      requestInit: { headers: server.headers, redirect: 'error' },
    });
  }
  // generated server 的 MCP 端点是平台自己挂载的 /mcp/:id，不是上游 baseUrl。
  if (!self) throw new Error('generated server requires platform MCP endpoint info');
  return new StreamableHTTPClientTransport(new URL(`${self.baseUrl}/mcp/${server.id}`), {
    requestInit: { headers: { authorization: `Bearer ${self.token}` }, redirect: 'error' },
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
  onStderr?: (stream: Readable) => void,
): Effect.Effect<ConnectResult, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const client = new Client({ name: 'agentport', version: '0.1.0' });
    yield* Effect.acquireRelease(
      Effect.sync(() => client),
      (c) => Effect.promise(() => c.close().catch(() => undefined)),
    );

    yield* Effect.tryPromise({
      try: () => client.connect(transportFor(server, self, onStderr), { timeout: TIMEOUT_MS }),
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
  logger?: TestLogger,
): Promise<ServerTestOutcome> {
  const startedAt = Date.now();
  let stderr = '';
  const collectStderr = (stream: Readable): void => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      if (stderr.length < STDERR_MAX_BYTES) stderr = (stderr + chunk).slice(0, STDERR_MAX_BYTES);
    });
  };

  const program = Effect.gen(function* () {
    if (server.kind === 'http') yield* Effect.promise(() => assertSafeUrl(server.url, nodeEnv));
    if (server.kind === 'generated') {
      yield* Effect.promise(() => assertSafeUrl(server.baseUrl, nodeEnv));
    }
    return yield* Effect.scoped(connectAndList(server, self, collectStderr));
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

  // stderr 常含被测 server 的 env / token 回显：脱敏后才进日志与审计。
  const stderrTail = redactSecrets(stderr.trim());
  const cause = redactSecrets(describeFailure(result.cause));
  // SDK 只会说 "Connection closed"；stderr 最后一行往往是真正原因（缺配置、找不到命令）。
  // 返回体只带这一行：页面工具提示是单行截断，整段只进日志。
  const lastLine = stderrTail.split('\n').at(-1)?.slice(0, 300);
  const error = lastLine ? `${cause}: ${lastLine}` : cause;
  logger?.warn(
    {
      serverId: server.id,
      kind: server.kind,
      durationMs,
      error,
      ...(stderrTail ? { stderr: stderrTail } : {}),
    },
    'mcp server test failed',
  );
  return {
    ok: false,
    tools: [],
    error,
    ...(stderrTail ? { stderr: stderrTail } : {}),
    durationMs,
  };
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
