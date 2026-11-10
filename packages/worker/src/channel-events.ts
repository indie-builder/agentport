import type { schema } from '@agentport/db';
import type { ChannelEvent, ChannelMessage } from '@agentport/shared';
import type { Logger } from 'pino';
import { publishChannelEvent } from './runner-client.js';

export function channelMessageEvent(
  row: typeof schema.channelMessages.$inferSelect,
): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    kind: row.kind,
    authorBusinessId: row.authorBusinessId,
    agentId: row.agentId,
    runId: row.runId,
    body: row.body,
    clientMessageId: row.clientMessageId,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 频道通知是尽力而为：失败只记日志，不能让 run 失败或触发重试，DB 仍是权威。 */
export async function publishChannelEventSafely(
  channelId: string,
  event: ChannelEvent,
  logger: Logger,
  context: Record<string, unknown> = {},
): Promise<void> {
  try {
    await publishChannelEvent(channelId, event, logger);
  } catch (err) {
    logger.warn({ err, channelId, ...context }, 'channel event publish failed');
  }
}
