import type {
  AccessScope,
  Account,
  AuthMe,
  PermissionDefinition,
  RoleMatrix,
  RoleMatrixInput,
} from '@agentport/shared';
import { rpc } from '../orpc.js';
import { clientOptions } from './shared.js';

export type {
  AccessScope,
  Account,
  PermissionDefinition,
  PermissionGrant,
  Role,
  RoleMatrix,
  RoleMatrixInput,
} from '@agentport/shared';

export type Me = AuthMe;

export interface AccountPage {
  items: Account[];
  total: number;
}

export interface IdentityCandidate {
  businessId: string;
  name: string;
  accountActive: boolean;
}

export interface IdentityPage {
  items: IdentityCandidate[];
  total: number;
}

export interface PermissionCatalog {
  permissions: PermissionDefinition[];
  scopes: { id: AccessScope; label: string }[];
}

export interface CreateAccountInput {
  businessId: string;
  username: string;
  name: string;
  password: string;
  /** 历史业务 ID 必须显式恢复；普通新账户传 false。 */
  restore: boolean;
  roleIds?: string[];
}

export default {
  me: (): Promise<AuthMe> => rpc.auth.me(),
  /** 改密成功后服务端撤销全部会话，调用方必须重新登录。 */
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
