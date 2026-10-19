import { type ChatEvent, chatEventSchema } from '@agentport/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * 容器内入口：在只读挂载的 /workspace 上运行 Agent SDK。
 * 从 stdin 读一行 JSON 任务，向 stdout 逐行写 NDJSON 事件。
 * stdout 只放协议数据；日志一律写 stderr。
 */
const taskJson = await readLine();
const task = JSON.parse(taskJson) as { prompt: string; maxTurns?: number; maxBudgetUsd?: number };

function emit(event: ChatEvent) {
  process.stdout.write(`${JSON.stringify(chatEventSchema.parse(event))}\n`);
}

for await (const message of query({
  prompt: task.prompt,
  options: {
    cwd: '/workspace',
    settingSources: ['project'],
    permissionMode: 'dontAsk',
    allowedTools: ['mcp__*'],
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
  },
})) {
  // M4 会在这里把 SDK 消息映射成 ChatEvent；当前只输出最终结果
  if (message.type === 'result') {
    emit({
      type: 'run_finished',
      status: message.subtype === 'success' ? 'succeeded' : 'failed',
    });
  }
}

async function readLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}
