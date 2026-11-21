import {
  type ChannelEvent,
  type ChannelMessage,
  channelMessageCreatedEvent,
} from '@agentport/shared';
import type { Logger } from 'pino';
import { publishChannelEvent } from '../../queue/producer.js';

export async function publishChannelEventSafely(
  log: Logger,
  channelId: string,
  event: ChannelEvent,
  fields: Record<string, unknown> = {},
): Promise<void> {
  try {
    await publishChannelEvent(channelId, event);
  } catch (err) {
    log.warn({ err, channelId, ...fields, type: event.type }, 'channel event publish failed');
  }
}

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
