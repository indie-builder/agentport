import { randomUUID } from 'node:crypto';
import { fail, notFound } from '@agentport/core';
import type {
  AgentDefinition,
  ExecutionSubject,
  MessageAttachment,
  RunTrigger,
} from '@agentport/shared';
import { ACTIVE_RUN_STATUSES } from '@agentport/shared';
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { newId } from '../../id.js';
import {
  agentRuns,
  agents,
  channelAgentBindings,
  channelMessages,
  conversations,
  externalRequestKeys,
  messages,
} from '../../schema.js';
import { getAgentVersion } from '../agent-versions.js';
import { getAgentServerIds } from '../agents.js';
import { channelMemberRole, lockChannelRow } from '../channels.js';
import { assertRunBudget, getDepartmentIdForBusinessId } from '../governance.js';
import { lockRunResources } from '../locks.js';
import { inheritApprovals } from '../runs.js';
import { CHANNEL_CONTEXT_CHAR_LIMIT, CHANNEL_CONTEXT_MESSAGE_LIMIT } from './channel-context.js';
import { createConversation } from './conversations.js';
import { appendMessage, messageText } from './messages.js';
import { type AgentRun, createRun } from './run-context.js';

const CHANNEL_CONTEXT_HEADER = '【频道上下文】\n';
const CHANNEL_CONTEXT_CURRENT = '【当前消息】\n';
const CHANNEL_CONTEXT_OMITTED = '更早的消息已省略\n';

interface ChannelContextMessage {
  kind: 'human' | 'agent' | 'system';
  authorBusinessId: string | null;
  agentId: string | null;
  body: string;
  attachments: MessageAttachment[] | null;
}

function attachmentNames(message: ChannelContextMessage): string {
  const names = (message.attachments ?? []).map((attachment) => attachment.filename);
  return names.length === 0 ? '' : `（附件：${names.join('、')}）`;
}

function channelContextLine(message: ChannelContextMessage): string {
  if (message.kind === 'human') {
    return `成员 ${(message.authorBusinessId ?? '').slice(-6)}：${message.body}${attachmentNames(message)}\n`;
  }
  if (message.kind === 'agent') return `智能体 ${message.agentId ?? ''}：${message.body}\n`;
  return `系统：${message.body}\n`;
}

function buildChannelContext(rows: ChannelContextMessage[], truncated: boolean): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(channelContextLine);
  const fixed = CHANNEL_CONTEXT_HEADER.length + CHANNEL_CONTEXT_CURRENT.length;
  const whole = fixed + lines.reduce((sum, line) => sum + line.length, 0);
  if (!truncated && whole <= CHANNEL_CONTEXT_CHAR_LIMIT) {
    return `${CHANNEL_CONTEXT_HEADER}${lines.reverse().join('')}${CHANNEL_CONTEXT_CURRENT}`;
  }
  const budget = CHANNEL_CONTEXT_CHAR_LIMIT - fixed - CHANNEL_CONTEXT_OMITTED.length;
  const included: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > budget) break;
    included.push(line);
    used += line.length;
  }
  return `${CHANNEL_CONTEXT_HEADER}${CHANNEL_CONTEXT_OMITTED}${included.reverse().join('')}${CHANNEL_CONTEXT_CURRENT}`;
}

/** 先锁会话再检查活动运行，让后续入场看到前一个事务的提交。 */
export async function admitChatRun(
  db: Database,
  input: {
    agentId: string;
    message: string;
    conversationId?: string;
    trigger?: RunTrigger;
    evalRunId?: string;
    agentVersion?: number;
    definitionSnapshot?: AgentDefinition | null;
    /** 新会话标题；缺省取消息前 80 字。非浏览器入口用它标明来源。 */
    title?: string;
    /** 用户消息的完整 content；缺省等价于 `{ type: 'text', text: input.message }`。 */
    userContent?: unknown;
    subject: ExecutionSubject;
    /** 频道触发：准入自行取建该 agent 的 lane，并从 DB 复核频道成员与绑定。 */
    channel?: { channelId: string; channelMessageId: string };
    attachments?: MessageAttachment[];
    budgetExempt?: boolean;
    allowDisabled?: boolean;
    regenerate?: true;
    externalRequest?: {
      sourceKind: 'api_token' | 'webhook';
      sourceId: string;
      idempotencyKey: string;
      requestHash: string;
    };
  },
): Promise<{
  run: AgentRun;
  conversationId: string;
  inherited: string[];
  /** 本轮用户消息的 SDK uuid；runner 用它发送首条用户消息。 */
  userMessageUuid: string;
  regenerate?: { replacesRunId: string; forkFromMessageUuid?: string; prompt: string };
  replayed?: true;
}> {
  return db.transaction(async (tx) => {
    let externalRequestId: string | undefined;
    if (input.externalRequest !== undefined) {
      const { sourceKind, sourceId, idempotencyKey, requestHash } = input.externalRequest;
      const [inserted] = await tx
        .insert(externalRequestKeys)
        .values({ id: newId('externalRequest'), sourceKind, sourceId, idempotencyKey, requestHash })
        .onConflictDoNothing()
        .returning({ id: externalRequestKeys.id });
      if (inserted !== undefined) {
        externalRequestId = inserted.id;
      } else {
        const [existing] = await tx
          .select()
          .from(externalRequestKeys)
          .where(
            and(
              eq(externalRequestKeys.sourceKind, sourceKind),
              eq(externalRequestKeys.sourceId, sourceId),
              eq(externalRequestKeys.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (existing === undefined || existing.requestHash !== requestHash) {
          fail('CONFLICT', '同一幂等键已用于不同的请求');
        }
        if (existing.runId === null) {
          fail('CONFLICT', '同一幂等键的请求仍在处理中，请稍后重试');
        }
        const [existingRun] = await tx
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, existing.runId))
          .limit(1);
        if (existingRun === undefined) fail('CONFLICT', '原始运行记录已不可用');
        return {
          run: existingRun,
          conversationId: existingRun.conversationId,
          inherited: [],
          userMessageUuid: '',
          replayed: true,
        };
      }
    }

    // 与记忆写入共用「发起专家 + 子智能体」的记忆锁：集合在运行期间固定，
    // 入队前先锁住整个集合，新 run 不会在写入中途落地。
    const definition =
      input.definitionSnapshot ??
      (input.agentVersion === undefined
        ? null
        : ((await getAgentVersion(tx, input.agentId, input.agentVersion))?.definition ?? null));
    await lockRunResources(tx, input.agentId, definition?.agent.subAgentIds);
    // 锁序：先 agents 再 conversations；反向会和 agent_runs 的外键检查形成删除死锁。
    const [owner] = await tx
      .select({
        id: agents.id,
        enabled: agents.enabled,
        model: agents.model,
      })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1)
      .for('key share');
    if (!owner) notFound('agent');
    // 入口的 enabled 预检在锁外；停用若在等锁期间提交，只有锁内重读才能拦住这次入队。
    if (!owner.enabled && input.allowDisabled !== true) {
      fail('AGENT_DISABLED', '该智能体已停用，无法发起新对话；请到智能体页面启用后再试');
    }
    if (input.channel === undefined && input.trigger === 'channel') {
      fail('INVALID_INPUT', '频道触发必须带频道与来源消息');
    }
    if (!input.budgetExempt) {
      await assertRunBudget(tx, {
        agentId: input.agentId,
        initiatedBy: input.subject.kind === 'user' ? input.subject.businessId : null,
        definition,
      });
    }

    let conversationId: string;
    let conversationSdkSessionId: string | null = null;
    let channelContext: string | null = null;
    if (input.channel !== undefined) {
      const { channelId, channelMessageId } = input.channel;
      if (input.subject.kind !== 'user') {
        fail('INVALID_INPUT', '频道触发必须由自然人发起');
      }
      // 频道行锁把同一频道的准入与发消息串行化，lane 的取建不靠裸查再插。
      const channel = await lockChannelRow(tx, channelId);
      if (!channel) fail('NOT_FOUND', '频道不存在，可能已被删除');
      if (channel.archivedAt !== null) fail('CONFLICT', '频道已归档，无法触发智能体');
      const role = await channelMemberRole(tx, channelId, input.subject.businessId);
      if (role === null) fail('NOT_FOUND', '频道不存在，可能已被删除');
      if (role === 'viewer') fail('FORBIDDEN', '当前频道角色不能触发智能体');
      const [trigger] = await tx
        .select({
          seq: channelMessages.seq,
          kind: channelMessages.kind,
          authorBusinessId: channelMessages.authorBusinessId,
        })
        .from(channelMessages)
        .where(
          and(eq(channelMessages.id, channelMessageId), eq(channelMessages.channelId, channelId)),
        )
        .limit(1);
      if (!trigger) fail('NOT_FOUND', '触发消息不存在，可能已被删除');
      if (trigger.kind !== 'human' || trigger.authorBusinessId !== input.subject.businessId) {
        fail('FORBIDDEN', '只能从自己发送的频道消息触发智能体');
      }
      const [binding] = await tx
        .select({
          conversationId: channelAgentBindings.conversationId,
          status: channelAgentBindings.status,
          contextSeq: channelAgentBindings.contextSeq,
        })
        .from(channelAgentBindings)
        .where(
          and(
            eq(channelAgentBindings.channelId, channelId),
            eq(channelAgentBindings.agentId, input.agentId),
          ),
        )
        .limit(1)
        .for('update');
      if (!binding) notFound('agent', '该智能体未加入频道，无法触发');
      if (binding.status !== 'active') {
        fail('CONFLICT', '该智能体在频道内已断开，无法触发');
      }
      // 只补注入上次游标之后、触发消息之前的新消息；limit+1 用来判断是否还有更早的。
      const contextRows = await tx
        .select({
          kind: channelMessages.kind,
          authorBusinessId: channelMessages.authorBusinessId,
          agentId: channelMessages.agentId,
          body: channelMessages.body,
          attachments: channelMessages.attachments,
        })
        .from(channelMessages)
        .where(
          and(
            eq(channelMessages.channelId, channelId),
            gt(channelMessages.seq, binding.contextSeq),
            lt(channelMessages.seq, trigger.seq),
          ),
        )
        .orderBy(desc(channelMessages.seq))
        .limit(CHANNEL_CONTEXT_MESSAGE_LIMIT + 1);
      channelContext = buildChannelContext(
        contextRows.slice(0, CHANNEL_CONTEXT_MESSAGE_LIMIT),
        contextRows.length > CHANNEL_CONTEXT_MESSAGE_LIMIT,
      );
      if (binding.conversationId === null) {
        // 解绑再加回时旧 lane 仍在；频道行锁内先复用，避免撞 partial unique。
        const [existing] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.channelId, channelId), eq(conversations.agentId, input.agentId)),
          )
          .limit(1)
          .for('update');
        if (existing) {
          conversationId = existing.id;
        } else {
          conversationId = newId('conversation');
          await createConversation(tx, {
            id: conversationId,
            agentId: input.agentId,
            title: input.title ?? input.message.slice(0, 80),
            subject: input.subject,
            channelId,
          });
        }
        await tx
          .update(channelAgentBindings)
          .set({ conversationId })
          .where(
            and(
              eq(channelAgentBindings.channelId, channelId),
              eq(channelAgentBindings.agentId, input.agentId),
            ),
          );
      } else {
        conversationId = binding.conversationId;
        const [lane] = await tx
          .select({ agentId: conversations.agentId, channelId: conversations.channelId })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1)
          .for('update');
        if (lane?.channelId !== channelId || lane.agentId !== input.agentId) {
          fail('INTERNAL_ERROR', '频道智能体会话与绑定不一致，请刷新后重试');
        }
      }
    } else if (input.conversationId === undefined) {
      conversationId = newId('conversation');
      await createConversation(tx, {
        id: conversationId,
        agentId: input.agentId,
        title: input.title ?? input.message.slice(0, 80),
        subject: input.subject,
      });
    } else {
      conversationId = input.conversationId;
      const [conversation] = await tx
        .select({ agentId: conversations.agentId, sdkSessionId: conversations.sdkSessionId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
        .for('update');
      if (!conversation || conversation.agentId !== input.agentId) {
        notFound('conversation', '会话不存在或不属于该智能体；请从会话列表重新打开');
      }
      conversationSdkSessionId = conversation.sdkSessionId;
    }

    const [active] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, conversationId),
          inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .limit(1);
    if (active) fail('CONFLICT', '该会话仍有运行未结束，请等待完成或取消后再发送');

    let regenerated:
      | { replacesRunId: string; forkFromMessageUuid?: string; prompt: string }
      | undefined;
    let regeneratedUserMessageUuid = '';
    if (input.regenerate === true) {
      if (input.conversationId === undefined) {
        fail('INVALID_INPUT', '重新生成需要指定会话');
      }
      const [u] = await tx
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
      if (!u || u.runId === null) fail('CONFLICT', '该会话没有可重新生成的回复');
      const beforeU = sql`(
        select b.created_at, b.id from ${messages} b
        where b.id = ${u.id} and b.conversation_id = ${conversationId}
      )`;
      const [after] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            sql`(${messages.createdAt}, ${messages.id}) > ${beforeU}`,
            sql`${messages.runId} is distinct from ${u.runId}`,
          ),
        )
        .limit(1);
      if (after) fail('CONFLICT', '只能重新生成最后一轮回复');
      const [previous] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            sql`(${messages.createdAt}, ${messages.id}) < ${beforeU}`,
          ),
        )
        .limit(1);
      let forkFromMessageUuid: string | undefined;
      if (previous !== undefined) {
        const [p] = await tx
          .select({ sdkMessageUuid: messages.sdkMessageUuid })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.role, 'assistant'),
              isNotNull(messages.sdkMessageUuid),
              sql`${messages.content}->>'parentToolUseId' is null`,
              sql`(${messages.createdAt}, ${messages.id}) < ${beforeU}`,
            ),
          )
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(1);
        if (conversationSdkSessionId === null || p === undefined || p.sdkMessageUuid === null) {
          fail('CONFLICT', '该会话的历史缺少可用的 SDK 会话记录，无法重新生成；请重新对话后再试');
        }
        forkFromMessageUuid = p.sdkMessageUuid;
      }
      regeneratedUserMessageUuid = u.sdkMessageUuid ?? '';
      regenerated = {
        replacesRunId: u.runId,
        ...(forkFromMessageUuid === undefined ? {} : { forkFromMessageUuid }),
        prompt: messageText(u.content) ?? '',
      };
    }

    const run = await createRun(tx, {
      id: newId('run'),
      conversationId,
      agentId: input.agentId,
      ...(input.evalRunId === undefined ? {} : { evalRunId: input.evalRunId }),
      model: definition?.agent.model ?? owner.model,
      departmentId:
        input.subject.kind === 'user'
          ? await getDepartmentIdForBusinessId(tx, input.subject.businessId)
          : null,
      serverIds:
        definition === null
          ? await getAgentServerIds(tx, input.agentId)
          : definition.agent.serverIds,
      subject: input.subject,
      ...(input.channel !== undefined
        ? {
            trigger: 'channel' as const,
            channelId: input.channel.channelId,
            channelTriggerMessageId: input.channel.channelMessageId,
          }
        : input.trigger === undefined
          ? {}
          : { trigger: input.trigger }),
      ...(input.agentVersion === undefined ? {} : { agentVersion: input.agentVersion }),
      ...(input.definitionSnapshot === undefined
        ? {}
        : { definitionSnapshot: input.definitionSnapshot }),
    });
    // 频道 lane 由多位成员共享，单次运行批准不能跨触发者继承。
    const inherited =
      input.channel === undefined
        ? await inheritApprovals(tx, { conversationId, runId: run.id })
        : [];
    let userMessageUuid: string;
    if (regenerated !== undefined) {
      userMessageUuid = regeneratedUserMessageUuid;
    } else {
      // 页面消息的 SDK 身份由平台生成：runner 用它发首条用户消息，后续按点 fork 依赖它。
      userMessageUuid = randomUUID();
      await appendMessage(tx, {
        id: newId('message'),
        conversationId,
        role: 'user',
        senderBusinessId: input.subject.kind === 'user' ? input.subject.businessId : null,
        content:
          channelContext === null
            ? (input.userContent ?? {
                type: 'text',
                text: input.message,
                ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
              })
            : {
                type: 'text',
                text: `${channelContext}${input.message}`,
                ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
              },
        runId: run.id,
        sdkMessageUuid: userMessageUuid,
        ...(input.channel === undefined
          ? {}
          : { channelMessageId: input.channel.channelMessageId }),
      });
    }

    if (externalRequestId !== undefined) {
      await tx
        .update(externalRequestKeys)
        .set({ runId: run.id })
        .where(eq(externalRequestKeys.id, externalRequestId));
    }

    return {
      run,
      conversationId,
      inherited,
      userMessageUuid,
      ...(regenerated === undefined ? {} : { regenerate: regenerated }),
    };
  });
}
