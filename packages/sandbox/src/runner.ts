import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  CONFIG_CONTAINER_DIR,
  CONFIGURABLE_DISALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  errorText,
  INPUTS_CONTAINER_DIR,
  MCP_APPROVAL_HOOK_TIMEOUT_SECONDS,
  MEMORY_CONTAINER_DIR,
  type NativeQuestion,
  OUTPUTS_CONTAINER_DIR,
  type ProgressTodo,
  progressTodoSchema,
  SANDBOX_RUNTIME_ENV,
  type SandboxTask,
  SUBAGENT_MEMORY_CONTAINER_DIR,
  sandboxTaskSchema,
  type TerminalRunStatus,
  type WireFailureKind,
  WORKSPACE_CONTAINER_DIR,
} from '@agentport/shared';
import {
  forkSession,
  query,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createApprovalHook } from './approval-hook.js';
import {
  createFileBoundaryHook,
  createPersonalMemoryHook,
  PERSONAL_MEMORY_FILE,
} from './memory-permissions.js';
import { memoryRuntimeSettings } from './memory-runtime.js';
import { createQuestionChannel } from './questions.js';
import { createSubAgentBoundaryHook } from './sub-agent-permissions.js';

/**
 * 容器内入口：在只读挂载的 /workspace 上运行 Agent SDK。
 * 从 stdin 读一行 JSON 任务，向 stdout 逐行写 NDJSON 事件。
 * stdout 只放协议数据；日志一律写 stderr。
 */
interface RunnerEvent {
  type:
    | 'text_delta'
    | 'assistant_text'
    | 'assistant_block_start'
    | 'assistant_block_stop'
    | 'tool_start'
    | 'tool_input'
    | 'tool_result'
    | 'session_forked'
    | 'question_requested'
    | 'question_closed'
    | 'run_warning'
    | 'error'
    | 'run_finished';
  text?: string;
  message?: string;
  toolUseId?: string;
  /** question_requested：宿主据此落库；回答只经 stdin 回到这个工具。 */
  requestId?: string;
  questions?: NativeQuestion[];
  /** SDK 消息 uuid；落库后用于按历史点 fork。 */
  sdkUuid?: string;
  sessionId?: string;
  /** 子智能体产生的消息：指向父侧 Agent 的 tool_use id；顶层消息不写。 */
  parentToolUseId?: string;
  /** 助手消息内的内容块序号；text_delta / assistant_text 用它区分不同文本块。 */
  blockIndex?: number;
  /** assistant_block_start：该块的类型；其他事件不带。 */
  kind?: 'text' | 'tool_use';
  /** assistant_text：单块超过上限，text 只是保留的前缀。 */
  truncated?: boolean;
  name?: string;
  json?: string;
  content?: string;
  /** 顶层 TodoWrite 成功确认后的完整清单快照；省略表示本事件不改清单。 */
  todos?: ProgressTodo[];
  status?: Exclude<TerminalRunStatus, 'timeout'>;
  costUsd?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  /** 失败分类；只在 status !== 'succeeded' 时出现。 */
  failureKind?: WireFailureKind;
}

const configDir = process.env.CLAUDE_CONFIG_DIR ?? CONFIG_CONTAINER_DIR;
const memoryDirectory = MEMORY_CONTAINER_DIR;
const workspaceDir = WORKSPACE_CONTAINER_DIR;
const channelRun = process.env.PACE_RUN_TRIGGER === 'channel';

function log(message: string): void {
  process.stderr.write(`[runner] ${message}\n`);
}

const DEFAULT_MAX_FIELD_BYTES = 1024 * 1024;
const TRUNCATED = '\n…[truncated]';

function cap(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value);
  if (bytes <= maxBytes) return { text: value, truncated: false };
  log(`truncated a ${bytes} byte field to ${maxBytes} bytes`);
  return {
    text: Buffer.from(value).subarray(0, maxBytes).toString('utf8').replace(/�$/, ''),
    truncated: true,
  };
}

function capWithMarker(value: string, maxBytes: number): string {
  const { text, truncated } = cap(value, maxBytes);
  return truncated ? `${text}${TRUNCATED}` : text;
}

async function openTaskInput(): Promise<{
  task: SandboxTask;
  readLine: () => Promise<string | null>;
  close: () => void;
}> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  const readLine = async (): Promise<string | null> => {
    for (;;) {
      const { value, done } = await lines.next();
      if (done === true) return null;
      const trimmed = String(value).trim();
      if (trimmed.length > 0) return trimmed;
    }
  };
  const first = await readLine();
  if (first === null) {
    rl.close();
    throw new Error('stdin closed before task JSON arrived');
  }
  return { task: sandboxTaskSchema.parse(JSON.parse(first)), readLine, close: () => rl.close() };
}

/** 汇总所有模型的 token 用量；modelUsage 是权威口径。 */
function tokenUsage(
  modelUsage: Record<string, { inputTokens?: number; outputTokens?: number }> | undefined,
): { inputTokens?: number; outputTokens?: number } {
  if (!modelUsage) return {};
  let input = 0;
  let output = 0;
  let seen = false;
  for (const usage of Object.values(modelUsage)) {
    if (typeof usage.inputTokens === 'number') {
      input += usage.inputTokens;
      seen = true;
    }
    if (typeof usage.outputTokens === 'number') {
      output += usage.outputTokens;
      seen = true;
    }
  }
  return seen ? { inputTokens: input, outputTokens: output } : {};
}

function resultTokenUsage(message: {
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  modelUsage: Record<string, { inputTokens?: number; outputTokens?: number }> | undefined;
}): { inputTokens?: number; outputTokens?: number } {
  if (!channelRun) return tokenUsage(message.modelUsage);
  const snapshot = tokenUsage(Object.fromEntries(assistantUsage));
  return {
    inputTokens: Math.max(
      message.usage.input_tokens +
        (message.usage.cache_read_input_tokens ?? 0) +
        (message.usage.cache_creation_input_tokens ?? 0),
      snapshot.inputTokens ?? 0,
    ),
    outputTokens: Math.max(message.usage.output_tokens, snapshot.outputTokens ?? 0),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      if (!('type' in block)) return '';
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

function parentTag(id: string | null): { parentToolUseId?: string } {
  return id === null ? {} : { parentToolUseId: id };
}

function todoSnapshot(input: {
  toolUseId: string;
  isError: boolean | undefined;
  parentToolUseId: string | null;
  result: unknown;
  todoToolIds: ReadonlySet<string>;
}): ProgressTodo[] | undefined {
  if (input.parentToolUseId !== null || input.isError === true) return undefined;
  if (!input.todoToolIds.has(input.toolUseId)) return undefined;
  if (typeof input.result !== 'object' || input.result === null) return undefined;
  const parsed = progressTodoSchema
    .array()
    .safeParse((input.result as { newTodos?: unknown }).newTodos);
  if (!parsed.success) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
  if (bytes > maxFieldBytes) {
    log(`omitted a ${bytes} byte todo snapshot over the ${maxFieldBytes} byte limit`);
    return undefined;
  }
  return parsed.data;
}

/** transcript 文件名是 `<sessionId>.jsonl`，跨 project 目录查找（cwd 编码可能变化）。 */
async function findSessionFile(sessionId: string): Promise<string | null> {
  const projects = join(configDir, 'projects');
  let entries: string[];
  try {
    entries = await readdir(projects);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(projects, entry, `${sessionId}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return null;
}

const { task, readLine, close: closeInput } = await openTaskInput();
const maxFieldBytes = task.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
const permissionMode = task.permissionMode ?? 'dontAsk';
const memoryRuntime = memoryRuntimeSettings(task.memoryPolicy);

/**
 * 插件 MCP 工具名是 `mcp__plugin_<plugin>_<server>__<tool>`，插件名与 server 名里
 * 非 `[A-Za-z0-9_-]` 的字符都被 SDK 替换成 `_`；平台按原始名授权，这里换算出实名。
 */
function pluginScope(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

const pluginServers = task.plugins.flatMap((plugin) =>
  plugin.mcpServers.map(
    (server) => `plugin_${pluginScope(plugin.runtimeName)}_${pluginScope(server)}`,
  ),
);
// 插件技能在 SDK 里是 `<manifest name>:<skill 目录名>`；`plugin:<skill>` 不是合法写法。
const pluginSkills = task.plugins.flatMap((plugin) =>
  plugin.skills.map((skill) => `${plugin.runtimeName}:${skill}`),
);
const hasPluginAgents = task.plugins.some((plugin) => plugin.hasAgents);

// allow 规则只支持 `mcp__<server>__` 之后通配；`mcp__*` 不匹配任何工具。
// server 名来自挂载的 .mcp.json，逐个生成精确规则。
const allowedTools = [
  'Bash',
  `Read(/${memoryDirectory}/**)`,
  `Read(/${WORKSPACE_CONTAINER_DIR}/.claude/skills/*/references/**)`,
  ...(task.plugins.length === 0
    ? []
    : [`Read(/${WORKSPACE_CONTAINER_DIR}/.claude/plugins/*/skills/*/**)`]),
  // Edit(path) also authorizes Write; Write(path) is not a file permission rule.
  // proposal_only / 未启用专家记忆时必须拿掉这条写权限：SDK 的 auto-memory 已关闭，
  // 模型只能经记忆提案由平台写入；预批准写目录会让提案制形同虚设。
  ...(memoryRuntime.allowMemoryWrite ? [`Edit(/${memoryDirectory}/**)`] : []),
  ...(task.subAgents.length === 0
    ? []
    : [
        `Read(/${SUBAGENT_MEMORY_CONTAINER_DIR}/**)`,
        ...(memoryRuntime.allowMemoryWrite ? [`Edit(/${SUBAGENT_MEMORY_CONTAINER_DIR}/**)`] : []),
      ]),
  `Read(/${OUTPUTS_CONTAINER_DIR}/**)`,
  `Edit(/${OUTPUTS_CONTAINER_DIR}/**)`,
  `Read(/${INPUTS_CONTAINER_DIR}/**)`,
  ...task.mcpServers.map((name) => `mcp__${name}__*`),
  ...pluginServers.map((server) => `mcp__${server}__*`),
  ...task.extraAllowedTools.filter((rule) => !/^(Read|Write|Edit)(\(|$)/.test(rule)),
  ...(task.allowSubAgents || hasPluginAgents ? ['Agent'] : []),
  ...(task.hasWorkflows ? ['Workflow'] : []),
];
const abortController = new AbortController();
process.once('SIGTERM', () => abortController.abort());

const allowedByConfig = new Set(task.extraAllowedTools);
const configurableTools = new Set<string>(CONFIGURABLE_DISALLOWED_TOOLS);
const disallowedTools = [
  ...DEFAULT_DISALLOWED_TOOLS.filter((tool) => {
    if (tool === 'Read' || tool === 'Write' || tool === 'Edit') return false;
    if (!configurableTools.has(tool)) return true;
    if (tool === 'Agent' || tool === 'TaskStop') return !(task.allowSubAgents || hasPluginAgents);
    return !allowedByConfig.has(tool);
  }),
  ...task.extraDisallowedTools,
];

let emittedTerminal = false;
let initSessionId: string | undefined;
const assistantUsage = new Map<string, { inputTokens: number; outputTokens: number }>();
// run_finished 只能有一条：宿主按它落库并结束 SSE。
function emit(event: RunnerEvent): void {
  if (event.type === 'run_finished') emittedTerminal = true;
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function failRun(kind: WireFailureKind, message: string): void {
  if (emittedTerminal) return;
  log(`run failed (${kind}): ${message}`);
  emit({
    type: 'run_finished',
    status: kind === 'cancelled' ? 'cancelled' : 'failed',
    error: message,
    failureKind: kind,
    ...(initSessionId === undefined ? {} : { sessionId: initSessionId }),
    ...(channelRun ? tokenUsage(Object.fromEntries(assistantUsage)) : {}),
  });
}

function emitFinalResult(message: SDKResultMessage, cancelled: boolean): void {
  if (cancelled) {
    emit({
      type: 'run_finished',
      status: 'cancelled',
      failureKind: 'cancelled',
      costUsd: message.total_cost_usd,
      turns: message.num_turns,
      sessionId: message.session_id,
      ...resultTokenUsage(message),
    });
    return;
  }
  const succeeded = message.subtype === 'success' && !message.is_error;
  emit({
    type: 'run_finished',
    status: succeeded ? 'succeeded' : 'failed',
    costUsd: message.total_cost_usd,
    turns: message.num_turns,
    sessionId: message.session_id,
    ...resultTokenUsage(message),
    ...(succeeded
      ? {}
      : {
          error:
            message.subtype === 'success'
              ? message.result
              : `${message.subtype}: ${message.errors.join('; ')}`,
          failureKind: 'agent',
        }),
  });
}

function createInstructionQueue(): {
  push(text: string, uuid: string): void;
  close(): void;
  hasPending(): boolean;
  next(): Promise<SDKUserMessage | null>;
} {
  const messages: SDKUserMessage[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  return {
    push(text, uuid) {
      if (closed) {
        log('dropped an instruction: input stream is closed');
        return;
      }
      messages.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        uuid: uuid as NonNullable<SDKUserMessage['uuid']>,
        client_composed: true,
        priority: 'now',
      });
      notify();
    },
    close() {
      if (closed) return;
      closed = true;
      notify();
    },
    hasPending() {
      return messages.length > 0;
    },
    async next() {
      while (messages.length === 0) {
        if (closed) return null;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return messages.shift() ?? null;
    },
  };
}

const instructionQueue = createInstructionQueue();
process.stdin.once('end', () => instructionQueue.close());

/**
 * 原生澄清提问：dontAsk 下 SDK 根本不会调用 canUseTool，问题会被直接拒绝，
 * 因此不安装回调，也不把该模式暗映射成可提问。其他模式下只放行 AskUserQuestion。
 */
const questionChannel = createQuestionChannel({
  readLine,
  events: {
    requested: (event) => emit({ type: 'question_requested', ...event }),
    closed: (requestId) => emit({ type: 'question_closed', requestId }),
  },
  onUserMessage: (command) => instructionQueue.push(command.text, command.uuid),
  log,
});
abortController.signal.addEventListener('abort', () => {
  questionChannel.close();
  instructionQueue.close();
});

/**
 * 解析本次运行的 SDK session：
 * - 空会话：不 resume，让 CLI 新建；
 * - 续聊：resume 已有 session；
 * - 分支：先在已有 session 里 fork 到历史点（官方 forkSession，稳定的非 alpha 助手），再 resume 新 id。
 * transcript 缺失一律按 infra 失败，不回退成文本历史。
 */
async function resolveSession(input: SandboxTask): Promise<{
  resume?: string;
  fork?: { sessionId: string };
  error?: string;
}> {
  if (input.resumeSessionId === undefined) return {};
  if ((await findSessionFile(input.resumeSessionId)) === null) {
    return {
      error: `SDK session ${input.resumeSessionId} is missing from the mounted transcript directory`,
    };
  }
  if (input.forkFromMessageUuid === undefined) return { resume: input.resumeSessionId };

  try {
    const forked = await forkSession(input.resumeSessionId, {
      upToMessageId: input.forkFromMessageUuid,
      dir: workspaceDir,
    });
    log(`forked ${input.resumeSessionId} -> ${forked.sessionId}`);
    return { resume: forked.sessionId, fork: { sessionId: forked.sessionId } };
  } catch (err) {
    const message = errorText(err);
    return { error: `session fork failed: ${message}` };
  }
}

const session = await resolveSession(task);
if (session.error !== undefined) {
  failRun('infra', session.error);
  questionChannel.close();
  closeInput();
} else {
  if (session.fork !== undefined) {
    emit({ type: 'session_forked', sessionId: session.fork.sessionId });
  }
  log(`starting query (model=${task.model})`);

  /** 只发一条用户消息：uuid 由宿主生成并落库，后续按历史点 fork 依赖它。 */
  async function* userPrompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: task.prompt },
      parent_tool_use_id: null,
      // 宿主已按 uuid 校验过；SDK 的 UUID 是模板字面量类型，这里按契约收窄。
      uuid: task.userMessageUuid as NonNullable<SDKUserMessage['uuid']>,
      client_composed: true,
    };
    for (;;) {
      const next = await instructionQueue.next();
      if (next === null) return;
      yield next;
    }
  }

  let activeQuery: ReturnType<typeof query> | undefined;
  let finalResult: SDKResultMessage | undefined;
  let finalCancelled = false;
  try {
    const openBlocks = new Map<string, { index: number; kind: string }>();
    const todoToolIds = new Set<string>();
    const parentKey = (id: string | null): string => id ?? '';

    activeQuery = query({
      prompt: userPrompt(),
      options: {
        cwd: workspaceDir,
        settingSources: ['project'],
        settings: {
          enableAllProjectMcpServers: true,
          autoMemoryEnabled: memoryRuntime.autoMemoryEnabled,
          ...(memoryRuntime.autoMemoryEnabled ? { autoMemoryDirectory: memoryDirectory } : {}),
        },
        env: { ...process.env, ...SANDBOX_RUNTIME_ENV },
        forwardSubagentText: true,
        permissionMode,
        // dontAsk 不提示也不调用回调；安装它只会给其他模式多一条 fail-closed 路径。
        ...(permissionMode === 'dontAsk' ? {} : { canUseTool: questionChannel.canUseTool }),
        allowedTools,
        disallowedTools: [...new Set(disallowedTools)],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                createFileBoundaryHook({
                  memoryDir: memoryDirectory,
                  subAgentSlugs: new Set(task.subAgents.map((sub) => sub.slug)),
                  memoryWritable: memoryRuntime.allowMemoryWrite,
                }),
                createSubAgentBoundaryHook({
                  // 插件 MCP 的 scoped 名（plugin_<plugin>_<server>）与普通 server 同名空间，
                  // 主会话放行自己绑定的插件 server，子智能体保持一律拒绝。
                  servers: new Set([...task.mcpServers, ...pluginServers]),
                  skills: new Set(task.skills),
                  ...(task.plugins.length === 0 ? {} : { pluginSkills: new Set(pluginSkills) }),
                  subAgents: new Map(
                    task.subAgents.map((sub) => [
                      sub.slug,
                      { servers: new Set(sub.servers), skills: new Set(sub.skills) },
                    ]),
                  ),
                }),
              ],
            },
            {
              matcher: 'mcp__.*',
              timeout: MCP_APPROVAL_HOOK_TIMEOUT_SECONDS,
              onFailure: 'block',
              hooks: [createApprovalHook(task, workspaceDir, abortController.signal)],
            },
          ],
          ...(memoryRuntime.installPersonalHook
            ? {
                UserPromptSubmit: [
                  { hooks: [createPersonalMemoryHook(PERSONAL_MEMORY_FILE, log)] },
                ],
              }
            : {}),
        },
        // SDK 自己按名字补 Skill(name) 权限；这里不要放通配的 Skill。
        // 插件技能名带 `<plugin>:` 前缀，必须把完整名一并列出，否则会被当成未启用的技能。
        skills: [...task.skills, ...pluginSkills],
        ...(task.plugins.length === 0
          ? {}
          : {
              plugins: task.plugins.map((plugin) => ({
                type: 'local' as const,
                path: plugin.path,
              })),
            }),
        includePartialMessages: true,
        maxTurns: task.maxTurns,
        maxBudgetUsd: task.maxBudgetUsd,
        ...(task.effort === undefined ? {} : { effort: task.effort }),
        abortController,
        model: task.model,
        ...(session.resume === undefined ? {} : { resume: session.resume }),
      },
    });
    for await (const message of activeQuery) {
      if (message.type === 'system' && message.subtype === 'init') {
        initSessionId = message.session_id;
        const failed = message.mcp_servers?.filter((s) => s.status !== 'connected') ?? [];
        if (failed.length > 0) {
          log(`mcp not connected: ${failed.map((s) => `${s.name}=${s.status}`).join(', ')}`);
          emit({
            type: 'run_warning',
            message: `这些 MCP Server 没有连上，本次运行缺少它们的工具：${failed
              .map((s) => s.name)
              .join('、')}`,
          });
        }
        const pluginErrors = message.plugin_errors ?? [];
        if (pluginErrors.length > 0) {
          log(`plugin errors: ${pluginErrors.map((e) => `${e.plugin}:${e.type}`).join(', ')}`);
          emit({
            type: 'run_warning',
            message: `这些插件没有完全加载：${pluginErrors
              .map((e) => `${e.plugin}（${e.message}）`)
              .join('、')}`,
          });
        }
        if (
          task.plugins.length > 0 &&
          !task.plugins.some((plugin) =>
            message.plugins.some((loaded) => loaded.path === plugin.path),
          )
        ) {
          failRun('infra', '本次运行绑定了插件，但没有任何插件被加载；请检查插件目录挂载');
          break;
        }
        continue;
      }

      if (message.type === 'assistant') {
        const usage = message.message.usage;
        if (channelRun && message.error === undefined && usage !== undefined) {
          const previous = assistantUsage.get(message.message.id);
          assistantUsage.set(message.message.id, {
            inputTokens: Math.max(
              previous?.inputTokens ?? 0,
              usage.input_tokens +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0),
            ),
            outputTokens: Math.max(previous?.outputTokens ?? 0, usage.output_tokens),
          });
        }
        const parent = parentTag(message.parent_tool_use_id);
        const open = openBlocks.get(parentKey(message.parent_tool_use_id));
        for (const block of message.message.content) {
          if (block.type === 'text') {
            if (block.text.length === 0) continue;
            const { text, truncated } = cap(block.text, maxFieldBytes);
            emit({
              type: 'assistant_text',
              text,
              ...(open?.kind === 'text' ? { blockIndex: open.index } : {}),
              sdkUuid: message.uuid,
              ...(truncated ? { truncated } : {}),
              ...parent,
            });
            continue;
          }
          if (block.type !== 'tool_use') continue;
          if (block.name === 'TodoWrite' && message.parent_tool_use_id === null) {
            todoToolIds.add(block.id);
          }
          emit({
            type: 'tool_start',
            toolUseId: block.id,
            name: block.name,
            sdkUuid: message.uuid,
            ...parent,
          });
          emit({
            type: 'tool_input',
            toolUseId: block.id,
            json: capWithMarker(JSON.stringify(block.input), maxFieldBytes),
            ...parent,
          });
        }
        continue;
      }

      if (message.type === 'user') {
        const content = message.message.content;
        if (typeof content === 'string') continue;
        const parent = parentTag(message.parent_tool_use_id);
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const todos = todoSnapshot({
            toolUseId: block.tool_use_id,
            isError: block.is_error,
            parentToolUseId: message.parent_tool_use_id,
            result: message.tool_use_result,
            todoToolIds,
          });
          emit({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            content: capWithMarker(toolResultText(block.content), maxFieldBytes),
            ...(message.uuid === undefined ? {} : { sdkUuid: message.uuid }),
            ...parent,
            ...(todos === undefined ? {} : { todos }),
          });
        }
        continue;
      }

      if (message.type === 'stream_event') {
        const event = message.event;
        const parent = parentTag(message.parent_tool_use_id);
        const key = parentKey(message.parent_tool_use_id);
        if (event.type === 'message_start' || event.type === 'message_stop') {
          openBlocks.delete(key);
        } else if (event.type === 'content_block_start') {
          const kind = event.content_block.type;
          if (kind === 'text' || kind === 'tool_use') {
            openBlocks.set(key, { index: event.index, kind });
            emit({
              type: 'assistant_block_start',
              blockIndex: event.index,
              kind,
              sdkUuid: message.uuid,
              ...parent,
            });
          }
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          emit({
            type: 'text_delta',
            text: event.delta.text,
            blockIndex: event.index,
            sdkUuid: message.uuid,
            ...parent,
          });
        } else if (event.type === 'content_block_stop') {
          if (openBlocks.get(key)?.index === event.index) openBlocks.delete(key);
          emit({ type: 'assistant_block_stop', blockIndex: event.index });
        }
        continue;
      }

      if (message.type === 'result') {
        finalResult = message;
        finalCancelled = abortController.signal.aborted;
        if (finalCancelled || !instructionQueue.hasPending()) instructionQueue.close();
      }
    }
    if (finalResult !== undefined && !emittedTerminal) {
      emitFinalResult(finalResult, finalCancelled);
    }
  } catch (err) {
    const message = errorText(err);
    log(`query failed: ${message}`);
    failRun(abortController.signal.aborted ? 'cancelled' : 'agent', message);
  } finally {
    instructionQueue.close();
    questionChannel.close();
    closeInput();
    activeQuery?.close();
  }
}

log('query finished');
