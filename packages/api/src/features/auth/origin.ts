import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { getTrustedOrigins, isTrustedOrigin } from '../../config.js';
import { reject } from '../../plugins/errors.js';

/**
 * 写入口的 CSRF 防线：内部 auth.api 不经过 better-auth 的 origin check。
 * 同源请求由 Host 自动放行；带 Origin 的跨站/子域请求必须在 allowlist 内。
 */
export function isOriginAllowed(app: FastifyInstance, request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (origin === `${request.protocol}://${request.headers.host}`) return true;
  return isTrustedOrigin(origin, getTrustedOrigins(app.config));
}

/** 账户/角色/成员写入与其他认证写入口共用同一 Origin 校验。 */
export function requireTrustedOrigin(app: FastifyInstance): preHandlerHookHandler {
  return async (request, reply) => {
    if (!isOriginAllowed(app, request)) {
      return reject(reply, 'FORBIDDEN', 'origin not allowed');
    }
  };
}
