import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type AuditList = ApiOutput<ApiClient['audit']['list']>;

export type AuditEntry = AuditList['items'][number];

export type AuditStatus = AuditEntry['status'];

export type AuditQuery = Omit<Parameters<ApiClient['audit']['list']>[0]['query'], 'limit'> & {
  limit?: number;
};

export default {
  audit: (query: AuditQuery = {}, signal?: AbortSignal): Promise<AuditList> =>
    rpc.audit.list({ query }, clientOptions(signal)),
  exportAudit: (
    query: AuditQuery = {},
  ): Promise<{ format: string; exportedAt: string; items: AuditEntry[] }> => {
    const params = new URLSearchParams();
    if (query.action) params.set('action', query.action);
    if (query.status) params.set('status', query.status);
    if (query.target) params.set('target', query.target);
    if (query.actor) params.set('actor', query.actor);
    if (query.actorKind) params.set('actorKind', query.actorKind);
    if (query.since) params.set('since', query.since);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return nativeRequest(`/audit/export${search}`);
  },
  verifyAudit: (query: { afterSeq?: number; limit?: number } = {}) => rpc.audit.verify({ query }),
};
