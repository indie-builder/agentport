import { type ContentPolicyDecision, evaluateContentPolicy } from '@agentport/core';
import { type Database, repo } from '@agentport/db';

const security = repo.security;
const ACTION_RANK = { allow: 0, redact: 1, require_approval: 2, block: 3 } as const;

export async function checkOutboundToolArgs(input: {
  db: Database;
  agentId: string | null;
  runId: string | null;
  sourceId: string;
  args: Record<string, unknown>;
}): Promise<{ blocked: boolean; args: Record<string, unknown> }> {
  const policies = (await security.listEnabledContentPolicies(input.db, input.agentId)).filter(
    ({ direction }) => direction === 'outbound',
  );
  if (policies.length === 0) return { blocked: false, args: input.args };

  const decisions: ContentPolicyDecision[] = [];
  const inspect = (text: string): ContentPolicyDecision | null => {
    const decision = evaluateContentPolicy({
      text,
      policies,
      agentId: input.agentId,
      direction: 'outbound',
    });
    return decision.policy === null || decision.action === 'allow' ? null : decision;
  };
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const decision = inspect(value);
      if (decision === null) return value;
      decisions.push(decision);
      return decision.text;
    }
    if (typeof value === 'number') {
      const decision = inspect(String(value));
      if (decision !== null) {
        if (decision.action === 'redact') decision.action = 'block';
        decisions.push(decision);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          const decision = inspect(key);
          if (decision !== null) {
            if (decision.action === 'redact') decision.action = 'block';
            decisions.push(decision);
          }
          return [key, rewrite(item)];
        }),
      );
    }
    return value;
  };
  const scanned = rewrite(input.args) as Record<string, unknown>;
  const strongest = decisions.reduce<ContentPolicyDecision | null>(
    (best, current) =>
      best === null || ACTION_RANK[current.action] > ACTION_RANK[best.action] ? current : best,
    null,
  );
  if (strongest === null || strongest.policy === null) {
    return { blocked: false, args: input.args };
  }

  const action = strongest.action === 'redact' ? 'redact' : 'block';
  const blocked = action === 'block';
  const { policy, matchDigest } = strongest;
  await input.db.transaction(async (tx) => {
    const event = await security.createPolicyEvent(tx, {
      policyId: policy.id,
      policyName: policy.name,
      policyVersion: policy.version,
      direction: 'outbound',
      action,
      sourceKind: 'model_request',
      sourceId: input.sourceId,
      runId: input.runId,
      actor: input.agentId,
      matchDigest: matchDigest ?? '',
      snippet: '[REDACTED]',
    });
    if (blocked) {
      await security.createViolationCase(tx, {
        policyId: policy.id,
        policyName: policy.name,
        eventId: event.id,
        runId: input.runId,
        subjectKind: input.agentId === null ? 'user' : 'agent',
        subjectId: input.agentId ?? 'system',
        severity: 'high',
        summary: '[REDACTED]',
      });
    }
    await repo.audit.writeAuditInTx(tx, {
      actor: input.agentId ?? 'system',
      actorKind: input.agentId === null ? 'service' : 'agent',
      action: blocked ? 'policy.blocked' : 'policy.redacted',
      target: event.id,
      input: { policyId: policy.id, direction: 'outbound', sourceId: input.sourceId },
      status: 'ok',
    });
  });
  return { blocked, args: blocked ? input.args : scanned };
}
