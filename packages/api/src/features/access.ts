import type {
  AccessFilter,
  AccessResource,
  AccessScope,
  PermissionId,
  Principal,
} from '@agentport/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, isAppError } from '../plugins/errors.js';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

/** 用户路由的请求主体；服务主体不能借用用户写路径。 */
export function userPrincipal(request: FastifyRequest): UserPrincipal {
  const principal = request.principal;
  if (principal === null || principal === undefined || principal.kind !== 'user') {
    throw new AppError('UNAUTHORIZED', 'not logged in');
  }
  return principal;
}

/** 当前叶的已授权范围（多角色只合并完整 grant，去重后仍是同一叶的范围）。 */
export function grantedScopes(request: FastifyRequest, permissionId: PermissionId): AccessScope[] {
  const scopes = new Set<AccessScope>();
  for (const grant of userPrincipal(request).grants) {
    if (grant.permissionId === permissionId) scopes.add(grant.scope);
  }
  if (scopes.size === 0) throw new AppError('FORBIDDEN', '没有该操作的权限');
  return [...scopes];
}

/** 列表查询的必填主体过滤；禁止调用方省略后读全量。 */
export function accessFilter(request: FastifyRequest, permissionId: PermissionId): AccessFilter {
  return {
    businessId: userPrincipal(request).businessId,
    scopes: grantedScopes(request, permissionId),
  };
}

/**
 * 读对象后的范围判定。范围不符统一按不存在处理，避免向无权者泄露对象存在性；
 * 平台管理员跨用户读取的审计由 auth 的 authorize 统一写入。
 */
export async function authorizeObject(
  app: FastifyInstance,
  request: FastifyRequest,
  permissionId: PermissionId,
  resource: AccessResource,
  notFoundMessage: string,
): Promise<void> {
  try {
    await app.authorize(request, permissionId, resource);
  } catch (err) {
    if (isAppError(err) && err.code === 'FORBIDDEN') {
      throw new AppError('NOT_FOUND', notFoundMessage);
    }
    throw err;
  }
}

/** 审计 actor：用户存业务 ID，服务存明确的服务标识，未认证不冒充身份。 */
export function actorOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal === null || principal === undefined) return 'anonymous';
  return principal.kind === 'user' ? principal.businessId : principal.serviceId;
}
