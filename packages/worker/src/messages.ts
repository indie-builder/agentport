import { resolveOpenUiResponse } from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import { type ChatEvent, type PublicRunQuestion, segmentOpenUi } from '@agentport/shared';
import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { redactJson, redactSecrets } from './redact.js';

/** 工具入参在事件里是 JSON 字符串；落库时还原成对象，前端与 trace 都按对象渲染。 */
function parseToolInput(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * 块身份随消息落库，但只在本次运行内有效：`blockIndex` 会被 SDK 的后续消息重用，
 * 前端实时对齐要用运行内稳定的 id。shared 的事件类型加上该字段前先按存在性读取。
 */
function streamBlockIdOf(event: ChatEvent): string | undefined {
  if (!('streamBlockId' in event)) return undefined;
  return typeof event.streamBlockId === 'string' ? event.streamBlockId : undefined;
}

interface MessageRow {
  role: string;
  content: unknown;
  sdkMessageUuid?: string;
  streamBlockId?: string;
}

/** 事件流 → 消息行：assistant 文本按块存，工具调用存成 tool 消息（use + result 各一行）。 */
export function buildMessageRows(events: ChatEvent[]): MessageRow[] {
  const rows: MessageRow[] = [];
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, string>();
  const toolParents = new Map<string, string>();
  const toolUuids = new Map<string, string>();
  /** 每个提问工具调用的最新快照；按 toolUseId 附到工具历史，刷新后仍能还原卡片。 */
  const questions = new Map<string, PublicRunQuestion>();
  // 先收集全部快照：收尾时才写入的 answered/closed 排在 tool_result 之后，
  // 单遍处理会把旧的 pending 快照留在历史里。
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
          // 块身份随内容落库：读路径原样带出，前端才能按块重建而不是拼成一整段。
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
      // 子智能体内部的调用：标出它属于哪个父侧 Agent 调用，前端据此缩进。
      const parentToolUseId = event.parentToolUseId ?? toolParents.get(event.toolUseId);
      const parent = parentToolUseId === undefined ? {} : { parentToolUseId };
      // 工具调用的两半属于同一条 SDK 消息；fork 时按这个 uuid 重映射。
      const sdkMessageUuid = event.sdkUuid ?? toolUuids.get(event.toolUseId);
      const sdk = sdkMessageUuid === undefined ? {} : { sdkMessageUuid };
      // tool_use 也要落库：否则刷新后前端无法重建工具卡片（只有 result 没有卡片）。
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
          // 清单与工具结果同一条消息落库；模型生成的可见文本同样要脱敏。
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

  // 取消/超时没有原生 tool_result：提问卡片仍要保留，否则刷新后问题凭空消失。
  for (const [toolUseId, question] of questions) {
    if (answeredToolIds.has(toolUseId)) continue;
    const parentToolUseId = toolParents.get(toolUseId);
    const sdkMessageUuid = toolUuids.get(toolUseId);
    rows.push({
      role: 'tool',
      content: {
        type: 'tool_use',
        id: toolUseId,
        name: toolNames.get(toolUseId) ?? 'AskUserQuestion',
        input: parseToolInput(toolInputs.get(toolUseId)),
        ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
        question,
      },
      ...(sdkMessageUuid === undefined ? {} : { sdkMessageUuid }),
    });
  }

  return rows;
}

/** 落库后的助手块；前端用它把流式项对齐到真实消息，运行内字段不落库。 */
export interface PersistedMessage {
  id: string;
  blockIndex: number;
  streamBlockId?: string;
  parentToolUseId?: string;
  uiFormat: 'markdown' | 'openui';
  /** 本消息的 canonical 完整混合文本；纯文本、子智能体与截断块为 null。 */
  uiProgram: string | null;
}

/** 该会话上一条主助手（非子智能体）已合并的完整程序：跨轮补丁的基线。 */
async function previousUiProgram(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  conversationId: string,
  runId: string,
): Promise<string> {
  const [row] = await tx
    .select({ uiProgram: schema.messages.uiProgram })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.role, 'assistant'),
        isNotNull(schema.messages.uiProgram),
        // 重试重放时本 run 的旧输出不是上一轮，不能拿它当基线。
        sql`${schema.messages.runId} is distinct from ${runId}`,
        sql`${schema.messages.content}->>'parentToolUseId' is null`,
      ),
    )
    .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
    .limit(1);
  return row?.uiProgram ?? '';
}

/** 按输出顺序合并 UI 段：纯文字保留上一条基线，子智能体与截断块不参与。 */
function canonicalPrograms(
  rows: MessageRow[],
  baseline: string,
  uiFormat: 'markdown' | 'openui',
): Map<number, string | null> {
  const programs = new Map<number, string | null>();
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
    const hasUi =
      eligible &&
      segmentOpenUi(content.text as string).some((segment) => segment.kind === 'openui');
    // 纯文本消息不写程序，也不更新基线：下一轮补丁仍以最近一次真实 UI 为起点。
    if (!eligible || !hasUi) {
      programs.set(index, null);
      return;
    }
    const resolved = resolveOpenUiResponse(previous, content.text as string);
    if (resolved.trim() === '') {
      programs.set(index, null);
      return;
    }
    programs.set(index, resolved);
    previous = resolved;
  });
  return programs;
}

/** 按专家、会话、运行的顺序持锁，防止终态后追加输出或与删除形成反向锁等待。 */
export async function persistRunMessages(
  db: Database,
  input: {
    agentId: string;
    conversationId: string;
    runId: string;
    events: ChatEvent[];
    /** 本次运行后的 SDK session；与消息同事务写入，避免只存一半。 */
    sdkSessionId?: string;
    /** fork 造成的 uuid 重映射（旧 → 新），更新页面已保存的历史消息。 */
    uuidMap?: Array<{ from: string; to: string }>;
    /** 本轮智能体的回复格式；历史渲染按消息快照，不跟随之后的开关切换。 */
    uiFormat?: 'markdown' | 'openui';
  },
): Promise<{ written: boolean; messages: PersistedMessage[] }> {
  const rows = buildMessageRows(input.events);
  const uiFormat = input.uiFormat ?? 'markdown';

  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.id, input.agentId))
      .limit(1)
      .for('key share');
    if (!agent) return { written: false, messages: [] };

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
    if (!conversation) return { written: false, messages: [] };

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
    if (!run) return { written: false, messages: [] };

    // 基线必须在本 run 的输出删除之前读：先删会把上一轮也删掉，跨轮补丁就丢了。
    const baseline = await previousUiProgram(tx, input.conversationId, input.runId);
    // BullMQ 重试会重放同一 run：先删本 run 已落库的输出再写，避免重复消息。
    // 用户消息也带 run_id，但由 API 写入，重试时不能删。
    await tx
      .delete(schema.messages)
      .where(and(eq(schema.messages.runId, input.runId), ne(schema.messages.role, 'user')));
    const programs = canonicalPrograms(rows, baseline, uiFormat);
    // 先分配 id 并回传给宿主：前端要用它把流式消息与落库消息对应起来。
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
        // 只标记助手输出：tool 行不是可渲染的回复，用户消息的格式由准入时决定。
        ...(row.role === 'assistant' ? { uiFormat, uiProgram: programs.get(index) ?? null } : {}),
        ...(row.sdkMessageUuid === undefined ? {} : { sdkMessageUuid: row.sdkMessageUuid }),
      })),
    );
    // 会话的 SDK 状态必须与输出同事务：先落消息再单独存 session，
    // 失败时会出现「页面有历史、transcript 缺一截」的静默错位。
    if (input.sdkSessionId !== undefined) {
      await repo.chat.saveSdkState(tx, {
        conversationId: input.conversationId,
        sdkSessionId: input.sdkSessionId,
        ...(input.uuidMap === undefined ? {} : { uuidMap: input.uuidMap }),
      });
    }
    // 只回传可渲染的助手文本块，前端据此回填 messageId。
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
    };
  });
}
