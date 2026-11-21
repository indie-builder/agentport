import { repo } from '@agentport/db';
import { actorOf } from './access.js';
import type { RequestContext } from './context.js';

export function domainAudit(domain: string) {
  return async (
    context: RequestContext,
    action: string,
    target: string,
    input?: unknown,
  ): Promise<void> => {
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: `${domain}.${action}`,
      target,
      input,
      status: 'ok',
      requestId: context.requestId,
    });
  };
}
