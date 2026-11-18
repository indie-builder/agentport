import { fail, sha256Hex } from '@agentport/core';
import { repo } from '@agentport/db';
import type { IntegrationScope, Principal } from '@agentport/shared';
import type { RequestContext } from '../../http/context.js';
import { principalOf } from '../auth/session.js';
import { bearerToken } from '../servers/bearer.js';

export type ApiTokenAuth = NonNullable<
  Awaited<ReturnType<typeof repo.integrations.getApiTokenByHash>>
>;

export async function authenticateApiToken(
  context: RequestContext,
  scope: IntegrationScope,
): Promise<ApiTokenAuth> {
  const token = bearerToken(context.request.headers.get('authorization') ?? undefined);
  if (token === undefined) fail('UNAUTHORIZED', '缺少 API token');
  const row = await repo.integrations.getApiTokenByHash(context.db, sha256Hex(token));
  if (
    row === null ||
    row.revokedAt !== null ||
    (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())
  ) {
    fail('UNAUTHORIZED', 'API token 无效、已撤销或已过期');
  }
  const user = await repo.accounts.getAuthUserForPrincipal(context.db, row.ownerBusinessId);
  if (user === null || user.disabled) fail('UNAUTHORIZED', 'API token 所属账户不可用');
  if (!row.scopes.includes(scope)) fail('FORBIDDEN', `API token 缺少 ${scope} 权限`);
  context.principal = await principalOf(context, user);
  void repo.integrations.touchApiToken(context.db, row.id).catch((err: unknown) => {
    context.log.warn({ err, tokenId: row.id }, 'api token last used update failed');
  });
  return row;
}

export async function principalForBusinessId(
  context: RequestContext,
  businessId: string,
): Promise<Extract<Principal, { kind: 'user' }> | null> {
  const user = await repo.accounts.getAuthUserForPrincipal(context.db, businessId);
  if (user === null || user.disabled) return null;
  return principalOf(context, user);
}
