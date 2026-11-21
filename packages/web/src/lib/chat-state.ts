import {
  type ChatEvent,
  type ConversationMessage,
  messageAttachments,
  type ProgressTodo,
  type PublicRunQuestion,
  progressTodoSchema,
  publicRunQuestionSchema,
  streamBlockIdOf,
} from '@agentport/shared';
import type { ConversationDetail } from './api.js';

/** 用户消息上的附件：只有历史项带下载地址，刚发送的乐观项只展示元数据。 */
export interface UserAttachment {
  id?: string;
  filename: string;
  mimeType: string;
  size: number;
  downloadUrl?: string;
}

export type ChatItem =
  | {
      id?: string;
      kind: 'user';
      text: string;
      attachments?: UserAttachment[];
      messageId?: string;
      /** 产生这一轮运行的 id；没有助手输出时，终态读数由这条用户消息承载。 */
      runId?: string;
      authorBusinessId?: string;
      self?: boolean;
    }
  | {
      id?: string;
      kind: 'text';
      text: string;
      runId?: string;
      /** 助手消息内的块序号；同一消息的不同块不能合并，但会被 SDK 的后续消息重用。 */
      blockIndex?: number;
      /** run 内稳定的块身份；有它时按它对齐，不再用 blockIndex 判等。 */
      streamBlockId?: string;
      /** 产生该块的 SDK 消息 uuid；同一条消息的所有块共享。 */
      sdkUuid?: string;
      /** 子智能体产生的文本：父侧 Agent 的 tool_use id。 */
      parentToolUseId?: string;
      /** 超过单块上限被截断：text 只是保留的前缀。 */
      truncated?: boolean;
      /** 该块已结束；重用的块序号不能并进这一段。 */
      closed?: boolean;
      /** 落库后的消息 id：run_finished 回填，历史重建时直接给。 */
      messageId?: string;
      /**
       * 生成该消息时智能体的回复格式。历史按消息自身渲染：
       * 智能体之后把 `uiFormat` 改回 markdown，也不能把已存的 UI 显示成源码。
       */
      uiFormat?: 'markdown' | 'openui';
      /** editMode 合并后的完整程序；流式期间没有，只有原文。 */
      uiProgram?: string;
      /** 该消息 UI 段的表单/绑定快照，键是 blockKey。 */
      uiState?: unknown;
    }
  | {
      id?: string;
      kind: 'tool';
      toolUseId: string;
      name: string;
      input?: string;
      result?: string;
      /** 落库的 tool_result 消息 id：run_id 被分支/维护清空后，成果仍靠它定位。 */
      resultMessageId?: string;
      /** 子智能体内部的调用：父侧 Agent 的 tool_use id。 */
      parentToolUseId?: string;
      /** 前端收到的时刻，用于显示耗时；历史消息没有。 */
      startedAt?: number;
      endedAt?: number;
      runId?: string;
      /** 最近一次确认的任务清单快照；空数组表示已清空。 */
      todos?: ProgressTodo[];
      /** 原生提问的落库快照；取消/失败没有 tool_result 时也靠它展示问题。 */
      question?: PublicRunQuestion;
      /**
       * 快照确认顺序：tool_result 到达才编号，trace 位置仍留在 tool_start。
       * 早开始的调用可能晚确认，选清单必须按它而不是数组位置。
       */
      todoSeq?: number;
    }
  | { id?: string; kind: 'notice'; text: string; tone: 'ok' | 'error' | 'warning' | 'muted' };

/**
 * 事件流没有 isError 字段，沙盒只丢了文本。已知错误文案只能按前缀识别。
 * shortcut: 工具错误靠前缀判断，后端补 isError 后改这里。
 */
export function toolFailed(result: string | undefined): boolean {
  if (result === undefined) return false;
  const text = result.trimStart();
  return (
    text.startsWith('需要批准：') ||
    /^upstream \d{3}:/.test(text) ||
    text.startsWith('Error:') ||
    text.startsWith('error:')
  );
}

function runStart(items: ChatItem[]): number {
  return items.findLastIndex((item) => item.kind === 'user') + 1;
}

const REPLAY_TERMINAL_NOTICE = '结束事件未收到，正在读取已保存结果。';
const REPLAY_TRUNCATED_NOTICE = '较早事件已截断，运行结束后将读取已保存结果。';
const REPLAY_BUDGET_NOTICE = '增量事件超出回放预算，已跳过部分增量；完整块仍会继续显示。';
const REPLAY_NOTICE_TEXTS = new Set([
  REPLAY_TERMINAL_NOTICE,
  REPLAY_TRUNCATED_NOTICE,
  REPLAY_BUDGET_NOTICE,
]);

function replayNoticeText(reason: string): string {
  if (reason === 'terminal_missing') return REPLAY_TERMINAL_NOTICE;
  if (reason === 'budget') return REPLAY_BUDGET_NOTICE;
  return REPLAY_TRUNCATED_NOTICE;
}

function isReplayNotice(item: ChatItem): boolean {
  return item.kind === 'notice' && REPLAY_NOTICE_TEXTS.has(item.text);
}

function findStreamBlock(
  items: ChatItem[],
  streamBlockId: string,
  parentToolUseId: string | undefined,
): number {
  const start = runStart(items);
  for (let index = items.length - 1; index >= start; index--) {
    const item = items[index];
    if (item?.kind !== 'text' || item.streamBlockId !== streamBlockId) continue;
    if (item.parentToolUseId === parentToolUseId) return index;
  }
  return -1;
}

function textItem(
  event: Extract<ChatEvent, { type: 'assistant_text' }>,
  text: string,
  streamBlockId: string | undefined,
): ChatItem {
  return {
    kind: 'text',
    text,
    closed: true,
    ...(event.blockIndex === undefined ? {} : { blockIndex: event.blockIndex }),
    ...(streamBlockId === undefined ? {} : { streamBlockId }),
    ...(event.sdkUuid === undefined ? {} : { sdkUuid: event.sdkUuid }),
    ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: event.parentToolUseId }),
    ...(event.truncated === true ? { truncated: true } : {}),
  };
}

export function applyEvent(items: ChatItem[], event: ChatEvent): ChatItem[] {
  const streamBlockId = streamBlockIdOf(event);
  switch (event.type) {
    case 'text_delta': {
      // 同一段 = 同一个 run 内块身份，且归属同一层（子智能体文本的 parentToolUseId 不同）。
      // 不能用 sdkUuid 判等：真实 SDK 的 stream_event.uuid 每帧都变，拿它比较会把一段拆成碎片。
      // 有稳定身份时按它查已有段（父子交错时会命中中间的段），没有时退回末尾块的边界规则。
      if (streamBlockId !== undefined) {
        const index = findStreamBlock(items, streamBlockId, event.parentToolUseId);
        const previous = index >= 0 ? items[index] : undefined;
        if (previous?.kind === 'text') {
          if (previous.closed === true) return items;
          return items.with(index, { ...previous, text: previous.text + event.text });
        }
        return [
          ...items,
          {
            kind: 'text',
            text: event.text,
            ...(event.blockIndex === undefined ? {} : { blockIndex: event.blockIndex }),
            streamBlockId,
            ...(event.sdkUuid === undefined ? {} : { sdkUuid: event.sdkUuid }),
            ...(event.parentToolUseId === undefined
              ? {}
              : { parentToolUseId: event.parentToolUseId }),
          },
        ];
      }
      const last = items[items.length - 1];
      const previous = last?.kind === 'text' ? last : undefined;
      if (
        previous !== undefined &&
        previous.closed !== true &&
        previous.blockIndex === event.blockIndex &&
        previous.parentToolUseId === event.parentToolUseId
      ) {
        return items.with(-1, { ...previous, text: previous.text + event.text });
      }
      return [
        ...items,
        {
          kind: 'text',
          text: event.text,
          ...(event.blockIndex === undefined ? {} : { blockIndex: event.blockIndex }),
          ...(event.sdkUuid === undefined ? {} : { sdkUuid: event.sdkUuid }),
          ...(event.parentToolUseId === undefined
            ? {}
            : { parentToolUseId: event.parentToolUseId }),
        },
      ];
    }
    case 'assistant_text': {
      const index =
        streamBlockId === undefined
          ? (() => {
              const last = items[items.length - 1];
              return last?.kind === 'text' &&
                last.closed !== true &&
                last.blockIndex === event.blockIndex &&
                last.parentToolUseId === event.parentToolUseId
                ? items.length - 1
                : -1;
            })()
          : findStreamBlock(items, streamBlockId, event.parentToolUseId);
      if (index >= 0) {
        const previous = items[index];
        if (previous?.kind === 'text') {
          return items.with(index, {
            ...previous,
            ...textItem(event, event.text, streamBlockId),
          });
        }
      }
      return [...items, textItem(event, event.text, streamBlockId)];
    }
    case 'assistant_block_start': {
      if (streamBlockId !== undefined) return items;
      const last = items[items.length - 1];
      if (last?.kind !== 'text' || last.blockIndex !== event.blockIndex) return items;
      return items.with(-1, { ...last, closed: true });
    }
    case 'assistant_block_stop':
      return items;
    case 'tool_start':
      return [
        ...items,
        {
          kind: 'tool',
          toolUseId: event.toolUseId,
          name: event.name,
          startedAt: Date.now(),
          ...(event.parentToolUseId === undefined
            ? {}
            : { parentToolUseId: event.parentToolUseId }),
        },
      ];
    case 'tool_input':
      return items.map((item) =>
        item.kind === 'tool' && item.toolUseId === event.toolUseId
          ? { ...item, input: event.json }
          : item,
      );
    case 'tool_result': {
      const seq =
        event.todos === undefined ? {} : { todos: event.todos, todoSeq: highestTodoSeq(items) + 1 };
      return items.map((item) =>
        item.kind === 'tool' && item.toolUseId === event.toolUseId
          ? {
              ...item,
              result: event.content,
              endedAt: Date.now(),
              ...seq,
            }
          : item,
      );
    }
    case 'replay_truncated': {
      if (items.slice(runStart(items)).some(isReplayNotice)) return items;
      return [...items, { kind: 'notice', tone: 'muted', text: replayNoticeText(event.reason) }];
    }
    case 'run_finished':
      return items.map((item) =>
        item.kind === 'tool' && item.result === undefined && item.endedAt === undefined
          ? { ...item, endedAt: Date.now() }
          : item,
      );
    case 'run_warning':
      return [...items, { kind: 'notice', tone: 'warning', text: event.message }];
    case 'error':
      // 流可能仍然活着：只记录，不当作终态。
      return [...items, { kind: 'notice', tone: 'error', text: event.message }];
    case 'run_unavailable':
      // 记录已被清理，服务端不会再补事件；已收到的部分输出比一句空话更有用。
      return [...items, { kind: 'notice', tone: 'error', text: event.message }];
    case 'run_started': {
      // 同一 run 的基础设施重试会复用 Redis 日志并让 blockId 从 b0 重新发号：
      // 新 attempt 开始时清掉本轮旧的助手输出，整段重放最终只留最后一次 attempt。
      const start = runStart(items);
      // 没有本轮用户消息就没有可信的归属边界，不能把整段历史当成旧 attempt 清掉。
      if (start === 0) return items;
      // 截断提示通常先于 run_started 到达；保留一条，其余旧输出交给本次重放覆盖。
      const notice = items.slice(start).findLast(isReplayNotice);
      return notice === undefined ? items.slice(0, start) : [...items.slice(0, start), notice];
    }
    default:
      return items;
  }
}

function blockText(block: unknown): string | null {
  if (typeof block === 'string') return block;
  if (typeof block !== 'object' || block === null) return null;
  const record = block as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  return null;
}

function historyTodos(record: Record<string, unknown>): { todos?: ProgressTodo[] } {
  if (record.todos === undefined) return {};
  const parsed = progressTodoSchema.array().safeParse(record.todos);
  return parsed.success ? { todos: parsed.data } : {};
}

export function questionFromContent(content: unknown): PublicRunQuestion | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const parsed = publicRunQuestionSchema.safeParse((content as Record<string, unknown>).question);
  return parsed.success ? parsed.data : undefined;
}

export function attachmentDownloadUrl(conversationId: string, attachmentId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/download`;
}

function historyAttachments(
  content: unknown,
  conversationId: string | undefined,
): UserAttachment[] {
  return messageAttachments(content).map(({ id, filename, mimeType, size }) => ({
    id,
    filename,
    mimeType,
    size,
    ...(conversationId ? { downloadUrl: attachmentDownloadUrl(conversationId, id) } : {}),
  }));
}

export function historyToItems(messages: ConversationMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolIndex = new Map<string, number>();
  let todoSeq = 0;
  for (const message of messages) {
    const { content, role } = message;

    if (role === 'user') {
      const anchor = message.conversationId ? { messageId: message.id } : {};
      const run = message.runId ? { runId: message.runId } : {};
      const text = blockText(content);
      const attachments = historyAttachments(content, message.conversationId);
      const extra = attachments.length > 0 ? { attachments } : {};
      if (text !== null) {
        items.push({ id: `${message.id}:0`, kind: 'user', text, ...run, ...extra, ...anchor });
        continue;
      }
      if (Array.isArray(content)) {
        const joined = content
          .map(blockText)
          .filter((part): part is string => part !== null)
          .join('\n');
        if (joined || attachments.length > 0) {
          items.push({
            id: `${message.id}:0`,
            kind: 'user',
            text: joined,
            ...run,
            ...extra,
            ...anchor,
          });
        }
      }
      continue;
    }

    const blocks = Array.isArray(content) ? content : [content];
    const run = message.runId ? { runId: message.runId } : {};
    const anchor =
      message.conversationId && message.uiFormat === 'openui' ? { messageId: message.id } : {};
    for (const [blockIndex, block] of blocks.entries()) {
      const id = `${message.id}:${blockIndex}`;
      const text = blockText(block);
      if (text !== null) {
        const record = typeof block === 'object' && block !== null ? block : {};
        const extra = record as Record<string, unknown>;
        items.push({
          id,
          kind: 'text',
          text,
          ...run,
          ...anchor,
          ...(typeof extra.blockIndex === 'number' ? { blockIndex: extra.blockIndex } : {}),
          ...(typeof extra.parentToolUseId === 'string'
            ? { parentToolUseId: extra.parentToolUseId }
            : {}),
          ...(extra.truncated === true ? { truncated: true } : {}),
          ...(message.uiFormat ? { uiFormat: message.uiFormat } : {}),
          ...(typeof message.uiProgram === 'string' ? { uiProgram: message.uiProgram } : {}),
          ...(message.uiState == null ? {} : { uiState: message.uiState }),
        });
        continue;
      }
      if (typeof block !== 'object' || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'tool_use' && (typeof record.name === 'string' || record.id)) {
        const question = questionFromContent(record);
        const toolUseId =
          typeof record.id === 'string'
            ? record.id
            : typeof record.toolUseId === 'string'
              ? record.toolUseId
              : crypto.randomUUID();
        if (!toolIndex.has(toolUseId)) toolIndex.set(toolUseId, items.length);
        items.push({
          id,
          kind: 'tool',
          toolUseId,
          name: typeof record.name === 'string' ? record.name : '未知工具',
          input: JSON.stringify(record.input ?? {}, null, 2),
          ...(question === undefined ? {} : { question }),
          ...run,
          ...(typeof record.parentToolUseId === 'string'
            ? { parentToolUseId: record.parentToolUseId }
            : {}),
        });
      } else if (record.type === 'tool_result') {
        // worker 落库用 toolUseId，SDK 原始块用 tool_use_id；两种都要认。
        const toolUseId =
          typeof record.toolUseId === 'string'
            ? record.toolUseId
            : typeof record.tool_use_id === 'string'
              ? record.tool_use_id
              : '';
        const result = blockText(record.content) ?? '';
        const todos = historyTodos(record);
        let seq: { todoSeq?: number } = {};
        if (todos.todos !== undefined) {
          todoSeq += 1;
          seq = { todoSeq };
        }
        const parent =
          typeof record.parentToolUseId === 'string'
            ? { parentToolUseId: record.parentToolUseId }
            : {};
        const question = questionFromContent(record);
        const snapshot = question === undefined ? {} : { question };
        const index = toolIndex.get(toolUseId);
        const existing = index === undefined ? undefined : items[index];
        if (index !== undefined && existing?.kind === 'tool') {
          items[index] = {
            ...existing,
            result,
            ...todos,
            ...seq,
            ...parent,
            ...snapshot,
            resultMessageId: message.id,
          };
        } else {
          items.push({
            id,
            kind: 'tool',
            toolUseId,
            name: '未知工具',
            result,
            ...todos,
            ...seq,
            ...parent,
            ...snapshot,
          });
          if (!toolIndex.has(toolUseId)) toolIndex.set(toolUseId, items.length - 1);
        }
      }
    }
  }
  return items;
}

export function latestTopLevelTodos(items: ChatItem[]): ProgressTodo[] | undefined {
  let latest: Extract<ChatItem, { kind: 'tool' }> | undefined;
  for (const item of items) {
    if (item.kind !== 'tool' || item.parentToolUseId !== undefined || item.todos === undefined)
      continue;
    if (latest === undefined || (item.todoSeq ?? 0) >= (latest.todoSeq ?? 0)) latest = item;
  }
  return latest === undefined || latest.todos === undefined || latest.todos.length === 0
    ? undefined
    : latest.todos;
}

function highestTodoSeq(items: ChatItem[]): number {
  let highest = 0;
  for (const item of items) {
    if (item.kind === 'tool' && item.todoSeq !== undefined && item.todoSeq > highest) {
      highest = item.todoSeq;
    }
  }
  return highest;
}

export interface HistorySnapshot {
  conversationId: string;
  boundaryId: string | null;
  messages: ConversationMessage[];
  count: number;
}

export function snapshotHistory(data: ConversationDetail, items: ChatItem[]): HistorySnapshot {
  return {
    conversationId: data.conversation.id,
    boundaryId: data.messages.at(-1)?.id ?? null,
    messages: data.messages,
    count: items.length,
  };
}

function beforeBoundary(message: ConversationMessage, boundary: ConversationMessage): boolean {
  if (message.createdAt !== boundary.createdAt) {
    return message.createdAt < boundary.createdAt;
  }
  return message.id <= boundary.id;
}

export function mergeOlderHistory(
  snapshot: HistorySnapshot,
  data: ConversationDetail,
  items: ChatItem[],
): { items: ChatItem[]; snapshot: HistorySnapshot } | null {
  if (snapshot.conversationId !== data.conversation.id) return null;
  if (snapshot.boundaryId === null || snapshot.count > items.length) return null;
  const boundary = snapshot.messages.findLast((message) => message.id === snapshot.boundaryId);
  if (!boundary) return null;

  const messages = new Map(snapshot.messages.map((message) => [message.id, message]));
  let added = false;
  for (const message of data.messages) {
    if (messages.has(message.id) || !beforeBoundary(message, boundary)) continue;
    messages.set(message.id, message);
    added = true;
  }
  if (!added) return null;

  const ordered = [...messages.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const history = historyToItems(ordered);
  return {
    items: [...history, ...items.slice(snapshot.count)],
    snapshot: { ...snapshot, messages: ordered, count: history.length },
  };
}

export function titleFromDetail(detail: ConversationDetail): string {
  const firstUser = detail.messages.find((message) => message.role === 'user');
  return (detail.conversation.title || blockText(firstUser?.content) || '未命名会话').slice(0, 80);
}
