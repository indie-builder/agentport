import type {
  ContentPolicy,
  ContentPolicyAction,
  ContentPolicyCreate,
  ContentPolicyUpdate,
  PolicyApprovalDecision,
  PolicyApprovalStatus,
  PolicySourceKind,
  ViolationCaseStatus,
  ViolationCaseUpdate,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SecurityEventQuery } from '../api.js';
import { useCursorList } from './shared.js';

const PAGE_SIZE = 50;

const securityKeys = {
  policies: ['security', 'policies'] as const,
  events: (filters: Pick<SecurityEventQuery, 'sourceKind' | 'action'>) =>
    ['security', 'events', filters] as const,
  approvals: (status: PolicyApprovalStatus) => ['security', 'approvals', status] as const,
  violations: (status: ViolationCaseStatus | 'all') => ['security', 'violations', status] as const,
};

const securityPoliciesQuery = queryOptions<ContentPolicy[]>({
  queryKey: securityKeys.policies,
  queryFn: () => api.securityPolicies(),
  staleTime: 0,
});

export function useSecurityPolicies() {
  return useQuery(securityPoliciesQuery);
}

export function useSecurityEvents(filters: {
  sourceKind?: PolicySourceKind;
  action?: ContentPolicyAction;
}) {
  return useCursorList({
    queryKey: securityKeys.events(filters),
    queryFn: (cursor) =>
      api.securityEvents({
        ...filters,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    staleTime: 0,
  });
}

export function useSecurityApprovals(status: PolicyApprovalStatus) {
  return useCursorList({
    queryKey: securityKeys.approvals(status),
    queryFn: (cursor) =>
      api.securityApprovals({
        status,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    staleTime: 0,
  });
}

export function useSecurityViolations(status: ViolationCaseStatus | 'all') {
  return useCursorList({
    queryKey: securityKeys.violations(status),
    queryFn: (cursor) =>
      api.securityViolations({
        ...(status === 'all' ? {} : { status }),
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    staleTime: 0,
  });
}

export function useCreateSecurityPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ContentPolicyCreate) => api.createSecurityPolicy(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: securityKeys.policies }),
  });
}

export function useUpdateSecurityPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: ContentPolicyUpdate }) =>
      api.updateSecurityPolicy(vars.id, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: securityKeys.policies }),
  });
}

export function useDeleteSecurityPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSecurityPolicy(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: securityKeys.policies }),
  });
}

export function useDecideSecurityApproval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: PolicyApprovalDecision }) =>
      api.decideSecurityApproval(vars.id, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['security', 'approvals'] }),
  });
}

export function useUpdateSecurityViolation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: ViolationCaseUpdate }) =>
      api.updateSecurityViolation(vars.id, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['security', 'violations'] }),
  });
}
