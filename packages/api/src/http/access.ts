import { AppError, isAppError, type NotFoundResource } from '@agentport/core';
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
  type ResourceAccessFilter,
  type ResourceAccessLevel,
  type ResourceKind,
} from '@agentport/shared';
import { writeCrossUserAudit } from './audit.js';
import type { RequestContext } from './context.js';
import { FORBIDDEN_MESSAGE, NOT_LOGGED_IN_MESSAGE, OBJECT_MISSING_MESSAGE } from './errors.js';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;
type AgentRelation = Awaited<ReturnType<typeof repo.access.getAgentRelation>>;

export function requireUser(context: RequestContext): UserPrincipal {
  const principal = context.principal;
  if (principal === null) throw new AppError('UNAUTHORIZED', NOT_LOGGED_IN_MESSAGE);
  if (principal.kind !== 'user') {
    throw new AppError('FORBIDDEN', 'service principal cannot use user routes');
  }
  return principal;
}

export function hasPermission(context: RequestContext, permissionId: PermissionId): boolean {
  return requireUser(context).grants.some((grant) => grant.permissionId === permissionId);
}

export async function requirePermission(
  context: RequestContext,
  permissionId: PermissionId,
): Promise<void> {
  if (!hasPermission(context, permissionId)) {
    throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
  }
}

async function relationFor(
  context: RequestContext,
  principal: UserPrincipal,
  agentId: string,
  cached: { value?: AgentRelation },
): Promise<AgentRelation> {
  cached.value ??= await repo.access.getAgentRelation(context.db, agentId, principal.businessId);
  if (!cached.value.exists) throw new AppError('NOT_FOUND', OBJECT_MISSING_MESSAGE);
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
    if (relation.inactive && permissionId === 'agents.use') {
      throw new AppError('NOT_FOUND', OBJECT_MISSING_MESSAGE);
    }
    if (relation.isDefault) {
      if (agentPermissionAllows(grants, permissionId, relation, principal.businessId)) return;
      throw new AppError('NOT_FOUND', OBJECT_MISSING_MESSAGE);
    }
  }
  if (grants.length === 0) throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
  if (resource === undefined) {
    if (grants.some((grant) => grant.scope === 'platform' || grant.scope === 'own_data')) {
      return;
    }
    throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
  }

  if (resource.resource !== undefined) {
    const object = resource.resource;
    const platform = grants.some((grant) => grant.scope === 'platform');
    let allowed =
      platform ||
      (object.ownerBusinessId === principal.businessId &&
        grants.some((grant) => grant.scope === 'own_data'));
    if (!allowed && grants.some((grant) => grant.scope === 'authorized_resources')) {
      const grant =
        resource.objectId === undefined
          ? null
          : await repo.access.getResourceGrant(
              context.db,
              object.kind,
              resource.objectId,
              principal.businessId,
            );
      allowed =
        grant !== null &&
        (object.level === 'manage' ? grant.canManage : grant.canUse || grant.canManage);
    }
    if (!allowed) throw new AppError('NOT_FOUND', OBJECT_MISSING_MESSAGE);
    if (
      platform &&
      object.ownerBusinessId !== null &&
      object.ownerBusinessId !== principal.businessId
    ) {
      await writeCrossUserAudit(context.db, context.log, {
        actor: principal.businessId,
        permissionId,
        subjectBusinessId: object.ownerBusinessId,
        ...(resource.objectId === undefined ? {} : { target: resource.objectId }),
        requestId: context.requestId,
      });
    }
    return;
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
  if (matched === undefined) throw new AppError('NOT_FOUND', OBJECT_MISSING_MESSAGE);

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
    if (relation.inactive && definition.id === 'agents.use') continue;
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

function grantedScopes(context: RequestContext, permissionId: PermissionId): AccessScope[] {
  const scopes = new Set<AccessScope>();
  for (const grant of requireUser(context).grants) {
    if (grant.permissionId === permissionId) scopes.add(grant.scope);
  }
  if (scopes.size === 0) throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
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
  notFoundResource?: NotFoundResource,
): Promise<void> {
  try {
    await authorize(context, permissionId, resource);
  } catch (error) {
    if (isAppError(error) && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND'))
      throw new AppError(
        'NOT_FOUND',
        notFoundMessage,
        notFoundResource === undefined ? {} : { resource: notFoundResource },
      );
    throw error;
  }
}

export async function authorizeResourceAccess(
  context: RequestContext,
  permissionId: PermissionId,
  resource: {
    kind: ResourceKind;
    resourceId: string;
    ownerBusinessId: string | null;
    level: ResourceAccessLevel;
  },
  notFoundMessage: string,
  notFoundResource?: NotFoundResource,
): Promise<void> {
  await requirePermission(context, permissionId);
  await authorizeObject(
    context,
    permissionId,
    {
      objectId: resource.resourceId,
      resource: {
        kind: resource.kind,
        ownerBusinessId: resource.ownerBusinessId,
        level: resource.level,
      },
    },
    notFoundMessage,
    notFoundResource,
  );
}

export async function resourceAccessFilter(
  context: RequestContext,
  permissionId: PermissionId,
  kind: ResourceKind,
  level: ResourceAccessLevel,
): Promise<ResourceAccessFilter> {
  const scopes = grantedScopes(context, permissionId);
  const businessId = requireUser(context).businessId;
  const platform = scopes.includes('platform');
  return {
    businessId,
    platform,
    own: scopes.includes('own_data'),
    grantedIds:
      !platform && scopes.includes('authorized_resources')
        ? await repo.access.listResourceGrantIds(context.db, kind, businessId, level)
        : [],
  };
}
