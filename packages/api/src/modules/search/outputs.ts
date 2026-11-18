import { isAppError } from '@agentport/core';
import { repo } from '@agentport/db';
import type { PersonalOutputItem, PersonalOutputList } from '@agentport/shared';
import { requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { listWorkspaceOutputs } from '../../lib/outputs.js';

const RECENT_CONVERSATIONS = 50;
const FILES_PER_CONVERSATION = 100;

export async function collectPersonalOutputs(
  context: RequestContext,
  options: { q: string | undefined; limit: number },
): Promise<PersonalOutputList> {
  const conversations = await repo.chat.listOwnConversationsWithAgent(
    context.db,
    requireUser(context).businessId,
    RECENT_CONVERSATIONS,
  );
  const pages = await Promise.all(
    conversations.map(async (conversation) => {
      const page = await listWorkspaceOutputs(context, {
        slug: conversation.agentSlug,
        conversationId: conversation.id,
        limit: FILES_PER_CONVERSATION,
      }).catch((error: unknown) => {
        if (isAppError(error) && error.code === 'NOT_FOUND') return { items: [], nextCursor: null };
        throw error;
      });
      return { conversation, page };
    }),
  );

  const needle = options.q === undefined || options.q === '' ? null : options.q.toLocaleLowerCase();
  const items = pages.flatMap(({ conversation, page }) =>
    page.items.flatMap((file): PersonalOutputItem[] => {
      if (needle !== null && !file.path.toLocaleLowerCase().includes(needle)) return [];
      return [
        {
          conversationId: conversation.id,
          conversationTitle: conversation.title || '未命名会话',
          agentId: conversation.agentId,
          agentName: conversation.agentName,
          runId: file.runId,
          path: file.path,
          size: file.size,
          mimeType: file.mediaType,
          createdAt: file.createdAt,
        },
      ];
    }),
  );

  items.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    const leftKey = `${left.conversationId}:${left.runId}:${left.path}`;
    const rightKey = `${right.conversationId}:${right.runId}:${right.path}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  return {
    items: items.slice(0, options.limit),
    truncated: items.length > options.limit || pages.some(({ page }) => page.nextCursor !== null),
  };
}
