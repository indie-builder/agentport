import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const AUTH_COOKIE = 'agentport_token';
/** better-auth 会话有效期；cookie maxAge 与数据库 expiresAt 共用。 */
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24;
