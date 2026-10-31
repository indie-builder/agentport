import { cp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  conversationInputsDir,
  copyConversationInputs,
  copyConversationOutputs,
  displayAttachmentFilename,
  fail,
  removeConversationInputs,
  removeConversationOutputs,
  writeConversationAttachments,
} from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import {
  attachmentExtension,
  type ChatEvent,
  chatRequestSchema,
  conversationRenameSchema,
  conversationSearchQuerySchema,
  idParams,
  type MessageAttachment,
  type PermissionId,
  RUN_QUEUE_MAX_WAITING,
  runEnqueueOptions,
  wireFailureKind,
} from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { AppError, reject } from '../../plugins/errors.js';
import { chatRateLimit } from '../../plugins/security.js';
import { closeProducer, getQueue, subscribeRun } from '../../queue/producer.js';
import { typed } from '../../types.js';
import { accessFilter, actorOf, authorizeObject, userPrincipal } from '../access.js';
import { registerAttachmentRoutes } from './attachments.js';
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

/** 附件以 base64 随 JSON 发送：5×10MiB 原件编码后仍要留出正文与协议开销。 */
const CHAT_BODY_LIMIT = 16 * 1024 * 1024;

/** 新会话标题：正文优先，空正文用净化后的首个附件名，都没有时给出可读占位。 */
function attachmentConversationTitle(
  message: string,
  attachments: Array<{ filename: string }>,
): string {
  if (message.trim().length > 0) return message.slice(0, 80);
  const filename = displayAttachmentFilename(attachments[0]?.filename ?? '');
  return filename.length > 0 ? filename.slice(0, 80) : '附件';
}

/** 准入失败时只删本次写入的附件；路径按服务端元数据拼装并复核在会话目录内。 */
async function removeWrittenAttachments(input: {
  root: string;
  slug: string;
  conversationId: string;
  attachments: MessageAttachment[];
}): Promise<void> {
  const dir = resolve(conversationInputsDir(input));
  await Promise.all(
    input.attachments.map((attachment) => {
      const file = resolve(dir, `${attachment.id}${attachmentExtension(attachment.mimeType)}`);
      if (!file.startsWith(`${dir}${sep}`)) return Promise.resolve();
      return rm(file, { force: true });
    }),
  );
}

type RunRow = NonNullable<Awaited<ReturnType<typeof chatRepo.getRun>>>;

const CONVERSATION_MISSING = '会话不存在，可能已被删除；请从会话列表重新打开';
const RUN_MISSING = '运行记录不存在，可能已被清理；请刷新运行列表';

/** 读会话并执行对象范围检查：正文只对本人 O 或对应叶 P 开放。 */
async function loadConversation(app: FastifyInstance, request: FastifyRequest, id: string) {
  const conversation = await chatRepo.getConversation(app.db, id);
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
  await authorizeObject(
    app,
    request,
    'conversations.read',
    { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
    CONVERSATION_MISSING,
  );
  return conversation;
}

/** 平台范围在本请求内不会因对象归属改变；跨用户读取的审计由 authorize 负责。 */
function hasPlatformScope(request: FastifyRequest, permissionId: PermissionId): boolean {
  const principal = request.principal;
  return (
    principal?.kind === 'user' &&
    principal.grants.some(
      (grant) => grant.permissionId === permissionId && grant.scope === 'platform',
    )
  );
}

/** 读运行并执行对象范围检查；服务发起的运行只有 P 能读。 */
async function loadRun(app: FastifyInstance, request: FastifyRequest, id: string) {
  const run = await chatRepo.getRun(app.db, id);
  if (!run) throw new AppError('RUN_NOT_FOUND', RUN_MISSING);
  await authorizeObject(
    app,
    request,
    'runs.read',
    { objectId: run.id, createdBy: run.initiatedBy, privateContent: true },
    RUN_MISSING,
  );
  return run;
}

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
      ...chatRateLimit,
      config: { ...chatRateLimit.config, access: { kind: 'permission', permissionId: 'conversations.create' } },
      bodyLimit: CHAT_BODY_LIMIT,
      schema: { body: chatRequestSchema },
    },
    async (request, reply) => {
      const principal = userPrincipal(request);
      const { openuiAction, attachments, ...chatInput } = request.body;
      const { agentId, message, output } = chatInput;
      // 只有附件时正文是 null；下游统一按空字符串处理。
      const messageText = message ?? '';

      // 附件与生成式 UI 动作是两条互斥的输入通道：同时出现时客户端状态已错，明确拒绝。
      if (attachments !== undefined && openuiAction !== undefined) {
        return reject(reply, 'INVALID_INPUT', '附件与生成式 UI 动作不能同时发送，请只保留一种');
      }

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
      // 目标专家必须可被当前账户使用（本人负责、成员 canUse 或平台范围）。
      await authorizeObject(
        app,
        request,
        'agents.use',
        { agentId },
        '智能体不存在，可能已被删除；请刷新后重新选择',
      );
      if (request.body.conversationId === undefined) {
        // 新会话归当前用户；O 授权按本人创建，P 也只是替自己创建。
        await app.authorize(request, 'conversations.create', {
          createdBy: principal.businessId,
        });
      } else {
        const conversation = await chatRepo.getConversation(app.db, request.body.conversationId);
        if (!conversation || conversation.agentId !== agentId) {
          return reject(
            reply,
            'CONVERSATION_NOT_FOUND',
            '会话不存在或不属于该智能体；请从会话列表重新打开',
          );
        }
        await authorizeObject(
          app,
          request,
          'conversations.update',
          { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
          CONVERSATION_MISSING,
        );
      }

      if ((await getQueue().getWaitingCount()) > RUN_QUEUE_MAX_WAITING) {
        return reject(reply, 'SERVICE_UNAVAILABLE', '运行队列已满，请稍后重试');
      }

      const agentVersion = await repo.agentVersions.latestAgentVersion(app.db, agentId);

      // 新会话必须先落行才能拿到目录名；已有会话先校验归属，避免把文件写进别人的会话。
      let createdConversationId: string | undefined;
      let attachmentSlug: string | undefined;
      let requestedConversationId = request.body.conversationId;
      let writtenAttachments: MessageAttachment[] | undefined;
      if (attachments !== undefined) {
        if (requestedConversationId === undefined) {
          createdConversationId = newId('conversation');
          await chatRepo.createConversation(app.db, {
            id: createdConversationId,
            agentId,
            title: attachmentConversationTitle(messageText, attachments),
            subject: { kind: 'user', businessId: principal.businessId },
          });
          requestedConversationId = createdConversationId;
        } else {
          const conversation = await chatRepo.getConversation(app.db, requestedConversationId);
          if (!conversation || conversation.agentId !== agentId) {
            return reject(
              reply,
              'CONVERSATION_NOT_FOUND',
              '会话不存在或不属于该智能体；请从会话列表重新打开',
            );
          }
        }

        const [agent] = await app.db
          .select({ slug: schema.agents.slug })
          .from(schema.agents)
          .where(eq(schema.agents.id, agentId))
          .limit(1);
        if (!agent) {
          if (createdConversationId !== undefined) {
            await chatRepo.deleteConversation(app.db, createdConversationId).catch(() => undefined);
          }
          return reject(reply, 'AGENT_NOT_FOUND', '智能体不存在，可能已被删除；请刷新后重新选择');
        }
        attachmentSlug = agent.slug;
        try {
          writtenAttachments = await writeConversationAttachments({
            root: app.config.WORKSPACES_DIR,
            slug: agent.slug,
            conversationId: requestedConversationId,
            inputs: attachments,
          });
        } catch (err) {
          // 文件没写成就没有可回滚的消息；新建的会话行也要一起清掉。
          if (createdConversationId !== undefined) {
            await chatRepo.deleteConversation(app.db, createdConversationId).catch(() => undefined);
          }
          throw err;
        }
      }

      // 所选成果与附件随用户消息落库（worker 从消息读，不改变队列载荷）。
      const userContent =
        writtenAttachments === undefined
          ? output === undefined
            ? openuiAction === undefined
              ? undefined
              : openUiActionContent(openuiAction)
            : outputUserContent({
                text: messageText,
                output,
                ...(openuiAction === undefined ? {} : { openuiAction }),
              })
          : {
              type: 'text',
              text: messageText,
              attachments: writtenAttachments,
              ...(output === undefined ? {} : { output }),
            };
      // 动作内容在准入前构造完，与 run、用户消息同一次事务写入：
      // 先落纯文本再补写，补写失败会留下一个没有 job 的 queued run。
      let admitted: Awaited<ReturnType<typeof chatRepo.admitChatRun>>;
      try {
        admitted = await chatRepo.admitChatRun(app.db, {
          agentId,
          message: messageText,
          subject: { kind: 'user', businessId: principal.businessId },
          ...(agentVersion === null ? {} : { agentVersion }),
          trigger: 'chat',
          ...(requestedConversationId === undefined
            ? {}
            : { conversationId: requestedConversationId }),
          ...(userContent === undefined ? {} : { userContent }),
        });
      } catch (err) {
        // 准入失败时消息没有落库：只回收本次写入的文件，旧附件保持原样。
        if (
          writtenAttachments !== undefined &&
          attachmentSlug !== undefined &&
          requestedConversationId !== undefined
        ) {
          await removeWrittenAttachments({
            root: app.config.WORKSPACES_DIR,
            slug: attachmentSlug,
            conversationId: requestedConversationId,
            attachments: writtenAttachments,
          }).catch((cleanupErr: unknown) => {
            request.log.warn(
              { err: cleanupErr },
              'attachment cleanup after admission failure failed',
            );
          });
        }
        if (createdConversationId !== undefined) {
          await chatRepo.deleteConversation(app.db, createdConversationId).catch(() => undefined);
        }
        throw err;
      }
      const { run, conversationId, inherited } = admitted;

      // jobId = runId，重复投递天然幂等。job 只带标识与本次输入：
      // 续聊 / fork 状态由 worker 从 DB 读取，不把历史文本塞进队列。
      try {
        await getQueue().add(
          'run',
          {
            runId: run.id,
            agentId,
            conversationId,
            prompt: messageText,
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
        actor: actorOf(request),
        action: 'agent.run.requested',
        target: run.id,
        input: {
          agentId,
          prompt: messageText,
          // 附件只记数量与显示名；base64 内容永不进审计。
          ...(writtenAttachments === undefined
            ? {}
            : {
                attachmentCount: writtenAttachments.length,
                attachmentNames: writtenAttachments.map(({ filename }) => filename),
              }),
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
          actor: actorOf(request),
          action: 'agent.run.approvals_inherited',
          target: run.id,
          input: { toolNames: inherited },
          status: 'ok',
          requestId: request.id,
        });
      }

      return reply.status(202).send({
        runId: run.id,
        conversationId,
        // 只回传落库的展示元数据，不含 base64 与宿主路径；没有实际附件时不带该字段。
        ...(writtenAttachments === undefined || writtenAttachments.length === 0
          ? {}
          : { attachments: writtenAttachments }),
      });
    },
  );

  app.get(
    '/api/chat/:runId/events',
    {
      config: { access: { kind: 'permission', permissionId: 'runs.read' } },
      schema: { params: runIdParams },
    },
    async (request, reply) => {
      const { runId } = request.params;
      const run = await loadRun(app, request, runId);

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
        // 轮询期间复核对象范围：授权被撤销就停止接收，但不杀已准入的运行。
        // P 不重复判权，避免管理员跨用户观看时每 2 秒写一条审计；账户停用在下一次请求拒绝。
        try {
          if (!hasPlatformScope(request, 'runs.read')) {
            await app.authorize(request, 'runs.read', {
              objectId: current.id,
              createdBy: current.initiatedBy,
              privateContent: true,
            });
          }
        } catch {
          finishing = true;
          await writeEvent(reply, {
            type: 'run_unavailable',
            message: '当前账户已无权读取该运行，已停止接收。',
          }).catch((err: unknown) => {
            request.log.warn({ err, runId }, 'sse access recheck write failed');
          });
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
    '/api/conversations/search',
    {
      config: { access: { kind: 'permission', permissionId: 'conversations.read' } },
      schema: { querystring: conversationSearchQuerySchema },
    },
    async (request) => {
      const result = await chatRepo.searchConversations(app.db, {
        ...request.query,
        access: accessFilter(request, 'conversations.read'),
      });
      return {
        items: result.items.map(({ updatedAt, ...item }) => ({
          ...item,
          updatedAt: updatedAt.toISOString(),
        })),
        nextBefore: result.nextBefore,
      };
    },
  );

  app.get(
    '/api/conversations/:id',
    {
      config: { access: { kind: 'permission', permissionId: 'conversations.read' } },
      schema: { params: idParams, querystring: historyQuery },
    },
    async (request, reply) => {
      const conversation = await loadConversation(app, request, request.params.id);
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
      config: { access: { kind: 'permission', permissionId: 'conversations.update' } },
      schema: { params: idParams, body: conversationRenameSchema },
    },
    async (request, reply) => {
      await loadConversation(app, request, request.params.id);
      const conversation = await chatRepo.renameConversation(
        app.db,
        request.params.id,
        request.body.title,
      );
      if (!conversation) {
        return reject(reply, 'CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
      }
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
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
    {
      config: { access: { kind: 'permission', permissionId: 'conversations.delete' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      // 删除会级联清掉消息与运行；transcript 目录不归 DB 管，成功后单独清理。
      const conversation = await loadConversation(app, request, request.params.id);
      const ok = await chatRepo.deleteConversation(app.db, request.params.id);
      if (!ok) {
        return reject(reply, 'CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
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
            // 会话沙盒目录按会话派生，含定义草稿与成果；DB 删掉后不再有入口。
            rm(join(app.config.WORKSPACES_DIR, agent.slug, 'session-sandboxes', conversation.id), {
              recursive: true,
              force: true,
            }).catch((err: unknown) => {
              request.log.warn(
                { err, conversationId: conversation.id },
                'session sandbox cleanup failed',
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
            // 附件是随会话产生的运行数据；消息行删除后下载入口已不可达，文件一并回收。
            removeConversationInputs({
              root: app.config.WORKSPACES_DIR,
              slug: agent.slug,
              conversationId: conversation.id,
            }).catch((err: unknown) => {
              request.log.warn({ err, conversationId: conversation.id }, 'input cleanup failed');
            }),
          ]);
        }
      }
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
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
    {
      config: { access: { kind: 'permission', permissionId: 'runs.cancel' } },
      schema: { params: runIdParams },
    },
    async (request, reply) => {
      const { runId } = request.params;
      const run = await chatRepo.getRun(app.db, runId);
      if (!run) {
        return reject(reply, 'RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新后重试');
      }
      await authorizeObject(
        app,
        request,
        'runs.cancel',
        { objectId: run.id, createdBy: run.initiatedBy, privateContent: true },
        RUN_MISSING,
      );
      // 已结束的 run 再发 cancel 只会打扰 worker，直接返回。
      if (terminalEvent(run) === null && (await cancelAgentRun(app, runId))) {
        await writeAudit(app.db, request.log, {
          actor: actorOf(request),
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
      config: { access: { kind: 'permission', permissionId: 'conversations.create' } },
      schema: { params: idParams, body: branchBodySchema },
    },
    async (request, reply) => {
      // 分支点是原会话里一条已落库的消息；复制与 SDK 分叉状态在同一次写入里建立。
      // 先按读叶确认原会话属于本人，避免复制无权读取的正文；分支归当前用户所有。
      await loadConversation(app, request, request.params.id);
      const principal = userPrincipal(request);
      await app.authorize(request, 'conversations.create', {
        createdBy: principal.businessId,
      });
      const result = await chatRepo.branchConversation(app.db, {
        id: newId('conversation'),
        conversationId: request.params.id,
        subject: { kind: 'user', businessId: principal.businessId },
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
          await removeConversationInputs({
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

        // 附件 id 与消息元数据保持不变，只复制被保留消息实际引用的文件；
        // 缺任意文件都回滚分支，否则历史里会出现无法读取的附件。
        try {
          const attachmentIds = await chatRepo.attachmentIdsForMessages(
            app.db,
            Object.keys(result.messageIds),
          );
          if (attachmentIds.length > 0) {
            await copyConversationInputs({
              root: app.config.WORKSPACES_DIR,
              slug: agent.slug,
              sourceConversationId: request.params.id,
              targetConversationId: result.conversation.id,
              attachmentIds,
            });
          }
        } catch (err) {
          await rollback('conversation input copy failed', err);
          return reject(reply, 'CONFLICT', '该会话的历史附件不可用，无法按历史点分支；请稍后重试');
        }
      }
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
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
    {
      config: { access: { kind: 'permission', permissionId: 'conversations.read' } },
      schema: { querystring: listQuery },
    },
    async (request) => {
      const { agentId, limit } = request.query;
      const rows = await chatRepo.listConversations(app.db, {
        ...(agentId === undefined ? {} : { agentId }),
        limit,
        access: accessFilter(request, 'conversations.read'),
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
  registerAttachmentRoutes(rawApp);
}
