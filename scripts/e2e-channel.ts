#!/usr/bin/env node
/**
 * 频道模式真实链路验证：HTTP → BullMQ → worker → Docker 沙盒 → Claude Agent SDK
 * → 事件回流 → 频道时间线。只有 Anthropic 模型端点是本地假 SSE，其余全部是真实进程与容器。
 *
 * 用法：pnpm e2e:channel
 * 可选环境变量：SANDBOX_IMAGE（默认 agentport/sandbox:dev）、E2E_CHANNEL_FAKE_PORT（默认 4318）。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createDb } from '../packages/db/src/client.js';
import {
  type IsolatedRedis,
  startRedisContainer,
  stopRedisContainer,
} from '../packages/worker/test/global-setup.js';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../packages/worker/test/isolated-db.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const IMAGE = process.env.SANDBOX_IMAGE ?? 'agentport/sandbox:dev';
const FAKE_PORT = Number(process.env.E2E_CHANNEL_FAKE_PORT ?? 4318);
const REPLY_PREFIX = 'E2E-CHANNEL-REPLY';
/** 慢响应标记：正文含它时假模型先吐半句、延迟后再收尾，供停止/刷新恢复用例观察。 */
const SLOW_MARKER = 'E2E-CHANNEL-SLOW';
const SLOW_PARTIAL = 'E2E-CHANNEL-SLOW-PARTIAL';
const SLOW_DELAY_MS = Number(process.env.E2E_CHANNEL_FAKE_SLOW_MS ?? 15_000);
/** assert = 原有 HTTP 全链路；stack = 起栈常驻；ui = 起栈后跑浏览器 E2E 再清理。 */
const MODE = process.env.E2E_CHANNEL_MODE ?? 'assert';
/** `pnpm e2e:channel:ui -- --grep "second @"` 里 `--` 之后的参数原样转给 `e2e run`。 */
const E2E_RUN_ARGS = process.argv.slice(2);
// pnpm 把分隔符 `--` 也原样带进来，而 e2e 会把它当成后面的 flag 是文件名。
if (E2E_RUN_ARGS[0] === '--') E2E_RUN_ARGS.shift();
const UI_PORT = Number(process.env.E2E_CHANNEL_UI_PORT ?? 3310);
const WEB_DIST = join(REPO, 'packages/web/dist');
const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'e2e-channel-admin-password';
const STEP_TIMEOUT_MS = 180_000;

const startedAt = Date.now();

function logStep(message: string): void {
  console.log(`\n==> ${message}`);
}

function info(message: string): void {
  console.log(`  · ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ok  ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} 超过 ${options.timeoutMs ?? 60_000}ms`));
    }, options.timeoutMs ?? 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function pollUntil<T>(
  label: string,
  timeoutMs: number,
  check: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `等待超时（${timeoutMs}ms）：${label}${lastError ? `；最后错误：${String(lastError)}` : ''}`,
  );
}

function captureOutput(child: ChildProcess): {
  all: () => string;
  tail: (lines?: number) => string;
} {
  let output = '';
  const append = (chunk: Buffer | string): void => {
    output += chunk.toString();
    // 只保留尾部，避免长时间运行把内存吃满。
    if (output.length > 400_000) output = output.slice(-200_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return {
    all: () => output,
    tail: (lines = 80) => output.split('\n').slice(-lines).join('\n'),
  };
}

function childExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
}

async function stopChild(child: ChildProcess | undefined, label: string): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    childExit(child).then(() => true),
    delay(20_000).then(() => false),
  ]);
  if (exited) return;
  console.error(`${label} 未在 20s 内退出，发送 SIGKILL`);
  child.kill('SIGKILL');
  await childExit(child);
}

/** 浏览器模式需要 api 托管生产构建；已存在则复用，E2E_CHANNEL_REBUILD_WEB=1 强制重建。 */
async function ensureWebBuild(): Promise<void> {
  const index = join(WEB_DIST, 'index.html');
  if (process.env.E2E_CHANNEL_REBUILD_WEB !== '1' && existsSync(index)) {
    info(`复用已构建 web：${WEB_DIST}`);
    return;
  }
  logStep('构建 web 静态产物');
  const built = await run('pnpm', ['--filter', '@agentport/web', 'build'], { timeoutMs: 600_000 });
  if (built.code !== 0) fail(`构建 web 失败：${built.stderr.trim().slice(-2000)}`);
  if (!existsSync(index)) fail(`web 构建完成但缺少 ${index}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 浏览器 E2E 子进程：继承终端输出，失败码带回给调用方。 */
function runBrowserE2e(env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      [
        'exec',
        'e2e',
        'run',
        'tests/support/auth.e2e.ts',
        'tests/channels.e2e.ts',
        '--reporter',
        'list',
        ...E2E_RUN_ARGS,
      ],
      { cwd: REPO, env: { ...process.env, ...env }, stdio: 'inherit' },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('浏览器 E2E 超过 30 分钟'));
    }, 1_800_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** 打印可直接 source 的环境；stack 模式阻塞到 Ctrl-C，ui 模式跑完用例后返回。 */
async function runStackMode(databaseUrl: string, baseUrl: string): Promise<void> {
  const env = {
    E2E_APP_URL: baseUrl,
    DATABASE_URL: databaseUrl,
    E2E_ADMIN_USER: ADMIN_USER,
    E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
  };
  console.log('\n========== 浏览器 E2E 栈已就绪 ==========');
  for (const [key, value] of Object.entries(env)) {
    console.log(`export ${key}=${shellQuote(value)}`);
  }
  console.log(`栈地址：${baseUrl}`);
  console.log('==========================================');

  if (MODE === 'stack') {
    console.log('栈常驻中；按 Ctrl-C 结束并清理。');
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return;
  }

  logStep('运行浏览器 E2E：tests/channels.e2e.ts');
  if (E2E_RUN_ARGS.length > 0) info(`透传 e2e 参数：${E2E_RUN_ARGS.join(' ')}`);
  const code = await runBrowserE2e(env);
  if (code !== 0) {
    browserE2eExitCode = code;
    console.error(`浏览器 E2E 失败（exit ${code}）`);
    process.exitCode = code;
  }
}

interface FakeMessageRequest {
  at: number;
  path: string;
  prompt: string;
  reply: string;
}

interface FakeAnthropic {
  requests: Array<{ path: string; at: number }>;
  messageRequests: FakeMessageRequest[];
  close: () => Promise<void>;
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 最近一条 user 消息的最后一个文本块；前面的块是 CLI 注入的 system-reminder。 */
function lastUserText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== 'object' || message === null) continue;
    if ((message as { role?: unknown }).role !== 'user') continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      if (content.length > 0) return content;
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts = content
      .map((block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .filter((text) => text.length > 0);
    const text = texts.at(-1);
    if (text !== undefined) return text;
  }
  return '';
}

const CHANNEL_CURRENT_MARKER = '【当前消息】\n';

/** 频道触发的 prompt 是「频道上下文 + 【当前消息】 + 正文」；非频道请求只有正文。 */
function channelCurrentBody(prompt: string): string {
  const index = prompt.lastIndexOf(CHANNEL_CURRENT_MARKER);
  return (index < 0 ? prompt : prompt.slice(index + CHANNEL_CURRENT_MARKER.length)).trim();
}

async function startFakeAnthropic(port: number): Promise<FakeAnthropic> {
  const requests: Array<{ path: string; at: number }> = [];
  const messageRequests: FakeMessageRequest[] = [];
  let nextId = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const pathname = new URL(req.url ?? '/', 'http://fake').pathname;
      requests.push({ path: pathname, at: Date.now() });
      if (pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 32 }));
        return;
      }
      if (pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (pathname !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: pathname } }));
        return;
      }

      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      const prompt = lastUserText(body);
      const model =
        typeof (body as { model?: unknown } | null)?.model === 'string'
          ? (body as { model: string }).model
          : 'claude-sonnet-5-5';
      nextId += 1;
      const slow = prompt.includes(SLOW_MARKER);
      const reply = `${REPLY_PREFIX} ${prompt}`;
      messageRequests.push({ at: Date.now(), path: pathname, prompt, reply });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      writeSse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: `msg_e2e_${nextId}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      writeSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      const canWrite = (): boolean => !res.destroyed && !res.writableEnded;
      if (slow) {
        // 先写固定前半句，让浏览器在延迟窗口里能看到流式内容。
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: SLOW_PARTIAL },
        });
        await delay(SLOW_DELAY_MS);
        if (!canWrite()) return;
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ` ${reply}` },
        });
      } else {
        writeSse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: reply },
        });
      }
      if (!canWrite()) return;
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      writeSse(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      writeSse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === 'EADDRINUSE'
            ? `假 Anthropic 端口 ${port} 已被占用；用 E2E_CHANNEL_FAKE_PORT 换一个`
            : `假 Anthropic 启动失败：${error.message}`,
        ),
      );
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    requests,
    messageRequests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface ChannelEvent {
  type: string;
  channelId?: string;
  runId?: string;
  agentId?: string;
  status?: string;
  message?: { id: string; kind: string; body: string; runId: string | null; seq: number };
  [key: string]: unknown;
}

interface EventStream {
  events: ChannelEvent[];
  ready: Promise<void>;
  waitFor: (
    label: string,
    predicate: (event: ChannelEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<ChannelEvent>;
}

function openEventStream(url: string, cookie: string, signal: AbortSignal): EventStream {
  const events: ChannelEvent[] = [];
  const ready = Promise.withResolvers<void>();

  void (async () => {
    const response = await fetch(url, {
      headers: { cookie, accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok) {
      ready.reject(
        new Error(`频道 SSE 建立失败：HTTP ${response.status} ${await response.text()}`),
      );
      return;
    }
    ready.resolve();
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            events.push(JSON.parse(line.slice(6)) as ChannelEvent);
          } catch {
            // 非 JSON 的 data 行不是频道事件，忽略。
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  })().catch((error: unknown) => {
    if (!signal.aborted) ready.reject(error);
  });

  return {
    events,
    ready: ready.promise,
    waitFor(label, predicate, timeoutMs = STEP_TIMEOUT_MS) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return pollUntil(label, timeoutMs, async () => events.find(predicate));
    },
  };
}

interface ApiResult {
  status: number;
  json: unknown;
  text: string;
}

function apiCall(
  baseUrl: string,
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
): Promise<ApiResult> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => {
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  });
}

function redisDbOf(url: string): string {
  return new URL(url).pathname.replace('/', '') || '0';
}

async function waitForChannelSubscriber(
  container: string,
  database: string,
  channelId: string,
  timeoutMs = 20_000,
): Promise<void> {
  await pollUntil(`频道 ${channelId} 的 Redis 订阅连接`, timeoutMs, async () => {
    const result = await run('docker', [
      'exec',
      container,
      'redis-cli',
      '-n',
      database,
      'client',
      'list',
    ]);
    if (result.code !== 0) return false;
    return result.stdout.includes(`name=channel-events:${channelId}`);
  });
}

interface RunRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  status: string;
  trigger: string;
  channel_id: string | null;
  channel_trigger_message_id: string | null;
  initiated_by: string | null;
  error: string | null;
}

let database: IsolatedDatabase | null = null;
let redis: IsolatedRedis | null = null;
let fake: FakeAnthropic | null = null;
let apiProcess: ChildProcess | undefined;
let workerProcess: ChildProcess | undefined;
let apiTail = (): string => '';
let workerTail = (): string => '';
let runRoot = '';
let sseAbort: AbortController | undefined;
let pool: ReturnType<typeof createDb>['pool'] | undefined;
/** 浏览器用例失败时保留退出码；失败现场诊断在清理前按它触发。 */
let browserE2eExitCode: number | null = null;

async function cleanup(): Promise<void> {
  const keep = process.env.E2E_CHANNEL_KEEP === '1';
  sseAbort?.abort();
  await stopChild(workerProcess, 'worker');
  await stopChild(apiProcess, 'api');
  if (workerProcess?.pid !== undefined) {
    // 正常关停会自己停容器；这里只兜底清理本轮 worker 可能遗留的容器。
    const listed = await run('docker', [
      'ps',
      '-a',
      '--format',
      '{{.Names}}',
      '--filter',
      `name=agentport-${workerProcess.pid}-`,
    ]).catch(() => ({ code: -1, stdout: '', stderr: '' }));
    for (const name of listed.stdout.split('\n').filter(Boolean)) {
      await run('docker', ['rm', '-f', name]).catch(() => undefined);
    }
  }
  await fake?.close().catch(() => undefined);
  await pool?.end().catch(() => undefined);
  if (keep) {
    if (database !== null) {
      console.error(`保留临时库：${database.name}（用 .env 的管理连接、库名换成本库即可复查）`);
    }
    if (redis !== null) {
      console.error(
        `保留临时 Redis 容器：${redis.name}（${redis.url}；复查后 docker rm -f ${redis.name}）`,
      );
    }
  } else {
    await database?.close().catch(() => undefined);
    await stopRedisContainer(redis).catch(() => undefined);
  }
  if (runRoot !== '' && !keep) {
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  } else if (runRoot !== '') {
    console.error(`保留临时目录：${runRoot}`);
  }
}

const MAX_DIAGNOSTIC_ROWS = 50;
const MAX_DIAGNOSTIC_TEXT = 160;

/** 诊断只放摘要：压掉换行并截断，避免把整段正文或日志刷屏。 */
function summarize(value: unknown, max = MAX_DIAGNOSTIC_TEXT): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 日志与正文里的凭证不落进诊断输出。 */
function redact(text: string): string {
  return text
    .replace(/agentport_token=[^;\s"',]+/g, 'agentport_token=<redacted>')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted-key>');
}

function stamp(value: Date | string | null): string {
  if (value === null) return '-';
  return value instanceof Date ? value.toISOString() : value;
}

interface DiagnosticRunRow {
  id: string;
  status: string;
  trigger: string;
  conversation_id: string;
  agent_id: string;
  channel_id: string | null;
  channel_trigger_message_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  error: string | null;
}

interface DiagnosticChannelMessageRow {
  channel_id: string;
  seq: number;
  kind: string;
  agent_id: string | null;
  run_id: string | null;
  body: string;
  created_at: Date;
}

interface DiagnosticLaneMessageRow {
  conversation_id: string;
  role: string;
  run_id: string | null;
  channel_message_id: string | null;
  content: unknown;
  created_at: Date;
}

/** 失败时在清理临时库/容器之前打印现场：run 状态、消息落库、假模型请求、进程日志。 */
async function printFailureDiagnostics(): Promise<void> {
  console.log('\n========== 失败现场诊断（清理前） ==========');
  if (database !== null) console.log(`临时库：${database.name}`);
  if (redis !== null) console.log(`临时 Redis 容器：${redis.name}`);

  if (fake !== null) {
    const byPath = new Map<string, number>();
    for (const request of fake.requests) {
      byPath.set(request.path, (byPath.get(request.path) ?? 0) + 1);
    }
    console.log(
      `\n[假模型请求] /v1/messages ${fake.messageRequests.length} 条，全部请求 ${fake.requests.length} 条`,
    );
    console.log(`  路径计数：${JSON.stringify(Object.fromEntries(byPath))}`);
    for (const request of fake.messageRequests.slice(-MAX_DIAGNOSTIC_ROWS)) {
      console.log(
        `  ${stamp(new Date(request.at))} ${request.path} prompt=${JSON.stringify(
          summarize(request.prompt),
        )} reply=${JSON.stringify(summarize(request.reply))}`,
      );
    }
  }

  if (pool !== undefined) {
    try {
      const runs = await pool.query<DiagnosticRunRow>(
        `select id, status, trigger, conversation_id, agent_id, channel_id,
                channel_trigger_message_id, started_at, ended_at, error
           from agent_runs
          order by created_at asc`,
      );
      console.log(`\n[agent_runs] ${runs.rows.length} 行`);
      for (const row of runs.rows) {
        console.log(
          `  ${row.id} status=${row.status} trigger=${row.trigger} conversation=${
            row.conversation_id
          } agent=${row.agent_id} channel=${row.channel_id ?? '-'} trigger_message=${
            row.channel_trigger_message_id ?? '-'
          } started=${stamp(row.started_at)} ended=${stamp(row.ended_at)} error=${
            row.error === null ? '-' : JSON.stringify(summarize(row.error))
          }`,
        );
      }

      const counts = await pool.query<{ messages: string; channel_messages: string }>(
        `select (select count(*) from messages)::text as messages,
                (select count(*) from channel_messages)::text as channel_messages`,
      );
      console.log(
        `\n[messages] ${counts.rows[0]?.messages ?? '?'} 行；[channel_messages] ${
          counts.rows[0]?.channel_messages ?? '?'
        } 行（明细最多 ${MAX_DIAGNOSTIC_ROWS} 行）`,
      );

      const channelMessages = await pool.query<DiagnosticChannelMessageRow>(
        `select channel_id, seq, kind, agent_id, run_id, body, created_at
           from channel_messages
          order by seq asc
          limit ${MAX_DIAGNOSTIC_ROWS}`,
      );
      for (const row of channelMessages.rows) {
        console.log(
          `  channel_message seq=${row.seq} kind=${row.kind} channel=${row.channel_id} agent=${
            row.agent_id ?? '-'
          } run=${row.run_id ?? '-'} at=${stamp(row.created_at)} body=${JSON.stringify(
            summarize(row.body),
          )}`,
        );
      }

      const laneMessages = await pool.query<DiagnosticLaneMessageRow>(
        `select conversation_id, role, run_id, channel_message_id, content, created_at
           from messages
          order by created_at asc
          limit ${MAX_DIAGNOSTIC_ROWS}`,
      );
      for (const row of laneMessages.rows) {
        console.log(
          `  message at=${stamp(row.created_at)} conversation=${row.conversation_id} role=${
            row.role
          } run=${row.run_id ?? '-'} channel_message=${row.channel_message_id ?? '-'} content=${JSON.stringify(
            summarize(row.content),
          )}`,
        );
      }
    } catch (error) {
      console.log(`  [数据库诊断查询失败] ${redact(String(error))}`);
    }
  }

  console.log('\n--- api 日志（尾部）---');
  console.log(redact(apiTail()));
  console.log('--- worker 日志（尾部）---');
  console.log(redact(workerTail()));
  console.log('========== 诊断结束 ==========');
}

async function main(): Promise<void> {
  const envFile = join(REPO, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const adminDatabaseUrl = process.env.DATABASE_URL;
  assert(adminDatabaseUrl, '找到 .env 的 DATABASE_URL（只作为建临时库的管理连接）');

  logStep('检查 Docker 与沙盒镜像');
  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 15_000,
  });
  if (docker.code !== 0) fail(`Docker 不可用：${docker.stderr.trim()}`);
  info(`Docker ${docker.stdout.trim()}`);

  // 旧镜像可能存在但不含当前 worker 需要的 supervisor；按必需产物判断，避免假通过。
  const requiredEntry = 'dist/session-supervisor.js';
  const inspectImage = async (): Promise<string | null> => {
    const inspected = await run('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], {
      timeoutMs: 15_000,
    });
    return inspected.code === 0 ? inspected.stdout.trim() : null;
  };
  const probeEntry = async (): Promise<boolean> => {
    if ((await inspectImage()) === null) return false;
    const probed = await run(
      'docker',
      ['run', '--rm', '--entrypoint', 'ls', IMAGE, requiredEntry],
      {
        timeoutMs: 30_000,
      },
    );
    return probed.code === 0;
  };

  const imageReady = await probeEntry();
  if (!imageReady || process.env.E2E_CHANNEL_REBUILD_IMAGE === '1') {
    info(
      imageReady
        ? '按 E2E_CHANNEL_REBUILD_IMAGE=1 重建沙盒镜像'
        : `镜像 ${IMAGE} 缺失或不含 ${requiredEntry}，开始构建（可能需要几分钟）`,
    );
    const built = await run('docker', ['build', '--target', 'sandbox', '-t', IMAGE, '.'], {
      timeoutMs: 900_000,
    });
    if (built.code !== 0) fail(`构建 ${IMAGE} 失败：${built.stderr.trim().slice(-2000)}`);
  }
  const imageId = await inspectImage();
  assert(imageId !== null, `沙盒镜像可用：${IMAGE}`);
  assert(await probeEntry(), `镜像包含当前 supervisor：${requiredEntry}`);
  info(`image id: ${imageId}`);

  logStep('启动隔离 PostgreSQL（随机库）与临时 Redis 容器');
  database = await createIsolatedDatabase('e2e_channel', adminDatabaseUrl);
  if (!database) fail('PostgreSQL 不可用：无法创建临时库');
  info(`临时库：${database.name}（.env 指向的库未改动）`);
  redis = await startRedisContainer();
  if (!redis) fail('Redis 不可用：无法创建临时容器');
  info(`临时 Redis：${new URL(redis.url).host} db=${redisDbOf(redis.url)}`);

  const created = createDb(database.url);
  pool = created.pool;

  logStep(`启动假 Anthropic SSE（固定端口 ${FAKE_PORT}）`);
  fake = await startFakeAnthropic(FAKE_PORT);
  info(`http://127.0.0.1:${FAKE_PORT}`);

  runRoot = await realpath(await mkdtemp(join(tmpdir(), 'agentport-e2e-channel-')));
  const workspacesDir = join(runRoot, 'workspaces');
  const knowledgeDir = join(runRoot, 'knowledge');
  await mkdir(workspacesDir, { recursive: true });
  await mkdir(knowledgeDir, { recursive: true });
  info(`临时工作区：${workspacesDir}`);

  if (MODE !== 'assert') await ensureWebBuild();
  const apiPort = MODE === 'assert' ? await freePort() : UI_PORT;
  const modelProxyPort = await freePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const appSecret = randomBytes(32).toString('base64url');

  // 子进程只继承运行所需的宿主环境，不把 .env 里的真实模型凭证带进去。
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...(process.env.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: process.env.DOCKER_HOST }),
    ...(process.env.DOCKER_CONFIG === undefined
      ? {}
      : { DOCKER_CONFIG: process.env.DOCKER_CONFIG }),
  };

  logStep('启动 api 子进程');
  const apiEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    PORT: String(apiPort),
    SELF_URL: baseUrl,
    DATABASE_URL: database.url,
    REDIS_URL: redis.url,
    APP_SECRET_KEY: appSecret,
    JWT_SECRET: randomBytes(32).toString('base64url'),
    ADMIN_USER,
    ADMIN_PASSWORD,
    RATE_LIMIT_DISABLED: '1',
    CORS_ORIGINS: baseUrl,
    WORKSPACES_DIR: workspacesDir,
    KNOWLEDGE_DIR: knowledgeDir,
    SANDBOX_IMAGE: IMAGE,
    WEB_DIST,
  };
  apiProcess = spawn(
    process.execPath,
    ['--import', 'tsx', join(REPO, 'packages/api/src/index.ts')],
    { cwd: join(REPO, 'packages/api'), env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const apiCapture = captureOutput(apiProcess);
  const apiLogs = (): string => apiCapture.tail(100);
  apiTail = apiLogs;

  await Promise.race([
    pollUntil('API /health/ready', 60_000, async () => {
      if (apiProcess?.exitCode !== null) throw new Error(`api 已退出 (${apiProcess?.exitCode})`);
      try {
        const response = await fetch(`${baseUrl}/health/ready`);
        return response.status === 200;
      } catch {
        return false;
      }
    }),
    childExit(apiProcess).then(() => {
      throw new Error(`api 在就绪前退出：\n${apiLogs()}`);
    }),
  ]);
  info(`api ready：${baseUrl}`);

  logStep('启动 worker 子进程（真实 Docker 沙盒 + SDK，模型指向假 SSE）');
  const workerEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    DATABASE_URL: database.url,
    REDIS_URL: redis.url,
    APP_SECRET_KEY: appSecret,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
    // 非空凭证让 worker 启用模型代理；真实值永远不会离开宿主进程。
    ANTHROPIC_AUTH_TOKEN: 'e2e-channel-fake-token',
    ANTHROPIC_API_KEY: '',
    MODEL_PROXY_PORT: String(modelProxyPort),
    WORKSPACES_DIR: workspacesDir,
    HOST_WORKSPACES_DIR: workspacesDir,
    KNOWLEDGE_DIR: knowledgeDir,
    SANDBOX_IMAGE: IMAGE,
    SANDBOX_API_URL: `http://host.docker.internal:${apiPort}`,
    SANDBOX_EGRESS: 'open',
    SANDBOX_MAX_ACTIVE: '2',
    SANDBOX_IDLE_TIMEOUT_MS: '30000',
    AGENT_MAX_CONCURRENT: '1',
    AGENT_TIMEOUT_MS: '120000',
  };
  workerProcess = spawn(
    process.execPath,
    ['--import', 'tsx', join(REPO, 'packages/worker/src/index.ts')],
    { cwd: join(REPO, 'packages/worker'), env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const workerCapture = captureOutput(workerProcess);
  const workerLogs = (): string => workerCapture.tail(140);
  workerTail = workerLogs;

  await Promise.race([
    pollUntil('worker 就绪日志 "worker started"', 120_000, async () => {
      if (workerProcess?.exitCode !== null)
        throw new Error(`worker 已退出 (${workerProcess?.exitCode})`);
      return workerCapture.all().includes('worker started');
    }),
    childExit(workerProcess).then(() => {
      throw new Error(`worker 在就绪前退出：\n${workerLogs()}`);
    }),
  ]);
  info('worker 已启动');

  const defaultEnvironment = await pollUntil('默认运行环境登记', 30_000, async () => {
    const result = await created.pool.query<{ image_id: string }>(
      `select v.image_id
         from runtime_environments e
         join runtime_environment_versions v on v.id = e.online_version_id
        where e.is_default = true
        limit 1`,
    );
    return result.rows[0] ?? null;
  });
  assert(
    defaultEnvironment.image_id === imageId,
    `默认运行环境使用本次沙盒镜像（${defaultEnvironment.image_id}）`,
  );

  // 浏览器模式到此栈已可用于真实页面；原有无浏览器断言继续走 assert 模式。
  if (MODE !== 'assert') {
    await runStackMode(database.url, baseUrl);
    return;
  }

  logStep('HTTP 登录并创建智能体、频道、绑定');
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  assert(login.status === 200, `管理员登录返回 200（实际 ${login.status}）`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .filter(Boolean)
    .join('; ');
  assert(cookie.includes('agentport_token='), '登录返回 agentport_token cookie');

  const stamp = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  const agentResult = await apiCall(baseUrl, 'POST', '/api/agents', cookie, {
    slug: `e2e-channel-${stamp}`,
    name: `E2E 频道智能体 ${stamp}`,
    systemPrompt: '你是频道验证智能体。收到消息后直接回复内容。',
  });
  assert(agentResult.status === 201, `创建智能体返回 201（实际 ${agentResult.status}）`);
  const agent = agentResult.json as { id: string; enabled: boolean; slug: string };
  assert(agent.enabled === true, '智能体已启用');

  const channelResult = await apiCall(baseUrl, 'POST', '/api/channels', cookie, {
    name: `E2E 频道 ${stamp}`,
  });
  assert(channelResult.status === 201, `创建频道返回 201（实际 ${channelResult.status}）`);
  const channel = channelResult.json as { id: string };
  assert(channel.id.startsWith('chn_'), `频道 ID 使用 TypeID：${channel.id}`);

  const bindingResult = await apiCall(
    baseUrl,
    'POST',
    `/api/channels/${channel.id}/agents`,
    cookie,
    { agentId: agent.id },
  );
  assert(
    bindingResult.status === 201,
    `绑定智能体返回 201（实际 ${bindingResult.status}：${bindingResult.text}）`,
  );
  assert((bindingResult.json as { status: string }).status === 'active', '绑定状态为 active');

  logStep('建立频道 SSE，并等 Redis 订阅真正就绪');
  sseAbort = new AbortController();
  const stream = openEventStream(
    `${baseUrl}/api/channels/${channel.id}/events?after=0`,
    cookie,
    sseAbort.signal,
  );
  await stream.ready;
  await waitForChannelSubscriber(redis.name, redisDbOf(redis.url), channel.id);
  info('频道 SSE 已订阅 channel:<id>:events');

  logStep('第一次 @ 智能体');
  const firstBody = `E2E 第一条频道消息 ${stamp}`;
  const firstPost = await apiCall(baseUrl, 'POST', `/api/channels/${channel.id}/messages`, cookie, {
    body: firstBody,
    mentions: [agent.id],
  });
  assert(firstPost.status === 201, `发送频道消息返回 201（实际 ${firstPost.status}）`);
  const humanMessage1 = firstPost.json as { id: string; seq: number; kind: string };
  assert(humanMessage1.kind === 'human', '第一条消息 kind=human');

  const runStarted1 = await stream.waitFor(
    '第一次 run.started',
    (event) => event.type === 'run.started' && event.agentId === agent.id,
  );
  assert(runStarted1.runId !== undefined, `SSE 收到 run.started（${runStarted1.runId}）`);

  const firstReply = await pollUntil('假模型收到第一条频道消息', 60_000, async () =>
    fake.messageRequests.find((request) => channelCurrentBody(request.prompt) === firstBody),
  );
  info(`假模型第一条回复：${firstReply.reply}`);

  const agentEvent1 = await stream.waitFor(
    '第一次 agent message.created',
    (event) =>
      event.type === 'message.created' &&
      event.message?.kind === 'agent' &&
      event.message?.runId === runStarted1.runId,
  );
  assert(
    agentEvent1.message?.body === firstReply.reply,
    `SSE agent 消息正文与假模型回复一致：${agentEvent1.message?.body}`,
  );

  const finished1 = await stream.waitFor(
    '第一次 run.finished',
    (event) => event.type === 'run.finished' && event.runId === runStarted1.runId,
  );
  assert(finished1.status === 'succeeded', `第一次 run 终态 succeeded（实际 ${finished1.status}）`);

  logStep('第二次 @ 同一智能体，验证 lane 复用');
  const secondBody = `E2E 第二条频道消息 ${stamp}`;
  const secondPost = await apiCall(
    baseUrl,
    'POST',
    `/api/channels/${channel.id}/messages`,
    cookie,
    { body: secondBody, mentions: [agent.id] },
  );
  assert(secondPost.status === 201, `第二次发送频道消息返回 201（实际 ${secondPost.status}）`);
  const humanMessage2 = secondPost.json as { id: string; seq: number };

  const runStarted2 = await stream.waitFor(
    '第二次 run.started',
    (event) =>
      event.type === 'run.started' &&
      event.agentId === agent.id &&
      event.runId !== runStarted1.runId,
  );
  assert(runStarted2.runId !== undefined, `SSE 收到第二次 run.started（${runStarted2.runId}）`);

  const secondReply = await pollUntil('假模型收到第二条频道消息', 60_000, async () =>
    fake.messageRequests.find((request) => channelCurrentBody(request.prompt) === secondBody),
  );
  info(`假模型第二条回复：${secondReply.reply}`);

  const agentEvent2 = await stream.waitFor(
    '第二次 agent message.created',
    (event) =>
      event.type === 'message.created' &&
      event.message?.kind === 'agent' &&
      event.message?.runId === runStarted2.runId,
  );
  assert(
    agentEvent2.message?.body === secondReply.reply,
    `第二条 agent 消息正文与假模型回复一致：${agentEvent2.message?.body}`,
  );

  const finished2 = await stream.waitFor(
    '第二次 run.finished',
    (event) => event.type === 'run.finished' && event.runId === runStarted2.runId,
  );
  assert(finished2.status === 'succeeded', `第二次 run 终态 succeeded（实际 ${finished2.status}）`);

  logStep('数据库与 HTTP 断言');
  const runs = await created.pool.query<RunRow>(
    `select id, conversation_id, agent_id, status, trigger, channel_id,
            channel_trigger_message_id, initiated_by, error
       from agent_runs
      where channel_id = $1
      order by created_at asc`,
    [channel.id],
  );
  assert(runs.rows.length === 2, `agent_runs 有两条频道 run（实际 ${runs.rows.length}）`);
  const [run1, run2] = runs.rows;
  assert(run1 !== undefined && run2 !== undefined, '两条 run 行都存在');
  assert(run1.trigger === 'channel', `第一条 run trigger=channel（实际 ${run1.trigger}）`);
  assert(run1.channel_id === channel.id, '第一条 run channel_id 正确');
  assert(run1.agent_id === agent.id, '第一条 run agent_id 正确');
  assert(run1.conversation_id === run2.conversation_id, '两次 @ 复用同一个 lane conversation');
  assert(run1.initiated_by === 'bootstrap-admin', 'run 发起人是登录的管理员');
  assert(run1.channel_trigger_message_id === humanMessage1.id, '第一条 run 记录触发消息 ID');
  assert(run2.channel_trigger_message_id === humanMessage2.id, '第二条 run 记录触发消息 ID');
  assert(run1.status === 'succeeded', `第一条 run 状态 succeeded（实际 ${run1.status}）`);
  assert(run2.status === 'succeeded', `第二条 run 状态 succeeded（实际 ${run2.status}）`);

  const conversations = await created.pool.query<{ id: string }>(
    `select id from conversations where channel_id = $1 and agent_id = $2`,
    [channel.id, agent.id],
  );
  assert(
    conversations.rows.length === 1,
    `conversations(channel_id, agent_id) 只有一条 lane（实际 ${conversations.rows.length}）`,
  );
  assert(
    conversations.rows[0]?.id === run1.conversation_id,
    'lane conversation 就是两次 run 使用的会话',
  );

  const binding = await created.pool.query<{ conversation_id: string | null }>(
    `select conversation_id from channel_agent_bindings where channel_id = $1 and agent_id = $2`,
    [channel.id, agent.id],
  );
  assert(
    binding.rows[0]?.conversation_id === run1.conversation_id,
    '绑定上的 conversation_id 指向同一 lane',
  );

  const history = await apiCall(
    baseUrl,
    'GET',
    `/api/channels/${channel.id}/messages?limit=100`,
    cookie,
  );
  assert(history.status === 200, `读取频道时间线返回 200（实际 ${history.status}）`);
  const messages = history.json as Array<{
    id: string;
    seq: number;
    kind: string;
    body: string;
    agentId: string | null;
    runId: string | null;
    sourceMessageId: string | null;
  }>;
  const agentMessages = messages.filter((message) => message.kind === 'agent');
  assert(
    agentMessages.length === 2,
    `频道时间线有两条 kind=agent 回复（实际 ${agentMessages.length}）`,
  );
  assert(agentMessages[0]?.body === firstReply.reply, '时间线第一条回复正文正确');
  assert(agentMessages[1]?.body === secondReply.reply, '时间线第二条回复正文正确');
  assert(agentMessages[0]?.agentId === agent.id, '回复关联正确智能体');
  assert(agentMessages[0]?.runId === run1.id, '第一条回复关联第一条 run');
  assert(agentMessages[1]?.runId === run2.id, '第二条回复关联第二条 run');
  assert(
    agentMessages[0]?.seq !== undefined &&
      agentMessages[1]?.seq !== undefined &&
      agentMessages[0].seq > humanMessage1.seq &&
      agentMessages[1].seq > humanMessage2.seq,
    '回复 seq 按时间线递增',
  );
  assert(
    agentMessages.every((message) => message.sourceMessageId !== null),
    '回复带 source_message_id 指向 lane messages',
  );

  const messageRequests = fake.messageRequests;
  // CLI 会额外发一次会话标题生成请求；频道主请求的正文在【当前消息】之后。
  const mainRequests = messageRequests.filter((request) => {
    const body = channelCurrentBody(request.prompt);
    return body === firstBody || body === secondBody;
  });
  assert(
    mainRequests.length === 2,
    `假模型收到两条频道正文的主请求（实际 ${mainRequests.length}，/v1/messages 总数 ${messageRequests.length}）`,
  );
  assert(
    mainRequests[0] !== undefined &&
      mainRequests[1] !== undefined &&
      channelCurrentBody(mainRequests[0].prompt) === firstBody &&
      channelCurrentBody(mainRequests[1].prompt) === secondBody,
    '两次主请求分别携带对应的频道消息正文',
  );
  assert(
    mainRequests[1]?.prompt.startsWith('【频道上下文】') === true,
    '第二条主请求以频道上下文开头',
  );
  assert(
    mainRequests[1]?.prompt.includes(firstReply.reply) === true,
    '第二条主请求的上下文包含第一轮 agent 回复',
  );
  const unexpectedPaths = [
    ...new Set(
      fake.requests
        .map((request) => request.path)
        .filter(
          (path) =>
            path !== '/v1/messages' &&
            path !== '/v1/messages/count_tokens' &&
            path !== '/v1/models',
        ),
    ),
  ];
  assert(
    unexpectedPaths.length === 0,
    `模型代理只转发允许的路径${unexpectedPaths.length === 0 ? '' : `，意外路径：${unexpectedPaths.join(', ')}`}`,
  );

  const sseTypes = stream.events.reduce<Record<string, number>>((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`
========== 频道模式端到端结果 ==========
run1: ${run1.id}
  status=${run1.status} trigger=${run1.trigger}
  conversation=${run1.conversation_id}
  channel_message.body=${JSON.stringify(agentMessages[0]?.body)}
run2: ${run2.id}
  status=${run2.status} trigger=${run2.trigger}
  conversation=${run2.conversation_id}（与 run1 相同）
  channel_message.body=${JSON.stringify(agentMessages[1]?.body)}
频道 SSE 事件计数: ${JSON.stringify(sseTypes)}
假模型 /v1/messages 请求数: ${messageRequests.length}（其中频道主请求 ${mainRequests.length}）
耗时: ${elapsed}s
=========================================
`);
  console.log('全部断言通过');
}

let mainError: unknown;
try {
  await main();
} catch (error) {
  mainError = error;
} finally {
  if (mainError !== undefined || browserE2eExitCode !== null) {
    await printFailureDiagnostics().catch((error: unknown) =>
      console.error(`失败现场诊断输出出错：${String(error)}`),
    );
  }
  console.log('\n==> 清理');
  await cleanup();
  console.log('清理完成');
}

if (mainError !== undefined) {
  console.error(
    `\n端到端验证失败：${mainError instanceof Error ? mainError.stack : String(mainError)}`,
  );
  process.exitCode = 1;
}
