import { fail, readChannelAttachment } from '@agentport/core';
import { repo } from '@agentport/db';
import {
  ATTACHMENT_LIMITS,
  type ChannelEvent,
  channelEventsQuerySchema,
  channelMessageCreatedEvent,
  idParams,
  outputPathSchema,
  SERVER_SHUTDOWN_MESSAGE,
} from '@agentport/shared';
import type { Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { requireUser } from '../../http/access.js';
import { attachmentResponse } from '../../http/attachment.js';
import { requestBodyLimit } from '../../http/body-limit.js';
import type { HttpEnv, NativeHttpDependencies } from '../../http/context.js';
import { parseRequest, requestContext } from '../../http/context.js';
import { CHANNEL_NOT_FOUND_MESSAGE, isAppError } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { beginSse } from '../../http/sse.js';
import { safeMediaType } from '../../lib/outputs.js';
import { type RunSubscription, subscribeChannel } from '../../queue/producer.js';
import { ATTACHMENT_MISSING_MESSAGE } from '../chat/access.js';
import { auditChannelRead, channelSubject } from './access.js';
import { registerChannelRunEventsHttp } from './control.js';
import { readChannelRunOutput } from './runs.js';

const SSE_BATCH = 200;
const SSE_POLL_MS = 3000;
const SSE_FALLBACK_POLL_MS = 30_000;

async function writeEvent(
  stream: SSEStreamingApi,
  event: ChannelEvent,
  id?: string,
): Promise<void> {
  await stream.writeSSE({
    ...(id === undefined ? {} : { id }),
    data: JSON.stringify(event),
  });
}

function parseEventCursor(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function registerChannelEventsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  app.get('/api/channels/:id/events', access({ kind: 'authenticated' }), async (c) => {
    const context = requestContext(c);
    const input = parseRequest(c, z.object({ params: idParams, query: channelEventsQuerySchema }));
    const { id } = input.params;
    const subject = channelSubject(context);
    const readAccess = await repo.channels.getChannelReadAccess(context.db, subject, id);
    if (!readAccess) return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
    if (input.query.after > readAccess.maxSeq) {
      return fail('INVALID_INPUT', '事件游标超过频道当前消息序号');
    }
    const lastEventId = parseEventCursor(c.req.header('Last-Event-ID'));
    const initialCursor =
      lastEventId === undefined
        ? input.query.after
        : Math.min(Math.max(input.query.after, lastEventId), readAccess.maxSeq);
    const initial = await repo.channels.listMessages(context.db, subject, id, {
      after: initialCursor,
      limit: SSE_BATCH,
    });
    if (initial.kind === 'not_found') return fail('NOT_FOUND', CHANNEL_NOT_FOUND_MESSAGE);
    await auditChannelRead(context, { id, createdBy: initial.createdBy });
    beginSse(c, deps.timeout);
    let cursor = initialCursor;
    return streamSSE(c, async (stream) => {
      await stream.write('retry: 3000\n\n');
      let resolveClosed!: () => void;
      const ended = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      let closed = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionAbort = new AbortController();
      let subscription: RunSubscription | undefined;
      let catchUpTail: Promise<void> = Promise.resolve();
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        resolveClosed();
        c.req.raw.signal.removeEventListener('abort', cleanup);
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        subscriptionAbort.abort();
        subscription?.close();
      };
      const finish = (): void => {
        cleanup();
        void stream.close();
      };
      const lostAccess = async (): Promise<void> => {
        try {
          await writeEvent(stream, {
            type: 'error',
            code: 'FORBIDDEN',
            message: '当前账户已无权读取该频道，已停止接收。',
          });
        } finally {
          finish();
        }
      };
      const sendMessages = async (rows: repo.channels.ChannelMessageRow[]): Promise<void> => {
        for (const row of rows) {
          if (closed) return;
          const access = await repo.channels.getChannelReadAccess(context.db, subject, id);
          if (closed) return;
          if (!access) {
            await lostAccess();
            return;
          }
          const message = repo.channels.toChannelMessage(row);
          cursor = message.seq;
          await writeEvent(stream, channelMessageCreatedEvent(id, message), String(message.seq));
        }
      };
      const catchUp = async (): Promise<void> => {
        for (;;) {
          if (closed) return;
          let page: Awaited<ReturnType<typeof repo.channels.listMessages>>;
          try {
            page = await repo.channels.listMessages(context.db, subject, id, {
              after: cursor,
              limit: SSE_BATCH,
            });
          } catch (err) {
            context.log.warn({ err, channelId: id }, 'channel sse catch-up failed');
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
            context.log.error({ err, channelId: id }, 'channel sse write failed');
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
      stream.onAbort(cleanup);
      if (c.req.raw.signal.aborted) cleanup();
      else c.req.raw.signal.addEventListener('abort', cleanup, { once: true });
      try {
        await sendMessages(initial.items);
        if (initial.items.length === SSE_BATCH) await catchUp();
      } catch (err) {
        context.log.error({ err, channelId: id }, 'channel sse history failed');
        finish();
        return;
      }
      if (closed) return;
      let pollInterval = SSE_FALLBACK_POLL_MS;
      let polling = false;
      const schedulePoll = (): void => {
        if (closed) return;
        polling = true;
        pollTimer = setTimeout(() => {
          pollTimer = undefined;
          void enqueueCatchUp().finally(schedulePoll);
        }, pollInterval);
      };
      const startPolling = (interval: number): void => {
        if (closed) return;
        if (pollTimer !== undefined) {
          if (pollInterval === interval) return;
          pollInterval = interval;
          clearTimeout(pollTimer);
          pollTimer = undefined;
          schedulePoll();
          return;
        }
        pollInterval = interval;
        if (!polling) schedulePoll();
      };
      try {
        subscription = await subscribeChannel(
          id,
          async (event) => {
            if (closed) return;
            if (event.type === 'error') {
              if (event.message === SERVER_SHUTDOWN_MESSAGE) {
                finish();
                return;
              }
              context.log.warn(
                { channelId: id },
                'channel redis subscription ended; DB polling continues',
              );
              startPolling(SSE_POLL_MS);
              return;
            }
            await enqueueCatchUp();
            if (closed || event.type === 'message.created') return;
            const access = await repo.channels.getChannelReadAccess(context.db, subject, id);
            if (closed) return;
            if (!access) {
              await lostAccess();
              return;
            }
            try {
              await writeEvent(stream, event);
            } catch (err) {
              context.log.error({ err, channelId: id }, 'channel sse write failed');
              finish();
            }
          },
          subscriptionAbort.signal,
        );
      } catch (err) {
        context.log.warn(
          { err, channelId: id },
          'channel sse subscribe failed; DB polling continues',
        );
        startPolling(SSE_POLL_MS);
        await ended;
        return;
      }
      if (closed) subscription.close();
      else startPolling(SSE_FALLBACK_POLL_MS);
      await ended;
    });
  });
}

function registerChannelRunOutputsHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/channels/:id/runs/:runId/outputs/download',
    access({ kind: 'authenticated' }),
    async (c) => {
      const context = requestContext(c);
      const input = parseRequest(
        c,
        z.object({
          params: z.object({ id: z.string().min(1), runId: z.string().min(1) }),
          query: z.object({ path: outputPathSchema }),
        }),
      );
      const { file, data } = await readChannelRunOutput(
        context,
        input.params.id,
        input.params.runId,
        input.query.path,
      );
      return attachmentResponse(new Uint8Array(data), file.path, safeMediaType(file.mediaType));
    },
  );
}

function registerChannelAttachmentsHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/channels/:id/messages/:messageId/attachments/:attachmentId/download',
    access({ kind: 'authenticated' }),
    async (c) => {
      const context = requestContext(c);
      const input = parseRequest(
        c,
        z.object({
          params: z.object({
            id: z.string().min(1),
            messageId: z.string().min(1),
            attachmentId: z.string().min(1),
          }),
        }),
      );
      const principal = requireUser(context);
      const message = await repo.channels.getMessageForMember(
        context.db,
        principal.businessId,
        input.params.id,
        input.params.messageId,
      );
      const attachment = message?.attachments?.find(
        (item) => item.id === input.params.attachmentId,
      );
      if (attachment === undefined) return fail('NOT_FOUND', ATTACHMENT_MISSING_MESSAGE);
      let file: Awaited<ReturnType<typeof readChannelAttachment>>;
      try {
        file = await readChannelAttachment({
          root: context.config.WORKSPACES_DIR,
          channelId: input.params.id,
          messageId: input.params.messageId,
          attachment,
        });
      } catch (err) {
        if (isAppError(err) && err.code === 'NOT_FOUND') {
          return fail('NOT_FOUND', ATTACHMENT_MISSING_MESSAGE);
        }
        throw err;
      }
      return attachmentResponse(new Uint8Array(file.data), file.filename, file.mimeType);
    },
  );
}

export function registerChannelsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  app.on('POST', '/api/channels/:id/messages', requestBodyLimit(ATTACHMENT_LIMITS.bodyBytes));
  registerChannelEventsHttp(app, deps);
  registerChannelRunEventsHttp(app, deps);
  registerChannelAttachmentsHttp(app);
  registerChannelRunOutputsHttp(app);
}
