import type { FastifyInstance } from 'fastify';

/**
 * 安全与限流插件集中注册，避免散落在各 feature 里。
 * 限流用 Redis 存储：多进程/多 worker 部署时计数才一致。
 */
export async function registerSecurityPlugins(app: FastifyInstance): Promise<void> {
  const { default: helmet } = await import('@fastify/helmet');
  const { default: cors } = await import('@fastify/cors');
  const { default: compress } = await import('@fastify/compress');
  const { default: rateLimit } = await import('@fastify/rate-limit');
  const { Redis } = await import('ioredis');

  await app.register(helmet, {
    // MCP 端点会被非浏览器客户端访问，CSP 只对页面有意义，这里放宽。
    contentSecurityPolicy: false,
  });
  await app.register(cors, {
    origin: app.config.NODE_ENV !== 'production',
    credentials: true,
  });
  await app.register(compress, { global: true });

  const redis = new Redis(app.config.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on('error', (err: Error) => app.log.warn({ err }, 'rate-limit redis error'));

  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'agentport:rl:',
    ...(process.env.RATE_LIMIT_DISABLED === '1' ? { skip: () => true } : {}),
  });

  app.addHook('onClose', async () => {
    await redis.quit();
  });
}

/** 登录与执行类接口用更严格的限额。 */
export const authRateLimit = {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
} as const;

export const chatRateLimit = {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
} as const;
