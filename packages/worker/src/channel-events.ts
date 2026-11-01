import type { ChannelEvent } from '@agentport/shared';
import type { Logger } from 'pino';
import { publishChannelEvent } from './runner-client.js';

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
