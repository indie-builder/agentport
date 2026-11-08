import { channelsContract } from '@agentport/contract/channels';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { implement } from '@orpc/server';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { actorOf, requireUser } from '../../http/access.js';
import type { HttpEnv, RequestContext } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { AppError } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { publishChannelEvent, subscribeRun } from '../../queue/producer.js';
import { cancelAgentRun } from '../chat/cancel-run.js';
import type { NativeHttpDependencies } from '../chat/http.js';
import { terminalRunEvent, writeChatEvent } from '../runs/events.js';

const channelControl = repo.channelControl;
const TERMINAL_RECHECK_MS = 2000;
type ControlRun = repo.channelControl.ControlRun;
function toActiveRun(run: ControlRun) {
  return {
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    initiatedBy: run.initiatedBy,
    startedAt: run.startedAt?.toISOString() ?? null,
  };
}

function notFound(message = '频道不存在或你不是频道成员'): never {
  return fail('NOT_FOUND', message);
}
function forbidden(message: string): never {
  return fail('FORBIDDEN', message);
}
async function publishChannelFinished(
  context: RequestContext,
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
    context.log.warn({ err, runId: run.id }, 'channel run.finished publish failed');
  }
}
async function cancelRun(
  context: RequestContext,
  channelId: string,
  run: ControlRun,
): Promise<boolean> {
  if (run.status !== 'queued' && run.status !== 'running') return false;
  const result = await cancelAgentRun(context, run.id);
  if (result === 'queued') await publishChannelFinished(context, channelId, run);
  return result !== null;
}
type CancelRunBatchResult = {
  cancelled: number;
  failedRunIds: string[];
};
export async function cancelRunBatch(
  context: RequestContext,
  channelId: string,
  runs: ControlRun[],
): Promise<CancelRunBatchResult> {
  let cancelled = 0;
  const failedRunIds: string[] = [];
  for (const run of runs) {
    try {
      if (await cancelRun(context, channelId, run)) cancelled += 1;
    } catch (err) {
      context.log.warn({ err, runId: run.id }, 'channel control cancel failed');
      failedRunIds.push(run.id);
    }
  }
  return { cancelled, failedRunIds };
}

const os = implement(channelsContract).$context<RequestContext>();
export const channelsControlRouter = {
  activeRuns: os.activeRuns.handler(async ({ input, context }) => {
    const result = await channelControl.listActiveRuns(
      context.db,
      requireUser(context).businessId,
      input.params.id,
    );
    if (result.kind === 'not_found') return notFound();
    return { items: result.runs.map(toActiveRun) };
  }),
  stopRun: os.stopRun.handler(async ({ input, context }) => {
    const { id, runId } = input.params;
    const result = await channelControl.stopRun(
      context.db,
      requireUser(context).businessId,
      id,
      runId,
    );
    switch (result.kind) {
      case 'not_found':
        return result.target === 'run' ? notFound('运行不存在或不属于该频道') : notFound();
      case 'forbidden':
        return forbidden(
          result.reason === 'run_owner'
            ? '只有触发该运行的成员或频道管理员可以停止'
            : 'viewer 不能停止运行',
        );
      case 'ok': {
        const cancelled = await cancelRun(context, id, result.run);
        if (cancelled) {
          await repo.audit.writeAudit(context.db, context.log, {
            actor: actorOf(context),
            action: 'agent.run.cancelled',
            target: result.run.id,
            status: 'ok',
            requestId: context.requestId,
          });
        }
        return { ok: true };
      }
    }
  }),
  disconnectAgent: os.disconnectAgent.handler(async ({ input, context }) => {
    const { id, agentId } = input.params;
    const result = await channelControl.disconnectAgent(
      context.db,
      requireUser(context).businessId,
      id,
      agentId,
    );
    switch (result.kind) {
      case 'not_found':
        return result.target === 'agent' ? notFound('智能体未加入该频道') : notFound();
      case 'forbidden':
        return forbidden('仅频道 owner 或 admin 可以断开智能体');
      case 'ok': {
        const cancel = await cancelRunBatch(context, id, result.runs);
        if (cancel.failedRunIds.length > 0) {
          context.log.warn(
            { channelId: id, failedRunIds: cancel.failedRunIds },
            'channel disconnect left runs uncancelled',
          );
          await repo.audit.writeAudit(context.db, context.log, {
            actor: actorOf(context),
            action: 'channel.agent.disconnected',
            target: agentId,
            input: {
              channelId: id,
              cancelledRuns: cancel.cancelled,
              failedRunIds: cancel.failedRunIds,
            },
            status: 'error',
            requestId: context.requestId,
          });
          throw new AppError('SERVICE_UNAVAILABLE', '智能体已断开，但部分运行未能停止，请重试');
        }
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'channel.agent.disconnected',
          target: agentId,
          input: { channelId: id, cancelledRuns: cancel.cancelled },
          status: 'ok',
          requestId: context.requestId,
        });
        return undefined;
      }
    }
  }),
  close: os.close.handler(async ({ input, context }) => {
    const { id } = input.params;
    const result = await channelControl.closeChannel(
      context.db,
      requireUser(context).businessId,
      id,
    );
    switch (result.kind) {
      case 'not_found':
        return notFound();
      case 'forbidden':
        return forbidden('仅频道 owner 可以关闭频道');
      case 'ok': {
        const cancel = await cancelRunBatch(context, id, result.runs);
        if (cancel.failedRunIds.length > 0) {
          context.log.warn(
            { channelId: id, failedRunIds: cancel.failedRunIds },
            'channel close left runs uncancelled',
          );
          await repo.audit.writeAudit(context.db, context.log, {
            actor: actorOf(context),
            action: 'channel.closed',
            target: id,
            input: { cancelledRuns: cancel.cancelled, failedRunIds: cancel.failedRunIds },
            status: 'error',
            requestId: context.requestId,
          });
          throw new AppError('SERVICE_UNAVAILABLE', '频道已关闭，但部分运行未能停止，请重试');
        }
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'channel.closed',
          target: id,
          input: { cancelledRuns: cancel.cancelled },
          status: 'ok',
          requestId: context.requestId,
        });
        return { id, archivedAt: result.archivedAt.toISOString() };
      }
    }
  }),
};
export function registerChannelRunEventsHttp(
  app: Hono<HttpEnv>,
  deps: NativeHttpDependencies,
): void {
  app.get('/api/channels/:id/runs/:runId/events', access({ kind: 'authenticated' }), async (c) => {
    const context = requestContext(c);
    const input = z
      .object({ params: z.object({ id: z.string().min(1), runId: z.string().min(1) }) })
      .parse({ params: c.req.param(), query: c.req.query() });
    const { id, runId } = input.params;
    const businessId = requireUser(context).businessId;
    const access = await channelControl.getChannelRunForMember(context.db, businessId, id, runId);
    if (!access) return notFound('运行不存在或不属于该频道');
    const run = access.run;
    deps.timeout(c.req.raw, 0);
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      await stream.write('retry: 3000\n\n');
      let resolveClosed!: () => void;
      const ended = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      let closed = false;
      let finishing = false;
      let recheckTimer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionAbort = new AbortController();
      let subscription:
        | {
            close: () => void;
          }
        | undefined;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        resolveClosed();
        c.req.raw.signal.removeEventListener('abort', cleanup);
        if (recheckTimer !== undefined) clearTimeout(recheckTimer);
        subscriptionAbort.abort();
        subscription?.close();
      };
      const finish = (): void => {
        cleanup();
        void stream.close();
      };
      const lostAccess = async (): Promise<void> => {
        try {
          await writeChatEvent(stream, {
            type: 'run_unavailable',
            message: '运行记录已不存在，或当前账户已无权读取该频道运行，已停止接收。',
          });
        } catch (err) {
          context.log.warn({ err, runId }, 'channel run sse lost-access write failed');
        } finally {
          finish();
        }
      };
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
          current = await channelControl.getChannelRunForMember(context.db, businessId, id, runId);
        } catch {
          context.log.warn({ runId }, 'channel run sse recheck failed');
          scheduleRecheck();
          return;
        }
        if (closed || finishing) return;
        if (!current) {
          finishing = true;
          await lostAccess();
          return;
        }
        const missed = terminalRunEvent(current.run);
        if (!missed) {
          scheduleRecheck();
          return;
        }
        finishing = true;
        try {
          await writeChatEvent(stream, { type: 'replay_truncated', reason: 'terminal_missing' });
          await writeChatEvent(stream, missed);
        } catch (err) {
          context.log.error({ err, runId }, 'channel run sse write failed');
        }
        finish();
      };
      stream.onAbort(cleanup);
      if (c.req.raw.signal.aborted) cleanup();
      else c.req.raw.signal.addEventListener('abort', cleanup, { once: true });
      try {
        subscription = await subscribeRun(
          runId,
          async (event) => {
            if (closed || finishing) return;
            let access: Awaited<ReturnType<typeof channelControl.getChannelRunForMember>>;
            try {
              access = await channelControl.getChannelRunForMember(
                context.db,
                businessId,
                id,
                runId,
              );
            } catch {
              finishing = true;
              context.log.error({ runId }, 'channel run sse membership check failed');
              try {
                await writeChatEvent(stream, {
                  type: 'error',
                  message: '事件流中断，请刷新页面或重试',
                });
              } catch (writeErr) {
                context.log.error({ err: writeErr, runId }, 'channel run sse write failed');
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
            if (terminal) finishing = true;
            try {
              await writeChatEvent(stream, event);
            } catch (err) {
              context.log.error({ err, runId }, 'channel run sse write failed');
              finish();
              return;
            }
            if (terminal) finish();
          },
          subscriptionAbort.signal,
        );
      } catch (err) {
        context.log.error({ err, runId }, 'channel run sse subscribe failed');
        try {
          await writeChatEvent(stream, {
            type: 'error',
            message: '事件流中断，请刷新页面或重试',
          });
        } catch {}
        finish();
        return;
      }
      if (closed) {
        subscription.close();
        return;
      }
      const finished = terminalRunEvent(run);
      if (finished) {
        finishing = true;
        try {
          await writeChatEvent(stream, { type: 'replay_truncated', reason: 'terminal_missing' });
          await writeChatEvent(stream, finished);
        } catch (err) {
          context.log.error({ err, runId }, 'channel run sse write failed');
        }
        finish();
        return;
      }
      scheduleRecheck();
      await ended;
    });
  });
}
