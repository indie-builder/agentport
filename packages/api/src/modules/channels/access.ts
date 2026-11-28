import type { PermissionId } from '@agentport/shared';
import { authorize, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';

export function channelSubject(context: RequestContext): { businessId: string } {
  return { businessId: requireUser(context).businessId };
}

function isPlatformReader(context: RequestContext, permissionId: PermissionId): boolean {
  return requireUser(context).grants.some(
    (grant) => grant.permissionId === permissionId && grant.scope === 'platform',
  );
}

export async function auditChannelRead(
  context: RequestContext,
  channel: { id: string; createdBy: string },
): Promise<void> {
  if (!isPlatformReader(context, 'conversations.read')) return;
  await authorize(context, 'conversations.read', {
    objectId: channel.id,
    createdBy: channel.createdBy,
    privateContent: true,
  });
}
