import { and, eq, sql } from 'drizzle-orm';
import type { DbHandle } from '../../client.js';
import { channelAgentBindings, channelMessages } from '../../schema.js';

export const CHANNEL_CONTEXT_MESSAGE_LIMIT = 20;
export const CHANNEL_CONTEXT_CHAR_LIMIT = 8000;

export async function consumeChannelContext(
  db: DbHandle,
  input: { channelId: string; agentId: string; conversationId: string; channelMessageId: string },
): Promise<void> {
  await db
    .update(channelAgentBindings)
    .set({ contextSeq: sql`greatest(${channelAgentBindings.contextSeq}, ${channelMessages.seq})` })
    .from(channelMessages)
    .where(
      and(
        eq(channelAgentBindings.channelId, input.channelId),
        eq(channelAgentBindings.agentId, input.agentId),
        eq(channelAgentBindings.conversationId, input.conversationId),
        eq(channelMessages.channelId, input.channelId),
        eq(channelMessages.id, input.channelMessageId),
      ),
    );
}
