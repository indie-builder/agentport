import { type ContentPolicyDecision, evaluateContentPolicy } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import type { Logger } from 'pino';

export async function checkRunPromptPolicy(
  db: Database,
  input: {
    agentId: string;
    prompt: string;
    sourceId: string;
    subject: { kind: 'agent' | 'user'; id: string };
  },
): Promise<string | null> {
  const policies = await repo.security.listEnabledContentPolicies(db, input.agentId);
  const { action, policy, snippet, matchDigest, text } = evaluateContentPolicy({
    text: input.prompt,
    policies,
    agentId: input.agentId,
    direction: 'inbound',
  });
  if (policy === null || action === 'allow') return text;

  const effectiveAction = action === 'require_approval' ? 'block' : action;
  await db.transaction(async (tx) => {
    const event = await repo.security.createPolicyEvent(tx, {
      policyId: policy.id,
      policyName: policy.name,
      policyVersion: policy.version,
      direction: policy.direction,
      action: effectiveAction,
      sourceKind: 'run_prompt',
      sourceId: input.sourceId,
      ...(input.subject.kind === 'user' ? { actor: input.subject.id } : {}),
      matchDigest: matchDigest ?? '',
      snippet,
      destination: input.sourceId,
    });
    if (effectiveAction === 'block') {
      await repo.security.createViolationCase(tx, {
        policyId: policy.id,
        policyName: policy.name,
        eventId: event.id,
        subjectKind: input.subject.kind,
        subjectId: input.subject.id,
        severity: 'high',
        summary: snippet,
      });
    }
    await repo.audit.writeAuditInTx(tx, {
      actor: input.subject.id,
      ...(input.subject.kind === 'agent' ? { actorKind: 'agent' as const } : {}),
      action: effectiveAction === 'block' ? 'policy.blocked' : 'policy.redacted',
      target: event.id,
      input: { policyId: policy.id, direction: policy.direction },
      status: 'ok',
    });
  });
  return effectiveAction === 'redact' ? text : null;
}

export async function checkOutboundPolicy(
  db: Database,
  _logger: Logger,
  input: {
    agentId: string;
    runId: string;
    text: string;
    sourceId: string;
    originalText?: string;
  },
) {
  const { agentId, runId, sourceId, text } = input;
  const policies = (await repo.security.listEnabledContentPolicies(db, agentId)).filter(
    ({ direction }) => direction === 'outbound',
  );
  if (policies.length === 0) return { blocked: false, text };

  const rank = { allow: 0, redact: 1, require_approval: 2, block: 3 };
  let strongest: ContentPolicyDecision | undefined;
  let body = text;
  const original = evaluateContentPolicy({
    text: input.originalText ?? text,
    policies,
    agentId,
    direction: 'outbound',
  });
  if (
    original.policy !== null &&
    (original.action === 'block' || original.action === 'require_approval')
  ) {
    strongest = original;
  } else {
    let depth = 0;
    let modelValue = false;
    body = text.replace(
      /("(?:[^"\\]|\\.)*")(\s*:)?|[{}[\]]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
      (token: string, quoted: string | undefined, colon: string | undefined) => {
        const isModelValue = modelValue;
        modelValue = false;
        if (token === '{' || token === '[') {
          depth++;
          return token;
        }
        if (token === '}' || token === ']') {
          depth--;
          return token;
        }
        const value: string = quoted === undefined ? token : JSON.parse(quoted);
        const isKey = colon !== undefined;
        modelValue = depth === 1 && isKey && value === 'model';
        const decision = evaluateContentPolicy({
          text: value,
          policies,
          agentId,
          direction: 'outbound',
        });
        if (decision.action === 'allow') return token;
        if (decision.action === 'redact' && (quoted === undefined || isKey || isModelValue)) {
          decision.action = 'block';
        }
        if (!strongest || rank[decision.action] > rank[strongest.action]) strongest = decision;
        return decision.action === 'redact' ? JSON.stringify(decision.text) : token;
      },
    );
  }
  if (strongest === undefined || strongest.policy === null || strongest.action === 'allow') {
    return { blocked: false, text };
  }

  const { policy, matchDigest } = strongest;
  const action = strongest.action === 'require_approval' ? 'block' : strongest.action;
  const blocked = action === 'block';
  await db.transaction(async (tx) => {
    const event = await repo.security.createPolicyEvent(tx, {
      policyId: policy.id,
      policyName: policy.name,
      policyVersion: policy.version,
      direction: 'outbound',
      action,
      sourceKind: 'model_request',
      sourceId,
      runId,
      actor: agentId,
      matchDigest: matchDigest ?? '',
      snippet: '[REDACTED]',
    });
    if (blocked) {
      await repo.security.createViolationCase(tx, {
        policyId: policy.id,
        policyName: policy.name,
        eventId: event.id,
        runId,
        subjectKind: 'agent',
        subjectId: agentId,
        severity: 'high',
        summary: '[REDACTED]',
      });
    }
    await repo.audit.writeAuditInTx(tx, {
      actor: agentId,
      actorKind: 'agent',
      action: blocked ? 'policy.blocked' : 'policy.redacted',
      target: event.id,
      input: { policyId: policy.id, direction: 'outbound', runId },
      status: 'ok',
    });
  });
  return { blocked, text: blocked ? '' : body };
}
