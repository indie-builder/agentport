import { newId, repo, schema } from '@agentport/db';
import {
  type ChatEvent,
  chatRequestSchema,
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
import { closeProducer, getQueue, publishRun, subscribeRun } from '../../queue/producer.js';
import { typed } from '../../types.js';

const chatRepo = repo.chat;
const runsRepo = repo.runs;

const runIdParams = z.object({ runId: z.string().min(1) });
const branchBodySchema = z.object({ fromMessageId: z.string().min(1).optional() });
const listQuery = z.object({
  agentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

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

      let conversationId = request.body.conversationId;
      if (conversationId !== undefined) {
        const conversation = await chatRepo.getConversation(app.db, conversationId);
        if (!conversation || conversation.agentId !== agentId) {
          return reject(
            reply,
            'CONVERSATION_NOT_FOUND',
            '会话不存在或不属于该智能体；请从会话列表重新打开',
          );
        }
      } else {
        const conversation = await chatRepo.createConversation(app.db, {
          id: newId('conversation'),
          agentId,
          title: message.slice(0, 80),
        });
        conversationId = conversation.id;
      }

      const run = await chatRepo.createRun(app.db, {
        id: newId('run'),
        conversationId,
        agentId,
      });
      // 批准原先绑定单次 run；重发消息会新建 run，这里把上一 run 的已批准工具带过来。
      const inherited = await runsRepo.inheritApprovals(app.db, {
        conversationId,
        runId: run.id,
      });
      // 沙盒每次都是新容器，SDK session 无法复用；在写入本条消息前取历史，避免重复。
      const history = await chatRepo.getHistoryForPrompt(app.db, conversationId);
      await chatRepo.appendMessage(app.db, {
        id: newId('message'),
        conversationId,
        role: 'user',
        content: { type: 'text', text: message },
        runId: run.id,
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
      } catch (err) {
        await app.db
          .update(schema.agentRuns)
          .set({
            status: 'failed',
            endedAt: new Date(),
            error: '消息入队失败，请重新发送。',
            errorKind: 'infra',
          })
          .where(and(eq(schema.agentRuns.id, run.id), eq(schema.agentRuns.status, 'queued')));
        throw err;
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
      const subscriptionAbort = new AbortController();
      let subscription: { close: () => void } | undefined;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        subscriptionAbort.abort();
        subscription?.close();
      };
      const finish = (): void => {
        cleanup();
        reply.raw.end();
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
            if (closed) return;
            try {
              await writeEvent(reply, event);
            } catch (err) {
              request.log.error({ err, runId }, 'sse write failed');
              finish();
              return;
            }
            if (event.type === 'run_finished' || event.type === 'error') finish();
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
        try {
          await writeEvent(reply, finished);
        } catch (err) {
          request.log.error({ err, runId }, 'sse write failed');
        }
        finish();
      }
    },
  );

  app.get(
    '/api/conversations/:id',
    { preHandler: [rawApp.requireAuth], schema: { params: idParams } },
    async (request, reply) => {
      const conversation = await chatRepo.getConversation(app.db, request.params.id);
      if (!conversation) {
        return reject(
          reply,
          'CONVERSATION_NOT_FOUND',
          '会话不存在，可能已被删除；请从会话列表重新打开',
        );
      }
      const messages = await chatRepo.listMessages(app.db, conversation.id);
      return { conversation, messages };
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
      if (terminalEvent(run) === null) {
        // queued → cancelled 与 worker 的 claim 竞争；只有赢得更新的一方负责终态事件。
        const [queuedCancelled] =
          run.status === 'queued'
            ? await app.db
                .update(schema.agentRuns)
                .set({ status: 'cancelled', endedAt: new Date() })
                .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')))
                .returning({ id: schema.agentRuns.id })
            : [];
        if (queuedCancelled) {
          await publishRun(runId, { type: 'run_finished', status: 'cancelled' });
        } else {
          const cancelled = await chatRepo.cancelRun(app.db, runId);
          if (!cancelled) return reply.status(202).send({ ok: true });
          await publishRun(runId, { type: 'cancel' });
        }
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
