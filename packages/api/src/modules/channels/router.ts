import { channelsContract } from '@agentport/contract/channels';
import {
  ACCOUNT_NOT_FOUND_MESSAGE,
  fail,
  removeChannelInputs,
  writeChannelAttachments,
} from '@agentport/core';
import { idSuffix, newId, repo } from '@agentport/db';
import {
  CHANNEL_MAX_WAKE_AGENTS,
  type Channel,
  type ChannelAgentBinding,
  type ChannelDetail,
  type ChannelListItem,
  type ChannelMember,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import { authorizeObject, requireUser } from '../../http/access.js';
import { actorOf, type RequestContext } from '../../http/context.js';
import { CHANNEL_MEMBER_MISSING_MESSAGE, CHANNEL_NOT_FOUND_MESSAGE } from '../../http/errors.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { getQueue } from '../../queue/producer.js';
import { requireRunQueueCapacity } from '../runs/capacity.js';
import { auditChannelRead, channelSubject } from './access.js';
import { channelsApprovalsRouter } from './approvals.js';
import { cancelRunBatch, channelsControlRouter } from './control.js';
import { channelsHandoffRouter } from './handoff.js';
import { publishChannelMessageSafely } from './publish.js';
import { channelsRunsRouter } from './runs.js';
import { dispatchChannelWakes } from './wakes.js';

const AGENT_BINDING_FORBIDDEN = '当前频道角色无权管理智能体绑定';
const MEMBER_FORBIDDEN = '当前频道角色无权管理成员';

const channelRepo = repo.channels;
function toChannel(row: repo.channels.ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function toMember(row: repo.channels.ChannelMemberRow): ChannelMember {
  return {
    channelId: row.channelId,
    businessId: row.businessId,
    role: row.role,
    lastReadSeq: row.lastReadSeq,
    name: row.name,
    image: row.image,
    createdAt: row.createdAt.toISOString(),
  };
}
function toBinding(row: repo.channels.ChannelAgentBindingRow): ChannelAgentBinding {
  return {
    channelId: row.channelId,
    agentId: row.agentId,
    conversationId: row.conversationId,
    status: row.status,
    autoWakeOnAll: row.autoWakeOnAll,
    addedBy: row.addedBy,
    createdAt: row.createdAt.toISOString(),
  };
}
function toListItem(row: repo.channels.ChannelListItemRow): ChannelListItem {
  return {
    ...toChannel(row),
    role: row.role,
    lastReadSeq: row.lastReadSeq,
    unreadCount: row.unreadCount,
    memberCount: row.memberCount,
    agentCount: row.agentCount,
    lastMessage:
      row.lastMessage === null
        ? null
        : {
            ...row.lastMessage,
            createdAt: row.lastMessage.createdAt.toISOString(),
          },
  };
}
function toDetail(detail: repo.channels.ChannelDetail): ChannelDetail {
  return {
    ...toChannel(detail.channel),
    members: detail.members.map(toMember),
    agentBindings: detail.agentBindings.map(toBinding),
  };
}
async function auditWrite(
  context: RequestContext,
  event: {
    action: string;
    target?: string;
    input?: unknown;
    subjectBusinessId?: string;
    dedupeKey?: string;
  },
): Promise<void> {
  await repo.audit.writeAudit(context.db, context.log, {
    actor: actorOf(context),
    action: event.action,
    ...(event.target === undefined ? {} : { target: event.target }),
    ...(event.input === undefined ? {} : { input: event.input }),
    ...(event.subjectBusinessId === undefined
      ? {}
      : { subjectBusinessId: event.subjectBusinessId }),
    ...(event.dedupeKey === undefined ? {} : { dedupeKey: event.dedupeKey }),
    status: 'ok',
    requestId: context.requestId,
  });
}
const os = implement(channelsContract).$context<RequestContext>();
const channelsMainRouter = {
  list: os.list.handler(async ({ input, context }) => {
    const page = requireCursorPage(
      await channelRepo.listChannels(context.db, channelSubject(context), {
        ...cursorOption(input.query.cursor),
        limit: input.query.limit,
      }),
    );
    await Promise.all(page.items.map((channel) => auditChannelRead(context, channel)));
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  }),
  create: os.create.handler(async ({ input, context }) => {
    const principal = requireUser(context);
    const channel = await channelRepo.createChannel(context.db, {
      id: newId('channel'),
      name: input.body.name,
      description: input.body.description ?? null,
      createdBy: principal.businessId,
    });
    await auditWrite(context, {
      action: 'channel.created',
      target: channel.id,
      input: { name: channel.name, description: channel.description },
    });
    return toChannel(channel);
  }),
  detail: os.detail.handler(async ({ input, context }) => {
    const result = await channelRepo.getChannelDetail(
      context.db,
      channelSubject(context),
      input.params.id,
    );
    if ('kind' in result) return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
    await auditChannelRead(context, result.channel);
    return toDetail(result);
  }),
  update: os.update.handler(async ({ input, context }) => {
    const result = await channelRepo.updateChannel(
      context.db,
      channelSubject(context),
      input.params.id,
      input.body,
    );
    switch (result.kind) {
      case 'not_found':
        return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
      case 'forbidden':
        return fail('FORBIDDEN', '当前频道角色无权管理该频道');
      case 'ok':
        await auditWrite(context, {
          action: 'channel.updated',
          target: result.channel.id,
          input: input.body,
        });
        return toChannel(result.channel);
    }
  }),
  addMember: os.addMember.handler(async ({ input, context }) => {
    const result = await channelRepo.addMember(
      context.db,
      channelSubject(context),
      input.params.id,
      input.body,
    );
    switch (result.kind) {
      case 'not_found':
        return fail(
          'NOT_FOUND',
          result.target === 'account' ? ACCOUNT_NOT_FOUND_MESSAGE : CHANNEL_NOT_FOUND_MESSAGE,
        );
      case 'forbidden':
        if (result.reason === 'account_disabled') return fail('CONFLICT', '账户已停用');
        if (result.reason === 'owner_only') return fail('FORBIDDEN', '仅频道 owner 可以授予 owner');
        return fail('FORBIDDEN', MEMBER_FORBIDDEN);
      case 'conflict':
        return fail('CONFLICT', '该账户已是频道成员');
      case 'ok':
        await auditWrite(context, {
          action: 'channel.member.added',
          target: input.params.id,
          subjectBusinessId: result.member.businessId,
          input: { role: input.body.role },
        });
        return toMember(result.member);
    }
  }),
  updateMember: os.updateMember.handler(async ({ input, context }) => {
    const result = await channelRepo.updateMemberRole(
      context.db,
      channelSubject(context),
      input.params.id,
      input.params.businessId,
      input.body.role,
    );
    switch (result.kind) {
      case 'not_found':
        return fail(
          'NOT_FOUND',
          result.target === 'member' ? '成员不存在' : CHANNEL_NOT_FOUND_MESSAGE,
        );
      case 'forbidden':
        return fail(
          'FORBIDDEN',
          result.reason === 'owner_only' ? '仅频道 owner 可以授予或修改 owner' : MEMBER_FORBIDDEN,
        );
      case 'conflict':
        return fail('CONFLICT', '最后一个 owner 不能降级');
      case 'ok':
        await auditWrite(context, {
          action: 'channel.member.role_updated',
          target: input.params.id,
          subjectBusinessId: result.member.businessId,
          input: { role: input.body.role },
        });
        return toMember(result.member);
    }
  }),
  removeMember: os.removeMember.handler(async ({ input, context }) => {
    const result = await channelRepo.removeMember(
      context.db,
      channelSubject(context),
      input.params.id,
      input.params.businessId,
    );
    switch (result.kind) {
      case 'not_found':
        return fail(
          'NOT_FOUND',
          result.target === 'member' ? '成员不存在' : CHANNEL_NOT_FOUND_MESSAGE,
        );
      case 'forbidden':
        return fail(
          'FORBIDDEN',
          result.reason === 'owner_only' ? '仅频道 owner 可以移除 owner' : MEMBER_FORBIDDEN,
        );
      case 'conflict':
        return fail('CONFLICT', '最后一个 owner 不能移除');
      case 'ok': {
        const cancel = await cancelRunBatch(context, input.params.id, result.runs);
        if (cancel.failedRunIds.length > 0) {
          context.log.warn(
            { channelId: input.params.id, failedRunIds: cancel.failedRunIds },
            'channel member removal left runs uncancelled',
          );
        }
        await auditWrite(context, {
          action: 'channel.member.removed',
          target: input.params.id,
          subjectBusinessId: input.params.businessId,
          input: { cancelledRuns: cancel.cancelled },
        });
        return undefined;
      }
    }
  }),
  addAgent: os.addAgent.handler(async ({ input, context }) => {
    const { agentId, autoWakeOnAll } = input.body;
    const access = await channelRepo.getChannelManageAccess(
      context.db,
      channelSubject(context),
      input.params.id,
    );
    if (access.kind === 'not_found') return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
    if (access.kind === 'forbidden') {
      return fail('FORBIDDEN', AGENT_BINDING_FORBIDDEN);
    }
    await authorizeObject(context, 'agents.use', { agentId }, '智能体不存在，可能已被删除');
    const result = await channelRepo.addAgentBinding(
      context.db,
      channelSubject(context),
      input.params.id,
      { agentId, autoWakeOnAll },
    );
    switch (result.kind) {
      case 'not_found':
        return fail(
          'NOT_FOUND',
          result.target === 'agent' ? '智能体不存在，可能已被删除' : CHANNEL_NOT_FOUND_MESSAGE,
        );
      case 'forbidden':
        return fail('FORBIDDEN', AGENT_BINDING_FORBIDDEN);
      case 'conflict':
        return fail('CONFLICT', '该智能体已绑定此频道');
      case 'ok':
        await auditWrite(context, {
          action: 'channel.agent.bound',
          target: input.params.id,
          input: { agentId: input.body.agentId, autoWakeOnAll: input.body.autoWakeOnAll },
        });
        return toBinding(result.binding);
    }
  }),
  updateAgent: os.updateAgent.handler(async ({ input, context }) => {
    const access = await channelRepo.getChannelManageAccess(
      context.db,
      channelSubject(context),
      input.params.id,
    );
    if (access.kind === 'not_found') return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
    if (access.kind === 'forbidden') {
      return fail('FORBIDDEN', AGENT_BINDING_FORBIDDEN);
    }
    const result = await channelRepo.updateAgentBinding(
      context.db,
      channelSubject(context),
      input.params.id,
      input.params.agentId,
      { autoWakeOnAll: input.body.autoWakeOnAll },
    );
    switch (result.kind) {
      case 'not_found':
        return fail(
          'NOT_FOUND',
          result.target === 'agent' ? '智能体绑定不存在' : CHANNEL_NOT_FOUND_MESSAGE,
        );
      case 'forbidden':
        return fail('FORBIDDEN', AGENT_BINDING_FORBIDDEN);
      case 'ok':
        await auditWrite(context, {
          action: 'channel.agent.updated',
          target: input.params.id,
          input: { agentId: input.params.agentId, autoWakeOnAll: input.body.autoWakeOnAll },
        });
        return toBinding(result.binding);
    }
  }),
  removeAgent: os.removeAgent.handler(async ({ input, context }) => {
    const result = await channelRepo.removeAgentBinding(
      context.db,
      channelSubject(context),
      input.params.id,
      input.params.agentId,
    );
    switch (result.kind) {
      case 'not_found':
        return fail(
          'NOT_FOUND',
          result.target === 'agent' ? '智能体绑定不存在' : CHANNEL_NOT_FOUND_MESSAGE,
        );
      case 'forbidden':
        return fail('FORBIDDEN', AGENT_BINDING_FORBIDDEN);
      case 'ok': {
        const cancel = await cancelRunBatch(context, input.params.id, result.runs);
        if (cancel.failedRunIds.length > 0) {
          context.log.warn(
            { channelId: input.params.id, failedRunIds: cancel.failedRunIds },
            'channel agent removal left runs uncancelled',
          );
        }
        await auditWrite(context, {
          action: 'channel.agent.removed',
          target: input.params.id,
          input: { agentId: input.params.agentId, cancelledRuns: cancel.cancelled },
        });
        return undefined;
      }
    }
  }),
  messages: os.messages.handler(async ({ input, context }) => {
    const result = await channelRepo.listMessages(
      context.db,
      channelSubject(context),
      input.params.id,
      {
        after: input.query.after,
        limit: input.query.limit,
        ...(input.query.before === undefined ? {} : { before: input.query.before }),
      },
    );
    if (result.kind === 'not_found') return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
    await auditChannelRead(context, { id: input.params.id, createdBy: result.createdBy });
    return result.items.map(repo.channels.toChannelMessage);
  }),
  postMessage: os.postMessage.handler(async ({ input, context }) => {
    const { id } = input.params;
    const principal = requireUser(context);
    const mentions = input.body.mentions ?? [];
    const mentionAll = input.body.mentionAll ?? false;
    const wakes = mentions.length > 0 || mentionAll;
    if (wakes) {
      const role = await channelRepo.channelMemberRole(context.db, id, principal.businessId);
      if (role === null) return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
      if (role === 'viewer') return fail('FORBIDDEN', 'viewer 不能发言');
    }
    if (wakes) await requireRunQueueCapacity();
    const messageId = newId('channelMessage');
    const attachments = await writeChannelAttachments({
      root: context.config.WORKSPACES_DIR,
      channelId: id,
      messageId,
      inputs: input.body.attachments ?? [],
    });
    const discardAttachments = async (): Promise<void> => {
      if (attachments.length === 0) return;
      try {
        await removeChannelInputs({
          root: context.config.WORKSPACES_DIR,
          channelId: id,
          messageId,
        });
      } catch (err) {
        context.log.warn({ err, channelId: id, messageId }, 'channel attachment cleanup failed');
      }
    };
    let result: Awaited<ReturnType<typeof channelRepo.postMessage>>;
    try {
      result = await channelRepo.postMessage(context.db, channelSubject(context), id, {
        id: messageId,
        body: input.body.body ?? '',
        ...(input.body.clientMessageId === undefined
          ? {}
          : { clientMessageId: input.body.clientMessageId }),
        ...(mentions.length === 0 ? {} : { mentions }),
        ...(mentionAll ? { mentionAll } : {}),
        ...(attachments.length === 0 ? {} : { attachments }),
      });
    } catch (err) {
      await discardAttachments();
      throw err;
    }
    if (result.kind !== 'ok' || result.duplicate) {
      await discardAttachments();
    }
    switch (result.kind) {
      case 'not_found':
        return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
      case 'forbidden':
        return fail('FORBIDDEN', 'viewer 不能发言');
      case 'invalid_mentions':
        return fail('INVALID_INPUT', '只能 @ 已绑定且状态正常的智能体');
      case 'too_many_wakes':
        return fail('INVALID_INPUT', `一次最多唤醒 ${CHANNEL_MAX_WAKE_AGENTS} 个智能体`);
      case 'ok': {
        const message = repo.channels.toChannelMessage(result.message);
        await auditWrite(context, {
          action: 'channel.message.posted',
          target: message.id,
          input: {
            channelId: id,
            mentions,
            mentionAll,
            attachmentCount: attachments.length,
            attachmentNames: attachments.map((attachment) => attachment.filename),
          },
          dedupeKey: `aud_chmsg_${idSuffix(message.id)}`,
        });
        await publishChannelMessageSafely(context.log, id, message, { seq: message.seq });
        await dispatchChannelWakes({
          db: context.db,
          log: context.log,
          queue: getQueue(),
          workspacesDir: context.config.WORKSPACES_DIR,
          anthropicBaseUrl: context.config.ANTHROPIC_BASE_URL,
          channelMessageId: message.id,
        });
        return { status: result.duplicate ? (200 as const) : (201 as const), body: message };
      }
    }
  }),
  markRead: os.markRead.handler(async ({ input, context }) => {
    const result = await channelRepo.markRead(
      context.db,
      channelSubject(context),
      input.params.id,
      input.body.seq,
    );
    if (result.kind === 'not_found') return fail('NOT_FOUND', CHANNEL_MEMBER_MISSING_MESSAGE);
    return { lastReadSeq: result.lastReadSeq };
  }),
};

export const channelsRouter = {
  ...channelsMainRouter,
  ...channelsControlRouter,
  ...channelsApprovalsRouter,
  ...channelsHandoffRouter,
  ...channelsRunsRouter,
};
