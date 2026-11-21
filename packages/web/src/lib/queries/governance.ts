import type {
  AlertSettings,
  BudgetInput,
  CostGroupBy,
  CostSummary,
  DepartmentMembersInput,
  HandoverChecklist,
  ResourceGrant,
  ResourceGrantInput,
  ResourceKind,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../orpc.js';
import { AGENTS_QUERY_KEY } from './agents.js';
import { SERVERS_QUERY_KEY } from './servers.js';
import { useCursorList } from './shared.js';
import { SKILLS_QUERY_KEY } from './skills.js';

const GOVERNANCE_PAGE_SIZE = 50;

const governanceKeys = {
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

const resourceGrantsQuery = (resourceKind: ResourceKind, resourceId: string) =>
  queryOptions<ResourceGrant[]>({
    queryKey: governanceKeys.grants(resourceKind, resourceId),
    queryFn: () => rpc.governance.resourceGrants.list({ query: { resourceKind, resourceId } }),
    enabled: resourceId.length > 0,
    staleTime: 0,
  });

const handoverQuery = (businessId: string) =>
  queryOptions<HandoverChecklist>({
    queryKey: governanceKeys.handover(businessId),
    queryFn: () => rpc.governance.handover.checklist({ params: { businessId } }),
    enabled: businessId.length > 0,
    staleTime: 0,
  });

const costSummaryQuery = (days: number, groupBy: CostGroupBy) =>
  queryOptions<CostSummary>({
    queryKey: governanceKeys.cost(days, groupBy),
    queryFn: () => rpc.governance.costSummary({ query: { days, groupBy } }),
    staleTime: 30_000,
  });

const alertSettingsQuery = queryOptions<AlertSettings>({
  queryKey: governanceKeys.alerts,
  queryFn: () => rpc.governance.alerts.get(),
  staleTime: 0,
});

export function useDepartments(enabled = true) {
  return useCursorList({
    queryKey: governanceKeys.departments,
    queryFn: (cursor, signal) =>
      rpc.governance.departments.list(
        { query: { limit: GOVERNANCE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) } },
        { signal },
      ),
    enabled,
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useBudgets(enabled = true) {
  return useCursorList({
    queryKey: governanceKeys.budgets,
    queryFn: (cursor, signal) =>
      rpc.governance.budgets.list(
        { query: { limit: GOVERNANCE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) } },
        { signal },
      ),
    enabled,
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useResourceGrants(resourceKind: ResourceKind, resourceId: string) {
  return useQuery(resourceGrantsQuery(resourceKind, resourceId));
}

export function useGovernanceResources(resourceKind: ResourceKind, q: string, enabled = true) {
  const query = q.trim();
  return useCursorList({
    queryKey: governanceKeys.resources(resourceKind, q),
    queryFn: (cursor, signal) =>
      rpc.governance.resources(
        {
          query: {
            resourceKind,
            limit: GOVERNANCE_PAGE_SIZE,
            ...(query ? { q: query } : {}),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
        { signal },
      ),
    enabled,
    staleTime: 10_000,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useGovernanceIdentities(q: string) {
  const query = q.trim();
  return useCursorList({
    queryKey: governanceKeys.identities(q),
    queryFn: (cursor, signal) =>
      rpc.governance.identities(
        {
          query: {
            limit: GOVERNANCE_PAGE_SIZE,
            ...(query ? { q: query } : {}),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
        { signal },
      ),
    staleTime: 10_000,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
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
        AGENTS_QUERY_KEY[0],
        'knowledge',
        'data-domains',
        SKILLS_QUERY_KEY[0],
        SERVERS_QUERY_KEY[0],
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
