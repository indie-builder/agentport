import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type AuditEntry = ApiOutput<ApiClient['audit']['list']>['items'][number];

export type AuditStatus = AuditEntry['status'];

export interface AuditQuery {
  action?: string;
  status?: AuditStatus;
  target?: string;
  actor?: string;
  actorKind?: AuditEntry['actorKind'];
  since?: string;
  limit?: number;
  /** ISO 时间戳；与 beforeId 相互独立，由调用方自行选择。 */
  before?: string;
  /** 上一页最后一条的 id；同毫秒并列时用 id 继续翻页。 */
  beforeId?: string;
}

export interface AuditList {
  items: AuditEntry[];
}

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
