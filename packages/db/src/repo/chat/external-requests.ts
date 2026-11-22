import { fail, ORIGINAL_RUN_UNAVAILABLE_MESSAGE } from '@agentport/core';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '../../client.js';
import { agentRuns, externalRequestKeys } from '../../schema.js';

export type ExternalRequest = Pick<
  typeof externalRequestKeys.$inferInsert,
  'sourceKind' | 'sourceId' | 'idempotencyKey' | 'requestHash'
>;

export async function findExternalRequestRun(db: DbHandle, request: ExternalRequest) {
  const [existing] = await db
    .select({
      requestHash: externalRequestKeys.requestHash,
      runId: externalRequestKeys.runId,
      run: agentRuns,
    })
    .from(externalRequestKeys)
    .leftJoin(agentRuns, eq(agentRuns.id, externalRequestKeys.runId))
    .where(
      and(
        eq(externalRequestKeys.sourceKind, request.sourceKind),
        eq(externalRequestKeys.sourceId, request.sourceId),
        eq(externalRequestKeys.idempotencyKey, request.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing === undefined) return null;
  if (existing.requestHash !== request.requestHash) {
    fail('CONFLICT', '同一幂等键已用于不同的请求');
  }
  if (existing.runId === null) {
    fail('CONFLICT', '同一幂等键的请求仍在处理中，请稍后重试');
  }
  if (existing.run === null) fail('CONFLICT', ORIGINAL_RUN_UNAVAILABLE_MESSAGE);
  return existing.run;
}
