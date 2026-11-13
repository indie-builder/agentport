import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Account,
  type AccountPage,
  api,
  type CreateAccountInput,
  type IdentityPage,
  type PermissionCatalog,
  type RoleMatrix,
  type RoleMatrixInput,
} from '../api.js';

export const accountQuery = (query: { q: string; limit: number; offset: number }) =>
  queryOptions<AccountPage>({
    queryKey: ['accounts', query],
    queryFn: ({ signal }) => api.accounts(query, signal),
    staleTime: 0,
  });

export const permissionCatalogQuery = queryOptions<PermissionCatalog>({
  queryKey: ['permission-catalog'],
  queryFn: ({ signal }) => api.permissions(signal),
  staleTime: 5 * 60_000,
});

export const roleMatrixQuery = queryOptions<RoleMatrix>({
  queryKey: ['role-matrix'],
  queryFn: ({ signal }) => api.roles(signal),
  staleTime: 0,
});

export const identitiesQuery = (
  agentId: string | null,
  query: { q?: string; limit?: number; offset?: number } = {},
) =>
  queryOptions<IdentityPage>({
    queryKey: ['identities', agentId, query],
    queryFn: ({ signal }) => api.identities({ ...query, agentId: agentId ?? '' }, signal),
    enabled: agentId !== null,
    staleTime: 10_000,
  });

export function useIdentities(
  agentId: string | null,
  query: { q?: string; limit?: number; offset?: number } = {},
) {
  return useQuery(identitiesQuery(agentId, query));
}

export function useAccounts(query: { q: string; limit: number; offset: number }) {
  return useQuery(accountQuery(query));
}

export function useRoleMatrix(enabled = true) {
  return useQuery({ ...roleMatrixQuery, enabled });
}

export function useCreateAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) => api.createAccount(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useUpdateAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; input: { username?: string; name?: string } }) =>
      api.updateAccount(vars.businessId, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useSetAccountStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; status: Account['status'] }) =>
      api.setAccountStatus(vars.businessId, vars.status),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useResetAccountPassword() {
  return useMutation({
    mutationFn: (vars: { businessId: string; password: string }) =>
      api.resetAccountPassword(vars.businessId, vars.password),
  });
}

export function useDeleteAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (businessId: string) => api.deleteAccount(businessId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useSetAccountRoles() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; roleIds: string[] }) =>
      api.setAccountRoles(vars.businessId, vars.roleIds),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useSaveRoleMatrix() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: RoleMatrixInput) => api.saveRoles(input),
    onSuccess: (matrix) => {
      client.setQueryData(roleMatrixQuery.queryKey, matrix);
      // 角色改变会影响当前用户的 grants 与所有按权限过滤的列表。
      void client.invalidateQueries({ queryKey: ['me'] });
      void client.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      api.changePassword(vars.currentPassword, vars.newPassword),
  });
}
