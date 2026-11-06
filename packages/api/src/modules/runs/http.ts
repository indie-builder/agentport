import type { Hono } from 'hono';
import type { HttpEnv } from '../../http/context.js';
import { registerRunExportHttp } from './router.js';
export function registerRunsHttp(app: Hono<HttpEnv>): void {
  registerRunExportHttp(app);
}
