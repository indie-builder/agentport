import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { copyConversationOutputs, fail, removeConversationOutputs } from '@agentport/core';
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
import {
  actionBytes,
  checkOpenUiActionSource,
  OPENUI_ACTION_MAX_BYTES,
  openUiActionContent,
  sourcePairingProblem,
} from './openui-actions.js';
import { registerOpenUiStateRoutes } from './openui-state.js';
import { registerOpenUiToolRoutes } from './openui-tools.js';
import { checkOutputSelection, outputUserContent, registerOutputRoutes } from './outputs.js';

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
      const { openuiAction, ...chatInput } = request.body;
      const { agentId, message, output } = chatInput;

      // 来源成对：两个字段要么都有、要么都没有；缺一半是客户端拼错。open_url 也按此拒绝。
      const pairingProblem = openuiAction === undefined ? null : sourcePairingProblem(openuiAction);
      if (pairingProblem !== null) {
        return reject(reply, 'INVALID_INPUT', pairingProblem);
      }

      // open_url 由浏览器直接开窗，不该变成一轮对话：接受并返回 204，明确不入库。
      // 必要校验已在入口做完（shared schema 的协议与 http/https 地址）。
      if (openuiAction?.type === 'open_url') {
        return reply.status(204).send();
      }

      // 动作片段与正文一起落库：超过 64KB 时明确拒绝，避免表单值被截断后模型读到半份数据。
      if (openuiAction !== undefined && actionBytes(openuiAction) > OPENUI_ACTION_MAX_BYTES) {
        return reject(reply, 'PAYLOAD_TOO_LARGE', '生成式 UI 动作数据超过 64KB 上限，未发送');
      }

      // 落库的动作来源必须真实存在：伪造的 messageId/blockKey 会让审计对错消息。
      const sourceProblem =
        openuiAction === undefined
          ? null
          : await checkOpenUiActionSource(app.db, request.body.conversationId, openuiAction);
      if (sourceProblem !== null) {
        return reject(reply, 'INVALID_INPUT', sourceProblem);
      }

      // 所选成果必须属于当前会话：跨会话/未知版本一律拒绝，worker 才能安全复制成草稿。
      if (output !== undefined) {
        const outputProblem = await checkOutputSelection(app, {
          conversationId: request.body.conversationId,
          output,
        });
        if (outputProblem !== null) {
          return reject(reply, outputProblem.code, outputProblem.message);
        }
      }

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

      const agentVersion = await repo.agentVersions.latestAgentVersion(app.db, agentId);
      // 所选成果随用户消息落库（worker 从消息读它决定复制哪一版草稿），不改变队列载荷。
      const userContent =
        output === undefined
          ? openuiAction === undefined
            ? undefined
            : openUiActionContent(openuiAction)
          : outputUserContent({
              text: message,
              output,
              ...(openuiAction === undefined ? {} : { openuiAction }),
            });
      // 动作内容在准入前构造完，与 run、用户消息同一次事务写入：
      // 先落纯文本再补写，补写失败会留下一个没有 job 的 queued run。
      const { run, conversationId, inherited } = await chatRepo.admitChatRun(app.db, {
        agentId,
        message,
        ...(agentVersion === null ? {} : { agentVersion }),
        trigger: 'chat',
        ...(request.body.conversationId === undefined
          ? {}
          : { conversationId: request.body.conversationId }),
        ...(userContent === undefined ? {} : { userContent }),
      });

      // jobId = runId，重复投递天然幂等。job 只带标识与本次输入：
      // 续聊 / fork 状态由 worker 从 DB 读取，不把历史文本塞进队列。
      try {
        await getQueue().add(
          'run',
          {
            runId: run.id,
            agentId,
            conversationId,
            prompt: message,
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
        input: {
          agentId,
          prompt: message,
          // 生成式 UI 动作的来源段：用于把一次点击追到具体消息，实时消息可能没有 id。
          ...(openuiAction === undefined
            ? {}
            : {
                openuiAction: openuiAction.type,
                ...(openuiAction.messageId === undefined
                  ? {}
                  : { openuiMessageId: openuiAction.messageId }),
                ...(openuiAction.blockKey === undefined
                  ? {}
                  : { openuiBlockKey: openuiAction.blockKey }),
              }),
        },
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
          // 库里终态但流里没有终态（worker 发布失败/流已过期）时，终态没有 messageIds：
          // 先明确提示缺失，前端据此用已保存结果做 canonical 恢复。
          await writeEvent(reply, { type: 'replay_truncated', reason: 'terminal_missing' });
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
      // 每条回复都靠 run_id 回填读数；一次批量查，不按消息逐条取。
      const runMetrics = (
        await chatRepo.listRunMetrics(app.db, [
          ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
        ])
      ).map((run) => ({
        runId: run.id,
        status: run.status,
        turns: run.turns,
        durationMs: run.latencyMs,
        tokens:
          run.inputTokens === null && run.outputTokens === null
            ? null
            : (run.inputTokens ?? 0) + (run.outputTokens ?? 0),
        costUsd: run.costUsd === null ? null : Number(run.costUsd),
        error: run.error,
        endedAt: run.endedAt?.toISOString() ?? null,
      }));
      return {
        conversation,
        // 只回前端契约里的字段：SDK uuid 是内部续聊状态，不上 wire。
        // ui_format / ui_program / ui_state 是消息级渲染快照，必须原样带出，
        // 否则刷新后只能按当前智能体的开关猜格式。
        messages: messages.map(({ sdkMessageUuid: _sdk, ...message }) => message),
        runMetrics,
        nextBefore: hasMore ? messages[0]?.id : null,
      };
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

  app.delete(
    '/api/conversations/:id',
    { preHandler: [rawApp.requireAuth], schema: { params: idParams } },
    async (request, reply) => {
      // 删除会级联清掉消息与运行；transcript 目录不归 DB 管，成功后单独清理。
      const conversation = await chatRepo.getConversation(app.db, request.params.id);
      const ok = await chatRepo.deleteConversation(app.db, request.params.id);
      if (!ok) {
        return reject(
          reply,
          'CONVERSATION_NOT_FOUND',
          '会话不存在，可能已被删除；请从会话列表重新打开',
        );
      }
      if (conversation) {
        const [agent] = await app.db
          .select({ slug: schema.agents.slug })
          .from(schema.agents)
          .where(eq(schema.agents.id, conversation.agentId))
          .limit(1);
        if (agent) {
          await Promise.all([
            rm(join(app.config.WORKSPACES_DIR, agent.slug, 'sdk-sessions', conversation.id), {
              recursive: true,
              force: true,
            }).catch((err: unknown) => {
              // DB 已删，目录残留只是占空间；记日志不改变响应。
              request.log.warn(
                { err, conversationId: conversation.id },
                'sdk session cleanup failed',
              );
            }),
            // 成果按会话独立保存：DB 删掉后目录不再有任何索引，必须一起清理。
            removeConversationOutputs({
              root: app.config.WORKSPACES_DIR,
              slug: agent.slug,
              conversationId: conversation.id,
            }).catch((err: unknown) => {
              request.log.warn({ err, conversationId: conversation.id }, 'output cleanup failed');
            }),
          ]);
        }
      }
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'conversation.deleted',
        target: request.params.id,
        // 删除不回写会话原文，只记目标 id。
        input: { fields: [] },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
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
      // 分支点是原会话里一条已落库的消息；复制与 SDK 分叉状态在同一次写入里建立。
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
      // 每个会话只挂自己的 transcript 目录：分支要在自己的目录里找到来源 session 才能 fork。
      const [agent] = await app.db
        .select({ slug: schema.agents.slug })
        .from(schema.agents)
        .where(eq(schema.agents.id, result.conversation.agentId))
        .limit(1);
      const sessionsRoot = agent
        ? join(app.config.WORKSPACES_DIR, agent.slug, 'sdk-sessions')
        : null;
      const sourceDir = sessionsRoot === null ? null : join(sessionsRoot, request.params.id);
      const targetDir = sessionsRoot === null ? null : join(sessionsRoot, result.conversation.id);
      // 分支必须能独立继续：缺 transcript 或历史边界内的成果时删除分支，不留半份状态。
      const rollback = async (reason: string, err: unknown): Promise<void> => {
        request.log.warn({ err, conversationId: result.conversation.id }, reason);
        await chatRepo.deleteConversation(app.db, result.conversation.id).catch(() => undefined);
        if (targetDir !== null) {
          await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (agent !== undefined) {
          await removeConversationOutputs({
            root: app.config.WORKSPACES_DIR,
            slug: agent.slug,
            conversationId: result.conversation.id,
          }).catch(() => undefined);
        }
      };
      if (sourceDir !== null && targetDir !== null && result.copied > 0) {
        try {
          await cp(sourceDir, targetDir, { recursive: true, force: true });
        } catch (err) {
          // 分支行已写入，但缺 transcript 时首轮必定 infra 失败；在这里就说清楚并回滚分支。
          await rollback('sdk session copy failed', err);
          return reject(
            reply,
            'CONFLICT',
            '该会话的 SDK 会话记录不可用，无法按历史点分支；请重新对话后再试',
          );
        }
      }
      // 成果只复制历史边界内的版本，并把消息锚点换成分支里的新 id；
      // messageIds 是复制用的内部映射，不进 HTTP 响应。
      if (agent !== undefined) {
        try {
          await copyConversationOutputs({
            root: app.config.WORKSPACES_DIR,
            slug: agent.slug,
            sourceConversationId: request.params.id,
            targetConversationId: result.conversation.id,
            messageIds: result.messageIds,
          });
        } catch (err) {
          await rollback('conversation output copy failed', err);
          return reject(reply, 'CONFLICT', '该会话的历史成果不可用，无法按历史点分支；请稍后重试');
        }
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

  registerOpenUiStateRoutes(rawApp);
  registerOpenUiToolRoutes(rawApp);
  registerOutputRoutes(rawApp);
}
