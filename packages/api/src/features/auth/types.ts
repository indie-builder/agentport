// 模块增强必须在 program 里能解析到 '@fastify/jwt'，否则 declare module 会被当成新模块。
import type {} from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { username: string };
    user: { username: string };
  }
}

export const AUTH_COOKIE = 'agentport_token';
/** 与 JWT 有效期、cookie maxAge 共用同一个值，避免三者漂移。 */
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
