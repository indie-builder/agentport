import type {
  ContentPolicy,
  ContentPolicyCreate,
  ContentPolicyUpdate,
  PolicyApproval,
  PolicyApprovalDecision,
  ViolationCase,
  ViolationCaseUpdate,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';

export type SecurityEventQuery = Omit<
  Parameters<ApiClient['security']['events']['list']>[0]['query'],
  'limit'
> & { limit?: number };

type SecurityApprovalQuery = Omit<
  Parameters<ApiClient['security']['approvals']['list']>[0]['query'],
  'limit'
> & { limit?: number };

type SecurityViolationQuery = Omit<
  Parameters<ApiClient['security']['violations']['list']>[0]['query'],
  'limit'
> & { limit?: number };

type SecurityEventPage = ApiOutput<ApiClient['security']['events']['list']>;
type SecurityApprovalPage = ApiOutput<ApiClient['security']['approvals']['list']>;
type SecurityViolationPage = ApiOutput<ApiClient['security']['violations']['list']>;

export default {
  securityPolicies: (): Promise<ContentPolicy[]> => rpc.security.policies.list(),
  createSecurityPolicy: (input: ContentPolicyCreate): Promise<ContentPolicy> =>
    rpc.security.policies.create({ body: input }),
  updateSecurityPolicy: (id: string, input: ContentPolicyUpdate): Promise<ContentPolicy> =>
    rpc.security.policies.update({ params: { id }, body: input }),
  deleteSecurityPolicy: (id: string): Promise<void> =>
    rpc.security.policies.remove({ params: { id } }),
  securityEvents: (query: SecurityEventQuery): Promise<SecurityEventPage> =>
    rpc.security.events.list({ query }),
  securityApprovals: (query: SecurityApprovalQuery): Promise<SecurityApprovalPage> =>
    rpc.security.approvals.list({ query }),
  decideSecurityApproval: (id: string, input: PolicyApprovalDecision): Promise<PolicyApproval> =>
    rpc.security.approvals.decide({ params: { id }, body: input }),
  securityViolations: (query: SecurityViolationQuery): Promise<SecurityViolationPage> =>
    rpc.security.violations.list({ query }),
  updateSecurityViolation: (id: string, input: ViolationCaseUpdate): Promise<ViolationCase> =>
    rpc.security.violations.update({ params: { id }, body: input }),
};
