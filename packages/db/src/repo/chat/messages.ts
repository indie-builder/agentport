import { fail } from '@agentport/core';
import type { ExecutionSubject } from '@agentport/shared';
import { and, asc, desc, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import { conversations, messages } from '../../schema.js';
import { type Conversation, getConversation } from './conversations.js';
import { conversationSubject } from './shared.js';

export type Message = typeof messages.$inferSelect;

export interface ListMessagesOptions {
  /** 只取最新 N 条（按 created_at, id 倒序取，仍按正序返回）。 */
  limit?: number;
  /** 游标：只取这条消息之前的历史，配合 limit 做向前分页。 */
  before?: string;
}

/**
 * 不传 limit 时返回整段历史（branch 需要全部消息复制）；
 * 传 limit 时只取最新 N 条，避免把 tool 消息的大 jsonb 全量带给页面。
 */
export async function listMessages(
  db: DbHandle,
  conversationId: string,
  options: ListMessagesOptions = {},
): Promise<Message[]> {
  const filters: SQL[] = [eq(messages.conversationId, conversationId)];
  if (options.before !== undefined) {
    // 行值比较正好命中 (conversation_id, created_at, id) 索引；游标也限定在本会话。
    filters.push(sql`(${messages.createdAt}, ${messages.id}) < (
      select b.created_at, b.id from ${messages} b
      where b.id = ${options.before} and b.conversation_id = ${conversationId}
    )`);
  }
  const query = db
    .select()
    .from(messages)
    .where(and(...filters));
  if (options.limit === undefined) {
    return query.orderBy(asc(messages.createdAt), asc(messages.id));
  }
  const rows = await query
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(options.limit);
  return rows.reverse();
}

/** 分页游标必须属于本会话；否则行值比较会静默取整段历史。 */
export async function messageInConversation(
  db: Database,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .limit(1);
  return rows.length > 0;
}

const INSERT_CHUNK = 500;

export type MessageInsert = typeof messages.$inferInsert;

/** 一个 run 的消息逐行 insert 会有上千次往返；按 500 行一条语句批量写。 */
export async function insertMessages(db: DbHandle, rows: MessageInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(messages).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

/** 消息正文只在 content.text 里；tool 消息没有该字段。 */
export function messageText(content: unknown): string | null {
  if (typeof content !== 'object' || content === null || !('text' in content)) return null;
  return typeof content.text === 'string' ? content.text : null;
}

/** 分支首轮需要重映射的页面消息 uuid（该会话已保存、且有 SDK uuid 的那些）。 */
export async function listConversationMessageUuids(
  db: DbHandle,
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ uuid: messages.sdkMessageUuid })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNotNull(messages.sdkMessageUuid)));
  return rows.flatMap((row) => (row.uuid === null ? [] : [row.uuid]));
}

/**
 * 从原会话复制消息到新会话，并把新会话指向来源 SDK 会话与分叉点：
 * 首次运行时先 fork 到该点，再继续对话。fromMessageId 为空时复制全部；
 * 原会话、分支点或 SDK 会话缺失时抛业务错误（没有文本历史回退）。
 */
export async function branchConversation(
  db: Database,
  input: {
    id: string;
    conversationId: string;
    fromMessageId?: string;
    title?: string;
    subject: ExecutionSubject;
  },
): Promise<{
  conversation: Conversation;
  copied: number;
  /** 来源消息 id → 分支新消息 id；调用方据此复制历史边界内的文件快照。 */
  messageIds: Record<string, string>;
} | null> {
  return db.transaction(async (tx) => {
    const source = await getConversation(tx, input.conversationId);
    if (!source) return null;

    // 按 (createdAt, id) 排序后截断，与 listMessages 一致。
    const rows = await listMessages(tx, source.id);
    let cutoffIndex = rows.length - 1;
    if (input.fromMessageId !== undefined) {
      cutoffIndex = rows.findIndex((row) => row.id === input.fromMessageId);
      if (cutoffIndex < 0) return null;
    }
    const copy = rows.slice(0, cutoffIndex + 1);
    const forkPoint = copy.at(-1)?.sdkMessageUuid ?? null;
    // 非空历史必须能对应到 SDK transcript：否则只能拼文本，而平台已不保留该路径。
    if (copy.length > 0 && source.sdkSessionId === null) {
      fail('CONFLICT', '该会话还没有可用的 SDK 会话记录，无法按历史点分支；请重新对话后再试');
    }
    if (copy.length > 0 && !copy.every((row) => row.sdkMessageUuid !== null)) {
      // 旧版本会话的消息永远拿不到 uuid；不要把「等运行完成」当成可解决的问题。
      fail(
        'CONFLICT',
        '该会话的历史消息没有 SDK 会话记录（来自旧版本或 SDK 会话已丢失），无法按历史点分支',
      );
    }

    const [conversation] = await tx
      .insert(conversations)
      .values({
        id: input.id,
        agentId: source.agentId,
        title: input.title ?? source.title,
        parentId: source.id,
        branchOfMessageId: copy.at(-1)?.id ?? null,
        // 分叉前仍指向来源会话；首轮运行 fork 成功后改写为新 session。
        sdkSessionId: source.sdkSessionId,
        forkFromSdkMessageUuid: forkPoint,
        ...conversationSubject(input.subject),
      })
      .returning();
    if (!conversation) throw new Error('conversation insert returned no row');

    const messageIds: Record<string, string> = {};
    if (copy.length > 0) {
      const copies = copy.map((row) => {
        const id = newId('message');
        messageIds[row.id] = id;
        return {
          id,
          conversationId: conversation.id,
          role: row.role,
          senderBusinessId: row.senderBusinessId,
          content: row.content,
          runId: null,
          // 复制的是来源会话的 uuid；fork 后由运行收尾统一重映射到新 session。
          sdkMessageUuid: row.sdkMessageUuid,
          // 生成式 UI 的渲染快照必须跟着走：否则分支里的界面会退回围栏源码、表单状态全丢。
          uiFormat: row.uiFormat,
          uiProgram: row.uiProgram,
          uiState: row.uiState,
          createdAt: row.createdAt,
        };
      });
      await insertMessages(tx, copies);
    }

    return { conversation, copied: copy.length, messageIds };
  });
}

export async function appendMessage(
  db: DbHandle,
  input: {
    id: string;
    conversationId: string;
    role: string;
    content: unknown;
    /** 自然人消息的业务身份；assistant/tool/服务输入为 null。 */
    senderBusinessId?: string | null;
    runId?: string;
    sdkMessageUuid?: string;
    /** 频道触发时关联的频道消息。 */
    channelMessageId?: string;
  },
): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      senderBusinessId: input.senderBusinessId ?? null,
      content: input.content,
      runId: input.runId ?? null,
      channelMessageId: input.channelMessageId ?? null,
      ...(input.sdkMessageUuid === undefined ? {} : { sdkMessageUuid: input.sdkMessageUuid }),
    })
    .returning();
  if (!row) throw new Error('message insert returned no row');
  return row;
}
