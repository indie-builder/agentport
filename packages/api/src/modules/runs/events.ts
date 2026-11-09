import type { repo } from '@agentport/db';
import { type ChatEvent, isTerminalRunStatus, wireFailureKind } from '@agentport/shared';
import type { SSEStreamingApi } from 'hono/streaming';

type Run = Pick<
  NonNullable<Awaited<ReturnType<typeof repo.chat.getRun>>>,
  'status' | 'costUsd' | 'turns' | 'error' | 'errorKind'
>;

export function terminalRunEvent(run: Run): ChatEvent | null {
  if (!isTerminalRunStatus(run.status)) return null;
  return {
    type: 'run_finished',
    status: run.status,
    ...(run.costUsd !== null ? { costUsd: Number(run.costUsd) } : {}),
    ...(run.turns !== null ? { turns: run.turns } : {}),
    ...(run.error !== null ? { error: run.error } : {}),
    ...(run.errorKind === null ? {} : { failureKind: wireFailureKind(run.errorKind) }),
  };
}

export async function writeChatEvent(stream: SSEStreamingApi, event: ChatEvent): Promise<void> {
  await stream.writeSSE({ data: JSON.stringify(event) });
}
