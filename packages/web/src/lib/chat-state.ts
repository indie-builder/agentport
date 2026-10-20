import type { ChatEvent, ConversationMessage } from '@agentport/shared';
import type { Conversation, ConversationDetail } from './api.js';

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      input?: string;
      result?: string;
      /** 子智能体内部的调用：父侧 Agent 的 tool_use id。 */
      parentToolUseId?: string;
    }
  | { kind: 'notice'; text: string; tone: 'ok' | 'error' | 'muted' };

export function applyEvent(items: ChatItem[], event: ChatEvent): ChatItem[] {
  switch (event.type) {
    case 'text_delta': {
      const last = items[items.length - 1];
      if (last?.kind === 'text') {
        return [...items.slice(0, -1), { kind: 'text', text: last.text + event.text }];
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
          ? { ...item, result: event.content }
          : item,
      );
    case 'run_finished': {
      const parts: string[] = [];
      if (event.turns !== undefined) parts.push(`${event.turns} 轮`);
      if (event.costUsd !== undefined) parts.push(`$${event.costUsd.toFixed(4)}`);
      if (event.error) parts.push(event.error);
      const text =
        event.status === 'succeeded'
          ? ['运行完成', ...parts].join(' · ')
          : event.status === 'cancelled'
            ? '已停止'
            : [`运行${event.status === 'timeout' ? '超时' : '失败'}`, ...parts].join(' · ');
      return [
        ...items,
        {
          kind: 'notice',
          tone:
            event.status === 'succeeded' ? 'ok' : event.status === 'cancelled' ? 'muted' : 'error',
          text,
        },
      ];
    }
    case 'error':
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
        items.push({ kind: 'user', text });
        continue;
      }
      if (Array.isArray(content)) {
        const joined = content
          .map(blockText)
          .filter((part): part is string => part !== null)
          .join('\n');
        if (joined) items.push({ kind: 'user', text: joined });
      }
      continue;
    }

    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      const text = blockText(block);
      if (text !== null) {
        items.push({ kind: 'text', text });
        continue;
      }
      if (typeof block !== 'object' || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'tool_use' && typeof record.name === 'string') {
        items.push({
          kind: 'tool',
          toolUseId: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
          name: record.name,
          input: JSON.stringify(record.input ?? {}, null, 2),
        });
      } else if (record.type === 'tool_result') {
        const id = typeof record.tool_use_id === 'string' ? record.tool_use_id : '';
        const result = blockText(record.content) ?? '';
        const parent =
          typeof record.parentToolUseId === 'string'
            ? { parentToolUseId: record.parentToolUseId }
            : {};
        const index = items.findIndex((item) => item.kind === 'tool' && item.toolUseId === id);
        const existing = items[index];
        if (existing?.kind === 'tool') {
          items[index] = { ...existing, result, ...parent };
        } else {
          // 找不到 tool_use 时也保留归属：否则子智能体卡片会被当成顶层调用。
          items.push({ kind: 'tool', toolUseId: id, name: '未知工具', result, ...parent });
        }
      }
    }
  }
  return items;
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
