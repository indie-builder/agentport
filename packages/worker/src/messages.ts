import type { ChatEvent } from '@agentport/shared';
import { redactSecrets } from './redact.js';

/** 工具入参在事件里是 JSON 字符串；落库时还原成对象，前端与 trace 都按对象渲染。 */
function parseToolInput(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** 事件流 → 消息行：assistant 文本按块存，工具调用存成 tool 消息（use + result 各一行）。 */
export function buildMessageRows(events: ChatEvent[]): Array<{ role: string; content: unknown }> {
  const rows: Array<{ role: string; content: unknown }> = [];
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, string>();
  const toolParents = new Map<string, string>();

  for (const event of events) {
    if (event.type === 'assistant_text' && event.text.trim().length > 0) {
      rows.push({
        role: 'assistant',
        content: {
          type: 'text',
          text: redactSecrets(event.text),
          ...(event.parentToolUseId === undefined
            ? {}
            : { parentToolUseId: event.parentToolUseId }),
        },
      });
    } else if (event.type === 'tool_start') {
      toolNames.set(event.toolUseId, event.name);
      if (event.parentToolUseId !== undefined) {
        toolParents.set(event.toolUseId, event.parentToolUseId);
      }
    } else if (event.type === 'tool_input') {
      toolInputs.set(event.toolUseId, redactSecrets(event.json));
    } else if (event.type === 'tool_result') {
      // 子智能体内部的调用：标出它属于哪个父侧 Agent 调用，前端据此缩进。
      const parentToolUseId = event.parentToolUseId ?? toolParents.get(event.toolUseId);
      const parent = parentToolUseId === undefined ? {} : { parentToolUseId };
      // tool_use 也要落库：否则刷新后前端无法重建工具卡片（只有 result 没有卡片）。
      rows.push({
        role: 'tool',
        content: {
          type: 'tool_use',
          id: event.toolUseId,
          name: toolNames.get(event.toolUseId) ?? null,
          input: parseToolInput(toolInputs.get(event.toolUseId)),
          ...parent,
        },
      });
      rows.push({
        role: 'tool',
        content: {
          type: 'tool_result',
          toolUseId: event.toolUseId,
          name: toolNames.get(event.toolUseId) ?? null,
          content: redactSecrets(event.content),
          ...parent,
        },
      });
    }
  }

  return rows;
}
