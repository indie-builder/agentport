import type { Hono } from 'hono';
import type { HttpEnv } from '../../http/context.js';
import type { NativeHttpDependencies } from '../chat/http.js';
import { registerRunExportHttp } from './router.js';
export function registerRunsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  registerRunExportHttp(app, deps);
}
