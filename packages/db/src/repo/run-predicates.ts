import { and, eq, isNull } from 'drizzle-orm';
import { agentRuns } from '../schema.js';

export function neverStartedFailureFilter() {
  return and(
    eq(agentRuns.status, 'failed'),
    eq(agentRuns.errorKind, 'infra'),
    isNull(agentRuns.startedAt),
  );
}
