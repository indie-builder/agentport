import type { createDb, Database } from '@agentport/db';
import type { Principal } from '@agentport/shared';
import type { Context } from 'hono';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { AuthService } from './auth.js';

export type AppContext = {
  db: Database;
  client: ReturnType<typeof createDb>['client'];
  config: Config;
  log: Logger;
  auth: AuthService;
  authenticate: (context: RequestContext) => Promise<void>;
};

export type NativeHttpDependencies = { timeout: (request: Request, seconds: number) => void };

export type RequestContext = AppContext & {
  principal: Principal | null;
  requestId: string;
  request: Request;
  responseHeaders: Headers;
  remoteAddress: string;
  startedAt: number;
  route?: string;
  limit: (max: number, bucket: string) => Promise<void>;
};

export type HttpEnv = {
  Bindings: { remoteAddress?: string };
  Variables: { context: RequestContext; bodyLimitApplied?: boolean; requestFailed?: boolean };
};
export type HttpContext = Context<HttpEnv>;

export function requestContext(context: HttpContext): RequestContext {
  return context.get('context');
}

export function parseRequest<S extends z.ZodTypeAny>(c: HttpContext, schema: S): z.infer<S> {
  return schema.parse({ params: c.req.param(), query: c.req.query() });
}

export function actorOf(context: RequestContext): string {
  const principal = context.principal;
  if (principal === null) return 'anonymous';
  return principal.kind === 'user' ? principal.businessId : principal.serviceId;
}
