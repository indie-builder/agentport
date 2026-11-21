import { AppError, fail } from '@agentport/core';
import type { AccessFilter, ExecutionSubject } from '@agentport/shared';
import { ACTIVE_RUN_STATUSES } from '@agentport/shared';
import { and, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../../client.js';
import { agentRuns, agents, conversations, messages } from '../../schema.js';
import { lockAgentBindings } from '../locks.js';
import { type CursorPage, cursorValueSql, keysetPage } from '../pagination.js';
import { conversationAccessWhere, conversationSubject } from './shared.js';

export type Conversation = typeof conversations.$inferSelect;

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
    channelId?: string;
    providerDestination?: string | null;
  },
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({
      id: input.id,
      agentId: input.agentId,
      title: input.title,
      channelId: input.channelId ?? null,
      providerDestination: input.providerDestination ?? null,
      ...conversationSubject(input.subject),
    })
    .returning();
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

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

export async function markConversationDataDomainRestricted(
  db: DbHandle,
  conversationId: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ dataDomainRestricted: true })
    .where(eq(conversations.id, conversationId));
}

export async function isConversationDataDomainRestricted(
  db: DbHandle,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ restricted: conversations.dataDomainRestricted })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row?.restricted ?? false;
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

export interface ConversationSandboxTarget {
  conversationId: string;
  sandboxIds: string[];
}

export interface ConversationDeletionInput {
  id: string;
  access: AccessFilter;
}

export interface ConversationDeletionSnapshot {
  id: string;
  agentId: string;
  agentSlug: string;
  createdBy: string | null;
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
  agentName: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessage: { role: string; text: string; createdAt: Date } | null;
}

export interface OwnConversationWithAgent {
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  updatedAt: Date;
}

export async function listOwnConversationsWithAgent(
  db: Database,
  businessId: string,
  limit: number,
): Promise<OwnConversationWithAgent[]> {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      agentId: conversations.agentId,
      agentName: agents.name,
      agentSlug: agents.slug,
      updatedAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(and(eq(conversations.createdBy, businessId), isNull(conversations.channelId)))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(limit);
}

export async function listConversations(
  db: Database,
  options: { agentId?: string; limit?: number; cursor?: string; access: AccessFilter },
): Promise<CursorPage<ConversationSummary> | null> {
  const agentFilter =
    options.agentId === undefined ? undefined : eq(conversations.agentId, options.agentId);
  const result = await keysetPage(db, {
    table: conversations,
    cursor: options.cursor,
    limit: options.limit ?? 50,
    column: conversations.lastMessageAt,
    valueCursor: (row: { cursorValue: string }) => row.cursorValue,
    cursorKind: 'timestamp',
    where: [agentFilter, conversationAccessWhere(options.access), isNull(conversations.channelId)],
    load: ({ where, limit }: { where: SQL | undefined; limit: number }) => {
      const page = db
        .select({
          id: conversations.id,
          agentId: conversations.agentId,
          agentName: agents.name,
          title: conversations.title,
          createdAt: conversations.createdAt,
          cursorValue: cursorValueSql(conversations.lastMessageAt).as('cursorValue'),
        })
        .from(conversations)
        .innerJoin(agents, eq(agents.id, conversations.agentId))
        .where(where)
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(limit)
        .as('page');

      const last = db
        .select({
          role: messages.role,
          text: sql<string | null>`left(${messages.content}->>'text', 280)`.as('text'),
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.conversationId, page.id))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1)
        .as('last_message');

      return db
        .select({
          id: page.id,
          agentId: page.agentId,
          agentName: page.agentName,
          title: page.title,
          createdAt: page.createdAt,
          cursorValue: page.cursorValue,
          lastRole: last.role,
          lastText: last.text,
          lastCreatedAt: last.createdAt,
        })
        .from(page)
        .leftJoinLateral(last, sql`true`);
    },
  });
  if (result === null) return null;

  return {
    items: result.items.map(({ cursorValue, lastRole, lastText, lastCreatedAt, ...row }) => ({
      ...row,
      updatedAt: lastCreatedAt ?? row.createdAt,
      lastMessage:
        lastCreatedAt === null || lastRole === null
          ? null
          : { role: lastRole, text: lastText ?? '', createdAt: lastCreatedAt },
    })),
    nextCursor: result.nextCursor,
  };
}
