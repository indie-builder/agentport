import { AppError } from '@agentport/core';
import { Hono } from 'hono';
import type { AppContext, HttpEnv, RequestContext } from '../src/http/context.js';
import { errorProblem } from '../src/http/errors.js';

export function contextApp(runtime: AppContext): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();
  app.use('*', async (c, next) => {
    const context: RequestContext = {
      db: runtime.db,
      client: runtime.client,
      config: runtime.config,
      log: runtime.log,
      auth: runtime.auth,
      principal: null,
      requestId: crypto.randomUUID(),
      request: c.req.raw,
      responseHeaders: new Headers({ 'x-request-id': crypto.randomUUID() }),
      remoteAddress: '127.0.0.1',
      limit: async () => undefined,
    };
    c.set('context', context);
    await next();
  });
  app.onError((error, c) => {
    const body = errorProblem(c.get('context').requestId, error);
    return Response.json(body, { status: body.status });
  });
  app.notFound((c) => {
    const body = errorProblem(
      c.get('context').requestId,
      new AppError('NOT_FOUND', 'Route not found'),
    );
    return Response.json(body, { status: body.status });
  });
  return app;
}
