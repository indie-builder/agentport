import { randomUUID } from 'node:crypto';
import { fail } from '@agentport/core';
import type { ExecutionSubject, RunTrigger } from '@agentport/shared';
import { ACTIVE_RUN_STATUSES } from '@agentport/shared';
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { newId } from '../../id.js';
import {
  agentRuns,
  agents,
  channelAgentBindings,
  channelMessages,
  conversations,
} from '../../schema.js';
import { channelMemberRole, lockChannelRow } from '../channels.js';
import { lockRunResources } from '../locks.js';
import { inheritApprovals } from '../runs.js';
import { CHANNEL_CONTEXT_CHAR_LIMIT, CHANNEL_CONTEXT_MESSAGE_LIMIT } from './channel-context.js';
import { createConversation } from './conversations.js';
import { appendMessage } from './messages.js';
import { type AgentRun, createRun } from './run-context.js';

const CHANNEL_CONTEXT_HEADER = '【频道上下文】\n';
const CHANNEL_CONTEXT_CURRENT = '【当前消息】\n';
const CHANNEL_CONTEXT_OMITTED = '更早的消息已省略\n';

interface ChannelContextMessage {
  kind: 'human' | 'agent' | 'system';
  authorBusinessId: string | null;
  agentId: string | null;
  body: string;
}

function channelContextLine(message: ChannelContextMessage): string {
  if (message.kind === 'human') {
    return `成员 ${(message.authorBusinessId ?? '').slice(-6)}：${message.body}\n`;
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
    agentVersion?: number;
    /** 新会话标题；缺省取消息前 80 字。非浏览器入口用它标明来源。 */
    title?: string;
    /** 用户消息的完整 content；缺省等价于 `{ type: 'text', text: input.message }`。 */
    userContent?: unknown;
    subject: ExecutionSubject;
    /** 频道触发：准入自行取建该 agent 的 lane，并从 DB 复核频道成员与绑定。 */
    channel?: { channelId: string; channelMessageId: string };
  },
): Promise<{
  run: AgentRun;
  conversationId: string;
  inherited: string[];
  /** 本轮用户消息的 SDK uuid；runner 用它发送首条用户消息。 */
  userMessageUuid: string;
}> {
  return db.transaction(async (tx) => {
    // 与记忆写入共用「发起专家 + enabled 子级」的记忆锁：集合在运行期间固定，
    // 入队前先锁住整个集合，新 run 不会在写入中途落地。
    await lockRunResources(tx, input.agentId);
    // 锁序：先 agents 再 conversations；反向会和 agent_runs 的外键检查形成删除死锁。
    const [owner] = await tx
      .select({ id: agents.id, enabled: agents.enabled })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1)
      .for('key share');
    if (!owner) fail('AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');
    // 入口的 enabled 预检在锁外；停用若在等锁期间提交，只有锁内重读才能拦住这次入队。
    if (!owner.enabled) {
      fail('AGENT_DISABLED', '该智能体已停用，无法发起新对话；请到智能体页面启用后再试');
    }
    if (input.channel === undefined && input.trigger === 'channel') {
      fail('INVALID_INPUT', '频道触发必须带频道与来源消息');
    }

    let conversationId: string;
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
      if (!binding) fail('AGENT_NOT_FOUND', '该智能体未加入频道，无法触发');
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
          inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .limit(1);
    if (active) fail('CONFLICT', '该会话仍有运行未结束，请等待完成或取消后再发送');

    const run = await createRun(tx, {
      id: newId('run'),
      conversationId,
      agentId: input.agentId,
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
    });
    // 频道 lane 由多位成员共享，单次运行批准不能跨触发者继承。
    const inherited =
      input.channel === undefined
        ? await inheritApprovals(tx, { conversationId, runId: run.id })
        : [];
    // 页面消息的 SDK 身份由平台生成：runner 用它发首条用户消息，后续按点 fork 依赖它。
    const userMessageUuid = randomUUID();
    await appendMessage(tx, {
      id: newId('message'),
      conversationId,
      role: 'user',
      senderBusinessId: input.subject.kind === 'user' ? input.subject.businessId : null,
      content:
        channelContext === null
          ? (input.userContent ?? { type: 'text', text: input.message })
          : { type: 'text', text: `${channelContext}${input.message}` },
      runId: run.id,
      sdkMessageUuid: userMessageUuid,
      ...(input.channel === undefined ? {} : { channelMessageId: input.channel.channelMessageId }),
    });

    return { run, conversationId, inherited, userMessageUuid };
  });
}
