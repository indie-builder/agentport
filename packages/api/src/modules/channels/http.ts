import { fail, readChannelAttachment } from '@agentport/core';
import { repo } from '@agentport/db';
import { outputPathSchema } from '@agentport/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requireUser } from '../../http/access.js';
import type { HttpEnv } from '../../http/context.js';
import { parseRequest, requestContext } from '../../http/context.js';
import { isAppError } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import type { NativeHttpDependencies } from '../chat/http.js';
import { contentDisposition, safeMediaType } from '../chat/outputs.js';
import { registerChannelRunEventsHttp } from './control.js';
import { registerChannelEventsHttp } from './router.js';
import { readChannelRunOutput } from './runs.js';

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
      c.header('Content-Type', safeMediaType(file.mediaType));
      c.header('Content-Disposition', contentDisposition(file.path));
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(data));
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
      if (attachment === undefined) return fail('NOT_FOUND', '附件不存在，可能已被清理');
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
          return fail('NOT_FOUND', '附件不存在，可能已被清理');
        }
        throw err;
      }
      c.header('Content-Type', file.mimeType);
      c.header('Content-Disposition', contentDisposition(file.filename));
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(file.data));
    },
  );
}

export function registerChannelsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  registerChannelEventsHttp(app, deps);
  registerChannelRunEventsHttp(app, deps);
  registerChannelAttachmentsHttp(app);
  registerChannelRunOutputsHttp(app);
}
