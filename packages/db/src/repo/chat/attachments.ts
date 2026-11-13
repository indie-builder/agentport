import { type MessageAttachment, messageAttachments } from '@agentport/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { messages } from '../../schema.js';

/**
 * 下载入口的唯一成员校验：附件 id 必须被本会话的某条消息引用。
 * JSONB containment 先缩小到候选行，再用共享 schema 校验出精确元数据。
 */
export async function findConversationAttachment(
  db: Database,
  conversationId: string,
  attachmentId: string,
): Promise<MessageAttachment | null> {
  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        sql`${messages.content}->'attachments' @> ${JSON.stringify([{ id: attachmentId }])}::jsonb`,
      ),
    )
    .limit(1);
  return (
    messageAttachments(rows[0]?.content).find((attachment) => attachment.id === attachmentId) ??
    null
  );
}

/** 分支复制用：一批来源消息实际引用的附件 id，去重后保持首次出现顺序。 */
export async function attachmentIdsForMessages(
  db: Database,
  messageIds: string[],
): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(inArray(messages.id, messageIds));
  return [...new Set(rows.flatMap((row) => messageAttachments(row.content).map(({ id }) => id)))];
}
