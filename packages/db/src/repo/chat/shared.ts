import type { AccessFilter, ExecutionSubject } from '@agentport/shared';
import { eq, sql } from 'drizzle-orm';
import { conversations } from '../../schema.js';

export function conversationSubject(subject: ExecutionSubject) {
  return subject.kind === 'user'
    ? { createdBy: subject.businessId, serviceId: null }
    : { createdBy: null, serviceId: subject.serviceId };
}

/** 私有列表只认 O/P：P 看全部，O 只看自己的业务身份。 */
export function conversationAccessWhere(access: AccessFilter) {
  if (access.scopes.includes('platform')) return undefined;
  if (access.scopes.includes('own_data')) return eq(conversations.createdBy, access.businessId);
  return sql`false`;
}
