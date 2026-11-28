import { resolveOpenUiResponseDetailed } from '@agentport/core';
import { type Database, type DbHandle, newId, repo, schema } from '@agentport/db';
import {
  type ChatEvent,
  type ChatMessageRole,
  hasOpenUiSegment,
  type PublicRunQuestion,
  redactJson,
  redactSecrets,
  streamBlockIdOf,
} from '@agentport/shared';
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';

function parseToolInput(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

interface MessageRow {
  role: ChatMessageRole;
  content: unknown;
  sdkMessageUuid?: string;
  streamBlockId?: string;
}

export function buildMessageRows(events: ChatEvent[]): MessageRow[] {
  const rows: MessageRow[] = [];
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, string>();
  const toolParents = new Map<string, string>();
  const toolUuids = new Map<string, string>();
  const questions = new Map<string, PublicRunQuestion>();
  for (const event of events) {
    if (event.type === 'question_updated') {
      questions.set(event.question.toolUseId, event.question);
    }
  }
  const answeredToolIds = new Set<string>();

  for (const event of events) {
    if (event.type === 'assistant_text' && event.text.trim().length > 0) {
      const streamBlockId = streamBlockIdOf(event);
      rows.push({
        role: 'assistant',
        content: {
          type: 'text',
          text: redactSecrets(event.text),
          ...(event.blockIndex === undefined ? {} : { blockIndex: event.blockIndex }),
          ...(event.parentToolUseId === undefined
            ? {}
            : { parentToolUseId: event.parentToolUseId }),
          ...(event.truncated === true ? { truncated: true } : {}),
        },
        ...(event.sdkUuid === undefined ? {} : { sdkMessageUuid: event.sdkUuid }),
        ...(streamBlockId === undefined ? {} : { streamBlockId }),
      });
    } else if (event.type === 'tool_start') {
      toolNames.set(event.toolUseId, event.name);
      if (event.sdkUuid !== undefined) toolUuids.set(event.toolUseId, event.sdkUuid);
      if (event.parentToolUseId !== undefined) {
        toolParents.set(event.toolUseId, event.parentToolUseId);
      }
    } else if (event.type === 'tool_input') {
      toolInputs.set(event.toolUseId, redactJson(event.json));
    } else if (event.type === 'tool_result') {
      answeredToolIds.add(event.toolUseId);
      const question = questions.get(event.toolUseId);
      const parentToolUseId = event.parentToolUseId ?? toolParents.get(event.toolUseId);
      const parent = parentToolUseId === undefined ? {} : { parentToolUseId };
      const sdkMessageUuid = event.sdkUuid ?? toolUuids.get(event.toolUseId);
      const sdk = sdkMessageUuid === undefined ? {} : { sdkMessageUuid };
      rows.push({
        role: 'tool',
        content: {
          type: 'tool_use',
          id: event.toolUseId,
          name: toolNames.get(event.toolUseId) ?? null,
          input: parseToolInput(toolInputs.get(event.toolUseId)),
          ...parent,
          ...(question === undefined ? {} : { question }),
        },
        ...sdk,
      });
      rows.push({
        role: 'tool',
        content: {
          type: 'tool_result',
          toolUseId: event.toolUseId,
          name: toolNames.get(event.toolUseId) ?? null,
          content: redactSecrets(event.content),
          ...(event.todos === undefined
            ? {}
            : {
                todos: event.todos.map((todo) => ({
                  content: redactSecrets(todo.content),
                  activeForm: redactSecrets(todo.activeForm),
                  status: todo.status,
                })),
              }),
          ...parent,
          ...(question === undefined ? {} : { question }),
        },
        ...sdk,
      });
    }
  }

  const startedToolIds = new Set<string>([...toolNames.keys(), ...questions.keys()]);
  for (const toolUseId of startedToolIds) {
    if (answeredToolIds.has(toolUseId)) continue;
    const question = questions.get(toolUseId);
    const parentToolUseId = toolParents.get(toolUseId);
    const sdkMessageUuid = toolUuids.get(toolUseId);
    rows.push({
      role: 'tool',
      content: {
        type: 'tool_use',
        id: toolUseId,
        name: toolNames.get(toolUseId) ?? (question === undefined ? null : 'AskUserQuestion'),
        input: parseToolInput(toolInputs.get(toolUseId)),
        ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
        ...(question === undefined ? {} : { question }),
      },
      ...(sdkMessageUuid === undefined ? {} : { sdkMessageUuid }),
    });
  }

  return rows;
}

export const MESSAGES_NOT_SAVED_ERROR = '消息未保存，产出未发布';
export const MESSAGES_NOT_SAVED_MARKER = `；${MESSAGES_NOT_SAVED_ERROR}：`;

export interface PersistedMessage {
  id: string;
  blockIndex: number;
  streamBlockId?: string;
  parentToolUseId?: string;
  uiFormat: 'markdown' | 'openui';
  uiProgram: string | null;
}

export type PersistedChannelMessage = typeof schema.channelMessages.$inferSelect;

function channelReplyOf(
  messages: Array<{ id: string; row: MessageRow }>,
): { body: string; sourceMessageId: string } | null {
  const blocks = messages.filter(({ row }) => {
    if (row.role !== 'assistant') return false;
    const content = row.content as { text?: unknown; parentToolUseId?: unknown };
    return content.parentToolUseId === undefined && typeof content.text === 'string';
  });
  if (blocks.length === 0) return null;
  return {
    body: blocks.map(({ row }) => (row.content as { text: string }).text).join('\n\n'),
    sourceMessageId: blocks.at(-1)?.id ?? '',
  };
}

async function previousUiProgram(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  conversationId: string,
  excludedRunIds: string[],
): Promise<string> {
  const [row] = await tx
    .select({ uiProgram: schema.messages.uiProgram })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.role, 'assistant'),
        isNotNull(schema.messages.uiProgram),
        ...excludedRunIds.map((id) => sql`${schema.messages.runId} is distinct from ${id}`),
        sql`${schema.messages.content}->>'parentToolUseId' is null`,
      ),
    )
    .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
    .limit(1);
  return row?.uiProgram ?? '';
}

function canonicalPrograms(rows: MessageRow[], baseline: string, uiFormat: 'markdown' | 'openui') {
  const programs = new Map<number, string | null>();
  const diagnostics: ReturnType<typeof resolveOpenUiResponseDetailed>['diagnostics'] = [];
  let previous = baseline;
  rows.forEach((row, index) => {
    if (row.role !== 'assistant') return;
    const content = row.content as {
      text?: unknown;
      parentToolUseId?: unknown;
      truncated?: unknown;
    };
    const eligible =
      uiFormat === 'openui' &&
      content.parentToolUseId === undefined &&
      content.truncated !== true &&
      typeof content.text === 'string';
    const hasUi = eligible && hasOpenUiSegment(content.text as string);
    if (!eligible || !hasUi) {
      programs.set(index, null);
      return;
    }
    const resolved = resolveOpenUiResponseDetailed(previous, content.text as string);
    if (resolved.diagnostics.length > 0) {
      diagnostics.push(...resolved.diagnostics);
    }
    if (resolved.text.trim() === '') {
      programs.set(index, null);
      return;
    }
    programs.set(index, resolved.text);
    previous = resolved.text;
  });
  return { programs, diagnostics };
}

async function deleteRunOutputMessages(tx: DbHandle, runId: string): Promise<void> {
  await tx
    .delete(schema.messages)
    .where(and(eq(schema.messages.runId, runId), ne(schema.messages.role, 'user')));
}

export async function persistRunMessages(
  db: Database,
  input: {
    agentId: string;
    conversationId: string;
    runId: string;
    events: ChatEvent[];
    sdkSessionId?: string;
    modelExecuted?: boolean;
    uuidMap?: Array<{ from: string; to: string }>;
    uiFormat?: 'markdown' | 'openui';
    /** 重试中间轮不投影频道：同一 run 覆盖同一 seq 行会让已订阅者漏掉最终正文。 */
    projectChannelReply?: boolean;
    replacesRunId?: string;
    logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  },
): Promise<{
  written: boolean;
  messages: PersistedMessage[];
  channelMessage?: PersistedChannelMessage;
}> {
  const rows = buildMessageRows(input.events);
  const uiFormat = input.uiFormat ?? 'markdown';
  let openuiDiagnostics: ReturnType<typeof resolveOpenUiResponseDetailed>['diagnostics'] = [];

  const result = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.id, input.agentId))
      .limit(1)
      .for('key share');
    if (!agent) return { written: false, messages: [] };

    const [lane] = await tx
      .select({ channelId: schema.conversations.channelId })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, input.conversationId),
          eq(schema.conversations.agentId, input.agentId),
        ),
      )
      .limit(1);
    if (!lane) return { written: false, messages: [] };

    if (lane.channelId !== null) {
      const [channel] = await tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.id, lane.channelId))
        .limit(1)
        .for('update');
      if (!channel) return { written: false, messages: [] };
    }

    const [conversation] = await tx
      .select({ id: schema.conversations.id, channelId: schema.conversations.channelId })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, input.conversationId),
          eq(schema.conversations.agentId, input.agentId),
        ),
      )
      .limit(1)
      .for('update');
    if (!conversation || conversation.channelId !== lane.channelId) {
      return { written: false, messages: [] };
    }

    const [run] = await tx
      .select({
        id: schema.agentRuns.id,
        channelTriggerMessageId: schema.agentRuns.channelTriggerMessageId,
      })
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.id, input.runId),
          eq(schema.agentRuns.conversationId, input.conversationId),
          eq(schema.agentRuns.agentId, input.agentId),
          eq(schema.agentRuns.status, 'running'),
          lane.channelId === null
            ? isNull(schema.agentRuns.channelId)
            : eq(schema.agentRuns.channelId, lane.channelId),
        ),
      )
      .limit(1)
      .for('update');
    if (!run) return { written: false, messages: [] };

    const baseline = await previousUiProgram(
      tx,
      input.conversationId,
      input.replacesRunId === undefined ? [input.runId] : [input.runId, input.replacesRunId],
    );
    await deleteRunOutputMessages(tx, input.runId);
    if (input.replacesRunId !== undefined) {
      await deleteRunOutputMessages(tx, input.replacesRunId);
      await tx
        .update(schema.messages)
        .set({ runId: input.runId })
        .where(
          and(eq(schema.messages.runId, input.replacesRunId), eq(schema.messages.role, 'user')),
        );
    }
    const { programs, diagnostics } = canonicalPrograms(rows, baseline, uiFormat);
    openuiDiagnostics = diagnostics;
    const withIds = rows.map((row, index) => ({
      row,
      index,
      id: newId('message'),
      blockIndex:
        typeof row.content === 'object' && row.content !== null
          ? Number((row.content as Record<string, unknown>).blockIndex ?? 0)
          : 0,
    }));
    await repo.chat.insertMessages(
      tx,
      withIds.map(({ row, index, id }) => ({
        id,
        conversationId: input.conversationId,
        role: row.role,
        content: row.content,
        runId: input.runId,
        ...(row.role === 'assistant' ? { uiFormat, uiProgram: programs.get(index) ?? null } : {}),
        ...(row.sdkMessageUuid === undefined ? {} : { sdkMessageUuid: row.sdkMessageUuid }),
      })),
    );
    let channelMessage: PersistedChannelMessage | undefined;
    if (lane.channelId !== null && (input.projectChannelReply ?? true)) {
      const reply = channelReplyOf(withIds);
      if (reply !== null) {
        const [existing] = await tx
          .select({ id: schema.channelMessages.id })
          .from(schema.channelMessages)
          .where(
            and(
              eq(schema.channelMessages.channelId, lane.channelId),
              eq(schema.channelMessages.runId, input.runId),
              eq(schema.channelMessages.kind, 'agent'),
            ),
          )
          .orderBy(desc(schema.channelMessages.createdAt), desc(schema.channelMessages.id))
          .limit(1);
        if (existing) {
          [channelMessage] = await tx
            .update(schema.channelMessages)
            .set({
              agentId: input.agentId,
              body: reply.body,
              sourceMessageId: reply.sourceMessageId,
            })
            .where(eq(schema.channelMessages.id, existing.id))
            .returning();
        } else {
          [channelMessage] = await tx
            .insert(schema.channelMessages)
            .values({
              id: newId('channelMessage'),
              channelId: lane.channelId,
              kind: 'agent',
              agentId: input.agentId,
              runId: input.runId,
              body: reply.body,
              sourceMessageId: reply.sourceMessageId,
            })
            .returning();
        }
      }
    }
    if (lane.channelId !== null && channelMessage !== undefined) {
      await tx
        .update(schema.channels)
        .set({ updatedAt: new Date() })
        .where(eq(schema.channels.id, lane.channelId));
    }
    if (input.sdkSessionId !== undefined) {
      await repo.chat.saveSdkState(tx, {
        conversationId: input.conversationId,
        sdkSessionId: input.sdkSessionId,
        ...(input.uuidMap === undefined ? {} : { uuidMap: input.uuidMap }),
      });
    }
    if (
      lane.channelId !== null &&
      run.channelTriggerMessageId !== null &&
      (input.modelExecuted === true ||
        input.events.some((event) => event.type === 'tool_start' || event.type === 'tool_result'))
    ) {
      await repo.chat.consumeChannelContext(tx, {
        channelId: lane.channelId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        channelMessageId: run.channelTriggerMessageId,
      });
    }
    if (input.replacesRunId !== undefined) {
      await tx.delete(schema.agentRuns).where(eq(schema.agentRuns.id, input.replacesRunId));
    }
    return {
      written: true,
      messages: withIds
        .filter(({ row }) => row.role === 'assistant')
        .map(({ row, index, id, blockIndex }) => {
          const content = row.content as { parentToolUseId?: unknown };
          const parentToolUseId =
            typeof content.parentToolUseId === 'string' ? content.parentToolUseId : undefined;
          return {
            id,
            blockIndex,
            ...(row.streamBlockId === undefined ? {} : { streamBlockId: row.streamBlockId }),
            ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
            uiFormat,
            uiProgram: programs.get(index) ?? null,
          };
        }),
      ...(channelMessage === undefined ? {} : { channelMessage }),
    };
  });
  if (result.written && openuiDiagnostics.length > 0) {
    input.logger?.warn(
      {
        conversationId: input.conversationId,
        runId: input.runId,
        diagnostics: openuiDiagnostics,
      },
      'openui response resolution diagnostics',
    );
  }
  return result;
}
