import { type ChannelMessage, channelMessageCreatedEvent } from '@agentport/shared';
import type { Logger } from 'pino';
import { publishChannelEventSafely } from '../../queue/producer.js';

export async function publishChannelMessageSafely(
  log: Logger,
  channelId: string,
  message: ChannelMessage,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await publishChannelEventSafely(
    log,
    channelId,
    channelMessageCreatedEvent(channelId, message),
    fields,
  );
}
