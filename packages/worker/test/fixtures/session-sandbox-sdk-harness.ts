import { expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent, SandboxTaskInput } from '@agentport/shared';
import type { Logger } from 'pino';

import { renderWorkspace, type WorkspaceAgent } from '../../../core/src/workspace.js';
import { type DockerSandboxOptions, DockerSandboxProvider } from '../../src/sandbox/docker.js';
import type { Sandbox, SandboxCreateOptions } from '../../src/sandbox/provider.js';
import {
  SessionSandboxes,
  type SessionSandboxLease,
  type SessionSandboxSpec,
} from '../../src/sandbox/sessions.js';

const IMAGE = process.env.SANDBOX_IMAGE ?? 'agentport/sandbox:dev';
const MODEL = 'claude-sonnet-5-5';
const SDK_VERSION = (
  JSON.parse(readFileSync(new URL('../../../sandbox/package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  }
).dependencies['@anthropic-ai/claude-agent-sdk'];
export const SUBAGENT_MEMORY_ROOT = '/workspace/.claude/agent-memory';
const REPO_ROOT = Bun.fileURLToPath(new URL('../../../..', import.meta.url));

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
  const hash = new Bun.CryptoHasher('sha256');
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
    sha256: new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex'),
    builtAt: new Date(statSync(path).mtimeMs).toISOString(),
  };
}

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
          paths: { '@agentport/shared': [join(outputs.shared, 'index.d.ts')] },
        },
        references: [{ path: sharedConfig }],
      },
      null,
      2,
    )}\n`,
  );

  const before = { shared: sourceDigest(sources.shared), sandbox: sourceDigest(sources.sandbox) };
  const command = ['run', 'tsc', '-b', sandboxConfig, '--force'];
  const compiled = await run('bun', command, 180_000, REPO_ROOT);
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
    join(context, 'session-sdk-current-source.json'),
    `${JSON.stringify(
      {
        suite: 'session-sandbox-sdk',
        compiledAt: new Date().toISOString(),
        command: `bun ${command.join(' ')}`,
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

export const hasDocker = await dockerAvailable();

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

export function finishedEvent(events: ChatEvent[]): FinishedEvent | undefined {
  return events.find((event): event is FinishedEvent => event.type === 'run_finished');
}

function taskInput(prompt: string, resumeSessionId?: string): SandboxTaskInput {
  return {
    prompt,
    model: MODEL,
    maxTurns: 4,
    maxBudgetUsd: 0.01,
    userMessageUuid: crypto.randomUUID(),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function waitUntil(
  check: () => Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
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

export const HANG_MARKER = 'HANG_MARKER';

/** 最近一条带文本的 user 消息的最后一个文本块：前面的块是 CLI 注入的 system-reminder。 */
export function lastUserText(body: unknown): string {
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

export interface ToolStep {
  name: string;
  input: Record<string, unknown>;
}

interface ToolScenario {
  marker: string;
  steps: ToolStep[];
  finalText: string;
}

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

async function startFakeAnthropic(
  requestLog: string,
  getToolScenarios: () => ToolScenario[],
): Promise<FakeAnthropic> {
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
      const scenario = getToolScenarios().find((candidate) => prompt.includes(candidate.marker));
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

export function toolCalls(events: ChatEvent[]): ToolCall[] {
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
export const DENIED_RESULT =
  /denied|not allowed|not permitted|unavailable|no such tool|permission/i;

export const FILE_BOUNDARY_REASON =
  'File tools are limited to native memory, this run’s outputs, and skill reference Markdown.';

export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * `memory: project` 会自动启用 Read/Write/Edit；这里逐个裸 deny 验证显式禁用仍优先。
 * Read 用例用主题文件：MEMORY.md 本来就会被自动加载，不能当作显式 Read 的证据。
 */
export const DENY_CASES = [
  {
    name: 'deny-read',
    specKey: 'denyRead',
    tool: 'Read',
    slug: 'mem-deny-read',
    initial: 'SENTINEL-TOPIC-READ\n',
  },
  {
    name: 'deny-write',
    specKey: 'denyWrite',
    tool: 'Write',
    slug: 'mem-deny-write',
    initial: 'ORIGINAL-WRITE\n',
  },
  {
    name: 'deny-edit',
    specKey: 'denyEdit',
    tool: 'Edit',
    slug: 'mem-deny-edit',
    initial: 'ORIGINAL-EDIT\n',
  },
] as const;

export function sessionsFor(
  provider: DockerSandboxProvider,
  idleTimeoutMs = 60_000,
): SessionSandboxes {
  return new SessionSandboxes({
    provider,
    idleTimeoutMs,
    maxActive: 32,
    logger: quiet,
    resolveRuntimeEnvironment: async () => ({
      environmentId: 'env_test',
      environmentName: 'test',
      versionId: 'version_test',
      imageId: IMAGE,
    }),
  });
}

async function writeWorkspaceFixture(
  spec: SessionSandboxSpec,
  subAgents?: WorkspaceAgent[],
): Promise<void> {
  const files = renderWorkspace({
    agent: {
      slug: 'bash-parent',
      name: 'Bash Parent',
      model: MODEL,
      systemPrompt: '按用户要求执行命令并回报结果。',
      maxTurns: 10,
    },
    servers: [],
    ...(subAgents === undefined ? {} : { subAgents }),
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

function childAgent(slug: string, disallowedTools?: string[], maxTurns = 8): WorkspaceAgent {
  return {
    slug,
    name: slug,
    model: MODEL,
    systemPrompt: '执行父智能体交给你的命令并返回结果。',
    maxTurns,
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
  };
}

/** 子请求 body.system 既可能是字符串也可能是块数组；两种都按文本检查。 */
export function systemText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const system = (body as { system?: unknown }).system;
  return typeof system === 'string' ? system : JSON.stringify(system ?? '');
}

export function memoryTask(slugs: string[]): Partial<SandboxTaskInput> {
  return {
    allowSubAgents: true,
    subAgents: slugs.map((slug) => ({ slug })),
    maxTurns: 20,
  };
}

export async function containerExists(id: string): Promise<boolean> {
  const result = await run('docker', ['container', 'inspect', id], 10_000);
  return result.code === 0;
}

type SpecDescriptor = {
  name: string;
  prepare?: (spec: SessionSandboxSpec) => Promise<void>;
};

export function createSessionSdkSuite() {
  let fake: FakeAnthropic;
  let providerMounts: NonNullable<SandboxCreateOptions['extraMounts']>;
  let logDir: string;
  let sourceBuildRoot = '';
  let toolScenarios: ToolScenario[] = [];

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
      memoryWritable: true,
      sessionsDir: dirs.sessions,
    };
  }

  function createProvider(): DockerSandboxProvider {
    return new MountedDockerProvider(
      { memory: '1g', cpus: 1, pids: 256, egress: 'open' },
      providerMounts,
    );
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
      runId: `run-${crypto.randomUUID()}`,
      task: { ...taskInput(prompt, resumeSessionId), ...overrides },
      env: sandboxEnv(fake.baseUrl),
      onEvent: (event) => events.push(event),
      onStderr: (text) => stderr.push(text),
    });
    return { events, stderr, execution };
  }

  async function mountSubAgentMemory(
    name: string,
    spec: SessionSandboxSpec,
    slugs: string[],
  ): Promise<void> {
    const dirs: NonNullable<SessionSandboxSpec['subAgentMemoryDirs']> = [];
    for (const slug of [...slugs].sort()) {
      const memoryDir = subAgentHost(name, slug);
      await mkdir(memoryDir, { recursive: true, mode: 0o700 });
      await mkdir(join(spec.workspaceDir, '.claude', 'agent-memory', slug), {
        recursive: true,
        mode: 0o700,
      });
      dirs.push({ slug, memoryDir });
    }
    spec.subAgentMemoryDirs = dirs;
  }

  function subAgentHost(name: string, slug: string): string {
    return join(logDir, 'state', name, 'agent-memory', slug);
  }

  async function execute(
    spec: SessionSandboxSpec,
    prompt: string,
    overrides: Partial<SandboxTaskInput> = {},
    timeoutMs = 60_000,
  ) {
    const provider = createProvider();
    const sessions = sessionsFor(provider);
    try {
      const lease = await sessions.acquire(
        spec,
        new AbortController().signal,
        `run-${crypto.randomUUID()}`,
      );
      const run = await startRun(lease, prompt, undefined, overrides);
      const settlement = await withTimeout(run.execution.done, timeoutMs, 'bash behavior run');
      return { settlement, events: run.events, stderr: run.stderr };
    } finally {
      await sessions.close();
      await provider.destroyAll().catch(() => undefined);
    }
  }

  function denySpec(item: (typeof DENY_CASES)[number]): SpecDescriptor {
    return {
      name: item.name,
      async prepare(spec) {
        await mountSubAgentMemory(item.name, spec, [item.slug]);
        const host = subAgentHost(item.name, item.slug);
        await mkdir(join(host, 'topics'), { recursive: true, mode: 0o700 });
        await writeFile(join(host, 'MEMORY.md'), `# Memory\n\nAUTO-${item.name.toUpperCase()}\n`, {
          mode: 0o600,
        });
        await writeFile(join(host, 'topics', 'deny.md'), item.initial, { mode: 0o600 });
        await writeWorkspaceFixture(spec, [childAgent(item.slug, [item.tool])]);
      },
    };
  }

  const descriptors = {
    single: { name: 'single' },
    reuse: { name: 'reuse' },
    idle: { name: 'idle' },
    cancel: { name: 'cancel' },
    bashDefault: { name: 'bash-default', prepare: writeWorkspaceFixture },
    bashDontAsk: { name: 'bash-dontask', prepare: writeWorkspaceFixture },
    bashPlatformDeny: { name: 'bash-platform-deny', prepare: writeWorkspaceFixture },
    bashCommandDeny: { name: 'bash-command-deny', prepare: writeWorkspaceFixture },
    bashChild: {
      name: 'bash-child',
      prepare: (spec) => writeWorkspaceFixture(spec, [childAgent('bash-child')]),
    },
    bashChildDeny: {
      name: 'bash-child-deny',
      prepare: (spec) => writeWorkspaceFixture(spec, [childAgent('bash-child-denied', ['Bash'])]),
    },
    memory: {
      name: 'memory',
      async prepare(spec) {
        await mountSubAgentMemory('memory', spec, ['mem-child']);
        await writeWorkspaceFixture(spec, [childAgent('mem-child', undefined, 12)]);
      },
    },
    boundary: {
      name: 'boundary',
      async prepare(spec) {
        await mountSubAgentMemory('boundary', spec, ['mem-child', 'mem-sibling']);
        await writeFile(
          join(subAgentHost('boundary', 'mem-sibling'), 'MEMORY.md'),
          'SIBLING-SECRET\n',
          {
            mode: 0o600,
          },
        );
        await writeWorkspaceFixture(spec, [
          childAgent('mem-child', undefined, 12),
          childAgent('mem-sibling', undefined, 12),
        ]);
      },
    },
    [DENY_CASES[0].specKey]: denySpec(DENY_CASES[0]),
    [DENY_CASES[1].specKey]: denySpec(DENY_CASES[1]),
    [DENY_CASES[2].specKey]: denySpec(DENY_CASES[2]),
    unknown: { name: 'unknown', prepare: writeWorkspaceFixture },
  } satisfies Record<string, SpecDescriptor>;
  type SpecName = keyof typeof descriptors;
  const specs = new Map<SpecName, SessionSandboxSpec>();

  function getSpec(name: SpecName) {
    const spec = specs.get(name);
    if (spec === undefined) throw new Error(`session sandbox spec not prepared: ${name}`);
    return spec;
  }

  async function setup(specNames: readonly SpecName[]) {
    sourceBuildRoot = await mkdtemp(join(tmpdir(), 'session-sdk-source-'));
    const built = await compileCurrentSources(sourceBuildRoot);

    const image = await run('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], 10_000);
    if (image.code !== 0) {
      throw new Error(
        `sandbox image ${IMAGE} is missing; build it with bun run --filter @agentport/sandbox image`,
      );
    }

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
        'bun',
        IMAGE,
        '-e',
        "const fs=require('node:fs');const path=require('node:path');const base=require('node:module').createRequire('/app/packages/sandbox/package.json');process.stdout.write(JSON.parse(fs.readFileSync(path.join(path.dirname(base.resolve('@anthropic-ai/claude-agent-sdk')),'package.json'),'utf8')).version)",
      ],
      30_000,
    );
    if (sdk.code !== 0) {
      throw new Error(`cannot read the SDK version inside ${IMAGE}: ${sdk.stderr.trim()}`);
    }
    expect(sdk.stdout.trim()).toBe(SDK_VERSION);

    const sharedDir = await run(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'bun',
        IMAGE,
        '-e',
        "const base=require('node:module').createRequire('/app/packages/sandbox/package.json');process.stdout.write(require('node:path').dirname(require('node:path').dirname(base.resolve('@agentport/shared'))))",
      ],
      30_000,
    );
    if (sharedDir.code !== 0 || sharedDir.stdout.trim() === '') {
      throw new Error(
        `cannot resolve @agentport/shared inside ${IMAGE}: ${sharedDir.stderr.trim()}`,
      );
    }
    providerMounts = [
      { hostPath: built.sandbox, containerPath: '/app/dist', readonly: true },
      {
        hostPath: built.shared,
        containerPath: join(sharedDir.stdout.trim(), 'dist'),
        readonly: true,
      },
    ];

    logDir = await mkdtemp(join(tmpdir(), 'session-sdk-'));
    fake = await startFakeAnthropic(join(logDir, 'fake-anthropic.jsonl'), () => toolScenarios);
    await Promise.all(
      specNames.map(async (key) => {
        const { name, prepare }: SpecDescriptor = descriptors[key];
        const spec = await sandboxSpec(name);
        await prepare?.(spec);
        specs.set(key, spec);
      }),
    );

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
  }

  function reset() {
    fake.requests.length = 0;
    toolScenarios = [];
  }

  async function teardown() {
    await fake?.close();
    if (sourceBuildRoot !== '') {
      await rm(sourceBuildRoot, { recursive: true, force: true });
    }
  }

  return {
    setup,
    teardown,
    reset,
    getSpec,
    createProvider,
    startRun,
    subAgentHost,
    execute,
    get fake() {
      return fake;
    },
    set toolScenarios(scenarios: ToolScenario[]) {
      toolScenarios = scenarios;
    },
  };
}
