import { fail } from '@agentport/core';
import type { ChatMessageRole, ExecutionSubject } from '@agentport/shared';
import { and, asc, desc, eq, exists, isNotNull, type SQL } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import { agentRuns, conversations, messages } from '../../schema.js';
import { cancelPendingRunFailedWebhooks } from '../integrations.js';
import { type CursorPage, keysetBound, keysetPage } from '../pagination.js';
import { neverStartedFailureFilter } from '../run-predicates.js';
import {
  consumePolicyApproval,
  getApprovedPolicyApprovalForConversation,
  linkPolicyApprovalToRun,
  POLICY_APPROVAL_STALE_MESSAGE,
} from '../security.js';
import { type Conversation, getConversation } from './conversations.js';
import { conversationSubject } from './shared.js';

export type Message = typeof messages.$inferSelect;

export interface ListMessagesOptions {
  limit?: number;
  before?: string;
}

export function listMessages(
  db: DbHandle,
  conversationId: string,
  options?: ListMessagesOptions & { before?: never },
): Promise<Message[]>;
export function listMessages(
  db: DbHandle,
  conversationId: string,
  options: ListMessagesOptions,
): Promise<Message[] | null>;
export async function listMessages(
  db: DbHandle,
  conversationId: string,
  options: ListMessagesOptions = {},
): Promise<Message[] | null> {
  if (options.limit !== undefined) {
    const page = await listMessagePage(db, conversationId, {
      limit: options.limit,
      cursor: options.before,
    });
    return page?.items.reverse() ?? null;
  }
  const filters: SQL[] = [eq(messages.conversationId, conversationId)];
  if (options.before !== undefined) {
    if (options.before.includes('\u0000')) return null;
    const [anchor] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(...filters, eq(messages.id, options.before)))
      .limit(1);
    if (anchor === undefined) return null;
    filters.push(keysetBound(messages, options.before, messages.createdAt, 'desc'));
  }
  return db
    .select()
    .from(messages)
    .where(and(...filters))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

export async function getRunUserMessageText(db: DbHandle, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.runId, runId), eq(messages.role, 'user')))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(1);
  return messageText(row?.content);
}

export async function requeueInfraFailedRun(
  db: DbHandle,
  runId: string,
  text?: string,
  consumePolicyApprovalId?: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(agentRuns)
      .set({ status: 'queued', endedAt: null, error: null, errorKind: null })
      .where(and(eq(agentRuns.id, runId), neverStartedFailureFilter()))
      .returning({ conversationId: agentRuns.conversationId });
    if (updated === undefined) return false;
    if (consumePolicyApprovalId !== undefined) {
      const lockedRoute = await getApprovedPolicyApprovalForConversation(
        tx,
        updated.conversationId,
      );
      const consumed = await consumePolicyApproval(
        tx,
        consumePolicyApprovalId,
        lockedRoute?.destination ?? undefined,
      );
      if (consumed === null || (consumed.runId !== null && consumed.runId !== runId)) {
        fail('CONTENT_APPROVAL_REQUIRED', POLICY_APPROVAL_STALE_MESSAGE);
      }
      await linkPolicyApprovalToRun(tx, consumePolicyApprovalId, runId);
    }
    if (text !== undefined && !(await updateRunUserMessageText(tx, runId, text))) {
      throw new Error('requeued run has no user message');
    }
    await cancelPendingRunFailedWebhooks(tx, runId);
    return true;
  });
}

export async function updateRunUserMessageText(db: DbHandle, runId: string, text: string) {
  const queuedRun = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'queued')))
    .for('update');
  const [updated] = await db
    .update(messages)
    .set({ content: { type: 'text', text } })
    .where(and(eq(messages.runId, runId), eq(messages.role, 'user'), exists(queuedRun)))
    .returning({ id: messages.id });
  return updated !== undefined;
}

export async function getLastUserMessage(db: DbHandle, conversationId: string) {
  const [row] = await db
    .select({
      id: messages.id,
      content: messages.content,
      runId: messages.runId,
      sdkMessageUuid: messages.sdkMessageUuid,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row ?? null;
}

export function listMessagePage(
  db: DbHandle,
  conversationId: string,
  options: { limit: number; cursor?: string | undefined },
): Promise<CursorPage<Message> | null> {
  return keysetPage(db, {
    table: messages,
    cursor: options.cursor,
    limit: options.limit,
    where: [eq(messages.conversationId, conversationId)],
    load: ({ where, limit }) =>
      db
        .select()
        .from(messages)
        .where(where)
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit),
  });
}

const INSERT_CHUNK = 500;

export type MessageInsert = typeof messages.$inferInsert;

export async function insertMessages(db: DbHandle, rows: MessageInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(messages).values(rows.slice(i, i + INSERT_CHUNK));
  }
}

export function messageText(content: unknown): string | null {
  if (Array.isArray(content)) {
    const parts = (content as unknown[]).flatMap((part) =>
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
        ? [part.text]
        : [],
    );
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (typeof content !== 'object' || content === null || !('text' in content)) return null;
  return typeof content.text === 'string' ? content.text : null;
}

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
  messageIds: Record<string, string>;
} | null> {
  return db.transaction(async (tx) => {
    const source = await getConversation(tx, input.conversationId);
    if (!source) return null;

    const rows = await listMessages(tx, source.id);
    let cutoffIndex = rows.length - 1;
    if (input.fromMessageId !== undefined) {
      cutoffIndex = rows.findIndex((row) => row.id === input.fromMessageId);
      if (cutoffIndex < 0) return null;
    }
    const copy = rows.slice(0, cutoffIndex + 1);
    const forkPoint = copy.at(-1)?.sdkMessageUuid ?? null;
    if (copy.length > 0 && source.sdkSessionId === null) {
      fail('CONFLICT', '该会话还没有可用的 SDK 会话记录，无法按历史点分支；请重新对话后再试');
    }
    if (copy.length > 0 && !copy.every((row) => row.sdkMessageUuid !== null)) {
      fail(
        'CONFLICT',
        '该会话的历史消息没有 SDK 会话记录（来自旧版本或 SDK 会话已丢失），无法按历史点分支',
      );
    }

    const [restriction] = await tx
      .select({ restricted: conversations.dataDomainRestricted })
      .from(conversations)
      .where(eq(conversations.id, source.id))
      .limit(1);

    const providerDestination =
      source.providerDestination ??
      (await getApprovedPolicyApprovalForConversation(tx, source.id))?.destination ??
      null;

    const [conversation] = await tx
      .insert(conversations)
      .values({
        id: input.id,
        agentId: source.agentId,
        title: input.title ?? source.title,
        parentId: source.id,
        branchOfMessageId: copy.at(-1)?.id ?? null,
        sdkSessionId: source.sdkSessionId,
        forkFromSdkMessageUuid: forkPoint,
        dataDomainRestricted: source.dataDomainRestricted || (restriction?.restricted ?? false),
        providerDestination,
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
          sdkMessageUuid: row.sdkMessageUuid,
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
    role: ChatMessageRole;
    content: unknown;
    senderBusinessId?: string | null;
    runId?: string;
    sdkMessageUuid?: string;
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
