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
  message: string = CONVERSATION_MISSING,
) {
  const conversation = await repo.chat.getConversation(context.db, id);
  if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND', message);
  await authorizeObject(
    context,
    permissionId,
    { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
    message,
  );
  return conversation;
}

export function loadReadableConversation(context: RequestContext, id: string) {
  return loadConversationFor(context, id, 'conversations.read');
}

export function loadWritableConversation(context: RequestContext, id: string) {
  return loadConversationFor(context, id, 'conversations.update');
}

export function loadOpenuiConversation(
  context: RequestContext,
  id: string,
  permissionId: PermissionId,
) {
  return loadConversationFor(context, id, permissionId, '会话不存在，可能已被删除；请刷新后重试');
}
