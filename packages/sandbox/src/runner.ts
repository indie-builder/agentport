import { createInterface } from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';

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
    | 'run_finished';
  text?: string;
  toolUseId?: string;
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
}

interface RunnerTask {
  prompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** .mcp.json 里的 server key，用于生成精确的 allow 规则 */
  mcpServers?: string[];
  /** 智能体自定义的额外允许项（mcp__ 通配由 mcpServers 推导） */
  extraAllowedTools?: string[];
  /** 智能体自定义的额外禁用项，与默认禁用列表合并 */
  extraDisallowedTools?: string[];
  /** 推理强度，透传给 SDK */
  effort?: string;
  /** 思考预算 token 上限 */
  maxThinkingTokens?: number;
  /** 有子智能体时放行 Agent/TaskStop；子智能体定义由 .claude/agents/*.md 自动发现。 */
  allowSubAgents?: boolean;
}

function log(message: string): void {
  process.stderr.write(`[runner] ${message}\n`);
}

function emit(event: RunnerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** 只取第一行，不读 EOF：宿主写完任务后保持 stdin 打开。 */
async function readTask(): Promise<RunnerTask> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      return JSON.parse(trimmed) as RunnerTask;
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

const task = await readTask();
// allow 规则只支持 `mcp__<server>__` 之后通配；`mcp__*` 不匹配任何工具。
// server 名来自挂载的 .mcp.json，逐个生成精确规则。
const allowedTools = [
  ...(task.mcpServers ?? []).map((name) => `mcp__${name}__*`),
  ...(task.extraAllowedTools ?? []),
  // dontAsk 下未预批准的工具会被拒绝；委派时需显式放行 Agent。
  ...(task.allowSubAgents ? ['Agent'] : []),
];
const abortController = new AbortController();
process.once('SIGTERM', () => abortController.abort());

// 单层委派：仅当工作区里有子智能体时放行；子智能体文件自身仍禁用 Agent。
const agentTools = new Set(['Agent', 'TaskStop']);
const baseDisallowed = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'TaskStop',
  ...(task.extraDisallowedTools ?? []),
];
const disallowedTools = task.allowSubAgents
  ? baseDisallowed.filter((tool) => !agentTools.has(tool))
  : baseDisallowed;

log(`starting query (model=${task.model ?? 'default'})`);

for await (const message of query({
  prompt: task.prompt,
  options: {
    cwd: '/workspace',
    settingSources: ['project'],
    permissionMode: 'dontAsk',
    allowedTools,
    disallowedTools: [...new Set(disallowedTools)],
    includePartialMessages: true,
    maxTurns: task.maxTurns ?? 20,
    maxBudgetUsd: task.maxBudgetUsd ?? 2,
    ...(task.effort === undefined
      ? {}
      : { effort: task.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' }),
    ...(task.maxThinkingTokens === undefined ? {} : { maxThinkingTokens: task.maxThinkingTokens }),
    abortController,
    ...(task.model === undefined ? {} : { model: task.model }),
  },
})) {
  if (message.type === 'assistant') {
    // 完整文本块单独发一次：前端已用 text_delta 渲染，这次用于落库。
    const fullText = assistantText(message.message.content);
    if (fullText.length > 0) emit({ type: 'assistant_text', text: fullText });
    for (const block of message.message.content) {
      if (block.type !== 'tool_use') continue;
      emit({ type: 'tool_start', toolUseId: block.id, name: block.name });
      emit({ type: 'tool_input', toolUseId: block.id, json: JSON.stringify(block.input) });
    }
    continue;
  }

  if (message.type === 'user') {
    const content = message.message.content;
    if (typeof content === 'string') continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      emit({
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: toolResultText(block.content),
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
          }),
    });
  }
}

log('query finished');
