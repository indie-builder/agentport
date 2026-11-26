import type { AccessFilter, ExecutionSubject } from '@agentport/shared';
import { conversations } from '../../schema.js';
import { ownerScopeWhere } from '../access.js';

export function conversationSubject(subject: ExecutionSubject) {
  return subject.kind === 'user'
    ? { createdBy: subject.businessId, serviceId: null }
    : { createdBy: null, serviceId: subject.serviceId };
}

export function conversationAccessWhere(access: AccessFilter) {
  return ownerScopeWhere(conversations.createdBy, access);
}
