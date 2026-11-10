import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import type { PermissionId } from '@agentport/shared';
import { authorizeObject } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';

export const CONVERSATION_MISSING = '会话不存在，可能已被删除；请从会话列表重新打开';

async function loadConversationFor(
  context: RequestContext,
  id: string,
  permissionId: PermissionId,
) {
  const conversation = await repo.chat.getConversation(context.db, id);
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
  await authorizeObject(
    context,
    permissionId,
    { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
    CONVERSATION_MISSING,
  );
  return conversation;
}

export function loadReadableConversation(context: RequestContext, id: string) {
  return loadConversationFor(context, id, 'conversations.read');
}

export function loadWritableConversation(context: RequestContext, id: string) {
  return loadConversationFor(context, id, 'conversations.update');
}
