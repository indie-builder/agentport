import { repo } from '@agentport/db';
import { type ChatEvent, idParams, wireFailureKind } from '@agentport/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { AppError, reject } from '../../plugins/errors.js';
import { publishChannelEvent, subscribeRun } from '../../queue/producer.js';
import { typed } from '../../types.js';
import { actorOf, userPrincipal } from '../access.js';
import { cancelAgentRun } from '../chat/cancel-run.js';
import { registerChannelApprovalRoutes } from './approvals.js';

const channelControl = repo.channelControl;

const runParams = z.object({ id: z.string().min(1), runId: z.string().min(1) });
const agentParams = z.object({ id: z.string().min(1), agentId: z.string().min(1) });
const activeRunsQuerySchema = z.object({
  status: z.literal('active').default('active'),
});

/** 与私有 run SSE 相同的兜底间隔：worker 已把终态写库但没发出 run_finished。 */
const TERMINAL_RECHECK_MS = 2_000;

type ControlRun = repo.channelControl.ControlRun;

function toActiveRun(run: ControlRun) {
  return {
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
  };
}

/** 只对已进入终态的 run 生成 run_finished；queued/running 返回 null。 */
function terminalEvent(run: repo.channelControl.ChannelRunRow): ChatEvent | null {
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

/** SSE 写端背压：drain 前等待，客户端断开也会结束等待。 */
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

function notFound(reply: FastifyReply, message = '频道不存在或你不是频道成员'): FastifyReply {
  return reject(reply, 'NOT_FOUND', message);
}

function forbidden(reply: FastifyReply, message: string): FastifyReply {
  return reject(reply, 'FORBIDDEN', message);
}

/** 取消 queued run 后补发频道终态；发布失败只记日志，run 终止仍以 DB CAS 为准。 */
async function publishChannelFinished(
  request: FastifyRequest,
  channelId: string,
  run: ControlRun,
): Promise<void> {
  try {
    await publishChannelEvent(channelId, {
      type: 'run.finished',
      channelId,
      runId: run.id,
      agentId: run.agentId,
      status: 'cancelled',
    });
  } catch (err) {
    request.log.warn({ err, runId: run.id }, 'channel run.finished publish failed');
  }
}

/**
 * 停止单条 run 复用私有取消：queued 走 CAS 写终态，running 只发信号，容器由 worker 收尾。
 * 返回是否真正取消；调用方据此决定是否写审计。
 */
async function cancelRun(
  app: FastifyInstance,
  request: FastifyRequest,
  channelId: string,
  run: ControlRun,
): Promise<boolean> {
  if (run.status !== 'queued' && run.status !== 'running') return false;
  const result = await cancelAgentRun(app, run.id);
  // 只有本次 CAS 写终态才补频道终态；run.status 是读到的旧快照，可能已被 worker 领取。
  if (result === 'queued') await publishChannelFinished(request, channelId, run);
  return result !== null;
}

type CancelRunBatchResult = { cancelled: number; failedRunIds: string[] };

/** close / disconnect 已先提交频道状态；单条取消失败不回滚，继续尝试其余 run 并报告失败项。 */
async function cancelRunBatch(
  app: FastifyInstance,
  request: FastifyRequest,
  channelId: string,
  runs: ControlRun[],
): Promise<CancelRunBatchResult> {
  let cancelled = 0;
  const failedRunIds: string[] = [];
  for (const run of runs) {
    try {
      if (await cancelRun(app, request, channelId, run)) cancelled += 1;
    } catch (err) {
      request.log.warn({ err, runId: run.id }, 'channel control cancel failed');
      failedRunIds.push(run.id);
    }
  }
  return { cancelled, failedRunIds };
}

/** 频道控制面：活动 run 列表、run 事件流、stop / disconnect / close。 */
export function registerChannelControlRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  registerChannelApprovalRoutes(rawApp);

  app.get(
    '/api/channels/:id/runs',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams, querystring: activeRunsQuerySchema },
    },
    async (request, reply) => {
      const result = await channelControl.listActiveRuns(
        app.db,
        userPrincipal(request).businessId,
        request.params.id,
      );
      if (result.kind === 'not_found') return notFound(reply);
      return reply.send({ items: result.runs.map(toActiveRun) });
    },
  );

  app.get(
    '/api/channels/:id/runs/:runId/events',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: runParams },
    },
    async (request, reply) => {
      const { id, runId } = request.params;
      const businessId = userPrincipal(request).businessId;
      // 非成员在 hijack 前按 404 收口；平台管理员不是成员时也一样。
      const access = await channelControl.getChannelRunForMember(app.db, businessId, id, runId);
      if (!access) return notFound(reply, '运行不存在或不属于该频道');
      const run = access.run;

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write('retry: 3000\n\n');

      let closed = false;
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

      const lostAccess = async (): Promise<void> => {
        try {
          await writeEvent(reply, {
            type: 'run_unavailable',
            message: '运行记录已不存在，或当前账户已无权读取该频道运行，已停止接收。',
          });
        } catch (err) {
          request.log.warn({ err, runId }, 'channel run sse lost-access write failed');
        } finally {
          finish();
        }
      };

      // 轮询同时复核 run 是否仍在与成员关系是否仍有效。
      const scheduleRecheck = (): void => {
        if (closed || finishing) return;
        recheckTimer = setTimeout(() => {
          recheckTimer = undefined;
          void recheck();
        }, TERMINAL_RECHECK_MS);
      };
      const recheck = async (): Promise<void> => {
        let current: Awaited<ReturnType<typeof channelControl.getChannelRunForMember>>;
        try {
          current = await channelControl.getChannelRunForMember(app.db, businessId, id, runId);
        } catch {
          // 数据库错误可能带上连接信息，只记录标识。
          request.log.warn({ runId }, 'channel run sse recheck failed');
          scheduleRecheck();
          return;
        }
        if (closed || finishing) return;
        if (!current) {
          finishing = true;
          await lostAccess();
          return;
        }
        const missed = terminalEvent(current.run);
        if (!missed) {
          scheduleRecheck();
          return;
        }
        finishing = true;
        try {
          await writeEvent(reply, { type: 'replay_truncated', reason: 'terminal_missing' });
          await writeEvent(reply, missed);
        } catch (err) {
          request.log.error({ err, runId }, 'channel run sse write failed');
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
            // 回放和跟读都可能跨过撤权时刻：每条事件发送前重新确认成员关系。
            let access: Awaited<ReturnType<typeof channelControl.getChannelRunForMember>>;
            try {
              access = await channelControl.getChannelRunForMember(app.db, businessId, id, runId);
            } catch {
              // 查询失败时 producer 已推进 lastId，这条事件无法补发；发固定 error 并结束，
              // 不能继续回放，否则用户会看到缺失 token 的正常流。数据库错误可能带上连接信息，不记录 err。
              finishing = true;
              request.log.error({ runId }, 'channel run sse membership check failed');
              try {
                await writeEvent(reply, {
                  type: 'error',
                  message: '事件流中断，请刷新页面或重试',
                });
              } catch (writeErr) {
                request.log.error({ err: writeErr, runId }, 'channel run sse write failed');
              }
              finish();
              return;
            }
            if (closed || finishing) return;
            if (!access) {
              finishing = true;
              await lostAccess();
              return;
            }
            const terminal =
              event.type === 'run_finished' ||
              event.type === 'error' ||
              event.type === 'run_unavailable';
            // 先同步占位再 await 写入，轮询探测到的终态不会插进这次写入中间。
            if (terminal) finishing = true;
            try {
              await writeEvent(reply, event);
            } catch (err) {
              request.log.error({ err, runId }, 'channel run sse write failed');
              finish();
              return;
            }
            if (terminal) finish();
          },
          subscriptionAbort.signal,
        );
      } catch (err) {
        request.log.error({ err, runId }, 'channel run sse subscribe failed');
        try {
          await writeEvent(reply, {
            type: 'error',
            message: '事件流中断，请刷新页面或重试',
          });
        } catch {
          // 客户端已断开，没有可写的通道。
        }
        finish();
        return;
      }

      if (closed) {
        subscription.close();
        return;
      }

      // 重连到已结束的 run：订阅只会有未来事件，必须从 DB 补发终态。
      const finished = terminalEvent(run);
      if (finished) {
        finishing = true;
        try {
          await writeEvent(reply, { type: 'replay_truncated', reason: 'terminal_missing' });
          await writeEvent(reply, finished);
        } catch (err) {
          request.log.error({ err, runId }, 'channel run sse write failed');
        }
        finish();
        return;
      }

      scheduleRecheck();
    },
  );

  app.post(
    '/api/channels/:id/runs/:runId/stop',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: runParams },
    },
    async (request, reply) => {
      const { id, runId } = request.params;
      const result = await channelControl.stopRun(
        app.db,
        userPrincipal(request).businessId,
        id,
        runId,
      );
      switch (result.kind) {
        case 'not_found':
          return result.target === 'run'
            ? notFound(reply, '运行不存在或不属于该频道')
            : notFound(reply);
        case 'forbidden':
          return forbidden(
            reply,
            result.reason === 'run_owner'
              ? '只有触发该运行的成员或频道管理员可以停止'
              : 'viewer 不能停止运行',
          );
        case 'ok': {
          const cancelled = await cancelRun(app, request, id, result.run);
          if (cancelled) {
            await writeAudit(app.db, request.log, {
              actor: actorOf(request),
              action: 'agent.run.cancelled',
              target: result.run.id,
              status: 'ok',
              requestId: request.id,
            });
          }
          return reply.status(202).send({ ok: true });
        }
      }
    },
  );

  app.post(
    '/api/channels/:id/agents/:agentId/disconnect',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: agentParams },
    },
    async (request, reply) => {
      const { id, agentId } = request.params;
      const result = await channelControl.disconnectAgent(
        app.db,
        userPrincipal(request).businessId,
        id,
        agentId,
      );
      switch (result.kind) {
        case 'not_found':
          return result.target === 'agent'
            ? notFound(reply, '智能体未加入该频道')
            : notFound(reply);
        case 'forbidden':
          return forbidden(reply, '仅频道 owner 或 admin 可以断开智能体');
        case 'ok': {
          const cancel = await cancelRunBatch(app, request, id, result.runs);
          if (cancel.failedRunIds.length > 0) {
            request.log.warn(
              { channelId: id, failedRunIds: cancel.failedRunIds },
              'channel disconnect left runs uncancelled',
            );
            await writeAudit(app.db, request.log, {
              actor: actorOf(request),
              action: 'channel.agent.disconnected',
              target: agentId,
              input: {
                channelId: id,
                cancelledRuns: cancel.cancelled,
                failedRunIds: cancel.failedRunIds,
              },
              status: 'error',
              requestId: request.id,
            });
            throw new AppError('SERVICE_UNAVAILABLE', '智能体已断开，但部分运行未能停止，请重试');
          }
          await writeAudit(app.db, request.log, {
            actor: actorOf(request),
            action: 'channel.agent.disconnected',
            target: agentId,
            input: { channelId: id, cancelledRuns: cancel.cancelled },
            status: 'ok',
            requestId: request.id,
          });
          return reply.status(204).send();
        }
      }
    },
  );

  app.post(
    '/api/channels/:id/close',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: idParams },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await channelControl.closeChannel(
        app.db,
        userPrincipal(request).businessId,
        id,
      );
      switch (result.kind) {
        case 'not_found':
          return notFound(reply);
        case 'forbidden':
          return forbidden(reply, '仅频道 owner 可以关闭频道');
        case 'ok': {
          const cancel = await cancelRunBatch(app, request, id, result.runs);
          if (cancel.failedRunIds.length > 0) {
            request.log.warn(
              { channelId: id, failedRunIds: cancel.failedRunIds },
              'channel close left runs uncancelled',
            );
            await writeAudit(app.db, request.log, {
              actor: actorOf(request),
              action: 'channel.closed',
              target: id,
              input: { cancelledRuns: cancel.cancelled, failedRunIds: cancel.failedRunIds },
              status: 'error',
              requestId: request.id,
            });
            throw new AppError('SERVICE_UNAVAILABLE', '频道已关闭，但部分运行未能停止，请重试');
          }
          await writeAudit(app.db, request.log, {
            actor: actorOf(request),
            action: 'channel.closed',
            target: id,
            input: { cancelledRuns: cancel.cancelled },
            status: 'ok',
            requestId: request.id,
          });
          return reply.send({ id, archivedAt: result.archivedAt.toISOString() });
        }
      }
    },
  );
}
