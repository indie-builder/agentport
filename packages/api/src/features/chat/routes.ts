import { fail } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import {
  type ChatEvent,
  chatRequestSchema,
  conversationRenameSchema,
  idParams,
  RUN_QUEUE_MAX_WAITING,
  runEnqueueOptions,
  wireFailureKind,
} from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { chatRateLimit } from '../../plugins/security.js';
import { closeProducer, getQueue, subscribeRun } from '../../queue/producer.js';
import { typed } from '../../types.js';
import { cancelAgentRun } from './cancel-run.js';

const chatRepo = repo.chat;

const runIdParams = z.object({ runId: z.string().min(1) });
const branchBodySchema = z.object({ fromMessageId: z.string().min(1).optional() });
const listQuery = z.object({
  agentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().min(1).optional(),
});

/** worker 已把终态写进数据库但没能发出 run_finished 时，观众靠这个间隔兜底。 */
const TERMINAL_RECHECK_MS = 2_000;

type RunRow = NonNullable<Awaited<ReturnType<typeof chatRepo.getRun>>>;

/** 只对已进入终态的 run 生成 run_finished；queued/running 返回 null。 */
function terminalEvent(run: RunRow): ChatEvent | null {
  switch (run.status) {
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'timeout':
      return {
        type: 'run_finished',
        status: run.status,
        ...(run.costUsd !== null ? { costUsd: Number(run.costUsd) } : {}),
        ...(run.turns !== null ? { turns: run.turns } : {}),
        ...(run.error !== null ? { error: run.error } : {}),
        ...(run.errorKind === null ? {} : { failureKind: wireFailureKind(run.errorKind) }),
      };
    default:
      return null;
  }
}

async function writeEvent(reply: FastifyReply, event: ChatEvent): Promise<void> {
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

export function registerChatRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  app.post(
    '/api/chat',
    {
      preHandler: [rawApp.requireAuth],
      ...chatRateLimit,
      schema: { body: chatRequestSchema },
    },
    async (request, reply) => {
      const { agentId, message } = request.body;

      if (!(await chatRepo.agentExists(app.db, agentId))) {
        return reject(reply, 'AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');
      }
      // 停用的智能体不应能发起新运行；错误信息要说明下一步。
      if (!(await chatRepo.agentEnabled(app.db, agentId))) {
        return reject(
          reply,
          'AGENT_DISABLED',
          '该智能体已停用，无法发起新对话；请到智能体页面启用后再试',
        );
      }

      if ((await getQueue().getWaitingCount()) > RUN_QUEUE_MAX_WAITING) {
        return reject(reply, 'SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
      }

      const { run, conversationId, inherited, history } = await chatRepo.admitChatRun(app.db, {
        agentId,
        message,
        trigger: 'chat',
        ...(request.body.conversationId === undefined
          ? {}
          : { conversationId: request.body.conversationId }),
      });

      // jobId = runId，重复投递天然幂等。
      try {
        await getQueue().add(
          'run',
          {
            runId: run.id,
            agentId,
            conversationId,
            prompt: message,
            ...(history === null ? {} : { history }),
          },
          runEnqueueOptions(run.id),
        );
      } catch {
        try {
          await app.db
            .update(schema.agentRuns)
            .set({
              status: 'failed',
              endedAt: new Date(),
              error: '消息入队失败，请重新发送。',
              errorKind: 'infra',
            })
            .where(and(eq(schema.agentRuns.id, run.id), eq(schema.agentRuns.status, 'queued')));
        } catch {
          request.log.warn({ runId: run.id }, 'chat enqueue failure cleanup failed');
        }
        fail('SERVICE_UNAVAILABLE', '运行入队失败，请稍后重试');
      }

      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.run.requested',
        target: run.id,
        input: { agentId, prompt: message },
        status: 'ok',
        requestId: request.id,
      });

      if (inherited.length > 0) {
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'agent.run.approvals_inherited',
          target: run.id,
          input: { toolNames: inherited },
          status: 'ok',
          requestId: request.id,
        });
      }

      return reply.status(202).send({ runId: run.id, conversationId });
    },
  );

  app.get(
    '/api/chat/:runId/events',
    { preHandler: [rawApp.requireAuth], schema: { params: runIdParams } },
    async (request, reply) => {
      const { runId } = request.params;
      const run = await chatRepo.getRun(app.db, runId);
      if (!run) {
        return reject(reply, 'RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新后重试');
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write('retry: 3000\n\n');

      let closed = false;
      // 终态只能写一次：轮询探测到终态时先占位，订阅回调随即让路。
      let finishing = false;
      let recheckTimer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionAbort = new AbortController();
      let subscription: { close: () => void } | undefined;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (recheckTimer !== undefined) clearTimeout(recheckTimer);
        subscriptionAbort.abort();
        subscription?.close();
      };
      const finish = (): void => {
        cleanup();
        reply.raw.end();
      };

      // 客户端 abort 后停止轮询；每轮在上一轮结束后才排下一次，DB 慢时不会叠加查询。
      const scheduleRecheck = (): void => {
        if (closed || finishing) return;
        recheckTimer = setTimeout(() => {
          recheckTimer = undefined;
          void recheck();
        }, TERMINAL_RECHECK_MS);
      };
      const recheck = async (): Promise<void> => {
        let current: RunRow | null;
        try {
          current = await chatRepo.getRun(app.db, runId);
        } catch {
          // 数据库错误可能带上连接信息，只记录 runId。
          request.log.warn({ runId }, 'sse terminal recheck failed');
          scheduleRecheck();
          return;
        }
        if (closed || finishing) return;
        // run 已被清理：不再重试，明确结束这条流，避免客户端无限等待。
        if (current === null) {
          finishing = true;
          try {
            await writeEvent(reply, {
              type: 'run_unavailable',
              message: '运行记录已不存在，已停止接收。',
            });
          } catch {
            request.log.warn({ runId }, 'sse run unavailable write failed');
          }
          finish();
          return;
        }
        const missed = terminalEvent(current);
        if (!missed) {
          scheduleRecheck();
          return;
        }
        finishing = true;
        try {
          await writeEvent(reply, { type: 'replay_truncated', reason: 'terminal_missing' });
          await writeEvent(reply, missed);
        } catch (err) {
          request.log.error({ err, runId }, 'sse write failed');
        }
        finish();
      };

      // 同时监听 req 与 res：客户端 abort 时不同 Node 版本触发的对象不同。
      const onClose = (): void => cleanup();
      request.raw.on('close', onClose);
      request.raw.on('aborted', onClose);
      reply.raw.on('close', onClose);
      reply.raw.on('error', onClose);

      try {
        subscription = await subscribeRun(
          runId,
          async (event) => {
            if (closed || finishing) return;
            const terminal =
              event.type === 'run_finished' ||
              event.type === 'error' ||
              event.type === 'run_unavailable';
            // 先同步占位再 await 写入，轮询探测到的终态不会插进这次写入中间。
            if (terminal) finishing = true;
            try {
              await writeEvent(reply, event);
            } catch (err) {
              request.log.error({ err, runId }, 'sse write failed');
              finish();
              return;
            }
            if (terminal) finish();
          },
          subscriptionAbort.signal,
        );
      } catch (err) {
        request.log.error({ err, runId }, 'sse subscribe failed');
        try {
          await writeEvent(reply, {
            type: 'error',
            // 上游 Redis 报错可能含连接串，脱敏后再发给浏览器。
            message: '事件流中断，请刷新页面或重试',
          });
        } catch {
          // 客户端已断开，没有可写的通道。
        }
        finish();
        return;
      }

      // 客户端在订阅完成前就断开了：cleanup 当时拿不到订阅，必须在这里补一次释放。
      if (closed) {
        subscription.close();
        return;
      }

      // 重连到一个已结束的 run：订阅只能收到未来的事件，必须补发终态。
      const finished = terminalEvent(run);
      if (finished) {
        finishing = true;
        try {
          await writeEvent(reply, finished);
        } catch (err) {
          request.log.error({ err, runId }, 'sse write failed');
        }
        finish();
        return;
      }

      // 仍在进行的 run：worker 可能只把终态写进数据库而没能发事件。
      scheduleRecheck();
    },
  );

  app.get(
    '/api/conversations/:id',
    {
      preHandler: [rawApp.requireAuth],
      schema: { params: idParams, querystring: historyQuery },
    },
    async (request, reply) => {
      const conversation = await chatRepo.getConversation(app.db, request.params.id);
      if (!conversation) {
        return reject(
          reply,
          'CONVERSATION_NOT_FOUND',
          '会话不存在，可能已被删除；请从会话列表重新打开',
        );
      }
      const { limit, before } = request.query;
      // 多取一条判断是否还有更早的历史；游标先校验归属，外会话/未知 id 不能当游标。
      if (
        before !== undefined &&
        !(await chatRepo.messageInConversation(app.db, conversation.id, before))
      ) {
        return reject(reply, 'INVALID_INPUT', 'before 游标不属于该会话，请刷新后重试');
      }
      const rows = await chatRepo.listMessages(app.db, conversation.id, {
        limit: limit + 1,
        ...(before === undefined ? {} : { before }),
      });
      const hasMore = rows.length > limit;
      // listMessages 按正序返回，多出来的那条是最早的。
      const messages = hasMore ? rows.slice(1) : rows;
      return { conversation, messages, nextBefore: hasMore ? messages[0]?.id : null };
    },
  );

  app.patch(
    '/api/conversations/:id',
    {
      preHandler: [rawApp.requireAuth],
      schema: { params: idParams, body: conversationRenameSchema },
    },
    async (request, reply) => {
      const conversation = await chatRepo.renameConversation(
        app.db,
        request.params.id,
        request.body.title,
      );
      if (!conversation) {
        return reject(
          reply,
          'CONVERSATION_NOT_FOUND',
          '会话不存在，可能已被删除；请从会话列表重新打开',
        );
      }
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'conversation.renamed',
        target: conversation.id,
        // 标题可能含用户原文，审计只记改动字段。
        input: { fields: ['title'] },
        status: 'ok',
        requestId: request.id,
      });
      return {
        id: conversation.id,
        agentId: conversation.agentId,
        title: conversation.title,
        createdAt: conversation.createdAt,
      };
    },
  );

  app.post(
    '/api/chat/:runId/cancel',
    { preHandler: [rawApp.requireAuth], schema: { params: runIdParams } },
    async (request, reply) => {
      const { runId } = request.params;
      const run = await chatRepo.getRun(app.db, runId);
      if (!run) {
        return reject(reply, 'RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新后重试');
      }
      // 已结束的 run 再发 cancel 只会打扰 worker，直接返回。
      if (terminalEvent(run) === null && (await cancelAgentRun(app, runId))) {
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'agent.run.cancelled',
          target: runId,
          status: 'ok',
          requestId: request.id,
        });
      }
      return reply.status(202).send({ ok: true });
    },
  );

  app.post(
    '/api/conversations/:id/branch',
    {
      preHandler: [rawApp.requireAuth],
      schema: { params: idParams, body: branchBodySchema },
    },
    async (request, reply) => {
      const result = await chatRepo.branchConversation(app.db, {
        id: newId('conversation'),
        conversationId: request.params.id,
        ...(request.body.fromMessageId === undefined
          ? {}
          : { fromMessageId: request.body.fromMessageId }),
      });
      if (!result) {
        return reject(
          reply,
          'CONVERSATION_NOT_FOUND',
          '会话或分支点不存在，可能已被删除；请刷新后重试',
        );
      }
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'conversation.branched',
        target: result.conversation.id,
        input: { source: request.params.id, fromMessageId: request.body.fromMessageId ?? null },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(201).send(result.conversation);
    },
  );

  app.get(
    '/api/conversations',
    { preHandler: [rawApp.requireAuth], schema: { querystring: listQuery } },
    async (request) => {
      const { agentId, limit } = request.query;
      const rows = await chatRepo.listConversations(app.db, {
        ...(agentId === undefined ? {} : { agentId }),
        limit,
      });
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastMessage: row.lastMessage && {
          ...row.lastMessage,
          createdAt: row.lastMessage.createdAt.toISOString(),
        },
      }));
    },
  );

  app.addHook('onClose', async () => {
    await closeProducer();
  });
}
