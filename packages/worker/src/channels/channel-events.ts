import type { ChannelEvent } from '@agentport/shared';
import type { Logger } from 'pino';
import { publishChannelEvent } from '../runner-client.js';

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
