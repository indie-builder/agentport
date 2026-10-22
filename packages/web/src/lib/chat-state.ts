import type { ChatEvent, ConversationMessage } from '@agentport/shared';
import type { Conversation, ConversationDetail } from './api.js';

export type ChatItem =
  | { id?: string; kind: 'user'; text: string }
  | { id?: string; kind: 'text'; text: string }
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

export function applyEvent(items: ChatItem[], event: ChatEvent): ChatItem[] {
  switch (event.type) {
    case 'text_delta': {
      const last = items[items.length - 1];
      if (last?.kind === 'text') {
        // 仍是 O(n) 复制（store 必须有新数组身份），但 with() 省掉 slice 的中间数组；
        // 500 项实测 0.18µs/次，相对一次 React 提交可忽略。
        return items.with(-1, { kind: 'text', text: last.text + event.text });
      }
      return [...items, { kind: 'text', text: event.text }];
    }
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
    case 'tool_result':
      return items.map((item) =>
        item.kind === 'tool' && item.toolUseId === event.toolUseId
          ? { ...item, result: event.content, endedAt: Date.now() }
          : item,
      );
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
      // 终态由页面渲染成答案下方的一行读数，不再追加一条 notice。
      return items;
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

/** DB 里存的是 SDK 原始内容块；历史渲染只挑可读部分，工具调用按 tool_use_id 合并结果。 */
export function historyToItems(messages: ConversationMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    const { content, role } = message;

    if (role === 'user') {
      const text = blockText(content);
      if (text !== null) {
        items.push({ id: `${message.id}:0`, kind: 'user', text });
        continue;
      }
      if (Array.isArray(content)) {
        const joined = content
          .map(blockText)
          .filter((part): part is string => part !== null)
          .join('\n');
        if (joined) items.push({ id: `${message.id}:0`, kind: 'user', text: joined });
      }
      continue;
    }

    const blocks = Array.isArray(content) ? content : [content];
    for (const [blockIndex, block] of blocks.entries()) {
      const id = `${message.id}:${blockIndex}`;
      const text = blockText(block);
      if (text !== null) {
        items.push({ id, kind: 'text', text });
        continue;
      }
      if (typeof block !== 'object' || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'tool_use' && (typeof record.name === 'string' || record.id)) {
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
        const parent =
          typeof record.parentToolUseId === 'string'
            ? { parentToolUseId: record.parentToolUseId }
            : {};
        const index = items.findIndex(
          (item) => item.kind === 'tool' && item.toolUseId === toolUseId,
        );
        const existing = items[index];
        if (existing?.kind === 'tool') {
          items[index] = { ...existing, result, ...parent };
        } else {
          // 找不到 tool_use 时也保留归属：否则子智能体卡片会被当成顶层调用。
          items.push({
            id,
            kind: 'tool',
            toolUseId,
            name: '未知工具',
            result,
            ...parent,
          });
        }
      }
    }
  }
  return items;
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

/* ---------- 本地会话索引：历史列表接口上线前的兜底 ---------- */

const STORE_KEY = 'agentport:conversations';

export interface LocalConversation {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export function loadLocalConversations(): LocalConversation[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LocalConversation => {
      if (typeof item !== 'object' || item === null) return false;
      const record = item as Record<string, unknown>;
      return (
        typeof record.id === 'string' &&
        typeof record.agentId === 'string' &&
        typeof record.title === 'string' &&
        typeof record.createdAt === 'string' &&
        typeof record.updatedAt === 'string'
      );
    });
  } catch {
    return [];
  }
}

export function upsertLocalConversation(conversation: LocalConversation): void {
  const next = [conversation, ...loadLocalConversations().filter((c) => c.id !== conversation.id)];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next.slice(0, 100)));
  } catch {
    // 隐私模式或配额已满：历史索引只是便利功能，不阻断对话。
  }
}

export function localConversation(
  conversation: Pick<Conversation, 'id' | 'agentId' | 'title' | 'createdAt'>,
  title: string,
): LocalConversation {
  return {
    id: conversation.id,
    agentId: conversation.agentId,
    title: title.trim() || conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export function titleFromDetail(detail: ConversationDetail): string {
  const firstUser = detail.messages.find((message) => message.role === 'user');
  return (detail.conversation.title || blockText(firstUser?.content) || '未命名会话').slice(0, 80);
}
