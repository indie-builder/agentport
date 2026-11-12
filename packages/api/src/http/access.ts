import { AppError, isAppError } from '@agentport/core';
import { repo } from '@agentport/db';
import {
  type AccessFilter,
  type AccessResource,
  type AccessScope,
  type AgentAccess,
  agentPermissionAllows,
  agentScopeAllows,
  PERMISSIONS,
  type PermissionGrant,
  type PermissionId,
  type Principal,
} from '@agentport/shared';
import { writeCrossUserAudit } from '../plugins/audit.js';
import type { RequestContext } from './context.js';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;
type AgentRelation = Awaited<ReturnType<typeof repo.access.getAgentRelation>>;

export function requireUser(context: RequestContext): UserPrincipal {
  const principal = context.principal;
  if (principal === null) throw new AppError('UNAUTHORIZED', 'not logged in');
  if (principal.kind !== 'user') {
    throw new AppError('FORBIDDEN', 'service principal cannot use user routes');
  }
  return principal;
}

export async function requirePermission(
  context: RequestContext,
  permissionId: PermissionId,
): Promise<void> {
  const principal = requireUser(context);
  if (!principal.grants.some((grant) => grant.permissionId === permissionId)) {
    throw new AppError('FORBIDDEN', '没有该操作的权限');
  }
}

async function relationFor(
  context: RequestContext,
  principal: UserPrincipal,
  agentId: string,
  cached: { value?: AgentRelation },
): Promise<AgentRelation> {
  cached.value ??= await repo.access.getAgentRelation(context.db, agentId, principal.businessId);
  if (!cached.value.exists) throw new AppError('NOT_FOUND', '对象不存在');
  return cached.value;
}

export async function authorize(
  context: RequestContext,
  permissionId: PermissionId,
  resource?: AccessResource,
): Promise<void> {
  const principal = requireUser(context);
  const grants = principal.grants.filter((grant) => grant.permissionId === permissionId);
  const cached: { value?: AgentRelation } = {};
  if (resource?.agentId !== undefined && resource.privateContent !== true) {
    const relation = await relationFor(context, principal, resource.agentId, cached);
    if (relation.isDefault) {
      if (agentPermissionAllows(grants, permissionId, relation, principal.businessId)) return;
      throw new AppError('NOT_FOUND', '对象不存在');
    }
  }
  if (grants.length === 0) throw new AppError('FORBIDDEN', '没有该操作的权限');
  if (resource === undefined) {
    if (grants.some((grant) => grant.scope === 'platform' || grant.scope === 'own_data')) {
      return;
    }
    throw new AppError('FORBIDDEN', '没有该操作的权限');
  }

  let matched: PermissionGrant | undefined;
  for (const grant of grants) {
    if (grant.scope === 'platform') {
      if (resource.agentId !== undefined)
        await relationFor(context, principal, resource.agentId, cached);
      matched = grant;
      break;
    }
    if (resource.privateContent || grant.scope === 'own_data') {
      if (
        grant.scope === 'own_data' &&
        resource.createdBy !== null &&
        resource.createdBy !== undefined &&
        resource.createdBy === principal.businessId
      ) {
        matched = grant;
        break;
      }
      continue;
    }
    if (resource.agentId === undefined) continue;
    const relation = await relationFor(context, principal, resource.agentId, cached);
    if (agentScopeAllows(grant.scope, relation, principal.businessId)) {
      matched = grant;
      break;
    }
  }
  if (matched === undefined) throw new AppError('NOT_FOUND', '对象不存在');

  if (matched.scope === 'platform') {
    let owner = resource.createdBy ?? null;
    if (resource.privateContent !== true && resource.agentId !== undefined) {
      const relation = await relationFor(context, principal, resource.agentId, cached);
      owner = relation.ownerBusinessId ?? owner;
    }
    if (owner !== null && owner !== principal.businessId) {
      const target = resource.objectId ?? resource.agentId;
      await writeCrossUserAudit(context.db, context.log, {
        actor: principal.businessId,
        permissionId,
        subjectBusinessId: owner,
        ...(target === undefined ? {} : { target }),
        requestId: context.requestId,
      });
    }
  }
}

export async function agentAccess(context: RequestContext, agentId: string): Promise<AgentAccess> {
  const principal = requireUser(context);
  const cached: { value?: AgentRelation } = {};
  const relation = await relationFor(context, principal, agentId, cached);
  if (relation.isDefault) {
    return { agentId, permissionIds: ['agents.read', 'agents.use'] };
  }
  const granted = new Set(principal.grants.map((grant) => grant.permissionId));
  const permissionIds: PermissionId[] = [];
  for (const definition of PERMISSIONS) {
    if (!granted.has(definition.id)) continue;
    if (
      !definition.scopes.some(
        (scope) =>
          scope === 'authorized_agents' ||
          scope === 'maintained_agents' ||
          scope === 'owned_agents',
      )
    ) {
      continue;
    }
    const grants = principal.grants.filter((grant) => grant.permissionId === definition.id);
    if (grants.some((grant) => agentScopeAllows(grant.scope, relation, principal.businessId))) {
      permissionIds.push(definition.id);
    }
  }
  return { agentId, permissionIds };
}

export function grantedScopes(context: RequestContext, permissionId: PermissionId): AccessScope[] {
  const scopes = new Set<AccessScope>();
  for (const grant of requireUser(context).grants) {
    if (grant.permissionId === permissionId) scopes.add(grant.scope);
  }
  if (scopes.size === 0) throw new AppError('FORBIDDEN', '没有该操作的权限');
  return [...scopes];
}

export function accessFilter(context: RequestContext, permissionId: PermissionId): AccessFilter {
  return {
    businessId: requireUser(context).businessId,
    scopes: grantedScopes(context, permissionId),
  };
}

export async function authorizeObject(
  context: RequestContext,
  permissionId: PermissionId,
  resource: AccessResource,
  notFoundMessage: string,
): Promise<void> {
  try {
    await authorize(context, permissionId, resource);
  } catch (error) {
    if (isAppError(error) && error.code === 'FORBIDDEN')
      throw new AppError('NOT_FOUND', notFoundMessage);
    throw error;
  }
}

export function actorOf(context: RequestContext): string {
  const principal = context.principal;
  if (principal === null) return 'anonymous';
  return principal.kind === 'user' ? principal.businessId : principal.serviceId;
}
