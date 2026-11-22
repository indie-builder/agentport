import type { Account, AuthMe, RoleMatrix, RoleMatrixInput } from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions } from './shared.js';

export type {
  Account,
  Role,
  RoleMatrix,
  RoleMatrixInput,
} from '@agentport/shared';

export type AccountPage = ApiOutput<ApiClient['auth']['accounts']['list']>;

export type IdentityPage = ApiOutput<ApiClient['agents']['identities']>;

export type PermissionCatalog = ApiOutput<ApiClient['auth']['permissions']>;

export type CreateAccountInput = Omit<
  Parameters<ApiClient['auth']['accounts']['create']>[0]['body'],
  'restore'
> & {
  restore: boolean;
};

export default {
  me: (): Promise<AuthMe> => rpc.auth.me(),
  changePassword: (currentPassword: string, newPassword: string): Promise<{ ok: true }> =>
    rpc.auth.changePassword({ body: { currentPassword, newPassword } }),
  login: (username: string, password: string): Promise<{ ok: boolean }> =>
    rpc.auth.login({ body: { username, password } }),
  logout: (): Promise<{ ok: boolean }> => rpc.auth.logout(),
  accounts: (
    query: { q?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<AccountPage> => rpc.auth.accounts.list({ query }, clientOptions(signal)),
  createAccount: (input: CreateAccountInput): Promise<Account> =>
    rpc.auth.accounts.create({ body: input }),
  updateAccount: (
    businessId: string,
    input: { username?: string; name?: string },
  ): Promise<Account> => rpc.auth.accounts.update({ params: { businessId }, body: input }),
  setAccountStatus: (businessId: string, status: Account['status']): Promise<Account> =>
    rpc.auth.accounts.status({ params: { businessId }, body: { status } }),
  resetAccountPassword: (businessId: string, password: string): Promise<{ ok: true }> =>
    rpc.auth.accounts.password({ params: { businessId }, body: { password } }),
  deleteAccount: (businessId: string): Promise<{ ok: true }> =>
    rpc.auth.accounts.delete({ params: { businessId } }),
  setAccountRoles: (businessId: string, roleIds: string[]): Promise<{ ok: true }> =>
    rpc.auth.accounts.roles({ params: { businessId }, body: { roleIds } }),
  roles: (signal?: AbortSignal): Promise<RoleMatrix> =>
    rpc.auth.roles.list(undefined, clientOptions(signal)),
  permissions: (signal?: AbortSignal): Promise<PermissionCatalog> =>
    rpc.auth.permissions(undefined, clientOptions(signal)),
  saveRoles: (input: RoleMatrixInput): Promise<RoleMatrix> =>
    rpc.auth.roles.replace({ body: input }),
  identities: (
    query: { q?: string; limit?: number; offset?: number; agentId: string },
    signal?: AbortSignal,
  ): Promise<IdentityPage> => rpc.agents.identities({ query }, clientOptions(signal)),
};
