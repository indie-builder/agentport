import { channelsContract } from '@agentport/contract/channels';
import { fail } from '@agentport/core';
import { newId, repo } from '@agentport/db';
import {
  type Channel,
  type ChannelAgentBinding,
  type ChannelDetail,
  type ChannelEvent,
  type ChannelListItem,
  type ChannelMember,
  type ChannelMessage,
  channelEventsQuerySchema,
  idParams,
  RUN_QUEUE_MAX_WAITING,
  runEnqueueOptions,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import type { Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { authorize, authorizeObject, requireUser } from '../../http/access.js';
import type { HttpEnv, RequestContext } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { AppError } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import {
  getQueue,
  publishChannelMessage,
  type RunSubscription,
  subscribeChannel,
} from '../../queue/producer.js';
import type { NativeHttpDependencies } from '../chat/http.js';
import { failQueuedRunEnqueue } from '../runs/enqueue.js';
import { channelsApprovalsRouter } from './approvals.js';
import { channelsControlRouter } from './control.js';

const channelRepo = repo.channels;
const SSE_BATCH = 200;
const SSE_POLL_MS = 3000;
const LANE_BUSY_NOTICE = '当前智能体正在处理上一轮消息，本条已保存；请等它结束后再 @ 继续。';
function subjectFor(context: RequestContext): {
  businessId: string;
} {
  return { businessId: requireUser(context).businessId };
}
function isPlatformReader(context: RequestContext): boolean {
  return requireUser(context).grants.some(
    (grant) => grant.permissionId === 'conversations.read' && grant.scope === 'platform',
  );
}
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
function toMessage(row: repo.channels.ChannelMessageRow): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    kind: row.kind,
    authorBusinessId: row.authorBusinessId,
    agentId: row.agentId,
    runId: row.runId,
    body: row.body,
    clientMessageId: row.clientMessageId,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}
function toListItem(row: repo.channels.ChannelListItemRow): ChannelListItem {
  return {
    ...toChannel(row),
    role: row.role,
    lastReadSeq: row.lastReadSeq,
    unreadCount: row.unreadCount,
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
function notFound(message = '频道不存在'): never {
  return fail('NOT_FOUND', message);
}
async function publishMessage(
  context: RequestContext,
  channelId: string,
  message: ChannelMessage,
): Promise<void> {
  try {
    await publishChannelMessage(channelId, message);
  } catch (err) {
    context.log.warn(
      { err, channelId, seq: message.seq },
      'channel event publish failed; SSE will recover from DB replay',
    );
  }
}
function forbidden(message: string): never {
  return fail('FORBIDDEN', message);
}
function conflict(message: string): never {
  return fail('CONFLICT', message);
}
const auditRead = async (
  context: RequestContext,
  channel: {
    id: string;
    createdBy: string;
  },
): Promise<void> => {
  if (!isPlatformReader(context)) return;
  await authorize(context, 'conversations.read', {
    objectId: channel.id,
    createdBy: channel.createdBy,
    privateContent: true,
  });
};
async function writeEvent(stream: SSEStreamingApi, event: ChannelEvent): Promise<void> {
  await stream.writeSSE({ data: JSON.stringify(event) });
}
const os = implement(channelsContract).$context<RequestContext>();
export const channelsMainRouter = {
  list: os.list.handler(async ({ context }) => {
    const items = await channelRepo.listChannels(context.db, subjectFor(context));
    await Promise.all(items.map((channel) => auditRead(context, channel)));
    return items.map(toListItem);
  }),
  create: os.create.handler(async ({ input, context }) => {
    const principal = requireUser(context);
    const channel = await channelRepo.createChannel(context.db, {
      id: newId('channel'),
      name: input.body.name,
      description: input.body.description ?? null,
      createdBy: principal.businessId,
    });
    return toChannel(channel);
  }),
  detail: os.detail.handler(async ({ input, context }) => {
    const result = await channelRepo.getChannelDetail(
      context.db,
      subjectFor(context),
      input.params.id,
    );
    if ('kind' in result) return notFound();
    await auditRead(context, result.channel);
    return toDetail(result);
  }),
  update: os.update.handler(async ({ input, context }) => {
    const result = await channelRepo.updateChannel(
      context.db,
      subjectFor(context),
      input.params.id,
      input.body,
    );
    switch (result.kind) {
      case 'not_found':
        return notFound();
      case 'forbidden':
        return forbidden('当前频道角色无权管理该频道');
      case 'ok':
        return toChannel(result.channel);
    }
  }),
  addMember: os.addMember.handler(async ({ input, context }) => {
    const result = await channelRepo.addMember(
      context.db,
      subjectFor(context),
      input.params.id,
      input.body,
    );
    switch (result.kind) {
      case 'not_found':
        return result.target === 'account' ? notFound('账户不存在') : notFound();
      case 'forbidden':
        if (result.reason === 'account_disabled') return conflict('账户已停用');
        if (result.reason === 'owner_only') return forbidden('仅频道 owner 可以授予 owner');
        return forbidden('当前频道角色无权管理成员');
      case 'conflict':
        return conflict('该账户已是频道成员');
      case 'ok':
        return toMember(result.member);
    }
  }),
  removeMember: os.removeMember.handler(async ({ input, context }) => {
    const result = await channelRepo.removeMember(
      context.db,
      subjectFor(context),
      input.params.id,
      input.params.businessId,
    );
    switch (result.kind) {
      case 'not_found':
        return result.target === 'member' ? notFound('成员不存在') : notFound();
      case 'forbidden':
        return result.reason === 'owner_only'
          ? forbidden('仅频道 owner 可以移除 owner')
          : forbidden('当前频道角色无权管理成员');
      case 'conflict':
        return conflict('最后一个 owner 不能移除');
      case 'ok':
        return undefined;
    }
  }),
  addAgent: os.addAgent.handler(async ({ input, context }) => {
    const { agentId, autoWakeOnAll } = input.body;
    const access = await channelRepo.getChannelManageAccess(
      context.db,
      subjectFor(context),
      input.params.id,
    );
    if (access.kind === 'not_found') return notFound();
    if (access.kind === 'forbidden') {
      return forbidden('当前频道角色无权管理智能体绑定');
    }
    await authorizeObject(context, 'agents.use', { agentId }, '智能体不存在，可能已被删除');
    const result = await channelRepo.addAgentBinding(
      context.db,
      subjectFor(context),
      input.params.id,
      { agentId, autoWakeOnAll },
    );
    switch (result.kind) {
      case 'not_found':
        return result.target === 'agent' ? notFound('智能体不存在，可能已被删除') : notFound();
      case 'forbidden':
        return forbidden('当前频道角色无权管理智能体绑定');
      case 'conflict':
        return conflict('该智能体已绑定此频道');
      case 'ok':
        return toBinding(result.binding);
    }
  }),
  removeAgent: os.removeAgent.handler(async ({ input, context }) => {
    const result = await channelRepo.removeAgentBinding(
      context.db,
      subjectFor(context),
      input.params.id,
      input.params.agentId,
    );
    switch (result.kind) {
      case 'not_found':
        return result.target === 'agent' ? notFound('智能体绑定不存在') : notFound();
      case 'forbidden':
        return forbidden('当前频道角色无权管理智能体绑定');
      case 'ok':
        return undefined;
    }
  }),
  messages: os.messages.handler(async ({ input, context }) => {
    const result = await channelRepo.listMessages(
      context.db,
      subjectFor(context),
      input.params.id,
      input.query,
    );
    if (result.kind === 'not_found') return notFound();
    await auditRead(context, { id: input.params.id, createdBy: result.createdBy });
    return result.items.map(toMessage);
  }),
  postMessage: os.postMessage.handler(async ({ input, context }) => {
    const { id } = input.params;
    const principal = requireUser(context);
    const mentions = input.body.mentions ?? [];
    const mentionAll = input.body.mentionAll ?? false;
    const wakes = mentions.length > 0 || mentionAll;
    if (wakes) {
      const role = await channelRepo.channelMemberRole(context.db, id, principal.businessId);
      if (role === null) return notFound();
      if (role === 'viewer') return forbidden('viewer 不能发言');
    }
    if (wakes && (await getQueue().getWaitingCount()) > RUN_QUEUE_MAX_WAITING) {
      return fail('SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
    }
    const result = await channelRepo.postMessage(context.db, subjectFor(context), id, {
      id: newId('channelMessage'),
      body: input.body.body,
      ...(input.body.clientMessageId === undefined
        ? {}
        : { clientMessageId: input.body.clientMessageId }),
      ...(mentions.length === 0 ? {} : { mentions }),
      ...(mentionAll ? { mentionAll } : {}),
    });
    switch (result.kind) {
      case 'not_found':
        return notFound();
      case 'forbidden':
        return forbidden('viewer 不能发言');
      case 'invalid_mentions':
        return fail('INVALID_INPUT', '只能 @ 已绑定且状态正常的智能体');
      case 'ok': {
        const message = toMessage(result.message);
        await publishMessage(context, id, message);
        for (const agentId of result.wakeAgentIds) {
          const agentVersion = await repo.agentVersions.latestAgentVersion(context.db, agentId);
          let admitted: Awaited<ReturnType<typeof repo.chat.admitChatRun>>;
          try {
            admitted = await repo.chat.admitChatRun(context.db, {
              agentId,
              message: input.body.body,
              subject: { kind: 'user', businessId: principal.businessId },
              ...(agentVersion === null ? {} : { agentVersion }),
              trigger: 'channel',
              channel: { channelId: id, channelMessageId: message.id },
            });
          } catch (err) {
            if (err instanceof AppError && err.code === 'CONFLICT') {
              const notice = await channelRepo.postSystemMessage(context.db, {
                channelId: id,
                agentId,
                body: LANE_BUSY_NOTICE,
              });
              if (notice !== null) await publishMessage(context, id, toMessage(notice));
              continue;
            }
            throw err;
          }
          try {
            await getQueue().add(
              'run',
              {
                runId: admitted.run.id,
                agentId,
                conversationId: admitted.conversationId,
                prompt: input.body.body,
              },
              runEnqueueOptions(admitted.run.id),
            );
          } catch {
            try {
              await failQueuedRunEnqueue(context.db, admitted.run.id);
            } catch {
              context.log.warn(
                { runId: admitted.run.id },
                'channel enqueue failure cleanup failed',
              );
            }
            return fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
          }
        }
        return { status: result.duplicate ? (200 as const) : (201 as const), body: message };
      }
    }
  }),
  markRead: os.markRead.handler(async ({ input, context }) => {
    const result = await channelRepo.markRead(
      context.db,
      subjectFor(context),
      input.params.id,
      input.body.seq,
    );
    if (result.kind === 'not_found') return notFound('频道不存在或你不是频道成员');
    return { lastReadSeq: result.lastReadSeq };
  }),
};
export function registerChannelEventsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  app.get('/api/channels/:id/events', access({ kind: 'authenticated' }), async (c) => {
    const context = requestContext(c);
    const input = z
      .object({ params: idParams, query: channelEventsQuerySchema })
      .parse({ params: c.req.param(), query: c.req.query() });
    const { id } = input.params;
    const subject = subjectFor(context);
    const initial = await channelRepo.listMessages(context.db, subject, id, {
      after: input.query.after,
      limit: SSE_BATCH,
    });
    if (initial.kind === 'not_found') return notFound();
    if (input.query.after > initial.maxSeq) {
      return fail('INVALID_INPUT', '事件游标超过频道当前消息序号');
    }
    await auditRead(context, { id, createdBy: initial.createdBy });
    deps.timeout(c.req.raw, 0);
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    let cursor = input.query.after;
    return streamSSE(c, async (stream) => {
      await stream.write('retry: 3000\n\n');
      let resolveClosed!: () => void;
      const ended = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionAbort = new AbortController();
      let subscription: RunSubscription | undefined;
      let catchUpTail: Promise<void> = Promise.resolve();
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        resolveClosed();
        c.req.raw.signal.removeEventListener('abort', cleanup);
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        subscriptionAbort.abort();
        subscription?.close();
      };
      const finish = (): void => {
        cleanup();
        void stream.close();
      };
      const lostAccess = async (): Promise<void> => {
        try {
          await writeEvent(stream, {
            type: 'error',
            code: 'FORBIDDEN',
            message: '当前账户已无权读取该频道，已停止接收。',
          });
        } finally {
          finish();
        }
      };
      const sendMessages = async (rows: repo.channels.ChannelMessageRow[]): Promise<void> => {
        for (const row of rows) {
          if (closed) return;
          const access = await channelRepo.getChannelReadAccess(context.db, subject, id);
          if (closed) return;
          if (!access) {
            await lostAccess();
            return;
          }
          const message = toMessage(row);
          cursor = message.seq;
          await writeEvent(stream, {
            type: 'message.created',
            channelId: id,
            seq: message.seq,
            message,
          });
        }
      };
      const catchUp = async (): Promise<void> => {
        for (;;) {
          if (closed) return;
          let page: Awaited<ReturnType<typeof channelRepo.listMessages>>;
          try {
            page = await channelRepo.listMessages(context.db, subject, id, {
              after: cursor,
              limit: SSE_BATCH,
            });
          } catch (err) {
            context.log.warn({ err, channelId: id }, 'channel sse catch-up failed');
            return;
          }
          if (closed) return;
          if (page.kind === 'not_found') {
            await lostAccess();
            return;
          }
          if (page.items.length === 0) return;
          try {
            await sendMessages(page.items);
          } catch (err) {
            context.log.error({ err, channelId: id }, 'channel sse write failed');
            finish();
            return;
          }
          if (page.items.length < SSE_BATCH) return;
        }
      };
      const enqueueCatchUp = (): Promise<void> => {
        catchUpTail = catchUpTail.then(catchUp, catchUp);
        return catchUpTail;
      };
      stream.onAbort(cleanup);
      if (c.req.raw.signal.aborted) cleanup();
      else c.req.raw.signal.addEventListener('abort', cleanup, { once: true });
      try {
        await sendMessages(initial.items);
        if (initial.items.length === SSE_BATCH) await catchUp();
      } catch (err) {
        context.log.error({ err, channelId: id }, 'channel sse history failed');
        finish();
        return;
      }
      if (closed) return;
      const schedulePoll = (): void => {
        if (closed) return;
        pollTimer = setTimeout(() => {
          pollTimer = undefined;
          void enqueueCatchUp().finally(schedulePoll);
        }, SSE_POLL_MS);
      };
      schedulePoll();
      try {
        subscription = await subscribeChannel(
          id,
          async (event) => {
            if (closed) return;
            if (event.type === 'error') {
              if (event.message === 'Server shutting down') {
                finish();
                return;
              }
              context.log.warn(
                { channelId: id },
                'channel redis subscription ended; DB polling continues',
              );
              return;
            }
            await enqueueCatchUp();
            if (closed || event.type === 'message.created') return;
            const access = await channelRepo.getChannelReadAccess(context.db, subject, id);
            if (closed) return;
            if (!access) {
              await lostAccess();
              return;
            }
            try {
              await writeEvent(stream, event);
            } catch (err) {
              context.log.error({ err, channelId: id }, 'channel sse write failed');
              finish();
            }
          },
          subscriptionAbort.signal,
        );
      } catch (err) {
        context.log.warn(
          { err, channelId: id },
          'channel sse subscribe failed; DB polling continues',
        );
        await ended;
        return;
      }
      if (closed) subscription.close();
      await ended;
    });
  });
}

export const channelsRouter = {
  ...channelsMainRouter,
  ...channelsControlRouter,
  ...channelsApprovalsRouter,
};
