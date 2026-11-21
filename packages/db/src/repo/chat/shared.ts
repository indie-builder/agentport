import type { AccessFilter, ExecutionSubject } from '@agentport/shared';
import { eq, sql } from 'drizzle-orm';
import { conversations } from '../../schema.js';

export function conversationSubject(subject: ExecutionSubject) {
  return subject.kind === 'user'
    ? { createdBy: subject.businessId, serviceId: null }
    : { createdBy: null, serviceId: subject.serviceId };
}

export function conversationAccessWhere(access: AccessFilter) {
  if (access.scopes.includes('platform')) return undefined;
  if (access.scopes.includes('own_data')) return eq(conversations.createdBy, access.businessId);
  return sql`false`;
}
