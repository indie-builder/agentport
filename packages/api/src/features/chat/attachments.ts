import { readConversationAttachment } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isAppError, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { contentDisposition } from './outputs.js';

const attachmentParams = z.object({
  id: z.string().min(1),
  attachmentId: z.string().min(1),
});

const notFound = (reply: FastifyReply) => reject(reply, 'NOT_FOUND', '附件不存在，可能已被清理');

export function registerAttachmentRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.get(
    '/api/conversations/:id/attachments/:attachmentId/download',
    { preHandler: [rawApp.requireAuth], schema: { params: attachmentParams } },
    async (request, reply) => {
      const conversation = await repo.chat.getConversation(app.db, request.params.id);
      if (!conversation) {
        return reject(
          reply,
          'CONVERSATION_NOT_FOUND',
          '会话不存在，可能已被删除；请从会话列表重新打开',
        );
      }
      // 只接受本会话消息实际引用的附件；跨会话或伪造 id 与不存在同义。
      const attachment = await repo.chat.findConversationAttachment(
        app.db,
        conversation.id,
        request.params.attachmentId,
      );
      if (!attachment) return notFound(reply);

      const [agent] = await app.db
        .select({ slug: schema.agents.slug })
        .from(schema.agents)
        .where(eq(schema.agents.id, conversation.agentId))
        .limit(1);
      if (!agent) return notFound(reply);

      let file: Awaited<ReturnType<typeof readConversationAttachment>>;
      try {
        file = await readConversationAttachment({
          root: app.config.WORKSPACES_DIR,
          slug: agent.slug,
          conversationId: conversation.id,
          attachment,
        });
      } catch (err) {
        // 目录/文件缺失是清理后的正常结果；其余错误交给统一 500，不泄露宿主路径。
        if (isAppError(err) && err.code === 'NOT_FOUND') return notFound(reply);
        throw err;
      }

      // 一律 attachment + no-store + nosniff：图片/PDF 也不作为同源文档执行。
      return reply
        .header('Content-Type', file.mimeType)
        .header('Content-Disposition', contentDisposition(file.filename))
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(file.data);
    },
  );
}
