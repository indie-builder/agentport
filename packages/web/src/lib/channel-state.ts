import type { ChannelMessage } from '@agentport/shared';
import type { ChatItem } from './chat-state.js';

/**
 * 按 seq 排序合并并去重。服务端回包与 SSE 会送同一条消息，
 * 乐观项按 `clientMessageId` 被真实消息替换，不能只按 id 去重。
 */
export function mergeChannelMessages(
  existing: readonly ChannelMessage[],
  incoming: readonly ChannelMessage[],
): ChannelMessage[] {
  const byKey = new Map<string, ChannelMessage>();
  for (const message of [...existing, ...incoming]) {
    byKey.set(message.clientMessageId ?? message.id, message);
  }
  return [...byKey.values()].sort(
    (a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt),
  );
}

/** 光标前正在输入的 @ 片段；@ 前必须是空白，避免把邮箱当提及。 */
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(before[start - 1] ?? '')) return null;
  const query = before.slice(start + 1);
  if (/\s/.test(query)) return null;
  return { start, query };
}

/** 用选中的智能体替换光标前的 @ 片段，并把光标放到插入文本之后。 */
export function applyMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const token = mentionQueryAt(text, caret);
  if (token === null) return { text, caret };
  const inserted = `@${name} `;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(caret),
    caret: token.start + inserted.length,
  };
}

/** 文本里已删掉的 @ 名称不再作为 mentions 发送，避免误唤醒智能体。 */
export function pruneMentions(
  text: string,
  selected: readonly { agentId: string; name: string }[],
): string[] {
  return selected.filter((item) => text.includes(`@${item.name}`)).map((item) => item.agentId);
}

/**
 * 可见性按轮上报，而时间线把「用户消息」与随后连续的非用户回复各归一轮；
 * 一轮可见即整轮算读到，返回其中已落库消息的最大 seq。
 */
export function visibleReadSeq(
  items: readonly ChatItem[],
  visibleIds: readonly string[],
  seqById: ReadonlyMap<string, number>,
): number {
  const visible = new Set(visibleIds);
  let max = 0;
  let turnVisible = false;
  let previousUser = false;
  let started = false;
  for (const item of items) {
    if (!started || item.kind === 'user' || previousUser) {
      turnVisible = item.id !== undefined && visible.has(item.id);
      started = true;
    }
    previousUser = item.kind === 'user';
    const seq = turnVisible && item.id !== undefined ? seqById.get(item.id) : undefined;
    if (seq !== undefined && seq > max) max = seq;
  }
  return max;
}
