import { fail } from '@agentport/core';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, agents, conversations, messages } from '../schema.js';
import { inheritApprovals } from './runs.js';

/** 事务句柄：准入逻辑在事务内复用同一批写函数。 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

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
  db: Database | Tx,
  input: { id: string; agentId: string; title: string },
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({ id: input.id, agentId: input.agentId, title: input.title })
    .returning();
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

/** 只改标题：lastMessageAt 由 messages 触发器维护，这里不动。 */
export async function renameConversation(
  db: Database,
  conversationId: string,
  title: string,
): Promise<Conversation | null> {
  const [row] = await db
    .update(conversations)
    .set({ title })
    .where(eq(conversations.id, conversationId))
    .returning();
  return row ?? null;
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
  db: Database,
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
export async function insertMessages(db: Database | Tx, rows: MessageInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(messages).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

const HISTORY_LIMIT = 20;
const HISTORY_TEXT_LIMIT = 2_000;

/** 消息正文只在 content.text 里；tool 消息没有该字段。 */
export function messageText(content: unknown): string | null {
  if (typeof content !== 'object' || content === null || !('text' in content)) return null;
  return typeof content.text === 'string' ? content.text : null;
}

/**
 * 新 run 的上下文恢复：沙盒每次都是新容器，SDK 的 session resume 不可用，
 * 只能把最近 N 条 user/assistant 文本拼进 prompt。tool 消息体积不可控，跳过。
 */
export async function getHistoryForPrompt(
  db: Database | Tx,
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
    await insertMessages(
      db,
      copy.map((row) => ({
        id: newId('message'),
        conversationId: conversation.id,
        role: row.role,
        content: row.content,
        runId: null,
        createdAt: row.createdAt,
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
  // 先按 last_message_at 取一页会话（由 messages 触发器维护），lateral 只对这几行求最后一条消息。
  // 直接 lateral + orderBy 会把子查询跑遍全表（N 个会话 × messages 扫描）。
  const page = db
    .select({
      id: conversations.id,
      agentId: conversations.agentId,
      title: conversations.title,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(options.agentId === undefined ? undefined : eq(conversations.agentId, options.agentId))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(options.limit ?? 50)
    .as('page');

  const last = db
    .select({
      role: messages.role,
      // 列表不需要完整消息体；只取文本并截断，避免把大 jsonb 带进列表响应。
      text: sql<string | null>`left(${messages.content}->>'text', 280)`.as('text'),
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, page.id))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
    .as('last_message');

  // 行的顺序已由 page 的子查询确定，外层不再排序。
  const rows = await db
    .select({
      id: page.id,
      agentId: page.agentId,
      title: page.title,
      createdAt: page.createdAt,
      lastRole: last.role,
      lastText: last.text,
      lastCreatedAt: last.createdAt,
    })
    .from(page)
    .leftJoinLateral(last, sql`true`);

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
  db: Database | Tx,
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
  db: Database | Tx,
  input: { id: string; conversationId: string; agentId: string },
): Promise<AgentRun> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      id: input.id,
      conversationId: input.conversationId,
      agentId: input.agentId,
      status: 'queued',
    })
    .returning();
  if (!row) throw new Error('agent run insert returned no row');
  return row;
}

/** 先锁会话再检查活动运行，让后续入场看到前一个事务的提交。 */
export async function admitChatRun(
  db: Database,
  input: { agentId: string; message: string; conversationId?: string },
): Promise<{
  run: AgentRun;
  conversationId: string;
  inherited: string[];
  history: string | null;
}> {
  return db.transaction(async (tx) => {
    // 锁序：先 agents 再 conversations；反向会和 agent_runs 的外键检查形成删除死锁。
    const [owner] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1)
      .for('key share');
    if (!owner) fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');

    let conversationId: string;
    if (input.conversationId === undefined) {
      conversationId = newId('conversation');
      await createConversation(tx, {
        id: conversationId,
        agentId: input.agentId,
        title: input.message.slice(0, 80),
      });
    } else {
      conversationId = input.conversationId;
      const [conversation] = await tx
        .select({ agentId: conversations.agentId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
        .for('update');
      if (!conversation || conversation.agentId !== input.agentId) {
        fail('CONVERSATION_NOT_FOUND', '会话不存在或不属于该智能体；请从会话列表重新打开');
      }
    }

    const [active] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, conversationId),
          inArray(agentRuns.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (active) fail('CONFLICT', '该会话仍有运行未结束，请等待完成或取消后再发送');

    const run = await createRun(tx, { id: newId('run'), conversationId, agentId: input.agentId });
    // 批准原先绑定单次 run；重发消息会新建 run，这里把上一 run 的已批准工具带过来。
    const inherited = await inheritApprovals(tx, { conversationId, runId: run.id });
    // 在写入本条消息前取历史，避免把当前输入重复拼进上下文。
    const history = await getHistoryForPrompt(tx, conversationId);
    await appendMessage(tx, {
      id: newId('message'),
      conversationId,
      role: 'user',
      content: { type: 'text', text: input.message },
      runId: run.id,
    });

    return { run, conversationId, inherited, history };
  });
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
