import type { Hono } from 'hono';
import type { AppContext, HttpEnv } from './http/context.js';

export type { RouteAccess } from '@agentport/contract/access';
export type { AppContext, HttpContext, HttpEnv, RequestContext } from './http/context.js';

export type AppRuntime = AppContext & {
  app: Hono<HttpEnv>;
  close: () => Promise<void>;
};
