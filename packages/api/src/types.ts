import type { AccessResource, AgentAccess, PermissionId, Principal } from '@agentport/shared';
import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * 所有路由都用 ZodTypeProvider：schema 即类型来源，handler 里的
 * request.body / params / querystring 由 schema 推导，不再手写 safeParse。
 */
export type TypedApp = FastifyInstance<
  import('node:http').Server,
  import('node:http').IncomingMessage,
  import('node:http').ServerResponse,
  import('fastify').FastifyBaseLogger,
  ZodTypeProvider
>;

export function typed(app: FastifyInstance): TypedApp {
  return app.withTypeProvider<ZodTypeProvider>();
}

/** 每条 /api 路由必须选一种访问方式；缺声明在注册时抛错。 */
export type RouteAccess =
  | { kind: 'public'; reason: string }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permissionId: PermissionId }
  | { kind: 'service'; boundary: 'mcp' | 'run-token' | 'share-token'; reason: string };

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 requireAuth 或服务 token 边界写入；未认证为 null。 */
    principal: Principal | null;
  }

  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** 仅确认当前叶存在 grant；对象范围由 handler 读取对象后调用 authorize。 */
    requirePermission: (permissionId: PermissionId) => preHandlerHookHandler;
    authorize: (
      request: FastifyRequest,
      permissionId: PermissionId,
      resource?: AccessResource,
    ) => Promise<void>;
    agentAccess: (request: FastifyRequest, agentId: string) => Promise<AgentAccess>;
  }

  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}
