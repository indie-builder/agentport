import { AppError, fail } from '@agentport/core';
import type { AccessFilter, ExecutionSubject } from '@agentport/shared';
import { ACTIVE_RUN_STATUSES } from '@agentport/shared';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../../client.js';
import { agentRuns, agents, conversations, messages } from '../../schema.js';
import { lockAgentBindings } from '../locks.js';
import { conversationAccessWhere, conversationSubject } from './shared.js';

export type Conversation = typeof conversations.$inferSelect;

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
  db: DbHandle,
  input: {
    id: string;
    agentId: string;
    title: string;
    subject: ExecutionSubject;
    /** 非空表示频道 agent lane；私有对话不传。 */
    channelId?: string;
  },
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({
      id: input.id,
      agentId: input.agentId,
      title: input.title,
      channelId: input.channelId ?? null,
      ...conversationSubject(input.subject),
    })
    .returning();
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

/** 只改标题：lastMessageAt 由 messages 触发器维护，这里不动。 */
export async function renameConversation(
  db: Database,
  input: { id: string; title: string; access: AccessFilter },
): Promise<Conversation | null> {
  const [row] = await db
    .update(conversations)
    .set({ title: input.title })
    .where(and(eq(conversations.id, input.id), conversationAccessWhere(input.access)))
    .returning();
  return row ?? null;
}

/** 私有入口：频道 lane 不在这里暴露，访问统一走频道成员校验。 */
export async function getConversation(
  db: DbHandle,
  conversationId: string,
): Promise<Conversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), isNull(conversations.channelId)))
    .limit(1);
  return row ?? null;
}

/** 删除前关闭的目标：会话身份与它落库过的容器名（同一容器复用时去重）。 */
export interface ConversationSandboxTarget {
  conversationId: string;
  sandboxIds: string[];
}

export interface ConversationDeletionInput {
  id: string;
  /** conversations.delete 的范围；own_data 只匹配本人创建的会话。 */
  access: AccessFilter;
}

export interface ConversationDeletionSnapshot {
  id: string;
  agentId: string;
  agentSlug: string;
  createdBy: string | null;
  /** 即使 sandboxIds=[] 也保留会话身份，事务外据此等待关闭确认。 */
  targets: ConversationSandboxTarget[];
}

/** 短 tx A：按删除范围重查主体与全部目标，提交后由调用方在事务外等待关闭。 */
export async function prepareConversationDeletion(
  db: Database,
  input: ConversationDeletionInput,
): Promise<ConversationDeletionSnapshot | null> {
  return db.transaction((tx) => readConversationDeletionSnapshot(tx, input));
}

/** 短 tx B：重读完整快照并与 A 精确比较，匹配才删除；任何变化回滚。 */
export async function deleteConversation(
  db: Database,
  input: ConversationDeletionInput & { expected: ConversationDeletionSnapshot },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const actual = await readConversationDeletionSnapshot(tx, input);
    if (actual === null) return false;
    if (!sameConversationSnapshot(input.expected, actual)) {
      throw new AppError('CONFLICT', '会话在删除期间发生变化，请重试', { retryable: true });
    }
    const rows = await tx
      .delete(conversations)
      .where(and(eq(conversations.id, input.id), conversationAccessWhere(input.access)))
      .returning({ id: conversations.id });
    return rows.length > 0;
  });
}

/**
 * 锁序与 admitChatRun 一致（agents key share → conversations update），否则外键检查会和准入死锁。
 * A/B 都先取绑定锁，再按主体范围重查；目标集合与身份变化由调用方据此拒绝。
 */
async function readConversationDeletionSnapshot(
  tx: Transaction,
  input: ConversationDeletionInput,
): Promise<ConversationDeletionSnapshot | null> {
  await lockAgentBindings(tx);
  const scope = and(eq(conversations.id, input.id), conversationAccessWhere(input.access));
  const [owner] = await tx
    .select({ agentId: conversations.agentId })
    .from(conversations)
    .where(scope)
    .limit(1);
  if (!owner) return null;

  await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, owner.agentId))
    .limit(1)
    .for('key share');

  const [locked] = await tx.select().from(conversations).where(scope).limit(1).for('update');
  if (!locked) return null;

  const [active] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.conversationId, input.id),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .limit(1);
  if (active) fail('CONFLICT', '该会话仍有运行未结束，请等待完成或取消后再删除');

  const [agent] = await tx
    .select({ slug: agents.slug })
    .from(agents)
    .where(eq(agents.id, locked.agentId))
    .limit(1);
  if (!agent) return null;

  return {
    id: locked.id,
    agentId: locked.agentId,
    agentSlug: agent.slug,
    createdBy: locked.createdBy,
    targets: await sandboxTargetsForConversation(tx, input.id),
  };
}

export function sameTargets(
  left: ConversationSandboxTarget[],
  right: ConversationSandboxTarget[],
): boolean {
  return (
    left.length === right.length &&
    left.every((target, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        target.conversationId === other.conversationId &&
        target.sandboxIds.length === other.sandboxIds.length &&
        target.sandboxIds.every((id, sandboxIndex) => id === other.sandboxIds[sandboxIndex])
      );
    })
  );
}

function sameConversationSnapshot(
  expected: ConversationDeletionSnapshot,
  actual: ConversationDeletionSnapshot,
): boolean {
  return (
    expected.id === actual.id &&
    expected.agentId === actual.agentId &&
    expected.agentSlug === actual.agentSlug &&
    expected.createdBy === actual.createdBy &&
    sameTargets(expected.targets, actual.targets)
  );
}

async function sandboxTargetsForConversation(
  tx: Transaction,
  conversationId: string,
): Promise<ConversationSandboxTarget[]> {
  const runRows = await tx
    .select({ sandboxId: agentRuns.sandboxId })
    .from(agentRuns)
    .where(and(eq(agentRuns.conversationId, conversationId), isNotNull(agentRuns.sandboxId)));
  const sandboxIds = [
    ...new Set(runRows.flatMap((run) => (run.sandboxId === null ? [] : [run.sandboxId]))),
  ].sort();
  return [{ conversationId, sandboxIds }];
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
  options: { agentId?: string; limit?: number; access: AccessFilter },
): Promise<ConversationSummary[]> {
  const agentFilter =
    options.agentId === undefined ? undefined : eq(conversations.agentId, options.agentId);
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
    .where(
      and(agentFilter, conversationAccessWhere(options.access), isNull(conversations.channelId)),
    )
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
