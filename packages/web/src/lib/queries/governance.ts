import type {
  AlertSettings,
  BudgetInput,
  BudgetStatus,
  CostGroupBy,
  CostSummary,
  Department,
  DepartmentMembersInput,
  GovernanceIdentity,
  GovernanceResource,
  HandoverChecklist,
  ResourceGrant,
  ResourceGrantInput,
  ResourceKind,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../orpc.js';

export const governanceKeys = {
  departments: ['governance', 'departments'] as const,
  budgets: ['governance', 'budgets'] as const,
  grants: (resourceKind: ResourceKind, resourceId: string) =>
    ['governance', 'grants', resourceKind, resourceId] as const,
  resources: (resourceKind: ResourceKind, q: string) =>
    ['governance', 'resources', resourceKind, q] as const,
  identities: (q: string) => ['governance', 'identities', q] as const,
  handover: (businessId: string) => ['governance', 'handover', businessId] as const,
  cost: (days: number, groupBy: CostGroupBy) => ['governance', 'cost', days, groupBy] as const,
  alerts: ['governance', 'alerts'] as const,
};

export const departmentsQuery = queryOptions<Department[]>({
  queryKey: governanceKeys.departments,
  queryFn: () => rpc.governance.departments.list(),
  staleTime: 0,
});

export const budgetsQuery = queryOptions<BudgetStatus[]>({
  queryKey: governanceKeys.budgets,
  queryFn: () => rpc.governance.budgets.list(),
  staleTime: 0,
});

export const resourceGrantsQuery = (resourceKind: ResourceKind, resourceId: string) =>
  queryOptions<ResourceGrant[]>({
    queryKey: governanceKeys.grants(resourceKind, resourceId),
    queryFn: () => rpc.governance.resourceGrants.list({ query: { resourceKind, resourceId } }),
    enabled: resourceId.length > 0,
    staleTime: 0,
  });

export const governanceResourcesQuery = (resourceKind: ResourceKind, q: string, enabled = true) =>
  queryOptions<GovernanceResource[]>({
    queryKey: governanceKeys.resources(resourceKind, q),
    queryFn: () =>
      rpc.governance.resources({
        query: q.trim() ? { resourceKind, q: q.trim() } : { resourceKind },
      }),
    enabled,
    staleTime: 10_000,
  });

export const governanceIdentitiesQuery = (q: string) =>
  queryOptions<GovernanceIdentity[]>({
    queryKey: governanceKeys.identities(q),
    queryFn: () => rpc.governance.identities({ query: q.trim() ? { q: q.trim() } : {} }),
    staleTime: 10_000,
  });

export const handoverQuery = (businessId: string) =>
  queryOptions<HandoverChecklist>({
    queryKey: governanceKeys.handover(businessId),
    queryFn: () => rpc.governance.handover.checklist({ params: { businessId } }),
    enabled: businessId.length > 0,
    staleTime: 0,
  });

export const costSummaryQuery = (days: number, groupBy: CostGroupBy) =>
  queryOptions<CostSummary>({
    queryKey: governanceKeys.cost(days, groupBy),
    queryFn: () => rpc.governance.costSummary({ query: { days, groupBy } }),
    staleTime: 30_000,
  });

export const alertSettingsQuery = queryOptions<AlertSettings>({
  queryKey: governanceKeys.alerts,
  queryFn: () => rpc.governance.alerts.get(),
  staleTime: 0,
});

export function useDepartments(enabled = true) {
  return useQuery({ ...departmentsQuery, enabled });
}

export function useBudgets(enabled = true) {
  return useQuery({ ...budgetsQuery, enabled });
}

export function useResourceGrants(resourceKind: ResourceKind, resourceId: string) {
  return useQuery(resourceGrantsQuery(resourceKind, resourceId));
}

export function useGovernanceResources(resourceKind: ResourceKind, q: string, enabled = true) {
  return useQuery(governanceResourcesQuery(resourceKind, q, enabled));
}

export function useGovernanceIdentities(q: string) {
  return useQuery(governanceIdentitiesQuery(q));
}

export function useHandover(businessId: string) {
  return useQuery(handoverQuery(businessId));
}

export function useCostSummary(days: number, groupBy: CostGroupBy) {
  return useQuery(costSummaryQuery(days, groupBy));
}

export function useAlertSettings() {
  return useQuery(alertSettingsQuery);
}

export function useCreateDepartment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => rpc.governance.departments.create({ body: { name } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: governanceKeys.departments }),
  });
}

export function useUpdateDepartment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      rpc.governance.departments.update({ params: { id: vars.id }, body: { name: vars.name } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: governanceKeys.departments });
      void client.invalidateQueries({ queryKey: governanceKeys.budgets });
      void client.invalidateQueries({ queryKey: ['governance', 'handover'] });
    },
  });
}

export function useDeleteDepartment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc.governance.departments.remove({ params: { id } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: governanceKeys.departments });
      void client.invalidateQueries({ queryKey: governanceKeys.budgets });
      void client.invalidateQueries({ queryKey: ['governance', 'handover'] });
    },
  });
}

export function useSetDepartmentMembers() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; members: DepartmentMembersInput['members'] }) =>
      rpc.governance.departments.members({
        params: { id: vars.id },
        body: { members: vars.members },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: governanceKeys.departments });
      void client.invalidateQueries({ queryKey: ['governance', 'handover'] });
    },
  });
}

export function useUpsertBudget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BudgetInput) => rpc.governance.budgets.upsert({ body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: governanceKeys.budgets }),
  });
}

export function useDeleteBudget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc.governance.budgets.remove({ params: { id } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: governanceKeys.budgets }),
  });
}

export function useUpsertResourceGrant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ResourceGrantInput) =>
      rpc.governance.resourceGrants.upsert({ body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['governance', 'grants'] }),
  });
}

export function useDeleteResourceGrant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: ResourceGrant) =>
      rpc.governance.resourceGrants.remove({
        query: {
          resourceKind: vars.resourceKind,
          resourceId: vars.resourceId,
          businessId: vars.businessId,
        },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['governance', 'grants'] }),
  });
}

export function useTransferHandover() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; toBusinessId: string }) =>
      rpc.governance.handover.transfer({
        params: { businessId: vars.businessId },
        body: { toBusinessId: vars.toBusinessId },
      }),
    onSuccess: () => {
      for (const key of [
        'governance',
        'agents',
        'knowledge',
        'data-domains',
        'skills',
        'servers',
        'plugins',
        'runtime-environments',
        'schedules',
      ]) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useUpdateAlertSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AlertSettings) => rpc.governance.alerts.update({ body: input }),
    onSuccess: (settings) => {
      client.setQueryData(alertSettingsQuery.queryKey, settings);
    },
  });
}
