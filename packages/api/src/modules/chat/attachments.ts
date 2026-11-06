import { fail, readConversationAttachment } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { authorizeObject } from '../../http/access.js';
import type { HttpEnv } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { isAppError } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { contentDisposition } from './outputs.js';

const notFound = () => fail('NOT_FOUND', '附件不存在，可能已被清理');
export function registerChatAttachmentsHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/conversations/:id/attachments/:attachmentId/download',
    access({ kind: 'permission', permissionId: 'conversations.read' }),
    async (c) => {
      const context = requestContext(c);
      const input = z
        .object({
          params: z.object({
            id: z.string().min(1),
            attachmentId: z.string().min(1),
          }),
        })
        .parse({ params: c.req.param(), query: c.req.query() });
      const conversation = await repo.chat.getConversation(context.db, input.params.id);
      if (!conversation) {
        return fail('CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请从会话列表重新打开');
      }
      await authorizeObject(
        context,
        'conversations.read',
        { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
        '会话不存在，可能已被删除；请从会话列表重新打开',
      );
      const attachment = await repo.chat.findConversationAttachment(
        context.db,
        conversation.id,
        input.params.attachmentId,
      );
      if (!attachment) return notFound();
      const [agent] = await context.db
        .select({ slug: schema.agents.slug })
        .from(schema.agents)
        .where(eq(schema.agents.id, conversation.agentId))
        .limit(1);
      if (!agent) return notFound();
      let file: Awaited<ReturnType<typeof readConversationAttachment>>;
      try {
        file = await readConversationAttachment({
          root: context.config.WORKSPACES_DIR,
          slug: agent.slug,
          conversationId: conversation.id,
          attachment,
        });
      } catch (err) {
        if (isAppError(err) && err.code === 'NOT_FOUND') return notFound();
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
