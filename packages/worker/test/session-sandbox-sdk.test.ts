import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChatEvent, SandboxTaskInput } from '@agentport/shared';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { renderWorkspace, type WorkspaceAgent } from '../../core/src/workspace.js';
import { type DockerSandboxOptions, DockerSandboxProvider } from '../src/sandbox/docker.js';
import type { Sandbox, SandboxCreateOptions } from '../src/sandbox/provider.js';
import {
  SessionSandboxes,
  type SessionSandboxLease,
  type SessionSandboxSpec,
} from '../src/sandbox/sessions.js';

/**
 * 真实验收：官方 SDK 0.3.311 的原生 CLI 在 SANDBOX_IMAGE（默认 sandbox:dev）里经 supervisor
 * 执行，模型流量全部打到宿主本地假 Anthropic SSE，不读 .env、不向外发模型请求。
 * Bash 用例直接使用镜像自带的真实 bash，不再放测试专用包装脚本。
 *
 * 每次运行都从当前 shared/sandbox 源码编译到本次独占的临时目录，只读挂载覆盖镜像里
 * 旧版本；不重建共享镜像 tag，也不给 runtime 增加测试专用参数。
 */
const IMAGE = process.env.SANDBOX_IMAGE ?? 'agentport/sandbox:dev';
const MODEL = 'claude-sonnet-5-5';
const SDK_VERSION = '0.3.311';
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SOURCE_EVIDENCE_FILE = '/tmp/session-sdk-current-source.json';
/** 本次运行独占的当前源码编译产物；beforeAll 赋值，afterAll 清理。 */
let sandboxDist = '';
let sharedDist = '';
let sourceBuildRoot = '';

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as Logger;

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  timeoutMs = 60_000,
  cwd?: string,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args[0] ?? ''} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function dockerAvailable(): Promise<boolean> {
  try {
    const result = await run('docker', ['version', '--format', '{{.Server.Version}}'], 10_000);
    return result.code === 0;
  } catch {
    return false;
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

function sourceDigest(dir: string): string {
  const hash = createHash('sha256');
  for (const name of filesUnder(dir)) {
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(dir, name)))
      .update('\0');
  }
  return hash.digest('hex');
}

function newestSourceMtime(dir: string): number {
  return filesUnder(dir).reduce((max, name) => Math.max(max, statSync(join(dir, name)).mtimeMs), 0);
}

function artifact(path: string) {
  return {
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    builtAt: new Date(statSync(path).mtimeMs).toISOString(),
  };
}

/**
 * 每次运行都从当前 shared/sandbox 源码在独占临时目录编译，绝不复用 packages/<pkg>/dist。
 * 临时 tsconfig 只覆盖 outDir/tsBuildInfoFile，并把 @agentport/shared 指向本次构建的
 * 声明文件；项目引用与 tsc -b 仍由工作区工具链负责，产物不会写进共享 dist。
 */
async function compileCurrentSources(
  context: string,
): Promise<{ sandbox: string; shared: string }> {
  const sources = {
    shared: join(REPO_ROOT, 'packages/shared/src'),
    sandbox: join(REPO_ROOT, 'packages/sandbox/src'),
  };
  const outputs = {
    shared: join(context, 'shared'),
    sandbox: join(context, 'sandbox'),
  };
  const sharedConfig = join(context, 'tsconfig.shared.json');
  const sandboxConfig = join(context, 'tsconfig.sandbox.json');
  await writeFile(
    sharedConfig,
    `${JSON.stringify(
      {
        extends: join(REPO_ROOT, 'packages/shared/tsconfig.json'),
        compilerOptions: {
          outDir: outputs.shared,
          tsBuildInfoFile: join(context, 'shared.tsbuildinfo'),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    sandboxConfig,
    `${JSON.stringify(
      {
        extends: join(REPO_ROOT, 'packages/sandbox/tsconfig.json'),
        compilerOptions: {
          outDir: outputs.sandbox,
          tsBuildInfoFile: join(context, 'sandbox.tsbuildinfo'),
          // sandbox 源码里的 bare import 在容器运行时解析；编译期用本次 shared 产物。
          paths: { '@agentport/shared': [join(outputs.shared, 'index.d.ts')] },
        },
        references: [{ path: sharedConfig }],
      },
      null,
      2,
    )}\n`,
  );

  const before = { shared: sourceDigest(sources.shared), sandbox: sourceDigest(sources.sandbox) };
  const command = ['exec', 'tsc', '-b', sandboxConfig, '--force'];
  const compiled = await run('pnpm', command, 180_000, REPO_ROOT);
  if (compiled.code !== 0) {
    const output = `${compiled.stdout}${compiled.stderr}`.trim();
    throw new Error(`compiling current shared/sandbox sources failed: ${output}`);
  }
  const after = { shared: sourceDigest(sources.shared), sandbox: sourceDigest(sources.sandbox) };
  if (before.shared !== after.shared || before.sandbox !== after.sandbox) {
    throw new Error('shared/sandbox sources changed during compilation; rerun this suite');
  }

  const artifacts = {
    'shared/sandbox-session.js': join(outputs.shared, 'sandbox-session.js'),
    'sandbox/session-supervisor.js': join(outputs.sandbox, 'session-supervisor.js'),
  };
  const newestSource = Math.max(
    newestSourceMtime(sources.shared),
    newestSourceMtime(sources.sandbox),
  );
  for (const [label, path] of Object.entries(artifacts)) {
    if (statSync(path).mtimeMs < newestSource) {
      throw new Error(`${label} predates the current sources; refusing stale artifacts`);
    }
  }

  await writeFile(
    SOURCE_EVIDENCE_FILE,
    `${JSON.stringify(
      {
        suite: 'session-sandbox-sdk',
        compiledAt: new Date().toISOString(),
        command: `pnpm ${command.join(' ')}`,
        repoRoot: REPO_ROOT,
        sourceDigest: after,
        artifacts: Object.fromEntries(
          Object.entries(artifacts).map(([label, path]) => [label, artifact(path)]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  return outputs;
}

const hasDocker = await dockerAvailable();
const describeDocker = hasDocker ? describe : describe.skip;

/** 每个测试用自己的 provider，避免上一轮的容器跟踪串进下一轮。 */
class MountedDockerProvider extends DockerSandboxProvider {
  constructor(
    options: DockerSandboxOptions,
    private readonly mounts: NonNullable<SandboxCreateOptions['extraMounts']>,
  ) {
    super(options);
  }

  override create(options: SandboxCreateOptions): Promise<Sandbox> {
    return super.create({
      ...options,
      extraMounts: [...(options.extraMounts ?? []), ...this.mounts],
    });
  }
}

type FinishedEvent = Extract<ChatEvent, { type: 'run_finished' }>;

function finishedEvent(events: ChatEvent[]): FinishedEvent | undefined {
  return events.find((event): event is FinishedEvent => event.type === 'run_finished');
}

function taskInput(prompt: string, resumeSessionId?: string): SandboxTaskInput {
  return {
    prompt,
    model: MODEL,
    maxTurns: 4,
    maxBudgetUsd: 0.01,
    userMessageUuid: randomUUID(),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function waitUntil(check: () => Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface CapturedRequest {
  at: number;
  method: string;
  path: string;
  body: unknown;
  hung: boolean;
  closed: boolean;
}

interface FakeAnthropic {
  baseUrl: string;
  requests: CapturedRequest[];
  messageRequests(): CapturedRequest[];
  waitForRequest(
    predicate: (request: CapturedRequest) => boolean,
    ms?: number,
  ): Promise<CapturedRequest>;
  close(): Promise<void>;
}

const HANG_MARKER = 'HANG_MARKER';

/** 最近一条带文本的 user 消息的最后一个文本块：前面的块是 CLI 注入的 system-reminder。 */
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

/** 当前会话已执行的工具结果数；每次请求都带着完整历史，用它推进脚本步骤。 */
function countToolResults(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    if ((message as { role?: unknown }).role !== 'user') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result'
      ) {
        count += 1;
      }
    }
  }
  return count;
}

interface ToolStep {
  name: string;
  input: Record<string, unknown>;
}

interface ToolScenario {
  /** 该场景只响应提示词里含此标记的请求。 */
  marker: string;
  steps: ToolStep[];
  finalText: string;
}

/**
 * Bash 行为用例共用一个假 API；每个用例在运行前声明自己的确定性脚本，
 * 请求按「最近一条用户提示词」认领场景，按已有 tool_result 数推进到下一步。
 */
let toolScenarios: ToolScenario[] = [];

function sse(res: import('node:http').ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendMessage(
  res: import('node:http').ServerResponse,
  model: string,
  text: string,
  id: string,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/** 与官方流式 tool_use 一致：content_block_start + input_json_delta + stop_reason=tool_use。 */
function sendToolUse(
  res: import('node:http').ServerResponse,
  model: string,
  messageId: string,
  toolUseId: string,
  step: ToolStep,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: toolUseId, name: step.name, input: {} },
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function startFakeAnthropic(requestLog: string): Promise<FakeAnthropic> {
  const requests: CapturedRequest[] = [];
  let nextId = 0;
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const path = new URL(req.url ?? '/', 'http://fake').pathname;
      const record: CapturedRequest = {
        at: Date.now(),
        method: req.method ?? '',
        path,
        body,
        hung: false,
        closed: false,
      };
      requests.push(record);
      appendFileSync(requestLog, `${JSON.stringify(record)}\n`);

      if (path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 32 }));
        return;
      }
      if (path !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'not_found_error', message: `unexpected path ${path}` },
          }),
        );
        return;
      }

      const model =
        typeof (body as { model?: unknown } | null)?.model === 'string'
          ? (body as { model: string }).model
          : MODEL;
      const prompt = lastUserText(body);
      if (prompt.includes(HANG_MARKER)) {
        record.hung = true;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        sse(res, 'message_start', {
          type: 'message_start',
          message: {
            id: `msg_hang_${nextId}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        });
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        res.on('close', () => {
          record.closed = true;
        });
        return;
      }

      nextId += 1;
      const scenario = toolScenarios.find((candidate) => prompt.includes(candidate.marker));
      if (scenario !== undefined) {
        const step = scenario.steps[countToolResults(body)];
        if (step === undefined) {
          sendMessage(res, model, scenario.finalText, `msg_fake_${nextId}`);
        } else {
          sendToolUse(res, model, `msg_fake_${nextId}`, `toolu_fake_${nextId}`, step);
        }
        return;
      }
      sendMessage(res, model, `REPLY:${prompt}`, `msg_fake_${nextId}`);
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolvePromise());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://host.docker.internal:${port}`,
    requests,
    messageRequests: () => requests.filter((request) => request.path === '/v1/messages'),
    async waitForRequest(predicate, ms = 10_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = requests.find(predicate);
        if (found !== undefined) return found;
        await delay(50);
      }
      throw new Error('timed out waiting for a fake Anthropic request');
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

function sandboxEnv(baseUrl: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'testtoken',
    // 清空真实凭证与其他 provider 入口：任何漏网请求只能落到本地假 API。
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BEDROCK_BASE_URL: '',
    ANTHROPIC_VERTEX_BASE_URL: '',
    ANTHROPIC_FOUNDRY_BASE_URL: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
    NO_PROXY: 'host.docker.internal,localhost,127.0.0.1',
  };
}

interface ToolCall {
  id: string;
  name: string;
  parentToolUseId?: string;
  input?: string;
  result?: string;
}

/** 把分散的 tool_start/tool_input/tool_result 事件按 tool_use id 配对。 */
function toolCalls(events: ChatEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type === 'tool_start') {
      calls.set(event.toolUseId, {
        id: event.toolUseId,
        name: event.name,
        ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: event.parentToolUseId }),
      });
      continue;
    }
    if (event.type !== 'tool_input' && event.type !== 'tool_result') continue;
    const call = calls.get(event.toolUseId);
    if (call === undefined) continue;
    if (event.type === 'tool_input') call.input = event.json;
    else call.result = event.content;
  }
  return [...calls.values()];
}

/** 工具权限拒绝的文案随 SDK/规则来源变化，只判定共同语义，不锁死某一版措辞。 */
const DENIED_RESULT = /denied|not allowed|not permitted|unavailable|no such tool|permission/i;

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

interface TestSpecs {
  single: SessionSandboxSpec;
  reuse: SessionSandboxSpec;
  idle: SessionSandboxSpec;
  cancel: SessionSandboxSpec;
  bashDefault: SessionSandboxSpec;
  bashDontAsk: SessionSandboxSpec;
  bashPlatformDeny: SessionSandboxSpec;
  bashCommandDeny: SessionSandboxSpec;
  bashChild: SessionSandboxSpec;
  bashChildDeny: SessionSandboxSpec;
}

describeDocker('session sandbox with the real SDK native CLI', () => {
  let fake: FakeAnthropic;
  let providerMounts: NonNullable<SandboxCreateOptions['extraMounts']>;
  let logDir: string;
  let specs: TestSpecs;

  async function sandboxSpec(name: string): Promise<SessionSandboxSpec> {
    const root = join(logDir, 'state', name);
    const dirs = {
      workspace: join(root, 'workspace'),
      outputs: join(root, 'outputs'),
      inputs: join(root, 'inputs'),
      memory: join(root, 'memory'),
      sessions: join(root, 'sessions'),
    };
    for (const dir of Object.values(dirs)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(dirs.inputs, 'note.txt'), 'session sandbox fixture\n', { mode: 0o600 });
    return {
      agentId: `agent-${name}`,
      conversationId: `conversation-${name}`,
      runtimeEnvironmentId: null,
      workspaceDir: dirs.workspace,
      outputsDir: dirs.outputs,
      inputsDir: dirs.inputs,
      memoryDir: dirs.memory,
      sessionsDir: dirs.sessions,
    };
  }

  function createProvider(): DockerSandboxProvider {
    return new MountedDockerProvider(
      { memory: '1g', cpus: 1, pids: 256, egress: 'open' },
      providerMounts,
    );
  }

  /** 本套件直接使用已存在的 sandbox:dev，用固定环境身份解析到该镜像。 */
  function sessionsFor(provider: DockerSandboxProvider, idleTimeoutMs = 60_000): SessionSandboxes {
    return new SessionSandboxes({
      provider,
      idleTimeoutMs,
      logger: quiet,
      resolveRuntimeEnvironment: async () => ({
        environmentId: 'env_test',
        environmentName: 'test',
        versionId: 'version_test',
        imageId: IMAGE,
      }),
    });
  }

  async function startRun(
    lease: SessionSandboxLease,
    prompt: string,
    resumeSessionId?: string,
    overrides: Partial<SandboxTaskInput> = {},
  ): Promise<{
    events: ChatEvent[];
    stderr: string[];
    execution: Awaited<ReturnType<SessionSandboxLease['start']>>;
  }> {
    const events: ChatEvent[] = [];
    const stderr: string[] = [];
    const execution = await lease.start({
      runId: `run-${randomUUID()}`,
      task: { ...taskInput(prompt, resumeSessionId), ...overrides },
      env: sandboxEnv(fake.baseUrl),
      onEvent: (event) => events.push(event),
      onStderr: (text) => stderr.push(text),
    });
    return { events, stderr, execution };
  }

  /** 用当前 core 渲染器生成官方工作区文件，避免测试手写与产品渲染分叉。 */
  async function writeWorkspaceFixture(
    spec: SessionSandboxSpec,
    options: {
      subAgents?: WorkspaceAgent[];
      toolsDeny?: string[];
    } = {},
  ): Promise<void> {
    const files = renderWorkspace({
      agent: {
        slug: 'bash-parent',
        name: 'Bash Parent',
        model: MODEL,
        systemPrompt: '按用户要求执行命令并回报结果。',
        maxTurns: 10,
        ...(options.toolsDeny === undefined ? {} : { disallowedTools: options.toolsDeny }),
      },
      servers: [],
      ...(options.subAgents === undefined ? {} : { subAgents: options.subAgents }),
    });
    await writeFile(join(spec.workspaceDir, 'CLAUDE.md'), files.claudeMd);
    await writeFile(join(spec.workspaceDir, '.mcp.json'), files.mcpJson);
    const claudeDir = join(spec.workspaceDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    if (files.subAgents.length > 0) {
      const agentsDir = join(claudeDir, 'agents');
      await mkdir(agentsDir, { recursive: true });
      for (const child of files.subAgents) {
        await writeFile(join(agentsDir, `${child.slug}.md`), child.content);
      }
    }
  }

  function childAgent(slug: string, disallowedTools?: string[]): WorkspaceAgent {
    return {
      slug,
      name: slug,
      model: MODEL,
      systemPrompt: '执行父智能体交给你的命令并返回结果。',
      maxTurns: 8,
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
    };
  }

  /** 每次行为用例独占一个容器；结束后统一销毁，不把用例状态串到下一轮。 */
  async function execute(
    spec: SessionSandboxSpec,
    prompt: string,
    overrides: Partial<SandboxTaskInput> = {},
    timeoutMs = 60_000,
  ) {
    const provider = createProvider();
    const sessions = sessionsFor(provider);
    try {
      const lease = await sessions.acquire(spec, new AbortController().signal);
      const run = await startRun(lease, prompt, undefined, overrides);
      const settlement = await withTimeout(run.execution.done, timeoutMs, 'bash behavior run');
      return { settlement, events: run.events, stderr: run.stderr };
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }

  async function containerExists(id: string): Promise<boolean> {
    const result = await run('docker', ['container', 'inspect', id], 10_000);
    return result.code === 0;
  }

  beforeAll(async () => {
    sourceBuildRoot = await mkdtemp(join(tmpdir(), 'session-sdk-source-'));
    const built = await compileCurrentSources(sourceBuildRoot);
    sandboxDist = built.sandbox;
    sharedDist = built.shared;

    const image = await run('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], 10_000);
    if (image.code !== 0) {
      throw new Error(
        `sandbox image ${IMAGE} is missing; build it with pnpm --filter @agentport/sandbox image`,
      );
    }

    // 开箱证据：真实 GNU bash、poppler 工具齐全，默认用户 1000；不满足就不跑用例。
    const bash = await run(
      'docker',
      ['run', '--rm', '--entrypoint', 'bash', IMAGE, '--version'],
      30_000,
    );
    if (bash.code !== 0 || !bash.stdout.includes('GNU bash')) {
      throw new Error(`${IMAGE} does not ship a real GNU bash: ${bash.stderr.trim()}`);
    }
    for (const tool of ['pdftoppm', 'pdfinfo']) {
      const probe = await run('docker', ['run', '--rm', '--entrypoint', tool, IMAGE, '-v'], 30_000);
      if (probe.code !== 0) {
        throw new Error(`${IMAGE} is missing ${tool}: ${probe.stderr.trim()}`);
      }
    }
    const uid = await run('docker', ['run', '--rm', '--entrypoint', 'id', IMAGE, '-u'], 30_000);
    if (uid.code !== 0 || uid.stdout.trim() !== '1000') {
      throw new Error(
        `${IMAGE} must run as uid 1000, got ${uid.stdout.trim()}: ${uid.stderr.trim()}`,
      );
    }

    const sdk = await run(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'node',
        IMAGE,
        '-e',
        "const fs=require('node:fs');const name=fs.readdirSync('/app/node_modules/.pnpm').find((entry)=>entry.startsWith('@anthropic-ai+claude-agent-sdk@'));process.stdout.write(JSON.parse(fs.readFileSync('/app/node_modules/.pnpm/'+name+'/node_modules/@anthropic-ai/claude-agent-sdk/package.json','utf8')).version)",
      ],
      30_000,
    );
    if (sdk.code !== 0) {
      throw new Error(`cannot read the SDK version inside ${IMAGE}: ${sdk.stderr.trim()}`);
    }
    expect(sdk.stdout.trim()).toBe(SDK_VERSION);

    // 镜像里的 pnpm store 路径含构建哈希；运行时解析一次，避免写死路径。
    const sharedDir = await run(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'node',
        IMAGE,
        '-e',
        "process.stdout.write(require('node:fs').realpathSync('/app/node_modules/@agentport/shared'))",
      ],
      30_000,
    );
    if (sharedDir.code !== 0 || sharedDir.stdout.trim() === '') {
      throw new Error(
        `cannot resolve @agentport/shared inside ${IMAGE}: ${sharedDir.stderr.trim()}`,
      );
    }
    providerMounts = [
      { hostPath: sandboxDist, containerPath: '/app/dist', readonly: true },
      {
        hostPath: sharedDist,
        containerPath: join(sharedDir.stdout.trim(), 'dist'),
        readonly: true,
      },
    ];

    logDir = await mkdtemp(join(tmpdir(), 'session-sdk-'));
    fake = await startFakeAnthropic(join(logDir, 'fake-anthropic.jsonl'));
    specs = {
      single: await sandboxSpec('single'),
      reuse: await sandboxSpec('reuse'),
      idle: await sandboxSpec('idle'),
      cancel: await sandboxSpec('cancel'),
      bashDefault: await sandboxSpec('bash-default'),
      bashDontAsk: await sandboxSpec('bash-dontask'),
      bashPlatformDeny: await sandboxSpec('bash-platform-deny'),
      bashCommandDeny: await sandboxSpec('bash-command-deny'),
      bashChild: await sandboxSpec('bash-child'),
      bashChildDeny: await sandboxSpec('bash-child-deny'),
    };

    await Promise.all([
      writeWorkspaceFixture(specs.bashDefault),
      writeWorkspaceFixture(specs.bashDontAsk),
      writeWorkspaceFixture(specs.bashPlatformDeny),
      writeWorkspaceFixture(specs.bashCommandDeny),
      writeWorkspaceFixture(specs.bashChild, {
        subAgents: [childAgent('bash-child')],
      }),
      writeWorkspaceFixture(specs.bashChildDeny, {
        subAgents: [childAgent('bash-child-denied', ['Bash'])],
      }),
    ]);

    // 沙盒固定以 uid 1000 运行；只调整本测试自己的 /tmp 目录。
    const chown = await run(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        'root',
        '-v',
        `${join(logDir, 'state')}:${join(logDir, 'state')}`,
        '--entrypoint',
        'chown',
        IMAGE,
        '-R',
        '1000:1000',
        join(logDir, 'state'),
      ],
      30_000,
    );
    if (chown.code !== 0) {
      throw new Error(
        `failed to prepare session sandbox dirs for uid 1000: ${chown.stderr.trim()}`,
      );
    }
    console.error(`[session-sandbox-sdk] logs and requests: ${logDir}`);
  });

  beforeEach(() => {
    // 各用例只断言自己这轮的模型请求；落盘日志仍保留完整序列。
    fake.requests.length = 0;
    toolScenarios = [];
  });

  afterAll(async () => {
    await fake?.close();
    if (sourceBuildRoot !== '') {
      await rm(sourceBuildRoot, { recursive: true, force: true });
    }
  });

  it('runs one real SDK turn through the local fake Anthropic API', async () => {
    const provider = createProvider();
    const sessions = sessionsFor(provider);
    try {
      const lease = await sessions.acquire(specs.single, new AbortController().signal);
      const run = await startRun(lease, '单轮：请回复 SPIKE-ONE');
      const settlement = await withTimeout(run.execution.done, 30_000, 'single run');
      expect(settlement.state).toBe('stopped');
      if (settlement.state === 'stopped') expect(settlement.code).toBe(0);

      const finished = finishedEvent(run.events);
      expect(finished?.status).toBe('succeeded');
      expect(finished?.sessionId).toEqual(expect.any(String));
      expect(
        run.events.some(
          (event) => event.type === 'assistant_text' && event.text.includes('REPLY:单轮'),
        ),
      ).toBe(true);

      const messages = fake.messageRequests();
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages[0]?.body)).toContain('SPIKE-ONE');
      expect(new Set(fake.requests.map((request) => request.path))).toEqual(
        new Set(['/v1/messages']),
      );

      await lease.release({ reuse: true });
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }, 60_000);

  it('reuses one container and resumes the same SDK session across runs', async () => {
    const provider = createProvider();
    const sessions = sessionsFor(provider);
    try {
      const firstLease = await sessions.acquire(specs.reuse, new AbortController().signal);
      const firstSandboxId = firstLease.sandboxId;
      const first = await startRun(firstLease, '第一轮：请记住暗号 ORANGE-731');
      const firstSettlement = await withTimeout(first.execution.done, 30_000, 'reuse run 1');
      expect(firstSettlement.state).toBe('stopped');
      const firstFinished = finishedEvent(first.events);
      expect(firstFinished?.status).toBe('succeeded');
      const sessionId = firstFinished?.sessionId;
      expect(sessionId).toEqual(expect.any(String));
      if (sessionId === undefined) throw new Error('first run did not report a session id');
      await firstLease.release({ reuse: true });

      const secondLease = await sessions.acquire(specs.reuse, new AbortController().signal);
      expect(secondLease.sandboxId).toBe(firstSandboxId);
      const second = await startRun(secondLease, '第二轮：暗号是什么？', sessionId);
      const secondSettlement = await withTimeout(second.execution.done, 30_000, 'reuse run 2');
      expect(secondSettlement.state).toBe('stopped');
      const secondFinished = finishedEvent(second.events);
      expect(secondFinished?.status).toBe('succeeded');
      expect(secondFinished?.sessionId).toBe(sessionId);

      const messages = fake.messageRequests();
      expect(messages).toHaveLength(2);
      expect(messages[0]?.body).toBeDefined();
      // 第二轮请求必须带着宿主持久 session 里的第一轮历史，而不是重新开始。
      expect(JSON.stringify(messages[1]?.body)).toContain('ORANGE-731');
      expect(JSON.stringify(messages[1]?.body)).toContain('REPLY:第一轮：请记住暗号 ORANGE-731');
      expect(new Set(fake.requests.map((request) => request.path))).toEqual(
        new Set(['/v1/messages']),
      );

      await secondLease.release({ reuse: true });
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }, 60_000);

  it('recycles an idle container and resumes from the persistent session on disk', async () => {
    const provider = createProvider();
    // 短阈值让真实回收可被观察；生产默认值仍由 worker 配置控制。
    const sessions = sessionsFor(provider, 1_200);
    try {
      const firstLease = await sessions.acquire(specs.idle, new AbortController().signal);
      const firstSandboxId = firstLease.sandboxId;
      const first = await startRun(firstLease, '回收前：请记住暗号 BLUE-442');
      expect((await withTimeout(first.execution.done, 30_000, 'idle run 1')).state).toBe('stopped');
      const sessionId = finishedEvent(first.events)?.sessionId;
      if (sessionId === undefined) throw new Error('first run did not report a session id');
      await firstLease.release({ reuse: true });

      await waitUntil(
        async () => !(await containerExists(firstSandboxId)),
        20_000,
        `idle sandbox ${firstSandboxId} to be removed`,
      );

      const secondLease = await sessions.acquire(specs.idle, new AbortController().signal);
      expect(secondLease.sandboxId).not.toBe(firstSandboxId);
      const second = await startRun(secondLease, '回收后：继续', sessionId);
      expect((await withTimeout(second.execution.done, 30_000, 'idle run 2')).state).toBe(
        'stopped',
      );
      const secondFinished = finishedEvent(second.events);
      expect(secondFinished?.status).toBe('succeeded');
      expect(secondFinished?.sessionId).toBe(sessionId);

      const messages = fake.messageRequests();
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages[1]?.body)).toContain('BLUE-442');
      expect(JSON.stringify(messages[1]?.body)).toContain('REPLY:回收前：请记住暗号 BLUE-442');

      await secondLease.release({ reuse: true });
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }, 60_000);

  it('confirms a cancelled hung run, keeps the session id, and resumes on the same container', async () => {
    const provider = createProvider();
    const sessions = sessionsFor(provider);
    try {
      const firstLease = await sessions.acquire(specs.cancel, new AbortController().signal);
      const sandboxId = firstLease.sandboxId;
      const first = await startRun(firstLease, '取消前：请记住暗号 GREEN-913');
      expect((await withTimeout(first.execution.done, 30_000, 'cancel run 1')).state).toBe(
        'stopped',
      );
      const sessionId = finishedEvent(first.events)?.sessionId;
      if (sessionId === undefined) throw new Error('first run did not report a session id');

      const second = await startRun(firstLease, `取消挂起 ${HANG_MARKER} GREEN-913`, sessionId);
      const hung = await fake.waitForRequest((request) => request.hung, 10_000);
      const requestCountAtCancel = fake.requests.length;
      const cancelSettlement = await withTimeout(second.execution.cancel(), 15_000, 'cancel');
      expect(cancelSettlement.state).toBe('stopped');
      expect(await withTimeout(second.execution.done, 5_000, 'cancelled done')).toEqual(
        cancelSettlement,
      );

      const cancelledFinished = finishedEvent(second.events);
      expect(cancelledFinished?.status).toBe('cancelled');
      // 取消分支也必须把本轮 session id 交给宿主，否则下一轮只能退回旧 id。
      expect(cancelledFinished?.sessionId).toBe(sessionId);

      // 取消后不应再向模型发迟到请求（等待窗口内请求数不增长）。
      await delay(750);
      expect(fake.requests.length).toBe(requestCountAtCancel);
      expect(hung.closed).toBe(true);

      await firstLease.release({ reuse: true });
      const resumedLease = await sessions.acquire(specs.cancel, new AbortController().signal);
      expect(resumedLease.sandboxId).toBe(sandboxId);
      const resumed = await startRun(resumedLease, '取消后：继续 GREEN-913', sessionId);
      expect((await withTimeout(resumed.execution.done, 30_000, 'cancel run 3')).state).toBe(
        'stopped',
      );
      const resumedFinished = finishedEvent(resumed.events);
      expect(resumedFinished?.status).toBe('succeeded');
      expect(resumedFinished?.sessionId).toBe(sessionId);
      expect(JSON.stringify(fake.messageRequests().at(-1)?.body)).toContain('GREEN-913');
      expect(JSON.stringify(fake.messageRequests().at(-1)?.body)).toContain(
        'REPLY:取消前：请记住暗号 GREEN-913',
      );

      await resumedLease.release({ reuse: true });
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }, 60_000);

  it.each(['default', 'dontAsk'] as const)(
    'lets the parent agent run Bash under %s and write only to /mnt/outputs',
    async (mode) => {
      const marker = `BASH-${mode.toUpperCase()}`;
      const spec = mode === 'default' ? specs.bashDefault : specs.bashDontAsk;
      const outputName = `parent-${mode}.txt`;
      const command = [
        `printf 'ok' > /mnt/outputs/${outputName}`,
        `if printf 'no' > /workspace/should-not-exist-${mode}.txt 2>/dev/null; then echo WORKSPACE_WRITABLE; else echo WORKSPACE_READONLY; fi`,
      ].join('; ');
      toolScenarios = [
        {
          marker,
          steps: [
            {
              name: 'Bash',
              input: { command, description: 'write outputs and probe the readonly workspace' },
            },
          ],
          finalText: `DONE:${marker}`,
        },
      ];

      const result = await execute(spec, `${marker} 请执行 Bash 行为验收`, {
        permissionMode: mode,
        maxTurns: 6,
      });

      expect(result.settlement.state).toBe('stopped');
      expect(finishedEvent(result.events)?.status).toBe('succeeded');
      const bash = toolCalls(result.events).filter((call) => call.name === 'Bash');
      expect(bash).toHaveLength(1);
      // 父级自己的调用没有 parent_tool_use_id。
      expect(bash[0]?.parentToolUseId).toBeUndefined();
      expect(bash[0]?.result).toContain('WORKSPACE_READONLY');
      expect(readIfExists(join(spec.outputsDir, outputName))).toBe('ok');
      expect(readIfExists(join(spec.workspaceDir, `should-not-exist-${mode}.txt`))).toBeUndefined();
    },
    90_000,
  );

  it('keeps an explicit parent Bash deny effective', async () => {
    const marker = 'BASH-PLATFORM-DENY';
    const deniedFile = join(specs.bashPlatformDeny.outputsDir, 'platform-denied.txt');
    toolScenarios = [
      {
        marker,
        steps: [
          {
            name: 'Bash',
            input: { command: 'echo DENIED > /mnt/outputs/platform-denied.txt' },
          },
        ],
        finalText: `DONE:${marker}`,
      },
    ];

    const result = await execute(specs.bashPlatformDeny, `${marker} 尝试写入产出目录`, {
      extraDisallowedTools: ['Bash'],
      maxTurns: 6,
    });

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const bash = toolCalls(result.events).filter((call) => call.name === 'Bash');
    expect(bash).toHaveLength(1);
    expect(bash[0]?.result).toMatch(DENIED_RESULT);
    expect(readIfExists(deniedFile)).toBeUndefined();
  }, 90_000);

  it('keeps a command-level Bash deny effective while allowing other commands', async () => {
    const marker = 'BASH-COMMAND-DENY';
    const allowedFile = join(specs.bashCommandDeny.outputsDir, 'command-allowed.txt');
    const deniedFile = join(specs.bashCommandDeny.outputsDir, 'command-denied.txt');
    toolScenarios = [
      {
        marker,
        steps: [
          {
            name: 'Bash',
            input: {
              command:
                "printf 'ALLOWED_OUTPUT\\n' > /mnt/outputs/command-allowed.txt && cat /mnt/outputs/command-allowed.txt",
            },
          },
          {
            name: 'Bash',
            input: {
              command: 'echo DENIED_OUTPUT > /mnt/outputs/command-denied.txt',
            },
          },
        ],
        finalText: `DONE:${marker}`,
      },
    ];

    const result = await execute(specs.bashCommandDeny, `${marker} 依次执行两条命令`, {
      extraDisallowedTools: ['Bash(echo:*)'],
      maxTurns: 8,
    });

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const bash = toolCalls(result.events).filter((call) => call.name === 'Bash');
    expect(bash).toHaveLength(2);
    expect(bash[0]?.result).toContain('ALLOWED_OUTPUT');
    expect(bash[0]?.result).not.toMatch(DENIED_RESULT);
    expect(readIfExists(allowedFile)).toBe('ALLOWED_OUTPUT\n');
    expect(bash[1]?.result).toMatch(DENIED_RESULT);
    expect(readIfExists(deniedFile)).toBeUndefined();
  }, 90_000);

  it('lets a delegated subagent run Bash and write outputs', async () => {
    const parentMarker = 'BASH-CHILD-PARENT';
    const childMarker = 'BASH-CHILD-WORK';
    const childFile = join(specs.bashChild.outputsDir, 'child.txt');
    toolScenarios = [
      {
        marker: parentMarker,
        steps: [
          {
            name: 'Agent',
            input: {
              subagent_type: 'bash-child',
              description: 'child bash check',
              prompt: `${childMarker} 在子智能体里执行 Bash`,
            },
          },
        ],
        finalText: `DONE:${parentMarker}`,
      },
      {
        marker: childMarker,
        steps: [
          {
            name: 'Bash',
            input: { command: 'echo CHILD-RAN > /mnt/outputs/child.txt && echo CHILD-RAN' },
          },
        ],
        finalText: `DONE:${childMarker}`,
      },
    ];

    const result = await execute(
      specs.bashChild,
      `${parentMarker} 委派子智能体执行 Bash`,
      {
        allowSubAgents: true,
        subAgents: [{ slug: 'bash-child' }],
        maxTurns: 10,
      },
      120_000,
    );

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const calls = toolCalls(result.events);
    const agent = calls.find((call) => call.name === 'Agent');
    expect(agent?.input).toContain(childMarker);
    const childBash = calls.find(
      (call) => call.name === 'Bash' && call.parentToolUseId !== undefined,
    );
    expect(childBash?.parentToolUseId).toBe(agent?.id);
    expect(childBash?.result).toContain('CHILD-RAN');
    expect(readIfExists(childFile)).toBe('CHILD-RAN\n');
    // 子智能体的最终文本带父侧 Agent 的 tool_use id，证明确实由该委派产生。
    expect(
      result.events.some(
        (event) => event.type === 'assistant_text' && event.parentToolUseId === agent?.id,
      ),
    ).toBe(true);
  }, 120_000);

  it('keeps a subagent Bash deny scoped to that subagent', async () => {
    const parentMarker = 'BASH-CHILD-DENY-PARENT';
    const childMarker = 'BASH-CHILD-DENY-WORK';
    const beforeFile = join(specs.bashChildDeny.outputsDir, 'parent-before.txt');
    const afterFile = join(specs.bashChildDeny.outputsDir, 'parent-after.txt');
    const childFile = join(specs.bashChildDeny.outputsDir, 'child-denied.txt');
    toolScenarios = [
      {
        marker: parentMarker,
        steps: [
          {
            name: 'Bash',
            input: {
              command:
                'echo PARENT-BEFORE > /mnt/outputs/parent-before.txt && echo PARENT-BEFORE-RAN',
            },
          },
          {
            name: 'Agent',
            input: {
              subagent_type: 'bash-child-denied',
              description: 'child denied bash',
              prompt: `${childMarker} 在子智能体里尝试 Bash`,
            },
          },
          {
            name: 'Bash',
            input: {
              command: 'echo PARENT-AFTER > /mnt/outputs/parent-after.txt && echo PARENT-AFTER-RAN',
            },
          },
        ],
        finalText: `DONE:${parentMarker}`,
      },
      {
        marker: childMarker,
        steps: [
          {
            name: 'Bash',
            input: { command: 'echo CHILD-DENIED > /mnt/outputs/child-denied.txt' },
          },
        ],
        finalText: `DONE:${childMarker}`,
      },
    ];

    const result = await execute(
      specs.bashChildDeny,
      `${parentMarker} 先执行 Bash，再委派拒绝 Bash 的子智能体`,
      {
        allowSubAgents: true,
        subAgents: [{ slug: 'bash-child-denied' }],
        maxTurns: 12,
      },
      120_000,
    );

    expect(finishedEvent(result.events)?.status).toBe('succeeded');
    const calls = toolCalls(result.events);
    const parentBash = calls.filter(
      (call) => call.name === 'Bash' && call.parentToolUseId === undefined,
    );
    expect(parentBash).toHaveLength(2);
    expect(parentBash[0]?.result).toContain('PARENT-BEFORE-RAN');
    expect(parentBash[1]?.result).toContain('PARENT-AFTER-RAN');
    expect(readIfExists(beforeFile)).toBe('PARENT-BEFORE\n');
    expect(readIfExists(afterFile)).toBe('PARENT-AFTER\n');

    const agent = calls.find((call) => call.name === 'Agent');
    const childBash = calls.find(
      (call) => call.name === 'Bash' && call.parentToolUseId !== undefined,
    );
    expect(childBash?.parentToolUseId).toBe(agent?.id);
    expect(childBash?.result).toMatch(DENIED_RESULT);
    expect(readIfExists(childFile)).toBeUndefined();
  }, 120_000);
});
