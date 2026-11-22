import { fail, ORIGINAL_RUN_UNAVAILABLE_MESSAGE, sha256Hex } from '@agentport/core';
import { repo } from '@agentport/db';
import type { ChatRequest, IntegrationSourceKind, Principal, RunStatus } from '@agentport/shared';
import { authorize, authorizeObject } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { type StartRunDependencies, startRun } from '../chat/use-cases.js';

export interface ExternalRunSource {
  kind: IntegrationSourceKind;
  id: string;
}

const startRunDependencies = (context: RequestContext): StartRunDependencies => ({
  db: context.db,
  client: context.client,
  config: context.config,
  log: context.log,
  requestId: context.requestId,
  authorize: (permissionId, resource, notFoundMessage) =>
    notFoundMessage === undefined
      ? authorize(context, permissionId, resource)
      : authorizeObject(context, permissionId, resource, notFoundMessage),
});

export async function submitExternalRun(
  context: RequestContext,
  input: {
    principal: Extract<Principal, { kind: 'user' }>;
    source: ExternalRunSource;
    idempotencyKey?: string;
    request: { agentId: string; message: string; conversationId?: string };
    audit: { action: string; input: Record<string, unknown> };
  },
): Promise<{ replayed: boolean; runId: string; conversationId: string; status: RunStatus }> {
  const requestHash = sha256Hex(
    JSON.stringify({
      agentId: input.request.agentId,
      message: input.request.message,
      conversationId: input.request.conversationId ?? null,
    }),
  );
  const externalRequest =
    input.idempotencyKey === undefined
      ? undefined
      : {
          sourceKind: input.source.kind,
          sourceId: input.source.id,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        };
  const body: ChatRequest = {
    agentId: input.request.agentId,
    message: input.request.message,
    ...(input.request.conversationId === undefined
      ? {}
      : { conversationId: input.request.conversationId }),
  };

  const result = await startRun(input.principal, body, startRunDependencies(context), {
    trigger: 'event',
    auditInput: input.audit.input,
    ...(externalRequest === undefined ? {} : { externalRequest }),
  });
  if (result === null) fail('INTERNAL_ERROR', '运行创建失败');
  if ('replayed' in result && result.replayed === true) {
    const run = await repo.chat.getRun(context.db, result.runId);
    if (run === null) fail('INTERNAL_ERROR', ORIGINAL_RUN_UNAVAILABLE_MESSAGE);
    return {
      replayed: true,
      runId: result.runId,
      conversationId: result.conversationId,
      status: run.status,
    };
  }
  await repo.audit.writeAudit(context.db, context.log, {
    actor: input.principal.businessId,
    action: input.audit.action,
    target: result.runId,
    input: input.audit.input,
    status: 'ok',
    requestId: context.requestId,
  });
  return {
    replayed: false,
    runId: result.runId,
    conversationId: result.conversationId,
    status: 'queued',
  };
}
