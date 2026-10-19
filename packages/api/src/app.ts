import { createDb } from '@agentport/db';
import Fastify, { LogController } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerSecurityPlugins } from './plugins/security.js';
import { registerRoutes } from './routes/index.js';

export async function buildApp(config: Config) {
  const app = Fastify({
    // 仅在明确部署在反向代理后时信任 X-Forwarded-For，否则限流按 IP 分桶会被绕过。
    trustProxy: process.env.TRUST_PROXY === '1',
    // 请求日志由 plugins/metrics.ts 统一输出：按路由模板而非原始 URL。
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.apiKey',
          '*.token',
          '*.secret',
          '*.headers.authorization',
        ],
        censor: '[REDACTED]',
      },
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
        : {}),
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const { db, pool } = createDb(config.DATABASE_URL);
  app.decorate('db', db);
  app.decorate('pool', pool);
  app.decorate('config', config);

  app.addHook('onClose', async () => {
    await pool.end();
  });

  registerMetrics(app);
  await registerSecurityPlugins(app);
  registerRoutes(app);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: ReturnType<typeof createDb>['db'];
    pool: ReturnType<typeof createDb>['pool'];
    config: Config;
  }
}
