import {
  type ChatEvent,
  type ConversationMessage,
  messageAttachments,
  type ProgressTodo,
  type PublicRunQuestion,
  progressTodoSchema,
  publicRunQuestionSchema,
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
  | { id?: string; kind: 'notice'; text: string; tone: 'ok' | 'error' | 'muted' };

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

/** shared 事件类型加上 worker 补发的运行内块身份；shared 定稿前先按存在性读取。 */
function streamBlockIdOf(event: ChatEvent): string | undefined {
  if (!('streamBlockId' in event)) return undefined;
  return typeof event.streamBlockId === 'string' ? event.streamBlockId : undefined;
}

/**
 * 本轮的起点：最后一条用户消息之后。streamBlockId 只在一次运行内唯一，
 * 跨运行会从 b0 重新发号，查找必须限制在本轮，不能并进上一轮的同号段。
 */
function runStart(items: ChatItem[]): number {
  return items.findLastIndex((item) => item.kind === 'user') + 1;
}

/** 按稳定块身份找本轮已有的文本段；interleaved 的父子文本也会命中中间的段。 */
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
    // 完整块本身即段尾：后续异常 delta 不能重开这一段。
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
          // 完整块已封口这一段：之后迟到的 delta 不能再改文本。
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
        // 仍是 O(n) 复制（store 必须有新数组身份），但 with() 省掉 slice 的中间数组；
        // 500 项实测 0.18µs/次，相对一次 React 提交可忽略。
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
    /**
     * 完整块是落库内容，也是最终文本：替换增量拼出的文本（截断时更短，并带可见提示）。
     * 没有对应增量段时直接追加——只有完整块的子智能体文本以前完全看不见。
     */
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
    // 块边界只解释流的结构：不同块本就不合并，边界事件负责封口被重用的块身份。
    case 'assistant_block_start': {
      // 没有 streamBlockId 的旧事件只能按块序号封口；有稳定身份时新 delta 自带新身份，无需封口。
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
      // 确认顺序按结果到达编号：tool_start 的位置只决定 trace，早开始的调用可能晚确认。
      const seq =
        event.todos === undefined ? {} : { todos: event.todos, todoSeq: highestTodoSeq(items) + 1 };
      return items.map((item) =>
        item.kind === 'tool' && item.toolUseId === event.toolUseId
          ? {
              ...item,
              result: event.content,
              endedAt: Date.now(),
              // 省略表示不改清单；空数组表示清空，出现时整体替换。
              ...seq,
            }
          : item,
      );
    }
    case 'replay_truncated':
      // 只是说明回放不完整；run_finished 后再用服务端已保存的步骤补全。
      return [
        ...items,
        {
          kind: 'notice',
          tone: 'muted',
          text:
            event.reason === 'terminal_missing'
              ? '结束事件未收到，正在读取已保存结果。'
              : '较早事件已截断，运行结束后将读取已保存结果。',
        },
      ];
    case 'run_finished':
      return items.map((item) =>
        item.kind === 'tool' && item.result === undefined && item.endedAt === undefined
          ? { ...item, endedAt: Date.now() }
          : item,
      );
    case 'error':
      // 流可能仍然活着：只记录，不当作终态。
      return [...items, { kind: 'notice', tone: 'error', text: event.message }];
    case 'run_unavailable':
      // 记录已被清理，服务端不会再补事件；已收到的部分输出比一句空话更有用。
      return [...items, { kind: 'notice', tone: 'error', text: event.message }];
    case 'run_started':
      return items;
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

/**
 * 入库内容来自数据库，是未校验的 unknown：这里按 shared schema 收窄一次。
 * 非法快照直接当作没有，不能让整段历史渲染失败。
 */
function historyTodos(record: Record<string, unknown>): { todos?: ProgressTodo[] } {
  if (record.todos === undefined) return {};
  const parsed = progressTodoSchema.array().safeParse(record.todos);
  return parsed.success ? { todos: parsed.data } : {};
}

/**
 * 工具历史 content 上的原生提问快照（worker 在 use/result 里都写入）。
 * DB 内容是未校验的 unknown，按 shared 契约收窄；非法快照当作没有。
 */
export function questionFromContent(content: unknown): PublicRunQuestion | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const parsed = publicRunQuestionSchema.safeParse((content as Record<string, unknown>).question);
  return parsed.success ? parsed.data : undefined;
}

/** 附件下载地址只由会话与附件 id 决定；历史消息与刚发送的消息共用。 */
export function attachmentDownloadUrl(conversationId: string, attachmentId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}/download`;
}

/** 历史用户消息的附件；损坏数据由 shared 契约整体丢弃，不拖垮整段历史。 */
function historyAttachments(
  content: unknown,
  conversationId: string | undefined,
): UserAttachment[] {
  return messageAttachments(content).map(({ id, filename, mimeType, size }) => ({
    id,
    filename,
    mimeType,
    size,
    // 只有落库消息才有真实会话与附件 id；运行详情重建的合成 id 不能拼下载地址。
    ...(conversationId ? { downloadUrl: attachmentDownloadUrl(conversationId, id) } : {}),
  }));
}

/** DB 里存的是 SDK 原始内容块；历史渲染只挑可读部分，工具调用按 tool_use_id 合并结果。 */
export function historyToItems(messages: ConversationMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  // 历史按消息与块顺序重放：tool_result 出现的次序就是确认次序，与工具行位置无关。
  let todoSeq = 0;
  for (const message of messages) {
    const { content, role } = message;

    if (role === 'user') {
      // 运行详情重建的步骤没有真实 conversationId，id 是合成的，不能作为分支锚点。
      const anchor = message.conversationId ? { messageId: message.id } : {};
      const text = blockText(content);
      const attachments = historyAttachments(content, message.conversationId);
      const extra = attachments.length > 0 ? { attachments } : {};
      if (text !== null) {
        items.push({ id: `${message.id}:0`, kind: 'user', text, ...extra, ...anchor });
        continue;
      }
      if (Array.isArray(content)) {
        const joined = content
          .map(blockText)
          .filter((part): part is string => part !== null)
          .join('\n');
        if (joined || attachments.length > 0) {
          items.push({ id: `${message.id}:0`, kind: 'user', text: joined, ...extra, ...anchor });
        }
      }
      continue;
    }

    const blocks = Array.isArray(content) ? content : [content];
    // 回复上挂着产生它的 run；渲染时据此给这一轮补读数行。
    const run = message.runId ? { runId: message.runId } : {};
    // 运行步骤重建的步骤没有真实 conversationId，id 是合成的，不能当动作来源；
    // 只有 UI 消息需要显式 messageId（动作与状态归属），纯文本历史仍用块 id。
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
          // 落库时保留了块身份；按块重建时原样带回，子智能体文本与截断标记不丢。
          ...(typeof extra.blockIndex === 'number' ? { blockIndex: extra.blockIndex } : {}),
          ...(typeof extra.parentToolUseId === 'string'
            ? { parentToolUseId: extra.parentToolUseId }
            : {}),
          ...(extra.truncated === true ? { truncated: true } : {}),
          // 消息级格式快照：有没有这三个字段决定历史怎么渲染，缺省沿用智能体设置。
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
        items.push({
          id,
          kind: 'tool',
          toolUseId:
            typeof record.id === 'string'
              ? record.id
              : typeof record.toolUseId === 'string'
                ? record.toolUseId
                : crypto.randomUUID(),
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
        // 有快照的结果才占一个确认序号；补更早的 tool_use 不参与编号，因此跨页结论不变。
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
        const index = items.findIndex(
          (item) => item.kind === 'tool' && item.toolUseId === toolUseId,
        );
        const existing = items[index];
        if (existing?.kind === 'tool') {
          items[index] = { ...existing, result, ...todos, ...seq, ...parent, ...snapshot };
        } else {
          // 找不到 tool_use 时也保留归属：否则子智能体卡片会被当成顶层调用。
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
        }
      }
    }
  }
  return items;
}

/**
 * 一轮里最后确认的顶层工具清单快照。顺序按 tool_result 确认编号（todoSeq），
 * 不按数组位置：早开始的调用可能晚确认，补更早的 tool_use 也不会改变结论。
 * 子智能体的调用（parentToolUseId）不能覆盖主清单；空快照表示已清空，更早的非空快照不再显示。
 */
export function latestTopLevelTodos(items: ChatItem[]): ProgressTodo[] | undefined {
  let latest: Extract<ChatItem, { kind: 'tool' }> | undefined;
  for (const item of items) {
    if (item.kind !== 'tool' || item.parentToolUseId !== undefined || item.todos === undefined)
      continue;
    // 没有编号的旧数据退回数组位置。
    if (latest === undefined || (item.todoSeq ?? 0) >= (latest.todoSeq ?? 0)) latest = item;
  }
  return latest === undefined || latest.todos === undefined || latest.todos.length === 0
    ? undefined
    : latest.todos;
}

/** 已确认快照的最大编号；下一条结果取它 +1，重放或重试时编号仍保持单调。 */
function highestTodoSeq(items: ChatItem[]): number {
  let highest = 0;
  for (const item of items) {
    if (item.kind === 'tool' && item.todoSeq !== undefined && item.todoSeq > highest) {
      highest = item.todoSeq;
    }
  }
  return highest;
}

/* ---------- 分页历史：已加载前缀 + 本轮流式尾部 ---------- */

export interface HistorySnapshot {
  conversationId: string;
  /** 首次回填时最后一条消息的 id：分页只会在它之前补，尾部不会重复。 */
  boundaryId: string | null;
  /** 已加载历史中不晚于边界的原始消息，用于跨页合并与顺序判定。 */
  messages: ConversationMessage[];
  /** 前缀解析出的条数；其后都是本轮流式追加的尾部。 */
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

/** 保留已加载的原始历史，避免最新页窗口前移时丢失旧消息；流式尾部独立保留。 */
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

/* ---------- 会话标题 ---------- */

export function titleFromDetail(detail: ConversationDetail): string {
  const firstUser = detail.messages.find((message) => message.role === 'user');
  return (detail.conversation.title || blockText(firstUser?.content) || '未命名会话').slice(0, 80);
}
