import { AppError } from '@agentport/core';
import type { FastifyInstance } from 'fastify';
import { getTrustedOrigins, isTrustedOrigin } from '../config.js';

/** 测试与本地关闭限流；预设保留显式 `rateLimit: false`，避免落回全局默认。 */
const limitsOff = process.env.RATE_LIMIT_DISABLED === '1';

/** 限流存储调用失败即依赖不可用：不依赖 ioredis 的错误名/文案，统一成可重试 503。 */
function storeUnavailable(err: unknown) {
  return new AppError('SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试', {
    cause: err,
    retryable: true,
  });
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
      directives: {
        styleSrc: ["'self'", "'unsafe-inline'"],
        // UI 通过鉴权 fetch 取图后转 blob URL 渲染。
        imgSrc: ["'self'", 'data:', 'blob:'],
        // 原生 PDF 预览把下载字节转成 Blob URL 放进 iframe；只放同源与 blob。
        frameSrc: ["'self'", 'blob:'],
      },
    },
  });
  const trustedOrigins = getTrustedOrigins(app.config);
  await app.register(cors, {
    // 拒绝时返回 []：不写 allow-origin，但保留预检 204（与数组 allowlist 行为一致）。
    origin: (origin, cb) => {
      cb(null, origin && isTrustedOrigin(origin, trustedOrigins) ? origin : []);
    },
    credentials: true,
  });
  await app.register(compress, { global: true });

  // 限流专用连接（未与 BullMQ 共用）：有界重试 + 命令超时，Redis 故障时快速失败而不是挂死。
  // BullMQ 的队列连接要求 maxRetriesPerRequest: null，那条在各 queue 里单独创建，不受这里影响。
  const redis = new Redis(app.config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    // 从命令入队开始计时：3s 覆盖容器暂停/网络抖动的恢复窗口，1s 会把恢复后仍在队列里的命令误杀。
    commandTimeout: 3_000,
  });
  redis.on('error', (err: Error) => app.log.warn({ err }, 'rate-limit redis error'));

  // @fastify/rate-limit 的 RedisStore 只调用 defineCommand 和这两条 Lua 命令；
  // 在存储边界转换错误，避免 ioredis 升级改文案后限流故障退化成 500。
  const rateLimitRedis = new Proxy(redis, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      // 命令由 RedisStore 通过 defineCommand 懒注册；未定义时返回 undefined 让它继续注册。
      if (typeof value !== 'function') return value;
      if (prop !== 'rateLimit' && prop !== 'rateLimitRead') return value.bind(target);
      return (...args: unknown[]) => {
        const done = args.pop() as (err: Error | null, result?: unknown) => void;
        value.call(target, ...args, (err: Error | null, result: unknown) =>
          done(err ? storeUnavailable(err) : null, result),
        );
      };
    },
  });

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
    redis: rateLimitRedis,
    nameSpace: 'agentport:rl:',
    // 插件会 throw 这个返回值，所以必须是 Error；边界再渲染成 Problem。
    errorResponseBuilder: () =>
      new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试', { retryable: true }),
    // allowList 在计数前跳过全局限流；预设另以 rateLimit: false 显式关闭。
    ...(limitsOff ? { allowList: () => true } : {}),
  });

  app.addHook('onClose', async () => {
    // Redis 不可用时 quit 会随命令超时失败；关停不需要等待连接。
    await redis.quit().catch(() => redis.disconnect());
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
