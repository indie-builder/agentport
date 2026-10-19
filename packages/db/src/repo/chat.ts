import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, agents, conversations, messages } from '../schema.js';

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type RunStatus = NonNullable<typeof agentRuns.$inferInsert.status>;

/** 只更新我关心的字段；worker 也可复用。 */
export interface RunPatch {
  status?: RunStatus;
  sessionId?: string | null;
  sandboxId?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  error?: string | null;
  costUsd?: string | null;
  turns?: number | null;
}

// id 由调用方生成（TypeID），db 层只负责持久化。
export async function agentExists(db: Database, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows.length > 0;
}

export async function agentEnabled(db: Database, agentId: string): Promise<boolean> {
  const rows = await db
    .select({ enabled: agents.enabled })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows[0]?.enabled ?? false;
}

export async function createConversation(
  db: Database,
  input: { id: string; agentId: string; title: string },
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({ id: input.id, agentId: input.agentId, title: input.title })
    .returning();
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

export async function getConversation(
  db: Database,
  conversationId: string,
): Promise<Conversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

export async function listMessages(db: Database, conversationId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

const HISTORY_LIMIT = 20;
const HISTORY_TEXT_LIMIT = 2_000;

function messageText(content: unknown): string | null {
  if (typeof content !== 'object' || content === null || !('text' in content)) return null;
  return typeof content.text === 'string' ? content.text : null;
}

/**
 * 新 run 的上下文恢复：沙盒每次都是新容器，SDK 的 session resume 不可用，
 * 只能把最近 N 条 user/assistant 文本拼进 prompt。tool 消息体积不可控，跳过。
 */
export async function getHistoryForPrompt(
  db: Database,
  conversationId: string,
): Promise<string | null> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.role, ['user', 'assistant']),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(HISTORY_LIMIT);

  const lines = rows
    .reverse()
    .map((row) => {
      const text = messageText(row.content)?.trim();
      if (!text) return null;
      const clipped =
        text.length > HISTORY_TEXT_LIMIT ? `${text.slice(0, HISTORY_TEXT_LIMIT)}…` : text;
      return `${row.role === 'user' ? '用户' : '助手'}：${clipped}`;
    })
    .filter((line): line is string => line !== null);

  return lines.length > 0 ? lines.join('\n\n') : null;
}

/**
 * 从原会话复制消息到新会话。fromMessageId 为空时复制全部；
 * 原会话或分支点消息不存在时返回 null。
 */
export async function branchConversation(
  db: Database,
  input: { id: string; conversationId: string; fromMessageId?: string; title?: string },
): Promise<{ conversation: Conversation; copied: number } | null> {
  const source = await getConversation(db, input.conversationId);
  if (!source) return null;

  // 按 (createdAt, id) 排序后截断，与 listMessages 一致。
  const rows = await listMessages(db, source.id);
  let cutoffIndex = rows.length - 1;
  if (input.fromMessageId !== undefined) {
    cutoffIndex = rows.findIndex((row) => row.id === input.fromMessageId);
    if (cutoffIndex < 0) return null;
  }
  const copy = rows.slice(0, cutoffIndex + 1);

  const [conversation] = await db
    .insert(conversations)
    .values({
      id: input.id,
      agentId: source.agentId,
      title: input.title ?? source.title,
      parentId: source.id,
      branchOfMessageId: copy.at(-1)?.id ?? null,
    })
    .returning();
  if (!conversation) throw new Error('conversation insert returned no row');

  if (copy.length > 0) {
    await db.insert(messages).values(
      copy.map((row) => ({
        id: newId('message'),
        conversationId: conversation.id,
        role: row.role,
        content: row.content,
        runId: null,
      })),
    );
  }

  return { conversation, copied: copy.length };
}

export interface ConversationSummary {
  id: string;
  agentId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessage: { role: string; text: string; createdAt: Date } | null;
}

/** 会话列表：updatedAt 取最后一条消息时间，无消息时退回创建时间。 */
export async function listConversations(
  db: Database,
  options: { agentId?: string; limit?: number } = {},
): Promise<ConversationSummary[]> {
  const last = db
    .select({
      role: messages.role,
      // 列表不需要完整消息体；只取文本并截断，避免把大 jsonb 带进列表响应。
      text: sql<string | null>`left(${messages.content}->>'text', 280)`.as('text'),
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversations.id))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
    .as('last_message');

  const updatedAt = sql`coalesce(${last.createdAt}, ${conversations.createdAt})`;
  const rows = await db
    .select({
      id: conversations.id,
      agentId: conversations.agentId,
      title: conversations.title,
      createdAt: conversations.createdAt,
      lastRole: last.role,
      lastText: last.text,
      lastCreatedAt: last.createdAt,
    })
    .from(conversations)
    .leftJoinLateral(last, sql`true`)
    .where(options.agentId === undefined ? undefined : eq(conversations.agentId, options.agentId))
    .orderBy(desc(updatedAt), desc(conversations.id))
    .limit(options.limit ?? 50);

  return rows.map(({ lastRole, lastText, lastCreatedAt, ...row }) => ({
    ...row,
    updatedAt: lastCreatedAt ?? row.createdAt,
    lastMessage:
      lastCreatedAt === null || lastRole === null
        ? null
        : { role: lastRole, text: lastText ?? '', createdAt: lastCreatedAt },
  }));
}

export async function appendMessage(
  db: Database,
  input: { id: string; conversationId: string; role: string; content: unknown; runId?: string },
): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      runId: input.runId ?? null,
    })
    .returning();
  if (!row) throw new Error('message insert returned no row');
  return row;
}

export async function createRun(
  db: Database,
  input: { id: string; conversationId: string; agentId: string; approvals?: string[] },
): Promise<AgentRun> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      agentId: input.agentId,
      status: 'queued',
      ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
    })
    .returning();
  if (!row) throw new Error('agent run insert returned no row');
  return row;
}

export async function getRun(db: Database, runId: string): Promise<AgentRun | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return row ?? null;
}

export async function updateRun(
  db: Database,
  runId: string,
  patch: RunPatch,
): Promise<AgentRun | null> {
  if (Object.keys(patch).length === 0) return getRun(db, runId);
  const [row] = await db.update(agentRuns).set(patch).where(eq(agentRuns.id, runId)).returning();
  return row ?? null;
}

/** 已结束的 run 不能被取消覆盖。 */
export async function cancelRun(db: Database, runId: string): Promise<AgentRun | null> {
  const [row] = await db
    .update(agentRuns)
    .set({ status: 'cancelled', endedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['queued', 'running'])))
    .returning();
  return row ?? null;
}
