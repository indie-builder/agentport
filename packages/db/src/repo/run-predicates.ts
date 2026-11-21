import { and, eq, isNull } from 'drizzle-orm';
import { agentRuns } from '../schema.js';

export function neverStartedFailureFilter() {
  return and(
    eq(agentRuns.status, 'failed'),
    eq(agentRuns.errorKind, 'infra'),
    isNull(agentRuns.startedAt),
  );
}

export function isNeverStartedFailure(
  run: { status: string; errorKind: string | null; startedAt: Date | null } | null | undefined,
): boolean {
  return run?.status === 'failed' && run.errorKind === 'infra' && run.startedAt === null;
}
