import { newId, repo } from '@agentport/db';
import type { ChatEvent } from '@agentport/shared';
import { chatRequestSchema } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { closeProducer, getQueue, publishRun, subscribeRun } from '../../queue/producer.js';

const chatRepo = repo.chat;

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
      };
    default:
      return null;
  }
}

function writeEvent(reply: FastifyReply, event: ChatEvent): boolean {
  return reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerChatRoutes(app: FastifyInstance): void {
  app.post('/api/chat', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: 'INVALID_INPUT',
        message: parsed.error.issues[0]?.message ?? 'invalid body',
      });
    }
    const { agentId, message } = parsed.data;

    if (!(await chatRepo.agentExists(app.db, agentId))) {
      return reply
        .status(404)
        .send({ code: 'AGENT_NOT_FOUND', message: `agent ${agentId} not found` });
    }

    let conversationId = parsed.data.conversationId;
    if (conversationId !== undefined) {
      const conversation = await chatRepo.getConversation(app.db, conversationId);
      if (!conversation || conversation.agentId !== agentId) {
        return reply.status(404).send({
          code: 'CONVERSATION_NOT_FOUND',
          message: `conversation ${conversationId} not found`,
        });
      }
    } else {
      const conversation = await chatRepo.createConversation(app.db, {
        id: newId('conversation'),
        agentId,
        title: message.slice(0, 80),
      });
      conversationId = conversation.id;
    }

    const run = await chatRepo.createRun(app.db, { id: newId('run'), conversationId, agentId });
    await chatRepo.appendMessage(app.db, {
      id: newId('message'),
      conversationId,
      role: 'user',
      content: { type: 'text', text: message },
      runId: run.id,
    });
    // jobId = runId，重复投递天然幂等。
    await getQueue().add(
      'run',
      { runId: run.id, agentId, conversationId, prompt: message },
      { jobId: run.id },
    );

    return reply.status(202).send({ runId: run.id, conversationId });
  });

  app.get<{ Params: { runId: string } }>(
    '/api/chat/:runId/events',
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const { runId } = request.params;
      const run = await chatRepo.getRun(app.db, runId);
      if (!run) {
        return reply.status(404).send({ code: 'RUN_NOT_FOUND', message: `run ${runId} not found` });
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
      let unsubscribe: (() => void) | undefined;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
      };
      const finish = (): void => {
        cleanup();
        reply.raw.end();
      };

      const onClose = (): void => cleanup();
      request.raw.on('close', onClose);

      try {
        unsubscribe = await subscribeRun(runId, (event) => {
          if (closed) return;
          try {
            writeEvent(reply, event);
          } catch (err) {
            request.log.error({ err, runId }, 'sse write failed');
            finish();
            return;
          }
          if (event.type === 'run_finished' || event.type === 'error') finish();
        });
      } catch (err) {
        request.log.error({ err, runId }, 'sse subscribe failed');
        try {
          writeEvent(reply, {
            type: 'error',
            message: err instanceof Error ? err.message : 'subscription failed',
          });
        } catch {
          // 客户端已断开，没有可写的通道。
        }
        finish();
        return;
      }

      // 客户端在订阅完成前就断开了。
      if (closed) {
        unsubscribe();
        request.raw.off('close', onClose);
        return;
      }

      // 重连到一个已结束的 run：订阅只能收到未来的事件，必须补发终态。
      const finished = terminalEvent(run);
      if (finished) {
        try {
          writeEvent(reply, finished);
        } catch (err) {
          request.log.error({ err, runId }, 'sse write failed');
        }
        finish();
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/conversations/:id',
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const conversation = await chatRepo.getConversation(app.db, request.params.id);
      if (!conversation) {
        return reply.status(404).send({
          code: 'CONVERSATION_NOT_FOUND',
          message: `conversation ${request.params.id} not found`,
        });
      }
      const messages = await chatRepo.listMessages(app.db, conversation.id);
      return { conversation, messages };
    },
  );

  app.post<{ Params: { runId: string } }>(
    '/api/chat/:runId/cancel',
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      const { runId } = request.params;
      const run = await chatRepo.getRun(app.db, runId);
      if (!run) {
        return reply.status(404).send({ code: 'RUN_NOT_FOUND', message: `run ${runId} not found` });
      }
      // 已结束的 run 再发 cancel 只会打扰 worker，直接返回。
      if (terminalEvent(run) === null) {
        await publishRun(runId, { type: 'cancel' });
        await chatRepo.cancelRun(app.db, runId);
      }
      return reply.status(202).send({ ok: true });
    },
  );

  app.addHook('onClose', async () => {
    await closeProducer();
  });
}
