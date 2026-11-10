import type { Hono } from 'hono';
import type { AppContext, HttpEnv } from './http/context.js';

export type AppRuntime = AppContext & {
  app: Hono<HttpEnv>;
  close: () => Promise<void>;
};
