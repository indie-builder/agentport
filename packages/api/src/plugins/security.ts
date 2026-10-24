import { AppError } from '@agentport/core';
import type { FastifyInstance } from 'fastify';

/** 测试与本地关闭限流；预设保留显式 `rateLimit: false`，避免落回全局默认。 */
const limitsOff = process.env.RATE_LIMIT_DISABLED === '1';

type RateLimitSubmit = (
  key: string,
  timeWindow: number,
  max: number,
  continueExceeding: boolean,
  exponentialBackoff: boolean,
  callback: (err: Error | null, result: [number, number]) => void,
) => void;

/**
 * 限流存储故障必须走统一错误信封的 503，而不是被当成未知异常返回 500。
 * RedisStore 通过客户端上 defineCommand 生成的 rateLimit 命令写计数。
 */
export function failFastRateLimitStore(client: { rateLimit: RateLimitSubmit }): void {
  const submit = client.rateLimit.bind(client);
  client.rateLimit = (key, timeWindow, max, continueExceeding, exponentialBackoff, callback) =>
    submit(key, timeWindow, max, continueExceeding, exponentialBackoff, (err, result) =>
      callback(
        err
          ? new AppError('SERVICE_UNAVAILABLE', '限流服务暂时不可用，请稍后重试', { cause: err })
          : null,
        result,
      ),
    );
}

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

  // 限流在请求路径上：连接与命令都必须有界，否则 Redis 拒连时请求会挂住数秒。
  const redis = new Redis(app.config.REDIS_URL, {
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
  });
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

  failFastRateLimitStore(redis as unknown as { rateLimit: RateLimitSubmit });

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
