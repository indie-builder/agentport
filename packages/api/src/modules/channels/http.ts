import type { Hono } from 'hono';
import type { HttpEnv } from '../../http/context.js';
import type { NativeHttpDependencies } from '../chat/http.js';
import { registerChannelRunEventsHttp } from './control.js';
import { registerChannelEventsHttp } from './router.js';
export function registerChannelsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  registerChannelEventsHttp(app, deps);
  registerChannelRunEventsHttp(app, deps);
}
