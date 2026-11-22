import { channelsContract } from '@agentport/contract/channels';
import { repo } from '@agentport/db';
import { channelRunFinishedEvent, isActiveRunStatus } from '@agentport/shared';
import { implement } from '@orpc/server';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { actorOf, requireUser } from '../../http/access.js';
import type { HttpEnv, NativeHttpDependencies, RequestContext } from '../../http/context.js';
import { parseRequest, requestContext } from '../../http/context.js';
import { AppError } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { beginSse } from '../../http/sse.js';
import { cancelAgentRun } from '../runs/cancel-run.js';
import { writeChatEvent } from '../runs/events.js';
import { relayRunEvents } from '../runs/stream.js';
import { CHANNEL_MEMBER_MISSING, forbidden, notFound, RUN_NOT_IN_CHANNEL } from './errors.js';
import { publishChannelEventSafely, publishChannelMessageSafely } from './publish.js';

const channelControl = repo.channelControl;
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

async function publishChannelFinished(
  context: RequestContext,
  channelId: string,
  run: ControlRun,
): Promise<void> {
  await publishChannelEventSafely(
    context.log,
    channelId,
    channelRunFinishedEvent({
      channelId,
      runId: run.id,
      agentId: run.agentId,
      status: 'cancelled',
    }),
    { runId: run.id },
  );
}
async function cancelRun(
  context: RequestContext,
  channelId: string,
  run: ControlRun,
  recordNotice = false,
): Promise<boolean> {
  if (!isActiveRunStatus(run.status)) return false;
  const result = await cancelAgentRun(context, run.id);
  if (result === 'queued') {
    await publishChannelFinished(context, channelId, run);
    if (recordNotice) {
      try {
        const notice = await repo.channels.postSystemMessage(context.db, {
          channelId,
          agentId: run.agentId,
          runId: run.id,
          allowArchived: true,
          body: '运行已停止，打开运行详情查看状态。',
        });
        if (notice !== null)
          await publishChannelMessageSafely(
            context.log,
            channelId,
            repo.channels.toChannelMessage(notice),
            { runId: run.id },
          );
      } catch (err) {
        context.log.warn({ err, runId: run.id }, 'channel stop notice failed');
      }
    }
  }
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
    if (result.kind === 'not_found') return notFound(CHANNEL_MEMBER_MISSING);
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
        return result.target === 'run'
          ? notFound(RUN_NOT_IN_CHANNEL)
          : notFound(CHANNEL_MEMBER_MISSING);
      case 'forbidden':
        return forbidden(
          result.reason === 'run_owner'
            ? '只有触发该运行的成员或频道管理员可以停止'
            : 'viewer 不能停止运行',
        );
      case 'ok': {
        const cancelled = await cancelRun(context, id, result.run, true);
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
        return result.target === 'agent'
          ? notFound('智能体未加入该频道')
          : notFound(CHANNEL_MEMBER_MISSING);
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
          throw new AppError('SERVICE_UNAVAILABLE', '智能体已断开，但部分运行未能停止，请重试', {
            retryable: true,
          });
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
        return notFound(CHANNEL_MEMBER_MISSING);
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
          throw new AppError('SERVICE_UNAVAILABLE', '频道已关闭，但部分运行未能停止，请重试', {
            retryable: true,
          });
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
    const input = parseRequest(
      c,
      z.object({ params: z.object({ id: z.string().min(1), runId: z.string().min(1) }) }),
    );
    const { id, runId } = input.params;
    const businessId = requireUser(context).businessId;
    const access = await channelControl.getChannelRunForMember(context.db, businessId, id, runId);
    if (!access) return notFound(RUN_NOT_IN_CHANNEL);
    const run = access.run;
    beginSse(c, deps.timeout);
    return streamSSE(c, async (stream) => {
      await relayRunEvents({
        stream,
        signal: c.req.raw.signal,
        runId,
        initialRun: run,
        log: context.log,
        domain: {
          load: async () => {
            const current = await channelControl.getChannelRunForMember(
              context.db,
              businessId,
              id,
              runId,
            );
            return current
              ? { kind: 'run', run: current.run }
              : { kind: 'unavailable', reason: 'missing' };
          },
          guard: async () => {
            try {
              const current = await channelControl.getChannelRunForMember(
                context.db,
                businessId,
                id,
                runId,
              );
              return current ? 'ok' : 'forbidden';
            } catch {
              return 'error';
            }
          },
          writeUnavailable: async () => {
            try {
              await writeChatEvent(stream, {
                type: 'run_unavailable',
                message: '运行记录已不存在，或当前账户已无权读取该频道运行，已停止接收。',
              });
            } catch (err) {
              context.log.warn({ err, runId }, 'channel run sse lost-access write failed');
            }
          },
          labels: {
            recheckFailed: 'channel run sse recheck failed',
            writeFailed: 'channel run sse write failed',
            subscribeFailed: 'channel run sse subscribe failed',
            guardFailed: 'channel run sse membership check failed',
          },
        },
      });
    });
  });
}
