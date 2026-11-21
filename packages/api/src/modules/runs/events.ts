import type { repo } from '@agentport/db';
import { type ChatEvent, isTerminalRunStatus, wireFailureKind } from '@agentport/shared';
import type { SSEStreamingApi } from 'hono/streaming';
import { toIso } from '../../lib/iso.js';

type Run = Pick<
  NonNullable<Awaited<ReturnType<typeof repo.chat.getRun>>>,
  'status' | 'costUsd' | 'turns' | 'error' | 'errorKind'
>;

type RunDetail = NonNullable<Awaited<ReturnType<typeof repo.runs.getRunDetail>>>;

export function toRunDetail(detail: RunDetail) {
  return {
    run: {
      ...detail.run,
      startedAt: toIso(detail.run.startedAt),
      endedAt: toIso(detail.run.endedAt),
    },
    steps: detail.steps,
    conversation: detail.conversation,
  };
}

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
