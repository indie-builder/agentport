import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  agentInputSchema,
  agentRunJobSchema,
  permissionModeSchema,
  slugSchema,
} from '@agentport/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createMemoryHook } from './memory-permissions.js';
import { composePrompt } from './prompt.js';

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
    | 'tool_start'
    | 'tool_input'
    | 'tool_result'
    | 'error'
    | 'run_finished';
  text?: string;
  msg?: string;
  toolUseId?: string;
  /** 子智能体产生的消息：指向父侧 Agent 的 tool_use id；顶层消息不写。 */
  parentToolUseId?: string;
  name?: string;
  json?: string;
  content?: string;
  status?: 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  costUsd?: number;
  turns?: number;
  sessionId?: string;
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

const runnerTaskSchema = agentRunJobSchema.pick({ prompt: true, history: true }).extend({
  model: agentInputSchema.shape.model.removeDefault().optional(),
  maxTurns: agentInputSchema.shape.maxTurns.removeDefault().optional(),
  maxBudgetUsd: agentInputSchema.shape.maxBudgetUsd.removeDefault().optional(),
  permissionMode: permissionModeSchema.optional(),
  mcpServers: agentInputSchema.shape.serverIds.removeDefault().optional(),
  extraAllowedTools: agentInputSchema.shape.allowedTools.removeDefault().optional(),
  extraDisallowedTools: agentInputSchema.shape.disallowedTools.removeDefault().optional(),
  effort: agentInputSchema.shape.effort,
  maxThinkingTokens: agentInputSchema.shape.maxThinkingTokens,
  allowSubAgents: agentInputSchema.shape.enabled.removeDefault().optional(),
  /** 本平台缺省转为 []；SDK 自身省略该选项时沿用 CLI 默认。 */
  skills: slugSchema.array().optional(),
});

type RunnerTask = ReturnType<typeof runnerTaskSchema.parse>;

function log(message: string): void {
  process.stderr.write(`[runner] ${message}\n`);
}

/** 单字段上限：宿主侧还有 1MiB 单行/32MiB 总量兜底，这里先截断常见大块。 */
const MAX_FIELD_BYTES = 256 * 1024;
const TRUNCATED = '\n…[truncated]';

/** 按字节截断但不在多字节字符中间切开；截断时追加标记。 */
function cap(value: string): string {
  if (Buffer.byteLength(value) <= MAX_FIELD_BYTES) return value;
  return `${Buffer.from(value).subarray(0, MAX_FIELD_BYTES).toString('utf8').replace(/�$/, '')}${TRUNCATED}`;
}

/** 只取第一行，不读 EOF：宿主写完任务后保持 stdin 打开。 */
async function readTask(): Promise<RunnerTask> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      return runnerTaskSchema.parse(JSON.parse(trimmed));
    }
  } finally {
    rl.close();
  }
  throw new Error('stdin closed before task JSON arrived');
}

/** 取 assistant 消息里的纯文本块，供落库使用。 */
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

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      if (typeof block !== 'object' || block === null) return '';
      if (!('type' in block) || block.type !== 'text') return '';
      if (!('text' in block) || typeof block.text !== 'string') return '';
      return block.text;
    })
    .filter((text) => text.length > 0)
    .join('\n');
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

const task = await readTask();
const prompt = composePrompt(task.prompt, task.history);
// allow 规则只支持 `mcp__<server>__` 之后通配；`mcp__*` 不匹配任何工具。
// server 名来自挂载的 .mcp.json，逐个生成精确规则。
const memoryDirectory = '/mnt/agent-memory';
const allowedTools = [
  `Read(/${memoryDirectory}/**)`,
  // 技能参考文件只读：.claude/skills/<slug>/references/**；写入仍仅限原生记忆目录。
  'Read(//workspace/.claude/skills/*/references/**)',
  // Edit(path) also authorizes Write; Write(path) is not a file permission rule.
  `Edit(/${memoryDirectory}/**)`,
  ...(task.mcpServers ?? []).map((name) => `mcp__${name}__*`),
  ...(task.extraAllowedTools ?? []).filter((rule) => !/^(Read|Write|Edit)(\(|$)/.test(rule)),
  // dontAsk 下未预批准的工具会被拒绝；委派时需显式放行 Agent。
  ...(task.allowSubAgents ? ['Agent'] : []),
];
const abortController = new AbortController();
process.once('SIGTERM', () => abortController.abort());

// 子智能体文件自身仍禁用 Agent；会话间工具只有显式出现在 allowedTools 里才放行（D-19）。
const allowedByConfig = new Set(task.extraAllowedTools ?? []);
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
  ...(task.extraDisallowedTools ?? []),
];
const disallowedTools = baseDisallowed.filter((tool) => {
  if (tool === 'Agent' || tool === 'TaskStop') return !task.allowSubAgents;
  if (tool === 'ListAgents' || tool === 'SendMessage') return !allowedByConfig.has(tool);
  return true;
});

log(`starting query (model=${task.model ?? 'default'})`);

// 读取工作区 .claude/settings.json 的 outputStyle，再以 inline settings 传入。
// SDK 会按 key 优先级把项目 .claude/settings.json 与 inline settings 合并；
// 这里额外 inline 传 outputStyle，保证跨 SDK 版本的合并语义下都能生效。
let outputStyle: string | undefined;
try {
  const parsed = JSON.parse(readFileSync('/workspace/.claude/settings.json', 'utf8')) as {
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

try {
  for await (const message of query({
    prompt,
    options: {
      cwd: '/workspace',
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
      // 用户文本是纯文本：不要做 @路径展开或斜杠命令解析。
      verbatimPrompts: true,
      // 子智能体的文本也要流出来，否则前端看不到它们的回答。
      forwardSubagentText: true,
      permissionMode: task.permissionMode ?? 'dontAsk',
      allowedTools,
      disallowedTools: [...new Set(disallowedTools)],
      hooks: { PreToolUse: [{ hooks: [createMemoryHook(memoryDirectory)] }] },
      // SDK 自己按名字补 Skill(name) 权限；这里不要放通配的 Skill。
      skills: task.skills ?? [],
      includePartialMessages: true,
      maxTurns: task.maxTurns ?? 20,
      maxBudgetUsd: task.maxBudgetUsd ?? 2,
      ...(task.effort === undefined ? {} : { effort: task.effort }),
      ...(task.maxThinkingTokens === undefined
        ? {}
        : { thinking: { type: 'enabled', budgetTokens: task.maxThinkingTokens } }),
      abortController,
      ...(task.model === undefined ? {} : { model: task.model }),
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
          msg: `这些 MCP Server 没有连上，本次运行缺少它们的工具：${failed
            .map((s) => s.name)
            .join('、')}`,
        });
      }
      continue;
    }

    if (message.type === 'assistant') {
      // 子智能体消息带 parent_tool_use_id（父侧 Agent 的 tool_use id）；顶层为 null。
      const parent = parentTag(message.parent_tool_use_id);
      // 完整文本块单独发一次：前端已用 text_delta 渲染，这次用于落库。
      const fullText = assistantText(message.message.content);
      if (fullText.length > 0) {
        emit({ type: 'assistant_text', text: cap(fullText), ...parent });
      }
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue;
        emit({ type: 'tool_start', toolUseId: block.id, name: block.name, ...parent });
        emit({
          type: 'tool_input',
          toolUseId: block.id,
          json: cap(JSON.stringify(block.input)),
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
          content: cap(toolResultText(block.content)),
          ...parent,
        });
      }
      continue;
    }

    if (message.type === 'stream_event') {
      const event = message.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        emit({ type: 'text_delta', text: event.delta.text });
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
  // 这里统一转成终态事件：取消归 cancelled，其余归 agent/infra。
  const message = err instanceof Error ? err.message : String(err);
  log(`query failed: ${message}`);
  if (!emittedTerminal) {
    const kind: FailureKind = abortController.signal.aborted ? 'cancelled' : 'agent';
    emit({
      type: 'run_finished',
      status: kind === 'cancelled' ? 'cancelled' : 'failed',
      error: message,
      failureKind: kind,
    });
  }
}

log('query finished');
