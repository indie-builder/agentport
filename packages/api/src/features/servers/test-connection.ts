import { isAbsolute } from 'node:path';
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
 * 没有理由允许 shell、内联代码与绝对路径的任意二进制。
 *
 * shortcut: 残余上限是 npx/uvx 仍会拉取并执行第三方代码（这正是正常的 MCP 启动
 * 方式），且被允许的脚本本身可信度由用户负责；彻底方案是把试连放进沙盒执行。
 * 解释器参数按白名单处理（只允许子命令 + 脚本路径），不在这里继续堆 denylist。
 */
const ALLOWED_COMMANDS = new Set(['npx', 'uvx', 'node', 'python', 'python3', 'deno', 'bun']);

/**
 * 解释器只允许「可选子命令 + 脚本路径 + 脚本自身参数」。脚本之前的解释器参数
 * 一律不放行，因此 -c/-m/-e、-cCODE、--eval=...、--import/--require/-r、
 * --loader/--experimental-loader、--input-type 等内联与模块注入形式都被挡住。
 * 脚本路径要求像路径（含 . 或 /），避免把 deno eval、bun x 这类子命令当成脚本。
 */
const INTERPRETER_SUBCOMMANDS: Record<string, readonly string[]> = {
  node: [],
  python: [],
  python3: [],
  bun: ['run'],
  deno: ['run'],
};

const SCRIPT_HINT = '解释器只能直接执行相对路径的脚本文件。运行时的执行在沙盒内，不受此限制。';

function assertInterpreterArgs(command: string, args: readonly string[]): void {
  const subcommands = INTERPRETER_SUBCOMMANDS[command] ?? [];
  const script = subcommands.includes(args[0] ?? '') ? args[1] : args[0];
  if (script === undefined) {
    throw new Error(`不支持测试该命令（${command}）：需要提供脚本路径。${SCRIPT_HINT}`);
  }
  if (script.startsWith('-')) {
    throw new Error(`不支持测试内联代码或加载器参数（${script}）：${SCRIPT_HINT}`);
  }
  if (!/[.\\/]/.test(script)) {
    throw new Error(`不支持测试该参数（${script}）：${SCRIPT_HINT}`);
  }
}

/**
 * 白名单内的命令仍可借参数读到宿主文件，因此在 spawn 前拒绝内联代码与绝对/上级路径。
 * 抛出的错误与命令白名单同一条降级路径（变成 ok:false 的试连结果）。
 */
export function assertStdioLaunchAllowed(command: string, args: readonly string[]): void {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(
      `不支持测试该命令（${command}）：只允许 ${[...ALLOWED_COMMANDS].join('、')}。运行时的执行在沙盒内，不受此限制。`,
    );
  }
  if (command in INTERPRETER_SUBCOMMANDS) assertInterpreterArgs(command, args);
  const outside = args.find((arg) => isAbsolute(arg) || arg.split(/[\\/]/).includes('..'));
  if (outside !== undefined) {
    throw new Error(
      `不支持测试该参数（${outside}）：不能使用绝对路径或 .. 路径。运行时的执行在沙盒内，不受此限制。`,
    );
  }
}

/**
 * 用户 env 在 spawn 时最后展开，能覆盖 PATH 或借 NODE_OPTIONS=--import=data:... 直接执行代码。
 * 这里只挡注入与加载路径变量；普通 env（API token 等）照常允许，避免破坏 MCP 试连。
 */
const BLOCKED_ENV_KEYS = new Set([
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'ELECTRON_RUN_AS_NODE',
]);
const BLOCKED_ENV_PREFIXES = ['DENO_', 'BUN_', 'DYLD_'];

export function assertStdioEnvAllowed(env: Record<string, string> | undefined): void {
  for (const key of Object.keys(env ?? {})) {
    const upper = key.toUpperCase();
    if (
      BLOCKED_ENV_KEYS.has(upper) ||
      BLOCKED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
    ) {
      throw new Error(
        `不支持测试该环境变量（${key}）：它可注入代码或改变加载路径。运行时的执行在沙盒内，不受此限制。`,
      );
    }
  }
}

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
    assertStdioLaunchAllowed(server.command, server.args);
    assertStdioEnvAllowed(server.env);
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
  tools: ServerTestResult['tools'];
}

/**
 * 测试结果会原样进入 API 响应，工具目录是唯一由上游控制的变长部分：
 * 超限时明确失败，不做静默截断，否则用户会以为工具真的只有这些。
 *
 * shortcut: SDK 的 listTools 先分页拉全再返回，内存已在 SDK 内占用；
 * 这里限制的是回给浏览器的响应大小，不是上游传输量。
 */
const MAX_TOOLS = 1000;
const MAX_TOOLS_BYTES = 1_048_576;

type CatalogTool = ServerTestResult['tools'][number];

function toToolCatalog(listed: { tools: ReadonlyArray<CatalogTool> }): ServerTestResult['tools'] {
  // 只回传契约里的四个字段：icons/_meta/annotations/outputSchema 等不进响应。
  const tools = listed.tools.map((t) => ({
    name: t.name,
    ...(t.title !== undefined ? { title: t.title } : {}),
    ...(t.description !== undefined ? { description: t.description } : {}),
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
  }));
  if (tools.length > MAX_TOOLS) {
    throw new Error(`工具目录过大（${tools.length} 个工具，上限 ${MAX_TOOLS}），已拒绝返回`);
  }
  if (Buffer.byteLength(JSON.stringify(tools)) > MAX_TOOLS_BYTES) {
    throw new Error(`工具目录超过 ${MAX_TOOLS_BYTES} 字节上限，已拒绝返回`);
  }
  return tools;
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
    const tools = yield* Effect.try({
      try: () => toToolCatalog(listed),
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
