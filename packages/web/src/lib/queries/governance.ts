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
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '../api.js';
import { AGENTS_QUERY_KEY } from './agents.js';
import { dataDomainKeys } from './data-domains.js';
import { pluginKeys } from './plugins.js';
import { runtimeEnvironmentKeys } from './runtime-environments.js';
import { SERVERS_QUERY_KEY } from './servers.js';
import { useCursorList } from './shared.js';
import { SKILLS_QUERY_KEY } from './skills.js';

const GOVERNANCE_PAGE_SIZE = 50;

const governanceKeys = {
  departments: ['governance', 'departments'] as const,
  budgets: ['governance', 'budgets'] as const,
  grantsAll: ['governance', 'grants'] as const,
  grants: (resourceKind: ResourceKind, resourceId: string) =>
    ['governance', 'grants', resourceKind, resourceId] as const,
  resources: (resourceKind: ResourceKind, q: string) =>
    ['governance', 'resources', resourceKind, q] as const,
  identities: (q: string) => ['governance', 'identities', q] as const,
  handoverAll: ['governance', 'handover'] as const,
  handover: (businessId: string) => ['governance', 'handover', businessId] as const,
  cost: (days: number, groupBy: CostGroupBy) => ['governance', 'cost', days, groupBy] as const,
  alerts: ['governance', 'alerts'] as const,
};

function invalidateDepartmentStructure(client: QueryClient) {
  void client.invalidateQueries({ queryKey: governanceKeys.departments });
  void client.invalidateQueries({ queryKey: governanceKeys.budgets });
  void client.invalidateQueries({ queryKey: governanceKeys.handoverAll });
}

const resourceGrantsQuery = (resourceKind: ResourceKind, resourceId: string) =>
  queryOptions<ResourceGrant[]>({
    queryKey: governanceKeys.grants(resourceKind, resourceId),
    queryFn: () => api.resourceGrants({ resourceKind, resourceId }),
    enabled: resourceId.length > 0,
    staleTime: 0,
  });

const handoverQuery = (businessId: string) =>
  queryOptions<HandoverChecklist>({
    queryKey: governanceKeys.handover(businessId),
    queryFn: () => api.handoverChecklist(businessId),
    enabled: businessId.length > 0,
    staleTime: 0,
  });

const costSummaryQuery = (days: number, groupBy: CostGroupBy) =>
  queryOptions<CostSummary>({
    queryKey: governanceKeys.cost(days, groupBy),
    queryFn: () => api.costSummary(days, groupBy),
    staleTime: 30_000,
  });

const alertSettingsQuery = queryOptions<AlertSettings>({
  queryKey: governanceKeys.alerts,
  queryFn: () => api.alertSettings(),
  staleTime: 0,
});

export function useDepartments(enabled = true) {
  return useCursorList({
    queryKey: governanceKeys.departments,
    queryFn: (cursor, signal) =>
      api.departments(
        { limit: GOVERNANCE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal,
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
      api.budgets(
        { limit: GOVERNANCE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal,
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
      api.governanceResources(
        {
          resourceKind,
          limit: GOVERNANCE_PAGE_SIZE,
          ...(query ? { q: query } : {}),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
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
      api.governanceIdentities(
        {
          limit: GOVERNANCE_PAGE_SIZE,
          ...(query ? { q: query } : {}),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
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
    mutationFn: (name: string) => api.createDepartment(name),
    onSuccess: () => void client.invalidateQueries({ queryKey: governanceKeys.departments }),
  });
}

export function useUpdateDepartment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) => api.updateDepartment(vars.id, vars.name),
    onSuccess: () => invalidateDepartmentStructure(client),
  });
}

export function useDeleteDepartment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteDepartment(id),
    onSuccess: () => invalidateDepartmentStructure(client),
  });
}

export function useSetDepartmentMembers() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; members: DepartmentMembersInput['members'] }) =>
      api.setDepartmentMembers(vars.id, vars.members),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: governanceKeys.departments });
      void client.invalidateQueries({ queryKey: governanceKeys.handoverAll });
    },
  });
}

export function useUpsertBudget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BudgetInput) => api.upsertBudget(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: governanceKeys.budgets }),
  });
}

export function useDeleteBudget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteBudget(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: governanceKeys.budgets }),
  });
}

export function useUpsertResourceGrant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ResourceGrantInput) => api.upsertResourceGrant(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: governanceKeys.grantsAll }),
  });
}

export function useDeleteResourceGrant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: ResourceGrant) =>
      api.deleteResourceGrant({
        resourceKind: vars.resourceKind,
        resourceId: vars.resourceId,
        businessId: vars.businessId,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: governanceKeys.grantsAll }),
  });
}

export function useTransferHandover() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; toBusinessId: string }) =>
      api.transferHandover(vars.businessId, vars.toBusinessId),
    onSuccess: () => {
      for (const key of [
        'governance',
        AGENTS_QUERY_KEY[0],
        'knowledge',
        dataDomainKeys.all[0],
        SKILLS_QUERY_KEY[0],
        SERVERS_QUERY_KEY[0],
        pluginKeys.all[0],
        runtimeEnvironmentKeys.all[0],
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
    mutationFn: (input: AlertSettings) => api.updateAlertSettings(input),
    onSuccess: (settings) => {
      client.setQueryData(alertSettingsQuery.queryKey, settings);
    },
  });
}
