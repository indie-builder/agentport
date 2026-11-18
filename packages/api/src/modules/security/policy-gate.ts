import { evaluateContentPolicy, fail, providerRouteDestination, sha256Hex } from '@agentport/core';
import { type Database, type DbHandle, repo, type Transaction } from '@agentport/db';
import type { PolicySourceKind } from '@agentport/shared';
import type { Logger } from 'pino';

const security = repo.security;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const ACTION_RANK = { allow: 0, redact: 1, require_approval: 2, block: 3 } as const;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

export async function enforceContentPolicy<T>(input: {
  db: Database;
  log: Logger;
  requestId: string;
  actor: string;
  texts: [string, ...string[]];
  extraTexts?: string[];
  payload: (texts: [string, ...string[]]) => { data: T; binding: unknown };
  agentId: string;
  origin?:
    | 'chat'
    | 'regenerate'
    | 'channel'
    | 'trial'
    | 'mcp'
    | 'external'
    | 'schedule'
    | 'question';
  sourceKind: PolicySourceKind;
  sourceId: string;
  channelId?: string;
  runId?: string;
  conversationId?: string;
}) {
  const policies = await security.listEnabledContentPolicies(input.db, input.agentId);
  const evaluate = (text: string) =>
    evaluateContentPolicy({ text, policies, agentId: input.agentId, direction: 'inbound' });
  const [first, ...rest] = input.texts;
  const firstScanned = evaluate(first);
  const restScanned = rest.map(evaluate);
  const extras = (input.extraTexts ?? []).map(evaluate);
  const strongest = [...restScanned, ...extras].reduce(
    (best, result) => (ACTION_RANK[result.action] > ACTION_RANK[best.action] ? result : best),
    firstScanned,
  );
  const unmappableRedaction =
    strongest.action === 'redact' ? extras.find(({ action }) => action === 'redact') : undefined;
  const decision = unmappableRedaction ?? strongest;
  const action = unmappableRedaction === undefined ? decision.action : 'require_approval';
  const texts: [string, ...string[]] = [firstScanned.text, ...restScanned.map(({ text }) => text)];
  const filterChannelContext = (text: string) => {
    const result = evaluate(text);
    return result.action === 'block' || result.action === 'require_approval' ? null : result.text;
  };
  if (decision.policy === null || action === 'allow') {
    return {
      payload: input.payload(texts).data,
      approvalId: null,
      eventId: null,
      filterChannelContext,
    };
  }
  const { policy, matchDigest } = decision;
  const run = input.runId === undefined ? null : await repo.chat.getRun(input.db, input.runId);
  const conversationId = run?.conversationId ?? input.conversationId;
  const lockedRoute =
    conversationId === undefined
      ? null
      : await security.getApprovedPolicyApprovalForConversation(input.db, conversationId);
  let destination = lockedRoute?.destination ?? null;
  if (destination === null) {
    let providerId = run?.servedProviderId ?? run?.providerId ?? null;
    if (providerId === null) {
      const agent = await repo.agents.getAgent(input.db, input.agentId);
      const version =
        run?.model == null && agent?.publishedVersion != null && input.origin !== 'trial'
          ? await repo.agentVersions.getAgentVersion(
              input.db,
              input.agentId,
              agent.publishedVersion,
            )
          : null;
      const model = run?.model ?? version?.definition?.agent.model ?? agent?.model ?? null;
      providerId = await repo.modelProviders.selectProviderForModel(input.db, model);
      if (providerId === null) {
        providerId = await repo.modelProviders.selectProviderForModel(input.db, model, {
          allowExhausted: true,
        });
      }
    }
    const provider =
      providerId === null ? null : await repo.modelProviders.getModelProvider(input.db, providerId);
    destination = providerRouteDestination(
      provider ?? {
        id: 'env',
        baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      },
    );
  }
  const createEvent = async (db: DbHandle, eventAction = action) => {
    const event = await security.createPolicyEvent(db, {
      policyId: policy.id,
      policyName: policy.name,
      policyVersion: policy.version,
      direction: policy.direction,
      action: eventAction,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      runId: input.runId ?? null,
      channelId: input.channelId ?? null,
      actor: input.actor,
      matchDigest: matchDigest ?? '',
      snippet: eventAction === 'block' ? '[REDACTED]' : decision.snippet,
      destination,
    });
    return event.id;
  };
  const writeAuditIn = (tx: Transaction, action: string, target: string) =>
    repo.audit.writeAuditInTx(tx, {
      actor: input.actor,
      ...(input.origin === 'mcp' ? { actorKind: 'service' as const } : {}),
      action,
      target,
      input: { policyId: policy.id, direction: policy.direction },
      status: 'ok',
      requestId: input.requestId,
    });

  const recordViolation = (db: DbHandle, eventId: string) =>
    security.createViolationCase(db, {
      policyId: policy.id,
      policyName: policy.name,
      eventId,
      runId: input.runId ?? null,
      subjectKind: 'user',
      subjectId: input.actor,
      severity: 'high',
      summary: `${policy.name}：[REDACTED]`,
    });
  if (
    action === 'block' ||
    (action === 'require_approval' && (input.origin === 'mcp' || input.origin === 'question'))
  ) {
    await input.db.transaction(async (tx) => {
      const eventId = await createEvent(tx, 'block');
      await recordViolation(tx, eventId);
      await writeAuditIn(tx, 'policy.blocked', eventId);
    });
    fail('CONTENT_BLOCKED', '内容命中安全策略，已阻止外发');
  }

  const { data: payload, binding } = input.payload(texts);
  if (action === 'redact') {
    const eventId = await input.db.transaction(async (tx) => {
      const id = await createEvent(tx);
      await writeAuditIn(tx, 'policy.redacted', id);
      return id;
    });
    return { payload, approvalId: null, eventId, filterChannelContext };
  }

  const payloadHash = sha256Hex(
    canonicalJson({ agentId: input.agentId, origin: input.origin, runId: input.runId, binding }),
  );
  const { approval, eventId } = await input.db.transaction(async (tx) => {
    const { approval, created } = await security.findOrCreatePolicyApproval(tx, {
      policyId: policy.id,
      policyName: policy.name,
      policyVersion: policy.version,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      runId: input.runId ?? null,
      channelId: input.channelId ?? null,
      payloadHash,
      destination,
      requestedBy: input.actor,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    });
    if (approval.status === 'approved') return { approval, eventId: await createEvent(tx) };
    if (!created || approval.status !== 'pending') return { approval, eventId: null };

    const eventId = await createEvent(tx);
    await recordViolation(tx, eventId);
    await writeAuditIn(tx, 'policy.approval_requested', eventId);
    return { approval, eventId };
  });
  if (approval.status === 'approved') {
    return { payload, approvalId: approval.id, eventId, filterChannelContext };
  }
  const approvalRequired = () =>
    fail('CONTENT_APPROVAL_REQUIRED', '敏感内容外发需要审批', {
      resource: 'policy_approval',
      resourceId: approval.id,
      hint: '审批后重试同一消息',
    });
  if (eventId === null) return approvalRequired();

  const recipients = await repo.governance.listAlertRecipientBusinessIds(input.db);
  await Promise.all(
    recipients.map((businessId) =>
      repo.notifications.createNotification(input.db, {
        businessId,
        kind: 'policy_approval',
        title: '内容外发待审批',
        body: `命中策略「${policy.name}」，请在安全运营中处理`,
        link: '/security?tab=approvals',
        sourceId: approval.id,
      }),
    ),
  );
  return approvalRequired();
}
