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
    // 前端构建产物无内联脚本；内联样式来自 React 的 style 属性，需要放行。
    // MCP 端点会被非浏览器客户端访问，在各自 route config 里单独关闭 CSP。
    contentSecurityPolicy: {
      directives: { styleSrc: ["'self'", "'unsafe-inline'"] },
    },
  });
  await app.register(cors, {
    origin: app.config.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    credentials: true,
  });
  await app.register(compress, { global: true });

  const redis = new Redis(app.config.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on('error', (err: Error) => app.log.warn({ err }, 'rate-limit redis error'));

  const limitsOff = process.env.RATE_LIMIT_DISABLED === '1';
  if (limitsOff) app.log.warn('rate limiting disabled by RATE_LIMIT_DISABLED=1');
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'agentport:rl:',
    // 注意：route 级 config.rateLimit 不受这个 skip 影响（Fastify 在路由层另建实例），
    // 因此测试里还要通过下面的 env 开关整体关闭限流。
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

export const mcpRateLimit = {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
} as const;

export const serverTestRateLimit = {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
} as const;

export const evalRunRateLimit = {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
} as const;
