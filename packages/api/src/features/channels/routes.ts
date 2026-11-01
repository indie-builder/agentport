import { newId, repo, schema } from '@agentport/db';
import {
  type Channel,
  type ChannelAgentBinding,
  type ChannelDetail,
  type ChannelEvent,
  type ChannelListItem,
  type ChannelMember,
  type ChannelMessage,
  channelAgentInputSchema,
  channelCreateSchema,
  channelEventsQuerySchema,
  channelMemberInputSchema,
  channelMessageInputSchema,
  channelMessagesQuerySchema,
  channelReadInputSchema,
  channelUpdateSchema,
  idParams,
  RUN_QUEUE_MAX_WAITING,
  runEnqueueOptions,
} from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, reject } from '../../plugins/errors.js';
import {
  getQueue,
  publishChannelMessage,
  type RunSubscription,
  subscribeChannel,
} from '../../queue/producer.js';
import { typed } from '../../types.js';
import { authorizeObject, userPrincipal } from '../access.js';
import { registerChannelControlRoutes } from './control.js';

const channelRepo = repo.channels;

const memberParams = z.object({ id: z.string().min(1), businessId: z.string().min(1) });
const agentParams = z.object({ id: z.string().min(1), agentId: z.string().min(1) });

/** 历史与实时补拉共用一页上限；SSE 循环直到页不满才停。 */
const SSE_BATCH = 200;
/** 无 outbox：发布失败靠短周期 DB 补读兜底，避免在线观众永久漏一条。 */
const SSE_POLL_MS = 3_000;

const LANE_BUSY_NOTICE = '当前智能体正在处理上一轮消息，本条已保存；请等它结束后再 @ 继续。';

function subjectFor(request: FastifyRequest): { businessId: string } {
  return { businessId: userPrincipal(request).businessId };
}

/** 成员身份决定能否进入频道；平台范围只用于跨用户读取审计。 */
function isPlatformReader(request: FastifyRequest): boolean {
  return userPrincipal(request).grants.some(
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

/** SSE 写端背压：drain 前等待，客户端断开也会结束等待。 */
async function writeEvent(reply: FastifyReply, event: ChannelEvent): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  if (reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      reply.raw.off('drain', done);
      reply.raw.off('close', done);
      reply.raw.off('error', done);
      resolve();
    };
    reply.raw.once('drain', done);
    reply.raw.once('close', done);
    reply.raw.once('error', done);
  });
}

function notFound(reply: FastifyReply, message = '频道不存在'): FastifyReply {
  return reject(reply, 'NOT_FOUND', message);
}

/** DB 已提交后再发布：实时通知失败不影响消息本身，SSE 会按 seq 从库补拉。 */
async function publishMessage(
  request: FastifyRequest,
  channelId: string,
  message: ChannelMessage,
): Promise<void> {
  try {
    await publishChannelMessage(channelId, message);
  } catch (err) {
    request.log.warn(
      { err, channelId, seq: message.seq },
      'channel event publish failed; SSE will recover from DB replay',
    );
  }
}

function forbidden(reply: FastifyReply, message: string): FastifyReply {
  return reject(reply, 'FORBIDDEN', message);
}

function conflict(reply: FastifyReply, message: string): FastifyReply {
  return reject(reply, 'CONFLICT', message);
}

export function registerChannelRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  registerChannelControlRoutes(rawApp);

  const auditRead = async (
    request: FastifyRequest,
    channel: { id: string; createdBy: string },
  ): Promise<void> => {
    if (!isPlatformReader(request)) return;
    await app.authorize(request, 'conversations.read', {
      objectId: channel.id,
      createdBy: channel.createdBy,
      privateContent: true,
    });
  };

  app.get(
    '/api/channels',
    { config: { access: { kind: 'authenticated' } } },
    async (request, reply) => {
      const items = await channelRepo.listChannels(app.db, subjectFor(request));
      await Promise.all(items.map((channel) => auditRead(request, channel)));
      return reply.send(items.map(toListItem));
    },
  );

  app.post(
    '/api/channels',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { body: channelCreateSchema },
    },
    async (request, reply) => {
      const principal = userPrincipal(request);
      const channel = await channelRepo.createChannel(app.db, {
        id: newId('channel'),
        name: request.body.name,
        description: request.body.description ?? null,
        createdBy: principal.businessId,
      });
      return reply.status(201).send(toChannel(channel));
    },
  );

  app.get(
    '/api/channels/:id',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const result = await channelRepo.getChannelDetail(
        app.db,
        subjectFor(request),
        request.params.id,
      );
      if ('kind' in result) return notFound(reply);
      await auditRead(request, result.channel);
      return reply.send(toDetail(result));
    },
  );

  app.patch(
    '/api/channels/:id',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams, body: channelUpdateSchema },
    },
    async (request, reply) => {
      const result = await channelRepo.updateChannel(
        app.db,
        subjectFor(request),
        request.params.id,
        request.body,
      );
      switch (result.kind) {
        case 'not_found':
          return notFound(reply);
        case 'forbidden':
          return forbidden(reply, '当前频道角色无权管理该频道');
        case 'ok':
          return reply.send(toChannel(result.channel));
      }
    },
  );

  app.post(
    '/api/channels/:id/members',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams, body: channelMemberInputSchema },
    },
    async (request, reply) => {
      const result = await channelRepo.addMember(
        app.db,
        subjectFor(request),
        request.params.id,
        request.body,
      );
      switch (result.kind) {
        case 'not_found':
          return result.target === 'account' ? notFound(reply, '账户不存在') : notFound(reply);
        case 'forbidden':
          if (result.reason === 'account_disabled') return conflict(reply, '账户已停用');
          if (result.reason === 'owner_only')
            return forbidden(reply, '仅频道 owner 可以授予 owner');
          return forbidden(reply, '当前频道角色无权管理成员');
        case 'conflict':
          return conflict(reply, '该账户已是频道成员');
        case 'ok':
          return reply.status(201).send(toMember(result.member));
      }
    },
  );

  app.delete(
    '/api/channels/:id/members/:businessId',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: memberParams },
    },
    async (request, reply) => {
      const result = await channelRepo.removeMember(
        app.db,
        subjectFor(request),
        request.params.id,
        request.params.businessId,
      );
      switch (result.kind) {
        case 'not_found':
          return result.target === 'member' ? notFound(reply, '成员不存在') : notFound(reply);
        case 'forbidden':
          return result.reason === 'owner_only'
            ? forbidden(reply, '仅频道 owner 可以移除 owner')
            : forbidden(reply, '当前频道角色无权管理成员');
        case 'conflict':
          return conflict(reply, '最后一个 owner 不能移除');
        case 'ok':
          return reply.status(204).send();
      }
    },
  );

  app.post(
    '/api/channels/:id/agents',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams, body: channelAgentInputSchema },
    },
    async (request, reply) => {
      const { agentId, autoWakeOnAll } = request.body;
      // 频道成员关系先于对象权限收口：非成员 404、成员不足 403，不借专家权限泄露其存在性。
      const access = await channelRepo.getChannelManageAccess(
        app.db,
        subjectFor(request),
        request.params.id,
      );
      if (access.kind === 'not_found') return notFound(reply);
      if (access.kind === 'forbidden') {
        return forbidden(reply, '当前频道角色无权管理智能体绑定');
      }
      // 绑定 agent 仍走现有对象范围授权，频道角色不能替代专家可用性判定。
      await authorizeObject(app, request, 'agents.use', { agentId }, '智能体不存在，可能已被删除');
      const result = await channelRepo.addAgentBinding(
        app.db,
        subjectFor(request),
        request.params.id,
        { agentId, autoWakeOnAll },
      );
      switch (result.kind) {
        case 'not_found':
          return result.target === 'agent'
            ? notFound(reply, '智能体不存在，可能已被删除')
            : notFound(reply);
        case 'forbidden':
          return forbidden(reply, '当前频道角色无权管理智能体绑定');
        case 'conflict':
          return conflict(reply, '该智能体已绑定此频道');
        case 'ok':
          return reply.status(201).send(toBinding(result.binding));
      }
    },
  );

  app.delete(
    '/api/channels/:id/agents/:agentId',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: agentParams },
    },
    async (request, reply) => {
      const result = await channelRepo.removeAgentBinding(
        app.db,
        subjectFor(request),
        request.params.id,
        request.params.agentId,
      );
      switch (result.kind) {
        case 'not_found':
          return result.target === 'agent' ? notFound(reply, '智能体绑定不存在') : notFound(reply);
        case 'forbidden':
          return forbidden(reply, '当前频道角色无权管理智能体绑定');
        case 'ok':
          return reply.status(204).send();
      }
    },
  );

  app.get(
    '/api/channels/:id/messages',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams, querystring: channelMessagesQuerySchema },
    },
    async (request, reply) => {
      const result = await channelRepo.listMessages(
        app.db,
        subjectFor(request),
        request.params.id,
        request.query,
      );
      if (result.kind === 'not_found') return notFound(reply);
      await auditRead(request, { id: request.params.id, createdBy: result.createdBy });
      return reply.send(result.items.map(toMessage));
    },
  );

  app.post(
    '/api/channels/:id/messages',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams, body: channelMessageInputSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const principal = userPrincipal(request);
      const mentions = request.body.mentions ?? [];
      const mentionAll = request.body.mentionAll ?? false;
      const wakes = mentions.length > 0 || mentionAll;
      // 队列状态不能先于频道身份暴露：非成员 404、viewer 403，事务内仍复核成员身份。
      if (wakes) {
        const role = await channelRepo.channelMemberRole(app.db, id, principal.businessId);
        if (role === null) return notFound(reply);
        if (role === 'viewer') return forbidden(reply, 'viewer 不能发言');
      }
      // 只有可能唤醒 lane 时才依赖 Redis：无 @ 的频道消息不因运行队列容量被拒。
      if (wakes && (await getQueue().getWaitingCount()) > RUN_QUEUE_MAX_WAITING) {
        return reject(reply, 'SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
      }

      const result = await channelRepo.postMessage(app.db, subjectFor(request), id, {
        id: newId('channelMessage'),
        body: request.body.body,
        ...(request.body.clientMessageId === undefined
          ? {}
          : { clientMessageId: request.body.clientMessageId }),
        ...(mentions.length === 0 ? {} : { mentions }),
        ...(mentionAll ? { mentionAll } : {}),
      });
      switch (result.kind) {
        case 'not_found':
          return notFound(reply);
        case 'forbidden':
          return forbidden(reply, 'viewer 不能发言');
        case 'invalid_mentions':
          return reject(reply, 'INVALID_INPUT', '只能 @ 已绑定且状态正常的智能体');
        case 'ok': {
          const message = toMessage(result.message);
          // DB 已提交：发布失败只影响实时通知，不把消息报成未保存；重连按 seq 回放。
          await publishMessage(request, id, message);

          for (const agentId of result.wakeAgentIds) {
            const agentVersion = await repo.agentVersions.latestAgentVersion(app.db, agentId);
            let admitted: Awaited<ReturnType<typeof repo.chat.admitChatRun>>;
            try {
              admitted = await repo.chat.admitChatRun(app.db, {
                agentId,
                message: request.body.body,
                subject: { kind: 'user', businessId: principal.businessId },
                ...(agentVersion === null ? {} : { agentVersion }),
                trigger: 'channel',
                channel: { channelId: id, channelMessageId: message.id },
              });
            } catch (err) {
              // shortcut: 忙碌只跳过这一条 lane、不阻塞其他被 @ 的 agent，P1 再排队合并。
              if (err instanceof AppError && err.code === 'CONFLICT') {
                const notice = await channelRepo.postSystemMessage(app.db, {
                  channelId: id,
                  agentId,
                  body: LANE_BUSY_NOTICE,
                });
                // 关闭竞态的赢家已经归档：不再补写误提示。
                if (notice !== null) await publishMessage(request, id, toMessage(notice));
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
                  prompt: request.body.body,
                },
                runEnqueueOptions(admitted.run.id),
              );
            } catch {
              // 与 chat 一致：消息已落库，只把这条 run 收敛为终态并报告入队失败。
              try {
                await app.db
                  .update(schema.agentRuns)
                  .set({
                    status: 'failed',
                    endedAt: new Date(),
                    error: '消息入队失败，请重新发送。',
                    errorKind: 'infra',
                  })
                  .where(
                    and(
                      eq(schema.agentRuns.id, admitted.run.id),
                      eq(schema.agentRuns.status, 'queued'),
                    ),
                  );
              } catch {
                request.log.warn(
                  { runId: admitted.run.id },
                  'channel enqueue failure cleanup failed',
                );
              }
              return reject(reply, 'SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
            }
          }
          return reply.status(result.duplicate ? 200 : 201).send(message);
        }
      }
    },
  );

  app.post(
    '/api/channels/:id/read',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams, body: channelReadInputSchema },
    },
    async (request, reply) => {
      const result = await channelRepo.markRead(
        app.db,
        subjectFor(request),
        request.params.id,
        request.body.seq,
      );
      if (result.kind === 'not_found') return notFound(reply, '频道不存在或你不是频道成员');
      return reply.send({ lastReadSeq: result.lastReadSeq });
    },
  );

  app.get(
    '/api/channels/:id/events',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams, querystring: channelEventsQuerySchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const subject = subjectFor(request);
      // 首次历史同时也是访问校验：非成员在 hijack 前按 404 收口。
      const initial = await channelRepo.listMessages(app.db, subject, id, {
        after: request.query.after,
        limit: SSE_BATCH,
      });
      if (initial.kind === 'not_found') return notFound(reply);
      if (request.query.after > initial.maxSeq) {
        return reject(reply, 'INVALID_INPUT', '事件游标超过频道当前消息序号');
      }
      await auditRead(request, { id, createdBy: initial.createdBy });

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write('retry: 3000\n\n');

      let cursor = request.query.after;
      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionAbort = new AbortController();
      let subscription: RunSubscription | undefined;
      let catchUpTail: Promise<void> = Promise.resolve();

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        subscriptionAbort.abort();
        subscription?.close();
      };
      const finish = (): void => {
        cleanup();
        reply.raw.end();
      };

      const lostAccess = async (): Promise<void> => {
        try {
          await writeEvent(reply, {
            type: 'error',
            message: '当前账户已无权读取该频道，已停止接收。',
          });
        } finally {
          finish();
        }
      };

      const sendMessages = async (rows: repo.channels.ChannelMessageRow[]): Promise<void> => {
        for (const row of rows) {
          if (closed) return;
          const access = await channelRepo.getChannelReadAccess(app.db, subject, id);
          if (closed) return;
          if (!access) {
            await lostAccess();
            return;
          }
          const message = toMessage(row);
          cursor = message.seq;
          await writeEvent(reply, {
            type: 'message.created',
            channelId: id,
            seq: message.seq,
            message,
          });
        }
      };

      // Redis 事件只是唤醒，正文与顺序按 DB 的 seq 补拉，并重新校验成员关系。
      const catchUp = async (): Promise<void> => {
        for (;;) {
          if (closed) return;
          let page: Awaited<ReturnType<typeof channelRepo.listMessages>>;
          try {
            page = await channelRepo.listMessages(app.db, subject, id, {
              after: cursor,
              limit: SSE_BATCH,
            });
          } catch (err) {
            request.log.warn({ err, channelId: id }, 'channel sse catch-up failed');
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
            request.log.error({ err, channelId: id }, 'channel sse write failed');
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

      const onClose = (): void => cleanup();
      request.raw.on('close', onClose);
      request.raw.on('aborted', onClose);
      reply.raw.on('close', onClose);
      reply.raw.on('error', onClose);

      try {
        await sendMessages(initial.items);
        if (initial.items.length === SSE_BATCH) await catchUp();
      } catch (err) {
        request.log.error({ err, channelId: id }, 'channel sse history failed');
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
              request.log.warn(
                { channelId: id },
                'channel redis subscription ended; DB polling continues',
              );
              return;
            }
            // Redis 事件只是唤醒：消息按 DB seq 补拉；生命周期提示补拉完再校验读权限后转发。
            await enqueueCatchUp();
            if (closed || event.type === 'message.created') return;
            const access = await channelRepo.getChannelReadAccess(app.db, subject, id);
            if (closed) return;
            if (!access) {
              await lostAccess();
              return;
            }
            try {
              await writeEvent(reply, event);
            } catch (err) {
              request.log.error({ err, channelId: id }, 'channel sse write failed');
              finish();
            }
          },
          subscriptionAbort.signal,
        );
      } catch (err) {
        request.log.warn(
          { err, channelId: id },
          'channel sse subscribe failed; DB polling continues',
        );
        return;
      }

      if (closed) subscription.close();
    },
  );
}
