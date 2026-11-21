import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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
import { AGENTS_QUERY_KEY } from './agents.js';
import { ME_QUERY_KEY } from './shared.js';

const authKeys = {
  accounts: (query: { q: string; limit: number; offset: number }) => ['accounts', query] as const,
  accountsAll: ['accounts'] as const,
  permissionCatalog: ['permission-catalog'] as const,
  roleMatrix: ['role-matrix'] as const,
  identities: (agentId: string | null, query: { q?: string; limit?: number; offset?: number }) =>
    ['identities', agentId, query] as const,
};

function invalidateAccountsAndMe(client: QueryClient) {
  void client.invalidateQueries({ queryKey: authKeys.accountsAll });
  void client.invalidateQueries({ queryKey: ME_QUERY_KEY });
}

export const accountQuery = (query: { q: string; limit: number; offset: number }) =>
  queryOptions<AccountPage>({
    queryKey: authKeys.accounts(query),
    queryFn: ({ signal }) => api.accounts(query, signal),
    staleTime: 0,
  });

export const permissionCatalogQuery = queryOptions<PermissionCatalog>({
  queryKey: authKeys.permissionCatalog,
  queryFn: ({ signal }) => api.permissions(signal),
  staleTime: 5 * 60_000,
});

export const roleMatrixQuery = queryOptions<RoleMatrix>({
  queryKey: authKeys.roleMatrix,
  queryFn: ({ signal }) => api.roles(signal),
  staleTime: 0,
});

const identitiesQuery = (
  agentId: string | null,
  query: { q?: string; limit?: number; offset?: number } = {},
) =>
  queryOptions<IdentityPage>({
    queryKey: authKeys.identities(agentId, query),
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
    onSuccess: () => void client.invalidateQueries({ queryKey: authKeys.accountsAll }),
  });
}

export function useUpdateAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; input: { username?: string; name?: string } }) =>
      api.updateAccount(vars.businessId, vars.input),
    onSuccess: () => invalidateAccountsAndMe(client),
  });
}

export function useSetAccountStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; status: Account['status'] }) =>
      api.setAccountStatus(vars.businessId, vars.status),
    onSuccess: () => void client.invalidateQueries({ queryKey: authKeys.accountsAll }),
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
    onSuccess: () => void client.invalidateQueries({ queryKey: authKeys.accountsAll }),
  });
}

export function useSetAccountRoles() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; roleIds: string[] }) =>
      api.setAccountRoles(vars.businessId, vars.roleIds),
    onSuccess: () => invalidateAccountsAndMe(client),
  });
}

export function useSaveRoleMatrix() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: RoleMatrixInput) => api.saveRoles(input),
    onSuccess: (matrix) => {
      client.setQueryData(roleMatrixQuery.queryKey, matrix);
      void client.invalidateQueries({ queryKey: ME_QUERY_KEY });
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      api.changePassword(vars.currentPassword, vars.newPassword),
  });
}
