import { createDb } from '@agentport/db';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { registerSecurityPlugins } from './plugins/security.js';
import { registerRoutes } from './routes/index.js';

export async function buildApp(config: Config) {
  const app = Fastify({
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
