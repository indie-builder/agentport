import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SANDBOX_RUNTIME_ENV, type SandboxTask, sandboxTaskSchema } from '@agentport/shared';
import { forkSession, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createFileBoundaryHook } from './memory-permissions.js';
import { createSubAgentBoundaryHook } from './sub-agent-permissions.js';

/**
 * 容器内入口：在只读挂载的 /workspace 上运行 Agent SDK。
 * 从 stdin 读一行 JSON 任务，向 stdout 逐行写 NDJSON 事件。
 * stdout 只放协议数据；日志一律写 stderr。
 *
 * 事件形状与 @agentport/shared 的 ChatEvent 一致，但镜像不打包 workspace 依赖，
 * 所以此处只保留结构类型；宿主侧仍会用 chatEventSchema 做一次校验。
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
    | 'error'
    | 'run_finished';
  text?: string;
  /** error 事件的文本。 */
  message?: string;
  toolUseId?: string;
  /** SDK 消息 uuid；落库后用于按历史点 fork。 */
  sdkUuid?: string;
  /** session_forked：新会话 id。 */
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
  status?: 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  costUsd?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  /** 失败分类；只在 status !== 'succeeded' 时出现。 */
  failureKind?: FailureKind;
}

/**
 * runner 内部的失败分类。宿主只能看到 stdout 上的事件，所以分类必须随 run_finished
 * 一起过线；否则 worker 无法区分「模型报错」和「基础设施断了」。
 */
type FailureKind = 'agent' | 'infra' | 'cancelled';

const configDir = process.env.CLAUDE_CONFIG_DIR ?? '/home/node/.claude';
const memoryDirectory = '/mnt/agent-memory';
const workspaceDir = '/workspace';

function log(message: string): void {
  process.stderr.write(`[runner] ${message}\n`);
}

/**
 * 单块上限：默认 1MiB，可由任务的 maxFieldBytes 覆盖。
 * 超限时只截断这一块并显式标记（assistant_text 带 truncated），不再静默丢尾部。
 */
const DEFAULT_MAX_FIELD_BYTES = 1024 * 1024;
const TRUNCATED = '\n…[truncated]';

/** 按字节截断但不在多字节字符中间切开；truncated 说明尾部已丢。 */
function cap(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value);
  if (bytes <= maxBytes) return { text: value, truncated: false };
  log(`truncated a ${bytes} byte field to ${maxBytes} bytes`);
  return {
    text: Buffer.from(value).subarray(0, maxBytes).toString('utf8').replace(/�$/, ''),
    truncated: true,
  };
}

/** 工具负载没有 truncated 字段，用标记说明尾部被截断。 */
function capWithMarker(value: string, maxBytes: number): string {
  const { text, truncated } = cap(value, maxBytes);
  return truncated ? `${text}${TRUNCATED}` : text;
}

/** 只取第一行，不读 EOF：宿主写完任务后保持 stdin 打开。 */
async function readTask(): Promise<SandboxTask> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      return sandboxTaskSchema.parse(JSON.parse(trimmed));
    }
  } finally {
    rl.close();
  }
  throw new Error('stdin closed before task JSON arrived');
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

/** 顶层消息 parent_tool_use_id 为 null：事件里省略该字段，宿主侧按 undefined 处理。 */
function parentTag(id: string | null): { parentToolUseId?: string } {
  return id === null ? {} : { parentToolUseId: id };
}

/** 会话 transcript 是否已在挂载目录里；缺失意味着挂载/清理出错，不能假装是空会话。 */
async function sessionExists(sessionId: string): Promise<boolean> {
  return (await findSessionFile(sessionId)) !== null;
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
    } catch {
      // 这个项目目录里没有该会话，继续找下一个。
    }
  }
  return null;
}

const task = await readTask();
const maxFieldBytes = task.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;

// allow 规则只支持 `mcp__<server>__` 之后通配；`mcp__*` 不匹配任何工具。
// server 名来自挂载的 .mcp.json，逐个生成精确规则。
const allowedTools = [
  `Read(/${memoryDirectory}/**)`,
  // 技能参考文件只读：.claude/skills/<slug>/references/**；写入仍仅限原生记忆目录。
  'Read(//workspace/.claude/skills/*/references/**)',
  // Edit(path) also authorizes Write; Write(path) is not a file permission rule.
  `Edit(/${memoryDirectory}/**)`,
  ...task.mcpServers.map((name) => `mcp__${name}__*`),
  ...task.extraAllowedTools.filter((rule) => !/^(Read|Write|Edit)(\(|$)/.test(rule)),
  // dontAsk 下未预批准的工具会被拒绝；委派时需显式放行 Agent。
  ...(task.allowSubAgents ? ['Agent'] : []),
];
const abortController = new AbortController();
process.once('SIGTERM', () => abortController.abort());

// 子智能体文件自身仍禁用 Agent；会话间工具只有显式出现在 allowedTools 里才放行（D-19）。
const allowedByConfig = new Set(task.extraAllowedTools);
// 父会话只自动批准自己的 server。只属于子级的 server 不写进会话级 disallowedTools：
// 子智能体继承会话权限，server 级 deny 会把它们自己的工具一起移除。
// 父级误调用这些 server 由 sub-agent-permissions 的 PreToolUse hook 拒绝。
const baseDisallowed = [
  'Bash',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'TaskStop',
  // 平台只支持「同步等待返回」这一种沟通模型。会话间消息工具会让调用方
  // 在对方返回前结束本轮，与平台约定相反，因此默认禁用。
  'ListAgents',
  'SendMessage',
  'SendUserMessage',
  'EndConversation',
  'Monitor',
  ...task.extraDisallowedTools,
];
const disallowedTools = baseDisallowed.filter((tool) => {
  if (tool === 'Agent' || tool === 'TaskStop') return !task.allowSubAgents;
  if (tool === 'ListAgents' || tool === 'SendMessage') return !allowedByConfig.has(tool);
  return true;
});

// 读取工作区 .claude/settings.json 的 outputStyle，再以 inline settings 传入。
// SDK 会按 key 优先级把项目 .claude/settings.json 与 inline settings 合并；
// 这里额外 inline 传 outputStyle，保证跨 SDK 版本的合并语义下都能生效。
let outputStyle: string | undefined;
try {
  const parsed = JSON.parse(
    readFileSync(join(workspaceDir, '.claude', 'settings.json'), 'utf8'),
  ) as {
    outputStyle?: unknown;
  };
  if (typeof parsed.outputStyle === 'string' && parsed.outputStyle)
    outputStyle = parsed.outputStyle;
} catch {
  // 文件不存在或非法：走默认输出风格。
}

let emittedTerminal = false;
// run_finished 只能有一条：宿主按它落库并结束 SSE。
function emit(event: RunnerEvent): void {
  if (event.type === 'run_finished') emittedTerminal = true;
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function failRun(kind: FailureKind, message: string): void {
  if (emittedTerminal) return;
  log(`run failed (${kind}): ${message}`);
  emit({
    type: 'run_finished',
    status: kind === 'cancelled' ? 'cancelled' : 'failed',
    error: message,
    failureKind: kind,
  });
}

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
  if (!(await sessionExists(input.resumeSessionId))) {
    return {
      error: `SDK session ${input.resumeSessionId} is missing from the mounted transcript directory`,
    };
  }
  if (input.forkFromMessageUuid === undefined) return { resume: input.resumeSessionId };

  try {
    // 映射由宿主从 transcript 的 forkedFrom 计算；这里只产生新会话 id。
    const forked = await forkSession(input.resumeSessionId, {
      upToMessageId: input.forkFromMessageUuid,
      dir: workspaceDir,
    });
    log(`forked ${input.resumeSessionId} -> ${forked.sessionId}`);
    return { resume: forked.sessionId, fork: { sessionId: forked.sessionId } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `session fork failed: ${message}` };
  }
}

const session = await resolveSession(task);
if (session.error !== undefined) {
  failRun('infra', session.error);
} else {
  // 先告诉宿主 fork 结果：即便这一轮随后失败，页面的历史映射也已经可写回。
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
      // 用户文本是纯文本：不要做 @路径展开或斜杠命令解析。
      client_composed: true,
    };
  }

  try {
    /**
     * 每个 parent 当前正在流式输出的块。SDK 的完整 assistant 消息只带自己那一个块，
     * 对消息内容 entries() 从 0 编号会把 thinking(0)+text(1) 的文本错报成 0，
     * 也不能与流事件的真实 index 对齐；完整消息在 content_block_stop 之前到达，按此对齐。
     */
    const openBlocks = new Map<string, { index: number; kind: string }>();
    const parentKey = (id: string | null): string => id ?? '';

    for await (const message of query({
      prompt: userPrompt(),
      options: {
        cwd: workspaceDir,
        settingSources: ['project'],
        // .mcp.json 里的 server 默认需要审批；无人值守时不批准就等于零工具静默成功。
        // 长期记忆用 Claude Code 原生 auto-memory：目录由 worker 从宿主持久卷挂到这里，
        // 跨 run 累积；平台侧只做浏览/编辑，不另造记忆格式。
        settings: {
          enableAllProjectMcpServers: true,
          autoMemoryEnabled: true,
          autoMemoryDirectory: memoryDirectory,
          ...(outputStyle === undefined ? {} : { outputStyle }),
        },
        // 容器进程 env 与工作区 settings 同源；这里再兜一层，避免 project settings 未加载时丢约束。
        env: { ...process.env, ...SANDBOX_RUNTIME_ENV },
        forwardSubagentText: true,
        permissionMode: task.permissionMode ?? 'dontAsk',
        allowedTools,
        disallowedTools: [...new Set(disallowedTools)],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                createFileBoundaryHook(memoryDirectory),
                createSubAgentBoundaryHook({
                  servers: new Set(task.mcpServers),
                  skills: new Set(task.skills),
                  subAgents: new Map(
                    task.subAgents.map((sub) => [
                      sub.slug,
                      { servers: new Set(sub.servers), skills: new Set(sub.skills) },
                    ]),
                  ),
                }),
              ],
            },
          ],
        },
        // SDK 自己按名字补 Skill(name) 权限；这里不要放通配的 Skill。
        skills: task.skills,
        includePartialMessages: true,
        maxTurns: task.maxTurns,
        maxBudgetUsd: task.maxBudgetUsd,
        ...(task.effort === undefined ? {} : { effort: task.effort }),
        ...(task.maxThinkingTokens === undefined
          ? {}
          : { thinking: { type: 'enabled', budgetTokens: task.maxThinkingTokens } }),
        abortController,
        model: task.model,
        ...(session.resume === undefined ? {} : { resume: session.resume }),
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        // MCP 起不来时 SDK 仍会正常跑完：模型只能用内置工具，最后报「成功」。
        // 这里必须显式暴露，否则用户在 UI 上看到的是「完成但什么都没做」。
        const failed = message.mcp_servers?.filter((s) => s.status !== 'connected') ?? [];
        if (failed.length > 0) {
          log(`mcp not connected: ${failed.map((s) => `${s.name}=${s.status}`).join(', ')}`);
          emit({
            type: 'error',
            message: `这些 MCP Server 没有连上，本次运行缺少它们的工具：${failed
              .map((s) => s.name)
              .join('、')}`,
          });
        }
        continue;
      }

      if (message.type === 'assistant') {
        // 子智能体消息带 parent_tool_use_id（父侧 Agent 的 tool_use id）；顶层为 null。
        const parent = parentTag(message.parent_tool_use_id);
        const open = openBlocks.get(parentKey(message.parent_tool_use_id));
        // 每个文本块单独发一次整块文本：前端已按 text_delta 渲染，这次用于落库。
        // 完整消息只含当前一个块，块序号取正在流式的那个真实 index，不能按消息内位置重编。
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
          emit({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            content: capWithMarker(toolResultText(block.content), maxFieldBytes),
            ...(message.uuid === undefined ? {} : { sdkUuid: message.uuid }),
            ...parent,
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
          // 工具块的内容由完整 assistant 消息发送；这里只标记边界。
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
        // 主动中止也会走到 result（subtype=error_during_execution），不会抛异常；
        // 不在这里判 abort，用户点「停止」会被显示成红色失败。
        const cancelled = abortController.signal.aborted;
        if (cancelled) {
          emit({
            type: 'run_finished',
            status: 'cancelled',
            costUsd: message.total_cost_usd,
            turns: message.num_turns,
            // fork 后 session id 会变；以 result 为准，宿主据此更新会话。
            sessionId: message.session_id,
            ...tokenUsage(message.modelUsage),
          });
          continue;
        }
        const succeeded = message.subtype === 'success' && !message.is_error;
        emit({
          type: 'run_finished',
          status: succeeded ? 'succeeded' : 'failed',
          costUsd: message.total_cost_usd,
          turns: message.num_turns,
          sessionId: message.session_id,
          ...tokenUsage(message.modelUsage),
          ...(succeeded
            ? {}
            : {
                error:
                  message.subtype === 'success'
                    ? message.result
                    : `${message.subtype}: ${message.errors.join('; ')}`,
                // SDK 返回的失败都来自模型/工具层；基础设施故障走下面的 catch。
                failureKind: 'agent',
              }),
        });
      }
    }
  } catch (err) {
    // 未捕获的异常会直接退出进程，宿主只能看到「没有 run_finished」。
    // 这里统一转成终态事件：取消归 cancelled，其余归 agent。
    const message = err instanceof Error ? err.message : String(err);
    log(`query failed: ${message}`);
    failRun(abortController.signal.aborted ? 'cancelled' : 'agent', message);
  }
}

log('query finished');
