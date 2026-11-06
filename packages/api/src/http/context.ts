import type { createDb, Database } from '@agentport/db';
import type { Principal } from '@agentport/shared';
import type { Context } from 'hono';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Auth } from '../modules/auth/better-auth.js';

export type AppContext = {
  db: Database;
  client: ReturnType<typeof createDb>['client'];
  config: Config;
  log: Logger;
  auth: Auth;
};

export type RequestContext = AppContext & {
  principal: Principal | null;
  requestId: string;
  request: Request;
  responseHeaders: Headers;
  remoteAddress: string;
  route?: string;
  limit: (max: number, bucket: string) => Promise<void>;
};

export type HttpEnv = {
  Bindings: { remoteAddress?: string };
  Variables: { context: RequestContext };
};
export type HttpContext = Context<HttpEnv>;

export function requestContext(context: HttpContext): RequestContext {
  return context.get('context');
}
