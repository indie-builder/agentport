import { AppError } from '@agentport/core';
import { RedisClient } from 'bun';
import type { MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { RedisStore, rateLimiter } from 'hono-rate-limiter';
import { getTrustedOrigins, isTrustedOrigin } from '../config.js';
import type { AppContext, HttpContext, HttpEnv } from './context.js';

export function createSecurity(context: AppContext) {
  const disabled = process.env.RATE_LIMIT_DISABLED === '1';
  const redis = disabled
    ? undefined
    : new RedisClient(context.config.REDIS_URL, {
        connectionTimeout: 3_000,
        idleTimeout: 3_000,
        autoReconnect: false,
      });
  if (redis) redis.onclose = () => undefined;
  const limiters = new Map<string, MiddlewareHandler<HttpEnv>>();
  const trustedOrigins = getTrustedOrigins(context.config);
  let closed = false;

  async function limit(c: HttpContext, max: number, bucket: string): Promise<void> {
    if (disabled || redis === undefined) return;
    const key = `${bucket}:${max}`;
    let limiter = limiters.get(key);
    if (limiter === undefined) {
      limiter = rateLimiter<HttpEnv>({
        windowMs: 60_000,
        limit: max,
        keyGenerator: (c) => c.get('context').remoteAddress,
        store: new RedisStore({
          prefix: `http:rl:${key}:`,
          client: {
            scriptLoad: (script) => redis.send('SCRIPT', ['LOAD', script]),
            evalsha: (sha, keys, args) =>
              redis.send('EVALSHA', [sha, String(keys.length), ...keys, ...args.map(String)]),
            decr: (key) => redis.decr(key),
            del: (key) => redis.del(key),
          },
        }),
        handler: () => {
          throw new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试', { retryable: true });
        },
      });
      limiters.set(key, limiter);
    }
    try {
      if (closed) throw new Error('rate-limit store closed');
      if (!redis.connected) await redis.connect();
      await limiter(c, async () => undefined);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试', {
        cause: error,
        retryable: true,
      });
    }
  }

  const apiLimit: MiddlewareHandler<HttpEnv> = async (c, next) => {
    await limit(c, 600, 'global');
    await next();
  };

  return {
    limit,
    apiLimit,
    middleware: [
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          frameSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      }),
      cors({
        origin: (origin) => (isTrustedOrigin(origin, trustedOrigins) ? origin : ''),
        credentials: true,
      }),
      compress(),
    ],
    close: async () => {
      closed = true;
      if (redis) redis.onclose = () => undefined;
      redis?.close();
    },
  };
}
