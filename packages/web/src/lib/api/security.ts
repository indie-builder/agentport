import type {
  ContentPolicy,
  ContentPolicyAction,
  ContentPolicyCreate,
  ContentPolicyUpdate,
  PolicyApproval,
  PolicyApprovalDecision,
  PolicyApprovalStatus,
  PolicyEvent,
  PolicySourceKind,
  ViolationCase,
  ViolationCaseStatus,
  ViolationCaseUpdate,
} from '@agentport/shared';
import { rpc } from '../orpc.js';

export interface SecurityEventQuery {
  sourceKind?: PolicySourceKind;
  action?: ContentPolicyAction;
  limit?: number;
  cursor?: string;
}

export interface SecurityApprovalQuery {
  status?: PolicyApprovalStatus;
  limit?: number;
  cursor?: string;
}

export interface SecurityViolationQuery {
  status?: ViolationCaseStatus;
  limit?: number;
  cursor?: string;
}

export type SecurityEventPage = { items: PolicyEvent[]; nextCursor: string | null };
export type SecurityApprovalPage = { items: PolicyApproval[]; nextCursor: string | null };
export type SecurityViolationPage = { items: ViolationCase[]; nextCursor: string | null };

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
