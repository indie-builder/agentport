import { repo } from '@agentport/db';
import type { PermissionId } from '@agentport/shared';
import { actorOf, type RequestContext } from './context.js';

interface WarnLogger {
  warn: (obj: object, msg: string) => void;
}

export async function writeCrossUserAudit(
  db: Parameters<typeof repo.audit.writeAudit>[0],
  logger: WarnLogger,
  input: {
    actor: string;
    permissionId: PermissionId;
    subjectBusinessId: string;
    target?: string;
    requestId: string;
  },
): Promise<void> {
  await repo.audit.writeAudit(db, logger, {
    actor: input.actor,
    actorKind: 'user',
    subjectBusinessId: input.subjectBusinessId,
    action: `access.cross_user.${input.permissionId}`,
    ...(input.target === undefined ? {} : { target: input.target }),
    status: 'ok',
    requestId: input.requestId,
  });
}

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
