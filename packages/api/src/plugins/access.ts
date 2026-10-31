import { repo } from '@agentport/db';
import {
  type AccessResource,
  type AgentAccess,
  PERMISSIONS,
  type PermissionGrant,
  type PermissionId,
  type Principal,
} from '@agentport/shared';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { writeCrossUserAudit } from './audit.js';
import { AppError } from './errors.js';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;
type AgentRelation = Awaited<ReturnType<typeof repo.access.getAgentRelation>>;

function userPrincipal(request: FastifyRequest): UserPrincipal {
  const principal = request.principal;
  if (principal === null || principal === undefined) {
    throw new AppError('UNAUTHORIZED', 'not logged in');
  }
  if (principal.kind !== 'user') {
    // 服务主体只能走既有 token 工具链，不能借用用户路由。
    throw new AppError('FORBIDDEN', 'service principal cannot use user routes');
  }
  return principal;
}

function matchesAgentScope(
  scope: PermissionGrant['scope'],
  relation: AgentRelation,
  businessId: string,
): boolean {
  switch (scope) {
    case 'platform':
      return true;
    case 'authorized_agents':
      return relation.ownerBusinessId === businessId || relation.canUse;
    case 'maintained_agents':
      return relation.ownerBusinessId === businessId || relation.canMaintain;
    case 'owned_agents':
      return relation.ownerBusinessId === businessId;
    case 'own_data':
      // 专家对象权限不使用 O；O 只由对象自身的 createdBy 判定。
      return false;
  }
}

async function relationFor(
  app: FastifyInstance,
  principal: UserPrincipal,
  agentId: string,
  cached: { value?: AgentRelation },
): Promise<AgentRelation> {
  cached.value ??= await repo.access.getAgentRelation(app.db, agentId, principal.businessId);
  if (!cached.value.exists) throw new AppError('NOT_FOUND', '对象不存在');
  return cached.value;
}

async function authorizeResource(
  app: FastifyInstance,
  request: FastifyRequest,
  permissionId: PermissionId,
  resource: AccessResource | undefined,
): Promise<void> {
  const principal = userPrincipal(request);
  const grants = principal.grants.filter((grant) => grant.permissionId === permissionId);
  if (grants.length === 0) throw new AppError('FORBIDDEN', '没有该操作的权限');

  // 无对象：全局叶只接受 P；创建类叶允许本人 O（新对象归本人）。
  if (resource === undefined) {
    if (grants.some((grant) => grant.scope === 'platform' || grant.scope === 'own_data')) {
      return;
    }
    throw new AppError('FORBIDDEN', '没有该操作的权限');
  }

  const cached: { value?: AgentRelation } = {};
  let matched: PermissionGrant | undefined;
  for (const grant of grants) {
    if (grant.scope === 'platform') {
      if (resource.agentId !== undefined)
        await relationFor(app, principal, resource.agentId, cached);
      matched = grant;
      break;
    }
    // 私人正文只对本人 O 或平台 P 开放；维护/授权范围不能旁路读取。
    if (resource.privateContent) {
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
    if (grant.scope === 'own_data') {
      if (
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
    const relation = await relationFor(app, principal, resource.agentId, cached);
    if (matchesAgentScope(grant.scope, relation, principal.businessId)) {
      matched = grant;
      break;
    }
  }

  // 范围不符统一按对象不存在处理，避免泄露其他用户的对象。
  if (matched === undefined) throw new AppError('NOT_FOUND', '对象不存在');

  if (matched.scope === 'platform') {
    // 私人正文的归属是创建者，专家负责人不能覆盖它。
    let owner = resource.createdBy ?? null;
    if (resource.privateContent !== true && resource.agentId !== undefined) {
      const relation = await relationFor(app, principal, resource.agentId, cached);
      owner = relation.ownerBusinessId ?? owner;
    }
    if (owner !== null && owner !== principal.businessId) {
      const target = resource.objectId ?? resource.agentId;
      await writeCrossUserAudit(app.db, request.log, {
        actor: principal.businessId,
        permissionId,
        subjectBusinessId: owner,
        ...(target === undefined ? {} : { target }),
        requestId: request.id,
      });
    }
  }
}

async function evaluateAgentAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  agentId: string,
): Promise<AgentAccess> {
  const principal = userPrincipal(request);
  const cached: { value?: AgentRelation } = {};
  const relation = await relationFor(app, principal, agentId, cached);
  const granted = new Set(principal.grants.map((grant) => grant.permissionId));
  const permissionIds: PermissionId[] = [];
  for (const definition of PERMISSIONS) {
    if (!granted.has(definition.id)) continue;
    // 只返回能作用于某个专家对象的叶；纯全局运维叶不属于对象动作。
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
    if (grants.some((grant) => matchesAgentScope(grant.scope, relation, principal.businessId))) {
      permissionIds.push(definition.id);
    }
  }
  return { agentId, permissionIds };
}

function preHandlers(
  value: preHandlerHookHandler | preHandlerHookHandler[] | undefined,
): preHandlerHookHandler[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 注册请求主体与授权 decorations，并用一个 onRoute hook 校验 /api 路由声明。
 * permission/authenticated 自动前置认证，避免逐条路由漏挂。
 */
export function registerAccess(app: FastifyInstance): void {
  app.decorateRequest('principal', null);

  app.decorate('requirePermission', (permissionId: PermissionId): preHandlerHookHandler => {
    return async (request) => {
      const principal = request.principal;
      if (principal === null || principal === undefined) {
        throw new AppError('UNAUTHORIZED', 'not logged in');
      }
      if (principal.kind !== 'user') {
        throw new AppError('FORBIDDEN', 'service principal cannot use user routes');
      }
      if (!principal.grants.some((grant) => grant.permissionId === permissionId)) {
        throw new AppError('FORBIDDEN', '没有该操作的权限');
      }
    };
  });

  app.decorate('authorize', (request, permissionId, resource) =>
    authorizeResource(app, request, permissionId, resource),
  );
  app.decorate('agentAccess', (request, agentId) => evaluateAgentAccess(app, request, agentId));

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/') && route.url !== '/api') return;
    const access = route.config?.access;
    if (access === undefined) {
      const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
      throw new Error(`route ${methods} ${route.url} is missing config.access`);
    }

    const required: preHandlerHookHandler[] =
      access.kind === 'permission'
        ? [app.requireAuth, app.requirePermission(access.permissionId)]
        : access.kind === 'authenticated'
          ? [app.requireAuth]
          : [];
    if (required.length === 0) return;

    // 路由自己已声明的 requireAuth 不重复执行。
    const existing = preHandlers(route.preHandler).filter((handler) => handler !== app.requireAuth);
    route.preHandler = [...required, ...existing];
  });
}
