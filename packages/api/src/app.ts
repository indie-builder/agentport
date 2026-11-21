import { createRequire } from 'node:module';
import { createServiceLogger, requestScopedLogger } from '@agentport/core/logger';
import { createDb } from '@agentport/db';
import { Hono } from 'hono';
import { requestId } from 'hono/request-id';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Config } from './config.js';
import type { HttpEnv, RequestContext } from './http/context.js';
import { AppError, errorProblem } from './http/errors.js';
import { closeHealth, registerHealthHttp } from './http/health.js';
import { createSecurity } from './http/security.js';
import { createAuth } from './modules/auth/better-auth.js';
import { ensureBootstrap, ensureDefaultAssistant } from './modules/auth/bootstrap.js';
import { configureQueueProducer } from './queue/producer.js';
import { closeScheduleQueue } from './queue/schedule.js';
import { registerRoutes } from './routes/index.js';
import type { AppRuntime } from './types.js';

const { version }: { version: string } = createRequire(import.meta.url)('../../../package.json');

export async function buildApp(
  config: Config,
  options: { timeout?: (request: Request, seconds: number) => void } = {},
): Promise<AppRuntime> {
  const log = createServiceLogger({
    service: 'api',
    env: config.NODE_ENV,
    version,
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });
  configureQueueProducer(config.REDIS_URL);
  const { db, client } = createDb(config.DATABASE_URL);
  const app = new Hono<HttpEnv>();
  const context = { db, client, config, log, auth: createAuth(config, db) };
  const security = createSecurity(context);
  let closing: Promise<void> | undefined;
  const runtime: AppRuntime = {
    ...context,
    app,
    close: () => {
      closing ??= (async () => {
        closeHealth();
        try {
          await security.close();
        } finally {
          try {
            await closeScheduleQueue();
          } finally {
            await client.close();
          }
        }
      })();
      return closing;
    },
  };

  app.use('*', requestId());
  app.use('*', async (c, next) => {
    const id = c.get('requestId');
    const remoteAddress =
      process.env.TRUST_PROXY === '1'
        ? (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
          c.env?.remoteAddress ??
          'unknown')
        : (c.env?.remoteAddress ?? 'unknown');
    const request: RequestContext = {
      ...context,
      log: requestScopedLogger(log, id),
      principal: null,
      requestId: id,
      request: c.req.raw,
      responseHeaders: new Headers(),
      remoteAddress,
      limit: (max, bucket) => security.limit(c, max, bucket),
    };
    c.set('context', request);
    const started = performance.now();
    await next();
    request.responseHeaders.forEach((value, key) => {
      if (key !== 'set-cookie') c.header(key, value);
    });
    for (const cookie of request.responseHeaders.getSetCookie())
      c.header('set-cookie', cookie, { append: true });
    if (c.req.path.startsWith('/api/')) {
      const responseTime = Math.round(performance.now() - started);
      const details = {
        route: request.route ?? c.req.routePath,
        statusCode: c.res.status,
        responseTime,
      };
      if (responseTime > 2_000 && !c.res.headers.get('content-type')?.includes('text/event-stream'))
        request.log.warn(details, 'slow request');
      else request.log.info(details, 'request completed');
    }
  });
  app.onError((error, c) => {
    const context = c.get('context');
    const body = errorProblem(context.requestId, error);
    if (body.status >= 500) context.log.error({ err: error, code: body.code }, 'unhandled error');
    else if (body.status !== 401)
      context.log.warn({ err: error, code: body.code }, 'request rejected');
    return c.json(body, body.status as ContentfulStatusCode);
  });
  app.notFound((c) =>
    Response.json(
      errorProblem(
        c.get('context').requestId,
        new AppError('NOT_FOUND', `Route ${c.req.method} ${c.req.path} not found`),
      ),
      { status: 404 },
    ),
  );
  for (const middleware of security.middleware) app.use('*', middleware);
  app.use('/api/*', security.apiLimit);
  registerHealthHttp(app);
  let bootstrapRun: Promise<void> | undefined;
  const bootstrap = (): Promise<void> => {
    bootstrapRun ??= ensureBootstrap(db, config).catch((error) => {
      bootstrapRun = undefined;
      throw error;
    });
    return bootstrapRun;
  };
  registerRoutes(
    app,
    context,
    {
      timeout: (request, seconds) => options.timeout?.(request, seconds),
    },
    bootstrap,
  );
  try {
    await ensureDefaultAssistant(db);
  } catch (err) {
    log.warn({ err }, 'default assistant seed failed');
  }
  try {
    await bootstrap();
  } catch (err) {
    log.warn({ err }, 'admin bootstrap failed');
  }
  return runtime;
}
