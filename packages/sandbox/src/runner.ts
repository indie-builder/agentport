import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type ChatEvent,
  CONFIG_CONTAINER_DIR,
  disallowedToolsFor,
  errorText,
  INPUTS_CONTAINER_DIR,
  MCP_APPROVAL_HOOK_TIMEOUT_SECONDS,
  MEMORY_CONTAINER_DIR,
  memoryWritable,
  OUTPUTS_CONTAINER_DIR,
  type ProgressTodo,
  progressTodoSchema,
  SANDBOX_RUNTIME_ENV,
  type SandboxTask,
  SUBAGENT_MEMORY_CONTAINER_DIR,
  sandboxTaskSchema,
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
import { createQuestionChannel } from './questions.js';
import { createStdinLines } from './stdin-lines.js';
import { createSubAgentBoundaryHook } from './sub-agent-permissions.js';

const configDir = process.env.CLAUDE_CONFIG_DIR ?? CONFIG_CONTAINER_DIR;
const memoryDirectory = MEMORY_CONTAINER_DIR;
const workspaceDir = WORKSPACE_CONTAINER_DIR;

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
  const stdin = createStdinLines();
  const readLine = async (): Promise<string | null> => {
    for (;;) {
      const line = await stdin.next();
      if (line === null) return null;
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed;
    }
  };
  const first = await readLine();
  if (first === null) {
    throw new Error('stdin closed before task JSON arrived');
  }
  return { task: sandboxTaskSchema.parse(JSON.parse(first)), readLine, close: () => stdin.close() };
}

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

function resultTokenUsage(
  message: {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };
    modelUsage: Record<string, { inputTokens?: number; outputTokens?: number }> | undefined;
  },
  channelRun: boolean,
  assistantUsage: ReadonlyMap<string, { inputTokens: number; outputTokens: number }>,
): { inputTokens?: number; outputTokens?: number } {
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
  maxFieldBytes: number;
}): ProgressTodo[] | undefined {
  if (input.parentToolUseId !== null || input.isError === true) return undefined;
  if (!input.todoToolIds.has(input.toolUseId)) return undefined;
  if (typeof input.result !== 'object' || input.result === null) return undefined;
  const parsed = progressTodoSchema
    .array()
    .safeParse((input.result as { newTodos?: unknown }).newTodos);
  if (!parsed.success) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
  if (bytes > input.maxFieldBytes) {
    log(`omitted a ${bytes} byte todo snapshot over the ${input.maxFieldBytes} byte limit`);
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

function pluginScope(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
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

export async function runRunner(): Promise<void> {
  const { task, readLine, close: closeInput } = await openTaskInput();
  const channelRun = task.tokenAccounting === 'channel';
  const maxFieldBytes = task.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const permissionMode = task.permissionMode ?? 'dontAsk';
  const allowMemoryWrite = memoryWritable(task.memoryPolicy);

  const pluginServers = task.plugins.flatMap((plugin) =>
    plugin.mcpServers.map(
      (server) => `plugin_${pluginScope(plugin.runtimeName)}_${pluginScope(server)}`,
    ),
  );
  const pluginSkills = task.plugins.flatMap((plugin) =>
    plugin.skills.map((skill) => `${plugin.runtimeName}:${skill}`),
  );
  const hasPluginAgents = task.plugins.some((plugin) => plugin.hasAgents);

  const allowedTools = [
    'Bash',
    `Read(/${memoryDirectory}/**)`,
    `Read(/${WORKSPACE_CONTAINER_DIR}/.claude/skills/*/references/**)`,
    ...(task.plugins.length === 0
      ? []
      : [`Read(/${WORKSPACE_CONTAINER_DIR}/.claude/plugins/*/skills/*/**)`]),
    ...(allowMemoryWrite ? [`Edit(/${memoryDirectory}/**)`] : []),
    ...(task.subAgents.length === 0
      ? []
      : [
          `Read(/${SUBAGENT_MEMORY_CONTAINER_DIR}/**)`,
          ...(allowMemoryWrite ? [`Edit(/${SUBAGENT_MEMORY_CONTAINER_DIR}/**)`] : []),
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
  const onSigterm = () => abortController.abort();
  process.once('SIGTERM', onSigterm);

  const disallowedTools = [
    ...disallowedToolsFor({
      allowedTools: task.extraAllowedTools,
      allowSubAgents: task.allowSubAgents || hasPluginAgents,
      keepFileTools: true,
    }),
    ...task.extraDisallowedTools,
  ];

  let emittedTerminal = false;
  let initSessionId: string | undefined;
  const assistantUsage = new Map<string, { inputTokens: number; outputTokens: number }>();
  function emit(event: ChatEvent): void {
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
        ...resultTokenUsage(message, channelRun, assistantUsage),
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
      ...resultTokenUsage(message, channelRun, assistantUsage),
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

  const instructionQueue = createInstructionQueue();

  const questionChannel = createQuestionChannel({
    readLine: async () => {
      const line = await readLine();
      if (line === null) instructionQueue.close();
      return line;
    },
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

  try {
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

      async function* userPrompt(): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content: task.prompt },
          parent_tool_use_id: null,
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
              autoMemoryEnabled: allowMemoryWrite,
              ...(allowMemoryWrite ? { autoMemoryDirectory: memoryDirectory } : {}),
            },
            env: { ...process.env, ...SANDBOX_RUNTIME_ENV },
            forwardSubagentText: true,
            permissionMode,
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
                      memoryWritable: allowMemoryWrite,
                    }),
                    createSubAgentBoundaryHook({
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
              ...(task.memoryPolicy.injectPersonalMemory
                ? {
                    UserPromptSubmit: [
                      { hooks: [createPersonalMemoryHook(PERSONAL_MEMORY_FILE, log)] },
                    ],
                  }
                : {}),
            },
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
                maxFieldBytes,
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
  } finally {
    process.off('SIGTERM', onSigterm);
  }

  log('query finished');
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === Bun.fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  await runRunner();
}
