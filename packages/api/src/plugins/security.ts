import { AppError } from '@agentport/core';
import type { FastifyInstance } from 'fastify';

/** 测试与本地关闭限流；预设保留显式 `rateLimit: false`，避免落回全局默认。 */
const limitsOff = process.env.RATE_LIMIT_DISABLED === '1';

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

  if (limitsOff) app.log.warn('rate limiting disabled by RATE_LIMIT_DISABLED=1');
  /*
   * 全局额度是「按 IP 计的所有请求」：servers 页面一次加载就会为每个已配置的
   * server 各拉一次工具列表（实测 40+ 条），120/min 会让正常浏览也 429。
   * 读放大是设计使然，所以总量放宽；真正的滥用风险在 SSE/登录/执行，
   * 那些已有更严格的 preset 单独限流。
   */
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'agentport:rl:',
    // 插件会 throw 这个返回值，所以必须是 Error；边界再渲染成 Problem。
    errorResponseBuilder: () =>
      new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试', { retryable: true }),
    // allowList 在计数前跳过全局限流；预设另以 rateLimit: false 显式关闭。
    ...(limitsOff ? { allowList: () => true } : {}),
  });

  app.addHook('onClose', async () => {
    await redis.quit();
  });
}

/** 登录与执行类接口用更严格的限额。 */
function preset(max: number) {
  const rateLimit: false | { max: number; timeWindow: string } = limitsOff
    ? false
    : { max, timeWindow: '1 minute' };
  return { config: { rateLimit } };
}

export const authRateLimit = preset(10);
export const chatRateLimit = preset(20);
export const mcpRateLimit = preset(60);
export const serverTestRateLimit = preset(20);
export const evalRunRateLimit = preset(10);
