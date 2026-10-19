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
  type: 'text_delta' | 'tool_start' | 'tool_input' | 'tool_result' | 'run_finished';
  text?: string;
  toolUseId?: string;
  name?: string;
  json?: string;
  content?: string;
  status?: 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  costUsd?: number;
  turns?: number;
  error?: string;
}

interface RunnerTask {
  prompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** .mcp.json 里的 server key，用于生成精确的 allow 规则 */
  mcpServers?: string[];
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
const allowedTools = (task.mcpServers ?? []).map((name) => `mcp__${name}__*`);
const abortController = new AbortController();
process.once('SIGTERM', () => abortController.abort());

log(`starting query (model=${task.model ?? 'default'})`);

for await (const message of query({
  prompt: task.prompt,
  options: {
    cwd: '/workspace',
    settingSources: ['project'],
    permissionMode: 'dontAsk',
    allowedTools,
    disallowedTools: [
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
    ],
    includePartialMessages: true,
    maxTurns: task.maxTurns ?? 20,
    maxBudgetUsd: task.maxBudgetUsd ?? 2,
    abortController,
    ...(task.model === undefined ? {} : { model: task.model }),
  },
})) {
  if (message.type === 'assistant') {
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
