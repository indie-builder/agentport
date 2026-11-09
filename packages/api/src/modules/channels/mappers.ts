import type { repo } from '@agentport/db';
import type { ChannelMessage } from '@agentport/shared';

export function toMessage(row: repo.channels.ChannelMessageRow): ChannelMessage {
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
