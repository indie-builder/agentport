import { repo } from '@agentport/db';
import type { PermissionId } from '@agentport/shared';
import { ATTACHMENT_LIMITS } from '@agentport/shared';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { authorize } from '../../http/access.js';
import { requestBodyLimit } from '../../http/body-limit.js';
import type { HttpEnv, NativeHttpDependencies, RequestContext } from '../../http/context.js';
import { parseRequest, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { beginSse } from '../../http/sse.js';
import { authorizeRun } from '../runs/access.js';
import { writeChatEvent } from '../runs/events.js';
import { relayRunEvents } from '../runs/stream.js';
import { registerChatAttachmentsHttp } from './attachments.js';
import { registerChatOutputsHttp } from './outputs.js';

function hasPlatformScope(context: RequestContext, permissionId: PermissionId): boolean {
  const principal = context.principal;
  return (
    principal?.kind === 'user' &&
    principal.grants.some(
      (grant) => grant.permissionId === permissionId && grant.scope === 'platform',
    )
  );
}

function registerChatEventsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  app.get(
    '/api/chat/:runId/events',
    access({ kind: 'permission', permissionId: 'runs.read' }),
    async (c) => {
      const context = requestContext(c);
      const input = parseRequest(c, z.object({ params: z.object({ runId: z.string().min(1) }) }));
      const { runId } = input.params;
      const run = await authorizeRun(context, runId, 'runs.read');
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
              const current = await repo.chat.getRun(context.db, runId);
              if (current === null) return { kind: 'unavailable', reason: 'missing' };
              if (!hasPlatformScope(context, 'runs.read')) {
                try {
                  await authorize(context, 'runs.read', {
                    objectId: current.id,
                    createdBy: current.initiatedBy,
                    privateContent: true,
                  });
                } catch {
                  return { kind: 'unavailable', reason: 'forbidden' };
                }
              }
              return { kind: 'run', run: current };
            },
            writeUnavailable: async (reason) => {
              const message =
                reason === 'missing'
                  ? '运行记录已不存在，已停止接收。'
                  : '当前账户已无权读取该运行，已停止接收。';
              try {
                await writeChatEvent(stream, { type: 'run_unavailable', message });
              } catch (err) {
                context.log.warn(
                  reason === 'missing' ? { runId } : { err, runId },
                  reason === 'missing'
                    ? 'sse run unavailable write failed'
                    : 'sse access recheck write failed',
                );
              }
            },
            labels: {
              recheckFailed: 'sse terminal recheck failed',
              writeFailed: 'sse write failed',
              subscribeFailed: 'sse subscribe failed',
            },
          },
        });
      });
    },
  );
}

export function registerChatHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  app.on('POST', '/api/chat', requestBodyLimit(ATTACHMENT_LIMITS.bodyBytes));
  registerChatEventsHttp(app, deps);
  registerChatOutputsHttp(app);
  registerChatAttachmentsHttp(app);
}
