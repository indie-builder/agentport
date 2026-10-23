import { type Database, newId, repo, schema } from '@agentport/db';
import type { ChatEvent } from '@agentport/shared';
import { and, eq, ne } from 'drizzle-orm';
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

/** 按专家、会话、运行的顺序持锁，防止终态后追加输出或与删除形成反向锁等待。 */
export async function persistRunMessages(
  db: Database,
  input: { agentId: string; conversationId: string; runId: string; events: ChatEvent[] },
): Promise<boolean> {
  const rows = buildMessageRows(input.events);

  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.id, input.agentId))
      .limit(1)
      .for('key share');
    if (!agent) return false;

    const [conversation] = await tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, input.conversationId),
          eq(schema.conversations.agentId, input.agentId),
        ),
      )
      .limit(1)
      .for('update');
    if (!conversation) return false;

    const [run] = await tx
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.id, input.runId),
          eq(schema.agentRuns.conversationId, input.conversationId),
          eq(schema.agentRuns.agentId, input.agentId),
          eq(schema.agentRuns.status, 'running'),
        ),
      )
      .limit(1)
      .for('update');
    if (!run) return false;

    // BullMQ 重试会重放同一 run：先删本 run 已落库的输出再写，避免重复消息。
    // 用户消息也带 run_id，但由 API 写入，重试时不能删。
    await tx
      .delete(schema.messages)
      .where(and(eq(schema.messages.runId, input.runId), ne(schema.messages.role, 'user')));
    await repo.chat.insertMessages(
      tx,
      rows.map((row) => ({
        id: newId('message'),
        conversationId: input.conversationId,
        role: row.role,
        content: row.content,
        runId: input.runId,
      })),
    );
    return true;
  });
}
